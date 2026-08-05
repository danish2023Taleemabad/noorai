import { WebSocket } from 'ws';
import { config } from '../config.js';
import { base64ToInt16, int16ToBase64, OPENAI_RATE } from './audio.js';

/**
 * Server-side connection to the OpenAI Realtime API over WebSocket.
 *
 * Unlike the browser agent (which uses an ephemeral key over WebRTC), a backend
 * connects with the raw API key over `wss://api.openai.com/v1/realtime`. Audio
 * is exchanged as base64 PCM16 @ 24 kHz.
 *
 * Session settings mirror the browser agent exactly: model, voice, reasoning
 * effort, and server_vad turn detection with the configured silence window.
 */

export interface RealtimeCallbacks {
  /** Called with 24 kHz PCM16 samples the model wants to speak. */
  onAudio: (pcm24k: Int16Array) => void;
  /** Called when the model starts a new response (barge-in: flush playback). */
  onResponseStarted?: () => void;
  /** Called once the session is created and configured. */
  onOpen?: () => void;
  /** Called with each finalized transcript line (caller or Noor). */
  onTranscript?: (role: 'caller' | 'noor', text: string) => void;
  /**
   * Called when the model invokes a function tool. Returns the tool's output
   * text (fed back to the model). If provided, the lookup_curriculum tool is
   * registered on the session.
   */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

export class OpenAIRealtimeSession {
  #ws: WebSocket | null = null;
  #ready = false;
  // Maps a function-call id -> tool name (name arrives on output_item.added,
  // arguments arrive later on the .done event).
  #toolNames = new Map<string, string>();

  constructor(
    private readonly instructions: string,
    private readonly cb: RealtimeCallbacks,
  ) {}

  connect(): void {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      config.openai.model,
    )}`;
    // GA Realtime API: connect to /v1/realtime with NO `OpenAI-Beta` header —
    // sending `realtime=v1` forces the retired beta shape (error
    // `beta_api_shape_disabled`).
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    });
    this.#ws = ws;

    ws.on('open', () => this.#configureSession());
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', () => {
      this.#ready = false;
      this.cb.onClose?.();
    });
    ws.on('error', (err) => this.cb.onError?.(err));
  }

  #configureSession(): void {
    // semantic_vad (default) = model-based end-of-turn detection, matching what
    // the niete browser agent actually ran; avoids the overlapping/"cluttered"
    // responses that raw server_vad @ low silence produces on a noisy phone line.
    const turnDetection: Record<string, unknown> =
      config.openai.turnDetection === 'server_vad'
        ? {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: config.openai.vadSilenceMs,
            create_response: true,
            interrupt_response: true,
          }
        : {
            type: 'semantic_vad',
            eagerness: 'auto',
            create_response: true,
            interrupt_response: true,
          };

    const session: Record<string, unknown> = {
      type: 'realtime',
      instructions: this.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: OPENAI_RATE },
          turn_detection: turnDetection,
          // Transcribe the caller's speech so we can log it (Noor's own
          // transcript comes back automatically with the audio response).
          transcription: { model: 'gpt-4o-mini-transcribe' },
        },
        output: {
          format: { type: 'audio/pcm', rate: OPENAI_RATE },
          voice: config.openai.voice,
        },
      },
    };
    if (config.openai.reasoningEffort) {
      session.reasoning = { effort: config.openai.reasoningEffort };
    }

    // Register the curriculum lookup tool when a handler is wired up. The model
    // calls this only when a caller asks about lesson plans and we don't already
    // have their curriculum in the prompt — so it never touches normal chat.
    if (this.cb.onToolCall) {
      session.tools = [
        {
          type: 'function',
          name: 'lookup_curriculum',
          description:
            'Get the Taleemabad curriculum (chapters and daily topics) for a given grade and subject. ' +
            'Call this when the caller asks about lesson plans, chapters, or what to teach/study and you do ' +
            'not already have that grade+subject curriculum in your context. Grades 1-5; subjects English, Maths, Urdu.',
          parameters: {
            type: 'object',
            properties: {
              grade: { type: 'string', description: 'Grade number, 1 to 5' },
              subject: {
                type: 'string',
                description: 'Subject: English, Maths, or Urdu',
              },
            },
            required: ['grade', 'subject'],
          },
        },
        {
          type: 'function',
          name: 'search_rumi_history',
          description:
            "Look up this caller's past chats with the Rumi WhatsApp assistant — their FULL history, including old " +
            'conversations. Use for a specific topic (query), their first/earliest messages (order="oldest"), or a ' +
            'specific day (on_date). Returns matching messages with dates. All arguments are optional.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Keywords to search for in their past chats (optional)',
              },
              order: {
                type: 'string',
                enum: ['oldest', 'newest'],
                description:
                  "'oldest' to get their FIRST/earliest messages; 'newest' for most recent (default)",
              },
              on_date: {
                type: 'string',
                description: 'A specific day to fetch messages from, as YYYY-MM-DD (optional)',
              },
            },
          },
        },
      ];
      session.tool_choice = 'auto';
    }

    this.#send({ type: 'session.update', session });
    this.#ready = true;

    // Greet first so the caller hears Noor immediately after connect.
    this.#send({ type: 'response.create' });
  }

  #onMessage(raw: unknown): void {
    let evt: {
      type?: string;
      delta?: string;
      transcript?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      item?: { type?: string; call_id?: string; name?: string };
    };
    try {
      evt = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (evt.type) {
      case 'session.created':
        this.cb.onOpen?.();
        break;
      // Finalized transcripts: caller's speech (input) and Noor's speech (output).
      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) this.cb.onTranscript?.('caller', evt.transcript);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': // older event name — support both
        if (evt.transcript) this.cb.onTranscript?.('noor', evt.transcript);
        break;
      // Response lifecycle — logged to diagnose overlapping/"cluttered" audio.
      case 'response.created':
        console.log('[realtime] response.created');
        break;
      case 'response.done':
        console.log('[realtime] response.done');
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log('[realtime] speech_stopped (turn end)');
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta': // older event name — support both
        if (evt.delta) this.cb.onAudio(base64ToInt16(evt.delta));
        break;
      case 'input_audio_buffer.speech_started':
        // Caller started talking -> model should stop (barge-in).
        this.cb.onResponseStarted?.();
        break;
      // Function calling: the tool name arrives with the new output item; the
      // arguments arrive (complete) on the .done event.
      case 'response.output_item.added':
        if (evt.item?.type === 'function_call' && evt.item.call_id) {
          this.#toolNames.set(evt.item.call_id, evt.item.name ?? '');
        }
        break;
      case 'response.function_call_arguments.done':
        void this.#handleFunctionCall(
          evt.call_id ?? '',
          evt.name,
          evt.arguments ?? '{}',
        );
        break;
      case 'error':
        this.cb.onError?.(String(raw));
        break;
      default:
        break;
    }
  }

  /**
   * Run a function call: parse args, invoke the handler, feed the output back to
   * the model, then ask it to continue (speak the answer). The handler itself is
   * an in-memory lookup, so this adds no network round-trip.
   */
  async #handleFunctionCall(
    callId: string,
    name: string | undefined,
    argsJson: string,
  ): Promise<void> {
    const fnName = name || this.#toolNames.get(callId) || '';
    this.#toolNames.delete(callId);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      /* leave args empty */
    }
    let output = '';
    try {
      output = (await this.cb.onToolCall?.(fnName, args)) ?? '';
    } catch (err) {
      this.cb.onError?.(err);
      output = 'Sorry, that lookup did not work just now.';
    }
    if (!callId) return;
    this.#send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.#send({ type: 'response.create' });
  }

  /** Push 24 kHz PCM16 caller audio to the model. */
  appendAudio(pcm24k: Int16Array): void {
    if (!this.#ready) return;
    this.#send({
      type: 'input_audio_buffer.append',
      audio: int16ToBase64(pcm24k),
    });
  }

  #send(obj: unknown): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(obj));
    }
  }

  close(): void {
    try {
      this.#ws?.close();
    } catch {
      /* already closed */
    }
    this.#ws = null;
    this.#ready = false;
  }
}
