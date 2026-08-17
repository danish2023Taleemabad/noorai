import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Background ambience mixed into the outgoing call audio (48 kHz mono):
 *   - OFFICE chatter — plays constantly, low volume, for the whole call.
 *   - KEYBOARD typing — plays only while Noor is looking something up.
 *
 * The PCM assets are pre-decoded (see assets/*.pcm) so there's no runtime audio
 * decoding. Loaded once at boot; each call gets its own AmbienceMixer (own read
 * positions + typing state) sharing the read-only PCM.
 */

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

let officePcm: Int16Array | null = null;
let keyboardPcm: Int16Array | null = null;
let loaded = false;

const readPcm = (file: string): Int16Array | null => {
  try {
    const buf = fs.readFileSync(path.join(assetsDir, file));
    const pcm = new Int16Array(buf.length >> 1);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = buf.readInt16LE(i * 2);
    return pcm.length ? pcm : null;
  } catch {
    return null;
  }
};

/** Load ambience PCM once at boot. No-op / disabled if assets or flag absent. */
export const loadAmbience = (): void => {
  if (!config.ambience.enabled) {
    console.log('[ambience] disabled (AMBIENCE_ENABLED=false)');
    return;
  }
  officePcm = readPcm('office-48k-mono.pcm');
  keyboardPcm = readPcm('keyboard-48k-mono.pcm');
  loaded = Boolean(officePcm || keyboardPcm);
  console.log(
    loaded
      ? `[ambience] loaded (office=${Boolean(officePcm)} keyboard=${Boolean(keyboardPcm)})`
      : '[ambience] no assets found — disabled',
  );
};

export const ambienceReady = (): boolean => loaded;

export class AmbienceMixer {
  #officePos = 0;
  #kbPos = 0;
  #typing = false;
  #typingTimer: NodeJS.Timeout | null = null;

  /** Turn the keyboard-typing layer on/off (on while Noor searches). */
  setTyping(on: boolean): void {
    if (this.#typingTimer) {
      clearTimeout(this.#typingTimer);
      this.#typingTimer = null;
    }
    this.#typing = on && Boolean(keyboardPcm);
    if (this.#typing) {
      this.#kbPos = 0; // start the typing loop fresh
      // Safety: never let typing linger if no audio follows the lookup.
      this.#typingTimer = setTimeout(() => {
        this.#typing = false;
      }, 12_000);
    }
  }

  /** Mix ambience into a 48 kHz mono frame in place. Office is always on. */
  mixInto(frame: Int16Array): void {
    const ov = config.ambience.officeVolume;
    const kv = config.ambience.keyboardVolume;
    const office = officePcm;
    const kb = keyboardPcm;
    for (let i = 0; i < frame.length; i += 1) {
      let s = frame[i];
      if (office && ov > 0) {
        s += office[this.#officePos] * ov;
        this.#officePos += 1;
        if (this.#officePos >= office.length) this.#officePos = 0;
      }
      if (this.#typing && kb && kv > 0) {
        s += kb[this.#kbPos] * kv;
        this.#kbPos += 1;
        if (this.#kbPos >= kb.length) this.#kbPos = 0;
      }
      frame[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s | 0;
    }
  }

  dispose(): void {
    if (this.#typingTimer) clearTimeout(this.#typingTimer);
    this.#typingTimer = null;
  }
}
