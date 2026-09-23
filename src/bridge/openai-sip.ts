import crypto from 'crypto';
import type { Request, Response } from 'express';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { buildNoorContext } from '../context/build-noor-context.js';
import {
  getCurriculumSlice,
  normalizeGrade,
  normalizeSubject,
} from '../curriculum.js';
import {
  setUserMemoryGradeSubject,
  searchRumiHistory,
  recallRumi,
  isVectorReady,
  logCallStart,
  logCallEnd,
} from '../db.js';
import { syncCallerDelta } from '../rumi-sync.js';
import { embedTexts } from '../embeddings.js';
import { summarizeAndStore } from '../memory.js';

/**
 * Phone-call path via OpenAI's NATIVE SIP support — no VPS, no Asterisk, no RTP.
 *
 *   Caller → FlyNumber (SIP forward) → sip:<PROJECT_ID>@sip.api.openai.com:5061
 *     → OpenAI POSTs `realtime.call.incoming` to THIS webhook (HTTPS, Railway-ok)
 *     → we ACCEPT the call with Noor's instructions + tools
 *     → we open a WS on the call_id to run tools + capture the transcript
 *
 * OpenAI owns the telephony audio; Noor only speaks HTTPS + a WebSocket, so this
 * runs anywhere Noor already runs (Railway included). The tool + memory wiring
 * mirrors the WhatsApp CallSession so a phone caller gets the same Noor.
 */

const OPENAI_API = 'https://api.openai.com/v1';

// ---- webhook signature (OpenAI uses the Standard Webhooks scheme) ----

/** Verify the `webhook-signature` header. Returns true when valid (or when no
 *  secret is configured — dev mode). Never throws. */
export function verifySignature(req: Request): boolean {
  const secret = config.openai.webhookSecret;
  if (!secret) return true; // dev: signature check disabled

  try {
    const id = String(req.header('webhook-id') || '');
    const ts = String(req.header('webhook-timestamp') || '');
    const sigHeader = String(req.header('webhook-signature') || '');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!id || !ts || !sigHeader || !raw) return false;

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signed = `${id}.${ts}.${raw.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');

    // Header is a space-separated list of `v1,<sig>` — accept if any matches.
    return sigHeader.split(' ').some((part) => {
      const sig = part.includes(',') ? part.split(',')[1] : part;
      if (sig.length !== expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    });
  } catch {
    return false;
  }
}

/** Pull the caller's number out of the SIP `From` header in the webhook payload. */
export function callerNumberFrom(data: Record<string, unknown>): string {
  // Shapes seen: data.from, or data.sip_headers: [{name:'From', value:'...'}]
  const direct = typeof data.from === 'string' ? data.from : '';
  if (direct) return direct.replace(/[^0-9+]/g, '') || direct;
  const headers = Array.isArray(data.sip_headers) ? data.sip_headers : [];
  for (const h of headers as { name?: string; value?: string }[]) {
    if (h && String(h.name).toLowerCase() === 'from' && h.value) {
      const m = h.value.match(/sip:\+?([0-9]+)@/) || h.value.match(/\+?([0-9]{6,})/);
      if (m) return m[1];
    }
  }
  return 'unknown';
}

// ---- the tool definitions (same set as the WhatsApp path) ----

const TOOLS = [
  {
    type: 'function',
    name: 'lookup_curriculum',
    description:
      'Get the Taleemabad curriculum (chapters and daily topics) for a grade and subject. ' +
      'Call when the caller asks about lesson plans, chapters, or what to teach and you do not ' +
      'already have that grade+subject in context. Grades 1-5; English, Maths, Urdu.',
    parameters: {
      type: 'object',
      properties: {
        grade: { type: 'string', description: 'Grade number, 1 to 5' },
        subject: { type: 'string', description: 'English, Maths, or Urdu' },
      },
      required: ['grade', 'subject'],
    },
  },
  {
    type: 'function',
    name: 'search_rumi_history',
    description:
      "Search the caller's past chats with the Rumi WhatsApp assistant (keyword, first/earliest " +
      "via order='oldest', or a specific day via on_date=YYYY-MM-DD). All args optional.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        order: { type: 'string', enum: ['oldest', 'newest'] },
        on_date: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'recall_rumi',
    description:
      "Answer any question about the caller's Rumi history — coaching/observation scores and " +
      'feedback, lesson plans, assessments, and observations they conducted. Pass their question.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

async function runTool(fromNumber: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'lookup_curriculum') {
    const grade = String(args.grade ?? '');
    const subject = String(args.subject ?? '');
    const g = normalizeGrade(grade);
    const s = normalizeSubject(subject);
    if (g && s) void setUserMemoryGradeSubject(fromNumber, g, s).catch(() => undefined);
    return (
      getCurriculumSlice(grade, subject) ||
      `No curriculum for grade "${grade}" subject "${subject}". Available: Grades 1-5; English, Maths, Urdu.`
    );
  }
  if (name === 'search_rumi_history') {
    const order = args.order === 'oldest' ? 'oldest' : 'newest';
    const hits = await searchRumiHistory(fromNumber, {
      query: String(args.query ?? '').trim() || undefined,
      order,
      onDate: String(args.on_date ?? '').trim() || undefined,
      limit: 10,
    });
    if (!hits.length) return 'No matching Rumi messages found.';
    return (order === 'oldest' ? hits : [...hits].reverse())
      .map((h) => `[${new Date(h.createdAt).toISOString().slice(0, 10)}] ${h.role === 'user' ? 'They' : 'Rumi'}: ${h.content}`)
      .join('\n');
  }
  if (name === 'recall_rumi') {
    const q = String(args.query ?? '').trim();
    if (!q) return 'No question given.';
    let queryEmbedding: number[] | undefined;
    if (isVectorReady()) {
      const [e] = await embedTexts([q]);
      queryEmbedding = e ?? undefined;
    }
    const hits = await recallRumi(fromNumber, { queryEmbedding, queryText: q, limit: 6 });
    if (!hits.length) return 'Nothing found in their Rumi history about that.';
    return hits
      .map((h) => `[${new Date(h.createdAt).toISOString().slice(0, 10)}] (${h.kind}) ${h.content.replace(/\s+/g, ' ').slice(0, 1200)}`)
      .join('\n\n');
  }
  return 'Unknown tool.';
}

// ---- accept the call + drive tools/transcript over the call WebSocket ----

async function acceptCall(callId: string, instructions: string): Promise<void> {
  const body = {
    type: 'realtime',
    model: config.openai.model,
    instructions,
    audio: {
      // Transcribe the caller so both sides land in the transcript (memory).
      input: { transcription: { model: 'gpt-4o-mini-transcribe' } },
      output: { voice: config.openai.voice },
    },
    tools: TOOLS,
    tool_choice: 'auto',
  };
  const res = await fetch(`${OPENAI_API}/realtime/calls/${callId}/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`accept failed: ${res.status} ${await res.text().catch(() => '')}`);
}

/** Open the call's control WebSocket: run tool calls, collect the transcript. */
function driveCall(callId: string, fromNumber: string): void {
  const transcript: { role: 'caller' | 'noor'; text: string }[] = [];
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
  });

  const send = (obj: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // Nudge Noor to greet first so the caller isn't met with silence.
  ws.on('open', () => send({ type: 'response.create' }));

  ws.on('message', (raw) => {
    let evt: {
      type?: string; transcript?: string; call_id?: string;
      name?: string; arguments?: string; item?: { type?: string; call_id?: string; name?: string };
    };
    try { evt = JSON.parse(String(raw)); } catch { return; }

    switch (evt.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) transcript.push({ role: 'caller', text: evt.transcript.trim() });
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (evt.transcript) transcript.push({ role: 'noor', text: evt.transcript.trim() });
        break;
      case 'response.function_call_arguments.done': {
        const callIdArg = evt.call_id || '';
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(evt.arguments || '{}'); } catch { /* keep empty */ }
        void runTool(fromNumber, evt.name || '', args)
          .catch(() => 'That lookup did not work just now.')
          .then((output) => {
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callIdArg, output } });
            send({ type: 'response.create' });
          });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    const text = transcript.map((t) => `${t.role === 'caller' ? 'Caller' : 'Noor'}: ${t.text}`).join('\n');
    void logCallEnd({ waCallId: callId, endedAt: new Date(), transcript: text });
    if (fromNumber && fromNumber !== 'unknown' && text) {
      void summarizeAndStore(fromNumber, text).catch(() => undefined);
    }
    console.log(`[sip ${callId.slice(0, 8)}] closed (${transcript.length} lines)`);
  });
  ws.on('error', (err) => console.warn(`[sip ${callId.slice(0, 8)}] ws error`, String(err)));
}

/** Express handler for OpenAI's realtime SIP webhook (POST /openai/call). */
export const handleOpenAISipWebhook = (req: Request, res: Response): void => {
  if (!verifySignature(req)) {
    console.warn('[sip] webhook signature verification failed');
    res.sendStatus(401);
    return;
  }

  const body = req.body ?? {};
  const type = body.type as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;

  if (type !== 'realtime.call.incoming') {
    res.sendStatus(200); // ack any other event type
    return;
  }

  const callId = String(data.call_id || '');
  if (!callId) {
    res.sendStatus(400);
    return;
  }
  const fromNumber = callerNumberFrom(data);
  console.log(`[sip ${callId.slice(0, 8)}] ▶ incoming from ${fromNumber}`);

  // Ack fast; set the call up asynchronously.
  res.sendStatus(200);

  void (async () => {
    try {
      void logCallStart({ waCallId: callId, callerNumber: fromNumber, startedAt: new Date() });
      const { instructions } = await buildNoorContext(fromNumber, undefined);
      await acceptCall(callId, instructions);
      driveCall(callId, fromNumber);

      // Fold in anything the caller sent Rumi since our last sync (off the path).
      void syncCallerDelta(fromNumber).catch(() => undefined);
    } catch (err) {
      console.warn(`[sip ${callId.slice(0, 8)}] setup failed`, String(err));
      // Best-effort reject so the caller isn't left hanging.
      void fetch(`${OPENAI_API}/realtime/calls/${callId}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      }).catch(() => undefined);
    }
  })();
};
