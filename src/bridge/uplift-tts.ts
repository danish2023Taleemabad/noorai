import { io, type Socket } from 'socket.io-client';
import { config } from '../config.js';

/**
 * Uplift AI streaming TTS over Socket.io — Noor's "mouth" on the `uplift` voice
 * path. We send text (sentence by sentence) and receive PCM 22.05 kHz / 16-bit
 * audio chunks. Used ONLY when VOICE_PROVIDER=uplift; the default OpenAI voice
 * path never touches this.
 *
 * Protocol (docs.upliftai.org/websocket-tts):
 *   connect  → server emits `message {type:'ready'}`
 *   emit 'synthesize' {type, requestId, text, voiceId, outputFormat}
 *   server  → `message {type:'audio_start'|'audio'|'audio_end', requestId, ...}`
 */

export const UPLIFT_RATE = 22050;

export interface UpliftCallbacks {
  /** 22.05 kHz PCM16 audio for a currently-active synthesis request. */
  onPcm: (pcm: Int16Array) => void;
  onError?: (err: unknown) => void;
}

export class UpliftTtsSession {
  #socket: Socket | null = null;
  #ready = false;
  #seq = 0;
  #generation = 0; // bumped on cancel() so late chunks are ignored
  #active = new Set<string>(); // requestIds whose audio we still want
  // In-order playback: audio for sentence N is held until sentence N-1 finishes,
  // so pipelined (concurrent) synth requests never interleave/overlap.
  #order: string[] = []; // requestIds in the order we sent them
  #head = 0; // index in #order currently being played out
  #buffed = new Map<string, Int16Array[]>(); // chunks buffered for not-yet-head reqs
  #ended = new Set<string>(); // requestIds that have received audio_end

  constructor(private readonly cb: UpliftCallbacks) {}

  get ready(): boolean {
    return this.#ready;
  }

  /** Connect + wait until the session is ready. Resolves (never rejects) so the
   *  caller can check `ready` and fall back to the OpenAI voice on failure. */
  connect(): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const socket = io(config.uplift.wsUrl, {
          auth: { token: config.uplift.apiKey },
          transports: ['websocket'],
        });
        this.#socket = socket;
        socket.on('message', (m: { type?: string; requestId?: string; audio?: string }) => {
          if (!m) return;
          if (m.type === 'ready') {
            this.#ready = true;
            finish();
          } else if (m.type === 'audio' && m.audio && m.requestId && this.#active.has(m.requestId)) {
            const buf = Buffer.from(m.audio, 'base64');
            if (buf.length >= 2) {
              // Copy into an aligned Int16Array (little-endian PCM16).
              const pcm = new Int16Array(buf.length >> 1);
              for (let i = 0; i < pcm.length; i += 1) pcm[i] = buf.readInt16LE(i * 2);
              if (this.#order[this.#head] === m.requestId) {
                this.cb.onPcm(pcm); // this sentence is the one currently playing
              } else {
                // A later sentence finished early — hold its audio in order.
                const arr = this.#buffed.get(m.requestId) ?? [];
                arr.push(pcm);
                this.#buffed.set(m.requestId, arr);
              }
            }
          } else if (m.type === 'audio_end' && m.requestId) {
            this.#ended.add(m.requestId);
            this.#drain();
          }
        });
        socket.on('connect_error', (e) => {
          this.cb.onError?.(e);
          finish();
        });
        socket.on('error', (e) => this.cb.onError?.(e));
      } catch (err) {
        this.cb.onError?.(err);
        finish();
      }
      // Never hang call setup waiting on TTS.
      setTimeout(finish, 5000);
    });
  }

  /** Queue a piece of text to speak. Audio arrives via onPcm, in send order. */
  speak(text: string): void {
    if (!this.#ready || !this.#socket || !text.trim()) return;
    const requestId = `g${this.#generation}_${this.#seq}`;
    this.#seq += 1;
    this.#active.add(requestId);
    this.#order.push(requestId);
    this.#socket.emit('synthesize', {
      type: 'synthesize',
      requestId,
      text,
      voiceId: config.uplift.voiceId,
      outputFormat: 'PCM_22050_16',
    });
  }

  /** Advance playback in send order, flushing any buffered audio for the new
   *  head and skipping past finished sentences. */
  #drain(): void {
    while (this.#head < this.#order.length) {
      const id = this.#order[this.#head];
      const buffered = this.#buffed.get(id);
      if (buffered) {
        for (const c of buffered) this.cb.onPcm(c);
        this.#buffed.delete(id);
      }
      if (this.#ended.has(id)) {
        this.#head += 1; // this sentence is done — move to the next
        continue;
      }
      break; // head not finished yet — wait for more of its audio
    }
  }

  /** Barge-in: drop all in-flight + buffered audio (new requests = new generation). */
  cancel(): void {
    this.#generation += 1;
    this.#active.clear();
    this.#order = [];
    this.#head = 0;
    this.#buffed.clear();
    this.#ended.clear();
  }

  close(): void {
    try {
      this.#socket?.close();
    } catch {
      /* noop */
    }
    this.#socket = null;
    this.#ready = false;
  }
}
