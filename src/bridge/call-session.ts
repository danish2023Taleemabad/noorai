import wrtcPkg from '@roamhq/wrtc';
import { config } from '../config.js';
import { OpenAIRealtimeSession } from './openai-realtime.js';
import { buildNoorContext } from '../context/build-noor-context.js';
import {
  downmixToMono,
  resampleLinear,
  upsample24to48,
  OPENAI_RATE,
  WHATSAPP_RATE,
} from './audio.js';

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

export class CallSession {
  #pc: InstanceType<typeof RTCPeerConnection> | null = null;
  #realtime: OpenAIRealtimeSession | null = null;
  #audioSource: any = null;
  #sink: any = null;

  // Playout buffer: a queue of 48 kHz PCM16 chunks + a read head into chunk[0].
  // Chunk-based (not per-sample) so draining is O(frame), never O(n) — the
  // per-sample Array.shift() approach was O(n²) and stuttered the audio.
  #chunks: Int16Array[] = [];
  #head = 0;
  #buffered = 0;
  #playing = false; // false = waiting for the jitter buffer to fill
  #playoutTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(
    public readonly callId: string,
    public readonly fromNumber: string,
    public readonly callerName?: string,
  ) {}

  get #tag(): string {
    return `[call ${this.callId}]`;
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

    const { instructions } = await buildNoorContext(
      this.fromNumber,
      this.callerName,
    );
    let firstAudioLogged = false;
    this.#realtime = new OpenAIRealtimeSession(instructions, {
      onAudio: (pcm24k) => {
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          console.log(`${this.#tag} 🔊 first Noor audio -> caller`);
        }
        this.#enqueuePlayout(pcm24k);
      },
      onResponseStarted: () => {
        console.log(`${this.#tag} caller speaking (barge-in) — flushing playout`);
        this.#flushPlayout();
      },
      onOpen: () => console.log(`${this.#tag} OpenAI Realtime connected`),
      onError: (err) => console.warn(`${this.#tag} [realtime] error`, String(err)),
      onClose: () => {
        console.log(`${this.#tag} OpenAI Realtime closed`);
        this.close();
      },
    });
    this.#realtime.connect();

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
        const pcm24k = resampleLinear(mono, data.sampleRate, OPENAI_RATE);
        this.#realtime.appendAudio(pcm24k);
      };
    };

    pc.oniceconnectionstatechange = () =>
      console.log(`${this.#tag} ICE state: ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`${this.#tag} peer state: ${state}`);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.close();
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.#waitForIceGathering(pc);

    this.#startPlayout();
    return pc.localDescription.sdp as string;
  }

  #enqueuePlayout(pcm24k: Int16Array): void {
    const pcm48k = upsample24to48(pcm24k);
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
    if (this.#playoutTimer) clearInterval(this.#playoutTimer);
    this.#playoutTimer = null;
    this.#flushPlayout();
    try {
      this.#sink?.stop();
    } catch {
      /* noop */
    }
    this.#realtime?.close();
    try {
      this.#pc?.close();
    } catch {
      /* noop */
    }
    this.#pc = null;
  }
}
