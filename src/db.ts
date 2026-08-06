import pg from 'pg';
import { config } from './config.js';

/**
 * Postgres call-log store. Optional: if DATABASE_URL is not set, every function
 * is a safe no-op so calls keep working while the DB is being provisioned.
 *
 * One row per call in `calls`: who called (name + number), timing, duration, and
 * the full transcript (caller + Noor turns).
 */

const { Pool } = pg;

let pool: pg.Pool | null = null;

export const dbEnabled = (): boolean => Boolean(config.databaseUrl);

export const initDb = async (): Promise<void> => {
  if (!dbEnabled()) {
    console.log('[db] DATABASE_URL not set — call logging disabled');
    return;
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 4,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id            BIGSERIAL PRIMARY KEY,
      wa_call_id    TEXT UNIQUE,
      caller_name   TEXT,
      caller_number TEXT,
      started_at    TIMESTAMPTZ,
      ended_at      TIMESTAMPTZ,
      duration_seconds INTEGER,
      status        TEXT,
      transcript    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calls_number ON calls (caller_number);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (started_at);`);
  // Per-caller rolling memory (bounded summary of past calls, keyed by number).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_memory (
      caller_number TEXT PRIMARY KEY,
      summary       TEXT NOT NULL DEFAULT '',
      call_count    INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Structured grade/subject remembered per caller — lets us inject the right
  // curriculum slice at connect on their next call (added after the table
  // existed, so ADD COLUMN IF NOT EXISTS keeps older DBs working).
  await pool.query(`ALTER TABLE user_memory ADD COLUMN IF NOT EXISTS grade TEXT;`);
  await pool.query(`ALTER TABLE user_memory ADD COLUMN IF NOT EXISTS subject TEXT;`);

  // --- Rumi history (synced from the Rumi chatbot's prod DB) ---
  // A per-caller profile (pre-aggregated stats + a bounded conversation summary),
  // injected at connect; and a local mirror of their messages for the
  // search_rumi_history tool (full-text searched LOCALLY on the call path).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumi_profile (
      phone_number   TEXT PRIMARY KEY,
      rumi_user_id   TEXT,
      name           TEXT,
      grades_taught  TEXT,
      subjects_taught TEXT,
      region         TEXT,
      organization   TEXT,
      preferred_language TEXT,
      lesson_plans_count INTEGER,
      lesson_plans_last_at TIMESTAMPTZ,
      coaching_sessions_count INTEGER,
      coaching_avg_percentage NUMERIC,
      coaching_sessions_last_at TIMESTAMPTZ,
      reading_assessments_count INTEGER,
      quizzes_count  INTEGER,
      videos_count   INTEGER,
      last_activity_at TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ,
      message_count  INTEGER,
      summary        TEXT,
      summary_at     TIMESTAMPTZ,
      synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Added after the table shipped — accurate recency/volume derived from the
  // synced messages (Rumi's users.* pre-agg columns are stale).
  await pool.query(`ALTER TABLE rumi_profile ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE rumi_profile ADD COLUMN IF NOT EXISTS message_count INTEGER;`);
  await pool.query(`ALTER TABLE rumi_profile ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE rumi_profile ADD COLUMN IF NOT EXISTS first_message_text TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumi_message (
      id           TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      role         TEXT,
      content      TEXT,
      message_type TEXT,
      created_at   TIMESTAMPTZ
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_rumi_msg_phone ON rumi_message (phone_number, created_at DESC);`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_rumi_msg_fts ON rumi_message USING gin (to_tsvector('simple', content));`,
  );
  // Small key/value store for sync watermarks.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Per-response latency measurements (caller stops speaking -> Noor's first
  // audio), one row per response, for responsiveness analytics in Metabase.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS response_latency (
      id            BIGSERIAL PRIMARY KEY,
      wa_call_id    TEXT,
      caller_number TEXT,
      latency_ms    INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latency_created ON response_latency (created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latency_call ON response_latency (wa_call_id);`);
  console.log('[db] connected — call logging + memory enabled');
};

/** Returns the caller's rolling memory summary, or null if none/DB off. */
export const getUserMemory = async (
  callerNumber: string,
): Promise<{
  summary: string;
  callCount: number;
  grade: string | null;
  subject: string | null;
} | null> => {
  if (!pool || !callerNumber) return null;
  try {
    const res = await pool.query(
      `SELECT summary, call_count, grade, subject FROM user_memory WHERE caller_number = $1`,
      [callerNumber],
    );
    if (res.rows.length === 0) return null;
    return {
      summary: res.rows[0].summary,
      callCount: res.rows[0].call_count,
      grade: res.rows[0].grade ?? null,
      subject: res.rows[0].subject ?? null,
    };
  } catch (err) {
    console.warn('[db] getUserMemory failed:', String(err));
    return null;
  }
};

/**
 * Remember a caller's grade + subject (from a curriculum lookup during a call),
 * without touching their rolling summary or call count. COALESCE keeps an
 * existing value if a null is passed. Next call injects the matching slice.
 */
export const setUserMemoryGradeSubject = async (
  callerNumber: string,
  grade: string | null,
  subject: string | null,
): Promise<void> => {
  if (!pool || !callerNumber) return;
  try {
    await pool.query(
      `INSERT INTO user_memory (caller_number, grade, subject, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (caller_number) DO UPDATE
         SET grade = COALESCE(EXCLUDED.grade, user_memory.grade),
             subject = COALESCE(EXCLUDED.subject, user_memory.subject),
             updated_at = now()`,
      [callerNumber, grade, subject],
    );
  } catch (err) {
    console.warn('[db] setUserMemoryGradeSubject failed:', String(err));
  }
};

/** Upserts the caller's rolling memory summary (bumps call_count). */
export const upsertUserMemory = async (
  callerNumber: string,
  summary: string,
): Promise<void> => {
  if (!pool || !callerNumber) return;
  try {
    await pool.query(
      `INSERT INTO user_memory (caller_number, summary, call_count, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (caller_number) DO UPDATE
         SET summary = EXCLUDED.summary,
             call_count = user_memory.call_count + 1,
             updated_at = now()`,
      [callerNumber, summary],
    );
  } catch (err) {
    console.warn('[db] upsertUserMemory failed:', String(err));
  }
};

/** Records the start of a call. Idempotent on wa_call_id. */
export const logCallStart = async (row: {
  waCallId: string;
  callerName?: string;
  callerNumber?: string;
  startedAt: Date;
}): Promise<void> => {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO calls (wa_call_id, caller_name, caller_number, started_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wa_call_id) DO UPDATE
         SET caller_name = EXCLUDED.caller_name,
             caller_number = EXCLUDED.caller_number,
             started_at = EXCLUDED.started_at`,
      [row.waCallId, row.callerName ?? null, row.callerNumber ?? null, row.startedAt],
    );
  } catch (err) {
    console.warn('[db] logCallStart failed:', String(err));
  }
};

/** Finalizes a call row with end time, duration, status, and transcript. */
export const logCallEnd = async (row: {
  waCallId: string;
  endedAt: Date;
  durationSeconds?: number;
  status?: string;
  transcript?: string;
}): Promise<void> => {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE calls
         SET ended_at = $2,
             duration_seconds = $3,
             status = $4,
             transcript = $5
       WHERE wa_call_id = $1`,
      [
        row.waCallId,
        row.endedAt,
        row.durationSeconds ?? null,
        row.status ?? null,
        row.transcript ?? null,
      ],
    );
  } catch (err) {
    console.warn('[db] logCallEnd failed:', String(err));
  }
};

/**
 * Record one response-latency measurement (ms from the caller's end-of-turn to
 * Noor's first audio). Fire-and-forget; no-op if DB disabled. Never blocks.
 */
export const logResponseLatency = async (row: {
  waCallId: string;
  callerNumber?: string;
  latencyMs: number;
}): Promise<void> => {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO response_latency (wa_call_id, caller_number, latency_ms)
       VALUES ($1, $2, $3)`,
      [row.waCallId, row.callerNumber ?? null, Math.round(row.latencyMs)],
    );
  } catch (err) {
    console.warn('[db] logResponseLatency failed:', String(err));
  }
};

// ---------------------------------------------------------------------------
// Rumi history (synced from the Rumi chatbot's prod DB)
// ---------------------------------------------------------------------------

/** The live pool (or null if DB disabled) — used by the Rumi sync job. */
export const getPool = (): pg.Pool | null => pool;

export interface RumiProfile {
  name: string | null;
  gradesTaught: string | null;
  subjectsTaught: string | null;
  region: string | null;
  organization: string | null;
  preferredLanguage: string | null;
  lessonPlansCount: number | null;
  lessonPlansLastAt: Date | null;
  coachingSessionsCount: number | null;
  coachingAvgPercentage: number | null;
  coachingSessionsLastAt: Date | null;
  readingAssessmentsCount: number | null;
  quizzesCount: number | null;
  videosCount: number | null;
  lastActivityAt: Date | null;
  lastMessageAt: Date | null;
  messageCount: number | null;
  firstMessageAt: Date | null;
  firstMessageText: string | null;
  summary: string | null;
}

/** The caller's synced Rumi profile, or null if none/DB off. Local read. */
export const getRumiProfile = async (
  phoneNumber: string,
): Promise<RumiProfile | null> => {
  if (!pool || !phoneNumber) return null;
  try {
    const res = await pool.query(
      `SELECT name, grades_taught, subjects_taught, region, organization,
              preferred_language, lesson_plans_count, lesson_plans_last_at,
              coaching_sessions_count, coaching_avg_percentage,
              coaching_sessions_last_at, reading_assessments_count,
              quizzes_count, videos_count, last_activity_at,
              last_message_at, message_count, first_message_at,
              first_message_text, summary
         FROM rumi_profile WHERE phone_number = $1`,
      [phoneNumber],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      name: r.name,
      gradesTaught: r.grades_taught,
      subjectsTaught: r.subjects_taught,
      region: r.region,
      organization: r.organization,
      preferredLanguage: r.preferred_language,
      lessonPlansCount: r.lesson_plans_count,
      lessonPlansLastAt: r.lesson_plans_last_at,
      coachingSessionsCount: r.coaching_sessions_count,
      coachingAvgPercentage:
        r.coaching_avg_percentage != null ? Number(r.coaching_avg_percentage) : null,
      coachingSessionsLastAt: r.coaching_sessions_last_at,
      readingAssessmentsCount: r.reading_assessments_count,
      quizzesCount: r.quizzes_count,
      videosCount: r.videos_count,
      lastActivityAt: r.last_activity_at,
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count,
      firstMessageAt: r.first_message_at,
      firstMessageText: r.first_message_text,
      summary: r.summary,
    };
  } catch (err) {
    console.warn('[db] getRumiProfile failed:', String(err));
    return null;
  }
};

/**
 * The caller's most recent Rumi messages (newest first), for the "what did we
 * last talk about" case. Local read — safe on the call path.
 */
export const getRecentRumiMessages = async (
  phoneNumber: string,
  limit = 6,
): Promise<{ role: string; content: string; createdAt: Date }[]> => {
  if (!pool || !phoneNumber) return [];
  try {
    const res = await pool.query(
      `SELECT role, content, created_at FROM rumi_message
        WHERE phone_number = $1 AND content <> ''
        ORDER BY created_at DESC LIMIT $2`,
      [phoneNumber, limit],
    );
    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[db] getRecentRumiMessages failed:', String(err));
    return [];
  }
};

/**
 * Look up the caller's synced Rumi messages (LOCAL — safe on the call path).
 * Flexible so Noor can handle temporal questions, not just keywords:
 *   - `query`   → keyword/full-text match (optional)
 *   - `onDate`  → messages on a specific day, YYYY-MM-DD (optional)
 *   - `order`   → 'oldest' (their FIRST/earliest messages) or 'newest' (default)
 */
export const searchRumiHistory = async (
  phoneNumber: string,
  opts: {
    query?: string;
    onDate?: string;
    order?: 'oldest' | 'newest';
    limit?: number;
  } = {},
): Promise<{ role: string; content: string; createdAt: Date }[]> => {
  if (!pool || !phoneNumber) return [];
  const limit = opts.limit ?? 10;
  const params: unknown[] = [phoneNumber];
  const where = [`phone_number = $1`, `content <> ''`];
  if (opts.query && opts.query.trim()) {
    params.push(opts.query.trim());
    const p = `$${params.length}`;
    where.push(
      `(to_tsvector('simple', content) @@ plainto_tsquery('simple', ${p}) OR content ILIKE '%' || ${p} || '%')`,
    );
  }
  if (opts.onDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.onDate)) {
    params.push(opts.onDate);
    where.push(
      `created_at >= $${params.length}::date AND created_at < ($${params.length}::date + interval '1 day')`,
    );
  }
  const dir = opts.order === 'oldest' ? 'ASC' : 'DESC';
  params.push(limit);
  try {
    const res = await pool.query(
      `SELECT role, content, created_at FROM rumi_message
        WHERE ${where.join(' AND ')}
        ORDER BY created_at ${dir}
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[db] searchRumiHistory failed:', String(err));
    return [];
  }
};
