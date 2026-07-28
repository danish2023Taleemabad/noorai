import { config } from './config.js';
import { dbEnabled, getUserMemory, upsertUserMemory } from './db.js';

/**
 * Per-caller long-term memory. After a call ends, we fold that call's transcript
 * into a BOUNDED rolling summary (rewritten, not appended, so it never grows).
 * The summary is injected into Noor's system prompt at the START of the next
 * call — so Noor "remembers" the caller with zero impact on live latency.
 *
 * This runs AFTER the call (off the critical path), so nobody waits on it.
 */

// Hard cap on the stored memory so the injected prompt stays small forever.
const MAX_MEMORY_CHARS = 1500;

const SYSTEM_PROMPT = `You maintain a concise, durable MEMORY PROFILE of a caller for a friendly voice assistant named Noor (used by teachers and students in Pakistan).
You are given the EXISTING MEMORY and a NEW CALL TRANSCRIPT. Output an UPDATED memory profile that MERGES them.
Keep only durable, reusable facts: who the caller is (teacher or student, name, grade/subject/school if known), recurring topics, stated preferences, and any unresolved or ongoing items to follow up on.
DROP small talk, greetings, and one-off trivia. Prefer terse bullet points.
HARD LIMIT: ${MAX_MEMORY_CHARS} characters. If over, keep the most important/durable facts and drop the rest.
Output ONLY the updated memory text — no preamble, no explanations.`;

/**
 * Summarize a finished call into the caller's rolling memory. Fire-and-forget;
 * safe no-op if the DB is disabled. Never throws to the caller.
 */
export const summarizeAndStore = async (
  callerNumber: string,
  transcript: string,
): Promise<void> => {
  if (!dbEnabled() || !callerNumber || !transcript.trim()) return;

  try {
    const existing = await getUserMemory(callerNumber);
    const existingSummary = existing?.summary?.trim() || '(none yet)';

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openai.memoryModel,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `EXISTING MEMORY:\n${existingSummary}\n\nNEW CALL TRANSCRIPT:\n${transcript}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.warn('[memory] summarizer HTTP', res.status);
      return;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    let summary = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!summary) return;
    if (summary.length > MAX_MEMORY_CHARS) {
      summary = `${summary.slice(0, MAX_MEMORY_CHARS)}…`;
    }

    await upsertUserMemory(callerNumber, summary);
    console.log(`[memory] updated for ${callerNumber} (${summary.length} chars)`);
  } catch (err) {
    console.warn('[memory] summarizeAndStore failed:', String(err));
  }
};
