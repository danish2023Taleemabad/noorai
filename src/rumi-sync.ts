import pg from 'pg';
import { config } from './config.js';
import {
  getPool,
  dbEnabled,
  isVectorReady,
  upsertRumiDoc,
  getDocsNeedingEmbedding,
  setDocEmbedding,
} from './db.js';
import { embedTexts, toVectorLiteral } from './embeddings.js';

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
  // columns are frozen at signup — verified stale). Sequential, not Promise.all:
  // a single pg.Client can only run one query at a time.
  const lp = await aggByUser(rumi, 'lesson_plans');
  const coaching = await aggByUser(rumi, 'coaching_sessions');
  const reading = await aggByUser(rumi, 'reading_assessments');
  const quiz = await aggByUser(rumi, 'quiz_sessions');

  const res = await rumi.query(`
    SELECT id, phone_number, COALESCE(name, first_name) AS name, grades_taught,
           subjects_taught, region, organization, preferred_language
      FROM users
     WHERE phone_number IS NOT NULL
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

/** Set accurate recency/volume + first-message on each profile from messages. */
async function refreshMessageStats(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    UPDATE rumi_profile p SET
      last_message_at = s.mx,
      first_message_at = s.mn,
      message_count = s.n
    FROM (SELECT phone_number, max(created_at) mx, min(created_at) mn, count(*)::int n
            FROM rumi_message GROUP BY phone_number) s
    WHERE p.phone_number = s.phone_number
  `);
  // The actual first thing they said (earliest non-empty message).
  await pool.query(`
    UPDATE rumi_profile p SET first_message_text = e.content
    FROM (SELECT DISTINCT ON (phone_number) phone_number, content
            FROM rumi_message WHERE content <> ''
            ORDER BY phone_number, created_at ASC) e
    WHERE p.phone_number = e.phone_number
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

// ---- structured records + message docs -> semantic recall corpus ----

const stripHtml = (s: string): string =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const jstr = (v: unknown, max = 3000): string => {
  try {
    return JSON.stringify(v).slice(0, max);
  } catch {
    return '';
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any */
// Render a JSON value (string | object | array-of-either) into readable text,
// pulling common text fields out of objects rather than "[object Object]".
const renderItem = (x: any): string => {
  if (x == null) return '';
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'object') {
    const t = x.title ?? x.description ?? x.text ?? x.point ?? x.detail ?? x.summary ?? x.recommendation;
    return t ? String(t).trim() : jstr(x, 200);
  }
  return String(x);
};
const renderVal = (v: any): string => {
  if (Array.isArray(v)) return v.map(renderItem).filter(Boolean).join('; ');
  return renderItem(v);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
const fmtCoaching = (r: any): string => {
  const a = r.analysis_data ?? {};
  const scores = a.scores ?? {};
  const overall = scores.percentage ?? scores.overall_percentage ?? scores.overall ?? null;
  let text = `Coaching observation${a.framework ? ` (${a.framework})` : ''}${r.observation_type ? ` [${r.observation_type}]` : ''}`;
  const subj = [a.topic, a.subject].filter(Boolean).join(' / ');
  if (subj) text += ` on ${subj}`;
  if (overall != null) text += `, overall score ${overall}%`;
  if (scores.grand_total != null && scores.max_marks != null)
    text += ` (${scores.grand_total}/${scores.max_marks} marks)`;
  text += '.';
  // Per-goal / per-domain labelled breakdown (keys like goal5_classroom_management).
  const goalLines: string[] = [];
  for (const [k, v] of Object.entries<any>(a)) {
    if (!/^goal\d|^domain\d/.test(k)) continue;
    const label = k.replace(/^(goal|domain)\d+_/, '').replace(/_/g, ' ');
    const grp = k.match(/^(goal\d+|domain\d+)/)?.[0];
    const tot = grp ? scores[`${grp}_total`] : undefined;
    if (typeof v === 'string' && v.trim())
      goalLines.push(`${label}${tot != null ? ` (${tot})` : ''}: ${v.trim().slice(0, 200)}`);
    else if (v && typeof v === 'object') {
      const s = v.score ?? v.total ?? v.marks ?? tot;
      const cmt = v.comment ?? v.feedback ?? v.summary;
      goalLines.push(`${label}${s != null ? `: ${s}` : ''}${cmt ? ` — ${String(cmt).slice(0, 150)}` : ''}`);
    } else if (tot != null) goalLines.push(`${label}: ${tot}`);
  }
  if (goalLines.length) text += ` Breakdown — ${goalLines.join('; ')}.`;
  for (const key of ['executive_summary', 'strengths', 'growth_opportunities', 'recommendations', 'areas_for_improvement', 'debrief_reflection', 'notable_moments', 'feedback', 'summary']) {
    const s = renderVal(a[key]);
    if (s) text += ` ${key.replace(/_/g, ' ')}: ${s.slice(0, 500)}.`;
  }
  if (r.prioritized_action) {
    const pa = typeof r.prioritized_action === 'string' ? r.prioritized_action : jstr(r.prioritized_action, 400);
    text += ` Prioritized action: ${pa}.`;
  }
  if (r.transcript_text)
    text += ` Lesson transcript excerpt: ${String(r.transcript_text).replace(/\s+/g, ' ').slice(0, 600)}.`;
  return text.slice(0, 4000);
};

const fmtLessonPlan = (r: any): string => {
  const head =
    `Lesson plan${r.topic ? ` on "${r.topic}"` : ''}` +
    `${r.grade ? ` (Grade ${r.grade}${r.subject ? ` ${r.subject}` : ''})` : r.subject ? ` (${r.subject})` : ''}` +
    `${r.type ? ` [${r.type}]` : ''}.`;
  let body = '';
  if (r.lesson_plan_html) body = stripHtml(String(r.lesson_plan_html));
  if (!body && r.content) body = typeof r.content === 'string' ? r.content : jstr(r.content, 4000);
  return `${head} ${body}`.slice(0, 5000);
};

const fmtReading = (r: any): string => {
  const parts = ['Reading assessment'];
  if (r.grade_level != null) parts.push(`grade ${r.grade_level}`);
  if (r.language) parts.push(String(r.language));
  if (r.passage_title) parts.push(`passage "${r.passage_title}"`);
  if (r.wcpm != null) parts.push(`WCPM ${Math.round(r.wcpm)}`);
  if (r.accuracy_percentage != null) parts.push(`accuracy ${Math.round(r.accuracy_percentage)}%`);
  if (r.comprehension_score != null) parts.push(`comprehension ${Math.round(r.comprehension_score)}%`);
  if (r.on_track != null) parts.push(r.on_track ? 'on track' : 'below benchmark');
  let text = `${parts.join(', ')}.`;
  if (r.diagnostic_summary) text += ` ${String(r.diagnostic_summary).slice(0, 600)}`;
  return text.slice(0, 3000);
};

const fmtQuiz = (r: any): string => {
  const parts = ['Quiz'];
  if (r.student_name) parts.push(`for ${r.student_name}`);
  if (r.student_class) parts.push(`class ${r.student_class}`);
  if (r.mastery_percentage != null) parts.push(`mastery ${r.mastery_percentage}%`);
  if (r.mastery_level) parts.push(String(r.mastery_level));
  if (r.correct_answers != null && r.total_questions_answered != null)
    parts.push(`${r.correct_answers}/${r.total_questions_answered} correct`);
  return `${parts.join(', ')}.`;
};

async function syncKind(
  rumi: pg.Client,
  kind: string,
  wmKey: string,
  selectCols: string,
  fromJoin: string,
  toContent: (r: any) => string,
): Promise<void> {
  const wm = await getState(wmKey);
  const res = await rumi.query(
    `SELECT ${selectCols}, x.created_at, u.phone_number
       FROM ${fromJoin}
      WHERE u.phone_number IS NOT NULL ${wm ? 'AND x.created_at > $1' : ''}
      ORDER BY x.created_at ASC
      LIMIT 20000`,
    wm ? [wm] : [],
  );
  if (res.rows.length === 0) {
    console.log(`[rumi-sync] ${kind} docs: 0 new`);
    return;
  }
  let maxTs = wm;
  for (const r of res.rows) {
    const content = toContent(r);
    if (r.phone_number && content) {
      await upsertRumiDoc(`${kind}:${r.id}`, r.phone_number, kind, content, r.created_at);
    }
    const ts = new Date(r.created_at).toISOString();
    if (!maxTs || ts > maxTs) maxTs = ts;
  }
  if (maxTs) await setState(wmKey, maxTs);
  console.log(`[rumi-sync] ${kind} docs: ${res.rows.length} new`);
}

/** Pull structured Rumi records (coaching, lesson plans, reading, quizzes). */
async function syncStructured(rumi: pg.Client): Promise<void> {
  await syncKind(rumi, 'coaching', 'rumi_coaching_wm',
    'x.id, x.analysis_data, x.observation_type, x.prioritized_action, x.photo_analysis, x.transcript_text',
    'coaching_sessions x JOIN users u ON u.id = x.user_id', fmtCoaching);
  await syncKind(rumi, 'lesson_plan', 'rumi_lp_wm',
    'x.id, x.topic, x.grade, x.subject, x.type, x.content, x.lesson_plan_html',
    'lesson_plans x JOIN users u ON u.id = x.user_id', fmtLessonPlan);
  await syncKind(rumi, 'reading', 'rumi_reading_wm',
    'x.id, x.grade_level, x.language, x.passage_title, x.wcpm, x.accuracy_percentage, x.comprehension_score, x.on_track, x.diagnostic_summary',
    'reading_assessments x JOIN users u ON u.id = x.user_id', fmtReading);
  await syncKind(rumi, 'quiz', 'rumi_quiz_wm',
    'x.id, x.student_name, x.student_class, x.mastery_percentage, x.mastery_level, x.correct_answers, x.total_questions_answered',
    'quiz_sessions x JOIN users u ON u.id = x.user_id', fmtQuiz);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Copy substantive chat messages from the local mirror into the recall corpus. */
async function syncMessageDocs(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const res = await pool.query(`
    INSERT INTO rumi_doc (id, phone_number, kind, content, created_at)
    SELECT 'message:' || m.id, m.phone_number, 'message', m.content, m.created_at
      FROM rumi_message m
     WHERE length(m.content) >= 20 AND left(m.content, 1) NOT IN ('/', '[')
    ON CONFLICT (id) DO NOTHING
  `);
  console.log(`[rumi-sync] message docs added: ${res.rowCount ?? 0}`);
}

/** Embed any rumi_doc rows missing an embedding (capped per run). */
async function embedPendingDocs(): Promise<void> {
  if (!isVectorReady()) return;
  let done = 0;
  while (done < config.rumi.embedCap) {
    const batch = await getDocsNeedingEmbedding(256);
    if (batch.length === 0) break;
    const vecs = await embedTexts(batch.map((d) => d.content));
    for (let i = 0; i < batch.length; i += 1) {
      const v = vecs[i];
      if (v) await setDocEmbedding(batch[i].id, toVectorLiteral(v));
    }
    done += batch.length;
    if (batch.length < 256) break;
  }
  if (done) console.log(`[rumi-sync] embedded ${done} doc(s)`);
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
    await syncStructured(rumi);
    await syncMessageDocs();
    await embedPendingDocs();
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

// A small warm pool kept open for per-call delta fetches (so a call doesn't pay
// a fresh TLS/connect each time). Lazy — created on first delta.
let deltaPool: pg.Pool | null = null;
const getDeltaPool = (): pg.Pool | null => {
  if (!rumiEnabled()) return null;
  if (!deltaPool) {
    deltaPool = new pg.Pool({
      host: config.rumi.host,
      port: config.rumi.port,
      user: config.rumi.user,
      password: config.rumi.password,
      database: config.rumi.database,
      ssl: { rejectUnauthorized: false },
      max: 2,
      statement_timeout: 4000,
      idleTimeoutMillis: 30_000,
    });
    deltaPool.on('error', () => undefined); // never crash on idle client errors
  }
  return deltaPool;
};

/**
 * Pull just THIS caller's Rumi messages that are newer than what we already have
 * locally, write them into Noor's local mirror, and return them. Used at connect
 * (fire-and-forget) so a caller who just chatted with Rumi is fresh on the call.
 *
 * FAIL-OPEN and non-blocking: returns [] on any error/timeout, and only acts for
 * callers we've already synced before (first-timers are handled by the batch
 * sync). Never throws.
 */
export async function syncCallerDelta(
  phone: string,
): Promise<{ role: string; content: string; createdAt: Date }[]> {
  const noor = getPool();
  const rumi = getDeltaPool();
  if (!noor || !rumi || !phone) return [];
  try {
    const wm = await noor.query(
      `SELECT max(created_at) mx FROM rumi_message WHERE phone_number = $1`,
      [phone],
    );
    const since: Date | null = wm.rows[0]?.mx ?? null;
    if (!since) return []; // never synced this caller — leave it to the batch job
    const res = await rumi.query(
      `SELECT c.id, c.role, c.content, c.message_type, c.created_at
         FROM conversations c JOIN users u ON u.id = c.user_id
        WHERE u.phone_number = $1 AND c.created_at > $2
        ORDER BY c.created_at ASC LIMIT 200`,
      [phone, since],
    );
    if (res.rows.length === 0) return [];
    for (const r of res.rows) {
      await noor.query(
        `INSERT INTO rumi_message (id, phone_number, role, content, message_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
        [r.id, phone, r.role, r.content, r.message_type, r.created_at],
      );
    }
    await noor.query(
      `UPDATE rumi_profile p SET last_message_at = s.mx, message_count = s.n
         FROM (SELECT max(created_at) mx, count(*)::int n FROM rumi_message WHERE phone_number = $1) s
        WHERE p.phone_number = $1`,
      [phone],
    );
    console.log(`[rumi-delta] ${phone}: +${res.rows.length} new message(s)`);
    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn('[rumi-delta] failed (fail-open):', String(err).slice(0, 120));
    return [];
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
