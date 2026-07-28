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
  console.log('[db] connected — call logging + memory enabled');
};

/** Returns the caller's rolling memory summary, or null if none/DB off. */
export const getUserMemory = async (
  callerNumber: string,
): Promise<{ summary: string; callCount: number } | null> => {
  if (!pool || !callerNumber) return null;
  try {
    const res = await pool.query(
      `SELECT summary, call_count FROM user_memory WHERE caller_number = $1`,
      [callerNumber],
    );
    if (res.rows.length === 0) return null;
    return { summary: res.rows[0].summary, callCount: res.rows[0].call_count };
  } catch (err) {
    console.warn('[db] getUserMemory failed:', String(err));
    return null;
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
