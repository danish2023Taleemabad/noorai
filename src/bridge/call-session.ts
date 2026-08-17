import wrtcPkg from '@roamhq/wrtc';
import { config } from '../config.js';
import { OpenAIRealtimeSession } from './openai-realtime.js';
import { buildNoorContext } from '../context/build-noor-context.js';
import { terminateCall } from '../whatsapp/calls-api.js';
import {
  getCurriculumSlice,
  normalizeGrade,
  normalizeSubject,
} from '../curriculum.js';
import {
  setUserMemoryGradeSubject,
  searchRumiHistory,
  logResponseLatency,
  recallRumi,
  isVectorReady,
} from '../db.js';
import { syncCallerDelta } from '../rumi-sync.js';
import { embedTexts } from '../embeddings.js';
import { UpliftTtsSession, UPLIFT_RATE } from './uplift-tts.js';
import {
  downmixToMono,
  resampleLinear,
  upsample24to48,
  StreamResampler,
  OPENAI_RATE,
  WHATSAPP_RATE,
} from './audio.js';

/** Split accumulated text into complete sentences + a remainder, for streaming
 *  to TTS. Flushes a long run-on even without punctuation to bound latency. */
const splitSentences = (buf: string): { sentences: string[]; rest: string } => {
  const sentences: string[] = [];
  let rest = buf;
  // Sentence enders incl. Urdu full-stop (۔) and question mark (؟).
  const re = /[^.!?۔؟\n]*[.!?۔؟\n]+/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(buf)) !== null) {
    sentences.push(m[0].trim());
    lastIdx = re.lastIndex;
  }
  rest = buf.slice(lastIdx);
  if (rest.length > 180) {
    // No punctuation for a long time — flush what we have.
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences: sentences.filter(Boolean), rest };
};

/**
 * One live WhatsApp call bridged to one OpenAI Realtime session.
 *
 * Audio path:
 *   WhatsApp caller --(Opus/SRTP)--> wrtc RTCAudioSink (PCM 48k, maybe stereo)
 *     --downmix mono--> --downsample 24k--> OpenAI Realtime
 *   OpenAI Realtime (PCM 24k) --upsample 48k--> wrtc RTCAudioSource --> caller
 *
 * @roamhq/wrtc has no TS types, so it's accessed via a loose alias.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrtc = wrtcPkg as any;
const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;

const FRAME_MS = 10;
const FRAME_SAMPLES_48K = (WHATSAPP_RATE * FRAME_MS) / 1000; // 480
// Safety ceiling only (~60s). The realtime API streams a response's audio
// FASTER than real-time, so the buffer legitimately holds several seconds of
// not-yet-played speech. We must NOT drop within a response (that skips/overlaps
// the playback) — this cap only guards against pathological unbounded growth.
const MAX_PLAYOUT_SAMPLES = WHATSAPP_RATE * 60;
// Jitter buffer: after silence, wait until this much audio is queued before
// resuming playback, so brief network/generation jitter doesn't cause underrun
// gaps ("unstable connection" stutter). ~120ms — a small, one-time cushion per
// talk-spurt, not per word.
const PREBUFFER_SAMPLES = Math.round(WHATSAPP_RATE * 0.12);

// How long to tolerate an ICE 'disconnected' blip before treating it as a real
// drop and closing. (Note: WhatsApp relays media via a Meta server, so a CALLER
// drop usually does NOT change our peer state — the no-media watchdog below is
// what actually catches caller drops. This is only for our-side/relay failures.)
const DISCONNECT_GRACE_MS = 10_000; // 10s

// "Caller gone" watchdog. WhatsApp relays audio continuously and never promptly
// tells us about a drop, and ICE stays connected (media goes via a Meta server).
// So the reliable signal is: has the caller produced any REAL speech recently?
// If there's been no real caller speech for this long, end the call. Each tick
// also logs incoming audio energy (RMS) so we can see what Meta sends post-drop.
const NO_INPUT_MS = 60_000; // 60s of no real caller speech → end
const WATCHDOG_TICK_MS = 5_000;

export class CallSession {
  #pc: InstanceType<typeof RTCPeerConnection> | null = null;
  #realtime: OpenAIRealtimeSession | null = null;
  #audioSource: any = null;
  #sink: any = null;

  /** Set by the webhook — invoked once when the session closes, for any reason
   *  (hangup, media drop, error), so it can free the line. */
  onClose?: () => void;
  #disconnectTimer: NodeJS.Timeout | null = null;
  #lastActivityAt = 0; // epoch ms of last speech activity — caller OR Noor
  #peakRmsSinceTick = 0; // loudest incoming frame since last heartbeat (diagnostic)
  #watchdog: NodeJS.Timeout | null = null;

  // Playout buffer: a queue of 48 kHz PCM16 chunks + a read head into chunk[0].
  // Chunk-based (not per-sample) so draining is O(frame), never O(n) — the
  // per-sample Array.shift() approach was O(n²) and stuttered the audio.
  #chunks: Int16Array[] = [];
  #head = 0;
  #buffered = 0;
  #playing = false; // false = waiting for the jitter buffer to fill
  #playoutTimer: NodeJS.Timeout | null = null;
  #closed = false;

  // Ordered transcript of the call (caller + Noor turns), for the DB log.
  #transcript: { role: 'caller' | 'noor'; text: string }[] = [];

  // Uplift voice path (only when VOICE_PROVIDER=uplift and connect succeeds).
  #uplift: UpliftTtsSession | null = null;
  #upResampler: StreamResampler | null = null; // stateful 22.05k -> 48k (no boundary clicks)
  #textBuf = ''; // accumulates OpenAI text deltas until a sentence is ready
  #responseText = ''; // full text of the in-flight response (for the transcript)
  #speechStoppedAt = 0; // for Uplift-path response-latency timing

  constructor(
    public readonly callId: string,
    public readonly fromNumber: string,
    public readonly callerName?: string,
  ) {}

  get #tag(): string {
    return `[call ${this.callId}]`;
  }

  /** Full transcript as "Caller: … / Noor: …" lines, in order. */
  getTranscriptText(): string {
    return this.#transcript
      .map((t) => `${t.role === 'caller' ? 'Caller' : 'Noor'}: ${t.text}`)
      .join('\n');
  }

  async createAnswer(offerSdp: string): Promise<string> {
    // STUN always; add TURN when configured (required on hosts without UDP
    // reachability, e.g. Railway — use TURN over TCP/TLS there).
    const iceServers: Record<string, unknown>[] = [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    if (config.turn.urls) {
      iceServers.push({
        urls: config.turn.urls.split(',').map((u) => u.trim()).filter(Boolean),
        username: config.turn.username || undefined,
        credential: config.turn.credential || undefined,
      });
    }
    const pc = new RTCPeerConnection({
      iceServers,
      // 'relay' forces all media through TURN — useful to guarantee/verify the
      // relay path on Railway; 'all' lets it try direct first.
      iceTransportPolicy: config.turn.forceRelay ? 'relay' : 'all',
    });
    this.#pc = pc;

    // Outgoing audio (Noor -> caller).
    this.#audioSource = new RTCAudioSource();
    const outTrack = this.#audioSource.createTrack();
    pc.addTrack(outTrack);

    // Decide Noor's voice engine. Uplift is used only when configured; if it
    // can't connect we fall back to the OpenAI voice for THIS call and nothing
    // else changes. We kick off the connect here so it overlaps buildNoorContext.
    let useUplift = config.voiceProvider === 'uplift' && Boolean(config.uplift.apiKey);
    let upliftConnect: Promise<void> | null = null;
    if (useUplift) {
      this.#upResampler = new StreamResampler(UPLIFT_RATE, WHATSAPP_RATE);
      this.#uplift = new UpliftTtsSession({
        onPcm: (pcm) => this.#onUpliftPcm(pcm),
        onError: (e) => console.warn(`${this.#tag} [uplift] ${String(e).slice(0, 120)}`),
      });
      upliftConnect = this.#uplift.connect();
    }

    const { instructions } = await buildNoorContext(
      this.fromNumber,
      this.callerName,
    );

    if (useUplift && upliftConnect) {
      await upliftConnect;
      if (!this.#uplift?.ready) {
        console.warn(`${this.#tag} [uplift] not ready — using OpenAI voice this call`);
        this.#uplift?.close();
        this.#uplift = null;
        useUplift = false;
      } else {
        console.log(`${this.#tag} [uplift] ready — Noor's voice via Uplift (Urdu)`);
      }
    }

    let firstAudioLogged = false;
    this.#realtime = new OpenAIRealtimeSession(instructions, {
      onAudio: (pcm24k) => {
        if (this.#closed) return; // ignore any late deltas after teardown
        this.#lastActivityAt = Date.now(); // Noor is speaking = activity
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          console.log(`${this.#tag} 🔊 first Noor audio -> caller`);
        }
        this.#enqueuePlayout(pcm24k);
      },
      onResponseStarted: () => {
        console.log(`${this.#tag} caller speaking (barge-in) — flushing playout`);
        this.#flushPlayout();
        if (this.#uplift) {
          // Drop in-flight Uplift audio + any half-buffered text, and reset the
          // resampler (the next audio is discontinuous after a flush).
          this.#uplift.cancel();
          this.#upResampler?.reset();
          this.#textBuf = '';
          this.#responseText = '';
        }
      },
      onOpen: () => console.log(`${this.#tag} OpenAI Realtime connected`),
      onTranscript: (role, text) => {
        const clean = text.trim();
        if (!clean) return;
        this.#transcript.push({ role, text: clean });
        // Real caller speech counts as activity (resets the silence timer).
        if (role === 'caller') this.#lastActivityAt = Date.now();
      },
      onResponseLatency: (ms) => {
        // Quantitative responsiveness metric — logged off the audio path.
        // (OpenAI voice path; the Uplift path logs its own in #onUpliftPcm.)
        console.log(`${this.#tag} [latency] response ${ms}ms`);
        void logResponseLatency({
          waCallId: this.callId,
          callerNumber: this.fromNumber,
          latencyMs: ms,
        }).catch(() => undefined);
      },
      // --- Uplift voice path only (no-ops when OpenAI is the voice) ---
      onSpeechStopped: () => {
        if (this.#uplift) this.#speechStoppedAt = Date.now();
      },
      onTextDelta: (delta) => {
        if (this.#closed || !this.#uplift) return;
        this.#responseText += delta;
        this.#textBuf += delta;
        const { sentences, rest } = splitSentences(this.#textBuf);
        this.#textBuf = rest;
        for (const s of sentences) {
          console.log(`${this.#tag} [uplift] speak: ${s.slice(0, 80)}`);
          this.#uplift.speak(s);
        }
      },
      onTextDone: (text) => {
        if (this.#closed || !this.#uplift) return;
        const tail = this.#textBuf.trim();
        if (tail) this.#uplift.speak(tail);
        this.#textBuf = '';
        const full = (this.#responseText || text).trim();
        this.#responseText = '';
        if (full) this.#transcript.push({ role: 'noor', text: full });
      },
      onToolCall: async (name, args) => {
        if (name === 'lookup_curriculum') {
          const grade = String(args.grade ?? '');
          const subject = String(args.subject ?? '');
          const slice = getCurriculumSlice(grade, subject);
          // Remember grade+subject so the next call injects it at connect (no
          // tool call needed then). Fire-and-forget — never blocks the response.
          const g = normalizeGrade(grade);
          const s = normalizeSubject(subject);
          if (g && s) {
            void setUserMemoryGradeSubject(this.fromNumber, g, s).catch(
              () => undefined,
            );
          }
          if (!slice) {
            return `No curriculum found for grade "${grade}" subject "${subject}". Available: Grades 1-5, subjects English, Maths, and Urdu.`;
          }
          console.log(`${this.#tag} [curriculum] served Grade ${g} ${s}`);
          return slice;
        }

        if (name === 'search_rumi_history') {
          const query = String(args.query ?? '').trim();
          const order = args.order === 'oldest' ? 'oldest' : 'newest';
          const onDate = String(args.on_date ?? '').trim() || undefined;
          // Local lookup over this caller's synced Rumi messages — no network to
          // Rumi prod, so it's fast on the live call path.
          const hits = await searchRumiHistory(this.fromNumber, {
            query: query || undefined,
            order,
            onDate,
            limit: 10,
          });
          console.log(
            `${this.#tag} [rumi] search q="${query}" order=${order} on=${onDate ?? '-'} -> ${hits.length} hits`,
          );
          if (hits.length === 0) {
            return 'No matching Rumi messages found for that.';
          }
          // Present oldest→newest for readability regardless of fetch order.
          const rows = order === 'oldest' ? hits : [...hits].reverse();
          return rows
            .map((h) => {
              const date = new Date(h.createdAt).toISOString().slice(0, 10);
              const who = h.role === 'user' ? 'They' : 'Rumi';
              return `[${date}] ${who}: ${h.content}`;
            })
            .join('\n');
        }

        if (name === 'recall_rumi') {
          const q = String(args.query ?? '').trim();
          if (!q) return 'No question given.';
          // Embed the question (one small call) for semantic recall; fall back
          // to keyword if embeddings/pgvector aren't available. Local search
          // over the caller's synced corpus — no live Rumi-prod call.
          let queryEmbedding: number[] | undefined;
          if (isVectorReady()) {
            const [e] = await embedTexts([q]);
            queryEmbedding = e ?? undefined;
          }
          const hits = await recallRumi(this.fromNumber, {
            queryEmbedding,
            queryText: q,
            limit: 6,
          });
          console.log(
            `${this.#tag} [rumi] recall "${q}" (${queryEmbedding ? 'semantic' : 'keyword'}) -> ${hits.length} hits`,
          );
          if (hits.length === 0) {
            return 'Nothing found in their Rumi history about that.';
          }
          // Truncate each record for a voice-sized tool result.
          return hits
            .map((h) => {
              const date = new Date(h.createdAt).toISOString().slice(0, 10);
              return `[${date}] (${h.kind}) ${h.content.replace(/\s+/g, ' ').slice(0, 1200)}`;
            })
            .join('\n\n');
        }

        return 'Unknown tool.';
      },
      onError: (err) => console.warn(`${this.#tag} [realtime] error`, String(err)),
      onClose: () => {
        console.log(`${this.#tag} OpenAI Realtime closed`);
        this.close();
      },
    }, useUplift ? 'text' : 'audio');
    this.#realtime.connect();

    // Fire-and-forget: pull anything this caller sent to Rumi since our last
    // sync and fold it into the live session. Runs off the call path — the
    // greeting never waits on it. The local mirror is updated regardless, so
    // search_rumi_history is fresh even if this races the greeting.
    void syncCallerDelta(this.fromNumber)
      .then((newMsgs) => {
        if (this.#closed || newMsgs.length === 0) return;
        const lines = newMsgs
          .map((m) => {
            const d = new Date(m.createdAt).toISOString().slice(0, 10);
            const who = m.role === 'user' ? 'They' : 'Rumi';
            return `[${d}] ${who}: ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`;
          })
          .join('\n');
        this.#realtime?.appendInstructions(
          `# Update — the caller ALSO just chatted with Rumi, newer than the history above:\n${lines}\n` +
            `This is their MOST RECENT Rumi activity — treat it as the latest.`,
        );
        console.log(`${this.#tag} [rumi-delta] folded ${newMsgs.length} new msg(s) into session`);
      })
      .catch(() => undefined);

    // Incoming audio (caller -> Noor).
    pc.ontrack = (event: any) => {
      const [track] = event.streams?.[0]?.getAudioTracks?.() ?? [event.track];
      if (!track) return;
      this.#sink = new RTCAudioSink(track);
      let firstCallerAudioLogged = false;
      this.#sink.ondata = (data: {
        samples: Int16Array;
        sampleRate: number;
        channelCount?: number;
      }) => {
        if (this.#closed || !this.#realtime) return;
        if (!firstCallerAudioLogged) {
          firstCallerAudioLogged = true;
          console.log(
            `${this.#tag} 🎙 first caller audio -> OpenAI ` +
              `(${data.sampleRate}Hz x${data.channelCount ?? 1}ch)`,
          );
        }
        // Downmix any stereo to mono, then resample from the ACTUAL input rate
        // (16 kHz in practice) to OpenAI's 24 kHz.
        const mono = downmixToMono(data.samples, data.channelCount ?? 1);
        // Track loudest recent incoming frame (RMS) — diagnostic for whether
        // Meta sends silence vs noise after a caller drop.
        let sumSq = 0;
        for (let i = 0; i < mono.length; i += 1) sumSq += mono[i] * mono[i];
        const rms = mono.length ? Math.sqrt(sumSq / mono.length) : 0;
        if (rms > this.#peakRmsSinceTick) this.#peakRmsSinceTick = rms;
        const pcm24k = resampleLinear(mono, data.sampleRate, OPENAI_RATE);
        this.#realtime.appendAudio(pcm24k);
      };
    };

    pc.oniceconnectionstatechange = () =>
      console.log(`${this.#tag} ICE state: ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`${this.#tag} peer state: ${state}`);
      if (state === 'connected') {
        // (Re)connected — cancel any pending disconnect grace.
        if (this.#disconnectTimer) {
          clearTimeout(this.#disconnectTimer);
          this.#disconnectTimer = null;
        }
        return;
      }
      if (state === 'failed' || state === 'closed') {
        this.close(); // definite drop / already tearing down
        return;
      }
      if (state === 'disconnected' && !this.#disconnectTimer) {
        // Might be a brief blip — wait; close only if it doesn't recover.
        this.#disconnectTimer = setTimeout(() => {
          console.warn(`${this.#tag} still disconnected after grace — closing`);
          this.close();
        }, DISCONNECT_GRACE_MS);
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.#waitForIceGathering(pc);

    this.#lastActivityAt = Date.now(); // start the silence countdown
    this.#startPlayout();
    this.#startWatchdog();
    return pc.localDescription.sdp as string;
  }

  /**
   * Ends the call after NO_INPUT_MS of MUTUAL silence — neither the caller nor
   * Noor has produced speech. This is the reliable "caller gone" signal here:
   * WhatsApp relays audio continuously and ICE stays connected, so neither can
   * detect a drop, but a dropped call goes fully silent. A caller who is just
   * listening to Noor is NOT silence (Noor speaking resets the timer), so a live
   * call is never cut. Each tick logs peak incoming RMS to reveal what Meta
   * relays after a drop (silence vs noise).
   */
  #startWatchdog(): void {
    this.#watchdog = setInterval(() => {
      if (this.#closed) return;
      const silenceMs = Date.now() - this.#lastActivityAt;
      const peakRms = Math.round(this.#peakRmsSinceTick);
      this.#peakRmsSinceTick = 0;
      console.log(
        `${this.#tag} [watchdog] silence=${Math.round(silenceMs / 1000)}s peakRms=${peakRms}`,
      );
      if (silenceMs >= NO_INPUT_MS) {
        console.warn(
          `${this.#tag} ${Math.round(silenceMs / 1000)}s of mutual silence — ending call`,
        );
        void terminateCall(this.callId).catch(() => undefined);
        this.close();
      }
    }, WATCHDOG_TICK_MS);
  }

  /** Uplift TTS audio (22.05 kHz) → resample to 24 kHz → same playout path as
   *  the OpenAI voice. Also counts as Noor activity and times response latency. */
  #onUpliftPcm(pcm22k: Int16Array): void {
    if (this.#closed) return;
    this.#lastActivityAt = Date.now(); // Noor is speaking = activity
    if (this.#speechStoppedAt) {
      const ms = Date.now() - this.#speechStoppedAt;
      this.#speechStoppedAt = 0;
      console.log(`${this.#tag} [latency] response ${ms}ms`);
      void logResponseLatency({
        waCallId: this.callId,
        callerNumber: this.fromNumber,
        latencyMs: ms,
      }).catch(() => undefined);
    }
    // Stateful resample straight to 48 kHz (continuous across chunks — no clicks).
    if (this.#upResampler) this.#pushPlayout48(this.#upResampler.process(pcm22k));
  }

  #enqueuePlayout(pcm24k: Int16Array): void {
    this.#pushPlayout48(upsample24to48(pcm24k));
  }

  #pushPlayout48(pcm48k: Int16Array): void {
    if (pcm48k.length === 0) return;
    this.#chunks.push(pcm48k);
    this.#buffered += pcm48k.length;
    // Drop oldest audio if we've buffered more than the cap (bounds latency).
    while (this.#buffered > MAX_PLAYOUT_SAMPLES && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift()!;
      this.#buffered -= dropped.length - this.#head;
      this.#head = 0;
    }
  }

  #flushPlayout(): void {
    this.#chunks = [];
    this.#head = 0;
    this.#buffered = 0;
    this.#playing = false;
  }

  #emitSilence(): void {
    this.#audioSource.onData({
      samples: new Int16Array(FRAME_SAMPLES_48K),
      sampleRate: WHATSAPP_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: FRAME_SAMPLES_48K,
    });
  }

  /** Emit one 480-sample (10ms) frame per tick; pad with silence when idle. */
  #startPlayout(): void {
    this.#playoutTimer = setInterval(() => {
      if (this.#closed || !this.#audioSource) return;

      // Jitter buffer: hold playback (send silence) until enough audio is queued,
      // and re-arm the cushion after an underrun.
      if (!this.#playing) {
        if (this.#buffered >= PREBUFFER_SAMPLES) {
          this.#playing = true;
        } else {
          this.#emitSilence();
          return;
        }
      } else if (this.#buffered === 0) {
        this.#playing = false;
        this.#emitSilence();
        return;
      }

      const frame = new Int16Array(FRAME_SAMPLES_48K);
      let filled = 0;
      while (filled < FRAME_SAMPLES_48K && this.#chunks.length > 0) {
        const chunk = this.#chunks[0];
        const avail = chunk.length - this.#head;
        const need = FRAME_SAMPLES_48K - filled;
        const n = Math.min(avail, need);
        frame.set(chunk.subarray(this.#head, this.#head + n), filled);
        filled += n;
        this.#head += n;
        this.#buffered -= n;
        if (this.#head >= chunk.length) {
          this.#chunks.shift();
          this.#head = 0;
        }
      }
      this.#audioSource.onData({
        samples: frame,
        sampleRate: WHATSAPP_RATE,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: FRAME_SAMPLES_48K,
      });
    }, FRAME_MS);
  }

  #waitForIceGathering(pc: any): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener?.('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener?.('icegatheringstatechange', check);
      setTimeout(resolve, 2000);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#disconnectTimer) clearTimeout(this.#disconnectTimer);
    this.#disconnectTimer = null;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
    if (this.#playoutTimer) clearInterval(this.#playoutTimer);
    this.#playoutTimer = null;
    this.#flushPlayout();
    try {
      this.#sink?.stop();
    } catch {
      /* noop */
    }
    this.#realtime?.close();
    this.#realtime = null;
    try {
      this.#uplift?.close();
    } catch {
      /* noop */
    }
    this.#uplift = null;
    try {
      this.#pc?.close();
    } catch {
      /* noop */
    }
    this.#pc = null;
    this.#audioSource = null;
    this.#sink = null;
    try {
      this.onClose?.();
    } catch {
      /* noop */
    }
  }
}
