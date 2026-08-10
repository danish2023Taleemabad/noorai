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
const MAX_CHARS = 6000; // keep well under the model's token limit
const BATCH = 256;

/**
 * Embed a list of texts. Returns embeddings aligned to the input (null for any
 * that failed). Never throws.
 */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts
      .slice(i, i + BATCH)
      .map((t) => (t || '').slice(0, MAX_CHARS) || ' ');
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
        console.warn('[embed] HTTP', res.status);
        continue;
      }
      const data = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
      };
      for (const d of data.data ?? []) out[i + d.index] = d.embedding;
    } catch (err) {
      console.warn('[embed] failed:', String(err).slice(0, 100));
    }
  }
  return out;
}

/** Postgres pgvector literal for an embedding array. */
export const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;
