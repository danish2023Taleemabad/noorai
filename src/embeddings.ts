import { config } from './config.js';

/**
 * OpenAI embeddings for semantic recall of Rumi history.
 *
 * We use text-embedding-3-small at reduced dimensions (512) — cheap
 * ($0.02 / 1M tokens) and small to store. Retrieval always filters by the
 * caller's phone first, so a plain cosine sort over that (small) subset is fast
 * even without an ANN index.
 */

export const EMBED_DIMS = 512;
const MAX_CHARS = 6000; // per-input cap (well under the 8k-token per-input limit)
const MAX_BATCH = 256; // array-size cap
// Character budget per request — a proxy for the 300k tokens/request API limit.
// Conservative for multilingual (Urdu) text where tokens/char is higher.
const CHAR_BUDGET = 300_000;

/**
 * Embed a list of texts. Returns embeddings aligned to the input (null for any
 * that failed). Never throws. Batches by BOTH array size and total characters,
 * so a request can't blow the per-request token limit.
 */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  const clean = texts.map((t) => (t || '').slice(0, MAX_CHARS) || ' ');
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  let i = 0;
  while (i < clean.length) {
    // Grow a batch until the count or character budget would be exceeded.
    let j = i;
    let chars = 0;
    while (
      j < clean.length &&
      j - i < MAX_BATCH &&
      chars + clean[j].length <= CHAR_BUDGET
    ) {
      chars += clean[j].length;
      j += 1;
    }
    if (j === i) j = i + 1; // always make progress (single oversized input)
    const slice = clean.slice(i, j);
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.openai.embedModel,
          input: slice,
          dimensions: EMBED_DIMS,
        }),
      });
      if (!res.ok) {
        console.warn('[embed] HTTP', res.status, (await res.text()).slice(0, 200));
      } else {
        const data = (await res.json()) as {
          data?: { embedding: number[]; index: number }[];
        };
        for (const d of data.data ?? []) out[i + d.index] = d.embedding;
      }
    } catch (err) {
      console.warn('[embed] failed:', String(err).slice(0, 120));
    }
    i = j;
  }
  return out;
}

/** Postgres pgvector literal for an embedding array. */
export const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;
