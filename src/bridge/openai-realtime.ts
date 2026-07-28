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
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

export class OpenAIRealtimeSession {
  #ws: WebSocket | null = null;
  #ready = false;

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

    this.#send({ type: 'session.update', session });
    this.#ready = true;

    // Greet first so the caller hears Noor immediately after connect.
    this.#send({ type: 'response.create' });
  }

  #onMessage(raw: unknown): void {
    let evt: { type?: string; delta?: string; transcript?: string };
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
      case 'error':
        this.cb.onError?.(String(raw));
        break;
      default:
        break;
    }
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
