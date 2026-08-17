/**
 * PCM16 mono resampling + base64 helpers to bridge audio between:
 *   - WhatsApp WebRTC (via @roamhq/wrtc): 16-bit PCM, 48 kHz mono
 *   - OpenAI Realtime API: 16-bit PCM ("pcm16"), 24 kHz mono, base64
 *
 * Simple 2:1 / 1:2 conversions (48k <-> 24k). Downsample averages sample pairs
 * to reduce aliasing; upsample linearly interpolates.
 */

export const WHATSAPP_RATE = 48000;
export const OPENAI_RATE = 24000;

/** 48 kHz -> 24 kHz: average each pair of samples. */
export const downsample48to24 = (input: Int16Array): Int16Array => {
  const out = new Int16Array(Math.floor(input.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j += 1) {
    out[j] = ((input[i] + input[i + 1]) / 2) | 0;
  }
  return out;
};

/** 24 kHz -> 48 kHz: linear interpolation between samples. */
export const upsample24to48 = (input: Int16Array): Int16Array => {
  if (input.length === 0) return new Int16Array(0);
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const next = i + 1 < input.length ? input[i + 1] : current;
    out[i * 2] = current;
    out[i * 2 + 1] = ((current + next) / 2) | 0;
  }
  return out;
};

/**
 * General linear-interpolation resampler (any rate -> any rate). WhatsApp's
 * decoded PCM has come through at 16 kHz in practice (not the 48 kHz the SDP
 * advertises), so a fixed 48->24 conversion is wrong — resample by actual rate.
 */
export const resampleLinear = (
  input: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array => {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(0, Math.floor(input.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = (a + (b - a) * frac) | 0;
  }
  return out;
};

/**
 * Stateful streaming linear resampler. Unlike `resampleLinear`, this carries the
 * fractional read position and the previous chunk's last sample across calls, so
 * back-to-back chunks resample WITHOUT a discontinuity (click) at each boundary.
 * Use one instance per continuous audio stream (e.g. Uplift TTS -> 48 kHz).
 */
export class StreamResampler {
  #step: number; // input samples advanced per output sample
  #cursor = 0; // fractional read position; 0 == the previous chunk's last sample
  #prev = 0; // last sample of the previous chunk
  #primed = false;

  constructor(fromRate: number, toRate: number) {
    this.#step = fromRate / toRate;
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    // Virtual data = [prev, ...input] once primed, so interpolation can bridge
    // the boundary between the previous chunk and this one.
    let data: Int16Array;
    if (this.#primed) {
      data = new Int16Array(input.length + 1);
      data[0] = this.#prev;
      data.set(input, 1);
    } else {
      data = input;
    }
    const out: number[] = [];
    let c = this.#cursor;
    const last = data.length - 1;
    while (c <= last) {
      const i = Math.floor(c);
      const f = c - i;
      const a = data[i];
      const b = i + 1 <= last ? data[i + 1] : a;
      out.push((a + (b - a) * f) | 0);
      c += this.#step;
    }
    this.#cursor = c - last; // leftover, relative to this chunk's last sample
    this.#prev = data[last];
    this.#primed = true;
    return Int16Array.from(out);
  }

  /** Reset continuity (e.g. after a barge-in flush, where audio is discontinuous). */
  reset(): void {
    this.#cursor = 0;
    this.#prev = 0;
    this.#primed = false;
  }
}

/** Interleaved stereo -> mono by averaging L/R. Returns input unchanged if mono. */
export const downmixToMono = (
  samples: Int16Array,
  channelCount: number,
): Int16Array => {
  if (channelCount <= 1) return samples;
  const out = new Int16Array(Math.floor(samples.length / channelCount));
  for (let i = 0, j = 0; j < out.length; i += channelCount, j += 1) {
    let sum = 0;
    for (let c = 0; c < channelCount; c += 1) sum += samples[i + c];
    out[j] = (sum / channelCount) | 0;
  }
  return out;
};

export const int16ToBase64 = (samples: Int16Array): string =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
    'base64',
  );

export const base64ToInt16 = (b64: string): Int16Array => {
  const buf = Buffer.from(b64, 'base64');
  // Copy into a fresh, correctly-aligned buffer before viewing as Int16.
  const aligned = new ArrayBuffer(buf.length);
  new Uint8Array(aligned).set(buf);
  return new Int16Array(aligned, 0, Math.floor(buf.length / 2));
};
