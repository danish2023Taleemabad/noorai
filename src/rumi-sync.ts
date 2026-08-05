import pg from 'pg';
import { config } from './config.js';
import { getPool, dbEnabled } from './db.js';

/**
 * Rumi history sync (Option A).
 *
 * A background job that reads the caller base from the Rumi chatbot's
 * production Postgres (READ-ONLY) and mirrors, into Noor's OWN database:
 *   - `rumi_profile` — one row per phone: pre-aggregated stats + a bounded
 *     LLM summary of their Rumi conversations (injected at connect).
 *   - `rumi_message` — a local copy of their messages, full-text indexed, so the
 *     `search_rumi_history` tool can answer about a year-old conversation with a
 *     LOCAL query (no Rumi prod call on the live path).
 *
 * The live call path NEVER touches Rumi prod — only Noor's local copy. So call
 * latency is unchanged; this job runs entirely off the call path.
 *
 * Safe no-op if RUMI_DB_USER/PASSWORD aren't set or Noor's DB is disabled.
 */

const rumiEnabled = (): boolean =>
  Boolean(config.rumi.user && config.rumi.password);

const MSG_BATCH = 2000;
const UPSERT_CHUNK = 500;
const SUMMARY_MAX_CHARS = 1200;
const SUMMARY_SRC_MESSAGES = 80;

let running = false;

const newRumiClient = (): pg.Client =>
  new pg.Client({
    host: config.rumi.host,
    port: config.rumi.port,
    user: config.rumi.user,
    password: config.rumi.password,
    database: config.rumi.database,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });

const flattenJson = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (Array.isArray(v)) return v.map(String).join(', ') || null;
  if (typeof v === 'object') return Object.values(v as object).map(String).join(', ') || null;
  return String(v);
};

// ---- watermarks (stored in Noor's sync_state) ----

const getState = async (key: string): Promise<string | null> => {
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query('SELECT value FROM sync_state WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
};
const setState = async (key: string, value: string): Promise<void> => {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
};

// ---- profile sync (full pull each run — the users table is small) ----

/** count + last date per user_id from a child table (users.* counts are stale). */
async function aggByUser(
  rumi: pg.Client,
  table: string,
): Promise<Map<string, { n: number; last: Date | null }>> {
  const m = new Map<string, { n: number; last: Date | null }>();
  try {
    const r = await rumi.query(
      `SELECT user_id, count(*)::int n, max(created_at) last FROM ${table} GROUP BY user_id`,
    );
    for (const row of r.rows) m.set(row.user_id, { n: row.n, last: row.last });
  } catch (err) {
    console.warn(`[rumi-sync] agg ${table} skipped:`, String(err).slice(0, 100));
  }
  return m;
}

async function syncProfiles(rumi: pg.Client): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  // Real activity counts/dates, computed fresh (Rumi's users.* pre-aggregated
  // columns are frozen at signup — verified stale).
  const [lp, coaching, reading, quiz] = await Promise.all([
    aggByUser(rumi, 'lesson_plans'),
    aggByUser(rumi, 'coaching_sessions'),
    aggByUser(rumi, 'reading_assessments'),
    aggByUser(rumi, 'quiz_sessions'),
  ]);

  const res = await rumi.query(`
    SELECT id, phone_number, COALESCE(name, first_name) AS name, grades_taught,
           subjects_taught, region, organization, preferred_language
      FROM users
     WHERE phone_number IS NOT NULL AND COALESCE(is_test_user, false) = false
  `);
  const z = { n: 0, last: null as Date | null };
  for (const u of res.rows) {
    const a = lp.get(u.id) ?? z;
    const co = coaching.get(u.id) ?? z;
    const rd = reading.get(u.id) ?? z;
    const qz = quiz.get(u.id) ?? z;
    await pool.query(
      `INSERT INTO rumi_profile (
         phone_number, rumi_user_id, name, grades_taught, subjects_taught, region,
         organization, preferred_language, lesson_plans_count, lesson_plans_last_at,
         coaching_sessions_count, coaching_sessions_last_at,
         reading_assessments_count, quizzes_count, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (phone_number) DO UPDATE SET
         rumi_user_id = EXCLUDED.rumi_user_id, name = EXCLUDED.name,
         grades_taught = EXCLUDED.grades_taught, subjects_taught = EXCLUDED.subjects_taught,
         region = EXCLUDED.region, organization = EXCLUDED.organization,
         preferred_language = EXCLUDED.preferred_language,
         lesson_plans_count = EXCLUDED.lesson_plans_count,
         lesson_plans_last_at = EXCLUDED.lesson_plans_last_at,
         coaching_sessions_count = EXCLUDED.coaching_sessions_count,
         coaching_sessions_last_at = EXCLUDED.coaching_sessions_last_at,
         reading_assessments_count = EXCLUDED.reading_assessments_count,
         quizzes_count = EXCLUDED.quizzes_count, synced_at = now()`,
      [
        u.phone_number, u.id, u.name, flattenJson(u.grades_taught),
        flattenJson(u.subjects_taught), u.region, u.organization, u.preferred_language,
        a.n, a.last, co.n, co.last, rd.n, qz.n,
      ],
    );
  }
  console.log(`[rumi-sync] profiles upserted: ${res.rows.length}`);
}

/** Set accurate recency/volume on each profile from the synced messages. */
async function refreshMessageStats(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    UPDATE rumi_profile p SET
      last_message_at = s.mx,
      message_count = s.n
    FROM (SELECT phone_number, max(created_at) mx, count(*)::int n
            FROM rumi_message GROUP BY phone_number) s
    WHERE p.phone_number = s.phone_number
  `);
}

// ---- message sync (incremental, keyset paginated by (created_at, id)) ----

async function syncMessages(rumi: pg.Client): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  let wmAt = await getState('rumi_msg_wm_at');
  let wmId = await getState('rumi_msg_wm_id');
  let total = 0;

  for (;;) {
    const first = wmAt == null;
    const res = await rumi.query(
      `SELECT c.id, u.phone_number, c.role, c.content, c.message_type, c.created_at
         FROM conversations c
         JOIN users u ON u.id = c.user_id
        WHERE u.phone_number IS NOT NULL
          AND COALESCE(u.is_test_user, false) = false
          ${first ? '' : 'AND (c.created_at, c.id) > ($1::timestamp, $2::uuid)'}
        ORDER BY c.created_at, c.id
        LIMIT ${MSG_BATCH}`,
      first ? [] : [wmAt, wmId],
    );
    if (res.rows.length === 0) break;

    for (let i = 0; i < res.rows.length; i += UPSERT_CHUNK) {
      const chunk = res.rows.slice(i, i + UPSERT_CHUNK);
      const vals: unknown[] = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 6;
        vals.push(r.id, r.phone_number, r.role, r.content, r.message_type, r.created_at);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
      });
      await pool.query(
        `INSERT INTO rumi_message (id, phone_number, role, content, message_type, created_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
        vals,
      );
    }

    const last = res.rows[res.rows.length - 1];
    wmAt = new Date(last.created_at).toISOString();
    wmId = String(last.id);
    await setState('rumi_msg_wm_at', wmAt);
    await setState('rumi_msg_wm_id', wmId);
    total += res.rows.length;
    if (res.rows.length < MSG_BATCH) break;
  }
  console.log(`[rumi-sync] messages synced this run: ${total}`);
}

// ---- summaries (bounded, capped per run, most-active first) ----

async function summarizeProfiles(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  // Callers whose summary is missing or stale — prioritised by REAL recency
  // (last_message_at from synced messages; users.last_activity_at is stale).
  const due = await pool.query(
    `SELECT phone_number FROM rumi_profile
      WHERE last_message_at IS NOT NULL
        AND (summary IS NULL OR summary_at IS NULL OR summary_at < last_message_at)
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $1`,
    [config.rumi.summaryCap],
  );
  let done = 0;
  for (const row of due.rows) {
    const phone = row.phone_number as string;
    const msgs = await pool.query(
      `SELECT role, content FROM rumi_message
        WHERE phone_number = $1 AND content <> ''
        ORDER BY created_at DESC LIMIT $2`,
      [phone, SUMMARY_SRC_MESSAGES],
    );
    if (msgs.rows.length === 0) continue;
    const transcript = msgs.rows
      .reverse()
      .map((m) => `${m.role === 'user' ? 'Teacher' : 'Rumi'}: ${m.content}`)
      .join('\n')
      .slice(0, 12_000);
    const summary = await summarize(transcript);
    if (!summary) continue;
    await pool.query(
      `UPDATE rumi_profile SET summary = $2, summary_at = now() WHERE phone_number = $1`,
      [phone, summary.slice(0, SUMMARY_MAX_CHARS)],
    );
    done += 1;
  }
  console.log(`[rumi-sync] summaries generated: ${done}`);
}

const SUMMARY_SYSTEM = `You summarize a teacher/student's past chats with "Rumi" (a WhatsApp education assistant) so a voice assistant named Noor can recall them on a call.
Keep only durable, useful facts: who they are (teacher/student, grade & subject taught, school if stated), what they repeatedly ask Rumi about, notable requests (lesson plans, coaching, reading, quizzes), and any open/unresolved threads.
Drop greetings, menu taps, and one-off noise. Terse bullet points. HARD LIMIT ${SUMMARY_MAX_CHARS} characters. Output ONLY the summary.`;

async function summarize(transcript: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openai.memoryModel,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!res.ok) {
      console.warn('[rumi-sync] summarizer HTTP', res.status);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[rumi-sync] summarize failed:', String(err));
    return null;
  }
}

/** Run one full sync pass. Never throws. */
export async function runRumiSync(): Promise<void> {
  if (!rumiEnabled()) {
    console.log('[rumi-sync] RUMI_DB_USER/PASSWORD not set — Rumi history disabled');
    return;
  }
  if (!dbEnabled()) {
    console.log('[rumi-sync] Noor DATABASE_URL not set — cannot store Rumi history');
    return;
  }
  if (running) {
    console.log('[rumi-sync] previous run still in progress — skipping');
    return;
  }
  running = true;
  const rumi = newRumiClient();
  const startedAt = Date.now();
  try {
    await rumi.connect();
    await syncProfiles(rumi);
    await syncMessages(rumi);
    await refreshMessageStats();
    await summarizeProfiles();
    console.log(`[rumi-sync] done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    console.warn('[rumi-sync] run failed:', String(err));
  } finally {
    try {
      await rumi.end();
    } catch {
      /* noop */
    }
    running = false;
  }
}

/**
 * Start the background scheduler: first run ~30s after boot (off the cold-start
 * path), then every RUMI_SYNC_INTERVAL_MINUTES. No-op if Rumi isn't configured.
 */
export function startRumiSyncScheduler(): void {
  if (!rumiEnabled()) {
    console.log('[rumi-sync] disabled (no RUMI_DB creds)');
    return;
  }
  const intervalMs = Math.max(5, config.rumi.syncIntervalMinutes) * 60_000;
  setTimeout(() => {
    void runRumiSync();
    setInterval(() => void runRumiSync(), intervalMs);
  }, 30_000);
  console.log(
    `[rumi-sync] scheduled — first run in 30s, then every ${config.rumi.syncIntervalMinutes}min`,
  );
}
