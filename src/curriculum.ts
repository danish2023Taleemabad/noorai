import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Curriculum context for Noor.
 *
 * At BOOT we load Taleemabad's "All Segments + SLOs" curriculum matrix (a Google
 * Sheet) once and flatten it into per-(grade × subject) text slices held in RAM.
 * Every lookup after that is a plain Map read — there is NO network call on the
 * live call path, so call latency is exactly as before.
 *
 * Safe no-op: if GOOGLE_SERVICE_ACCOUNT_JSON isn't set, or the fetch/parse fails,
 * curriculum stays empty and Noor runs exactly as it did before (just without
 * curriculum context). Nothing here can block or slow a call.
 */

const SUBJECT_ALIASES: Record<string, string> = {
  english: 'English',
  eng: 'English',
  angrezi: 'English',
  math: 'Maths',
  maths: 'Maths',
  mathematics: 'Maths',
  riazi: 'Maths',
  riyazi: 'Maths',
  urdu: 'Urdu',
};

/** Map a spoken/typed subject to the canonical sheet subject, or null. */
export const normalizeSubject = (raw?: string): string | null => {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (SUBJECT_ALIASES[k]) return SUBJECT_ALIASES[k];
  for (const [alias, canon] of Object.entries(SUBJECT_ALIASES)) {
    if (k.includes(alias)) return canon;
  }
  return null;
};

/** Extract a grade number (1–12) from free text, or null. */
export const normalizeGrade = (raw?: string): string | null => {
  if (!raw) return null;
  const m = String(raw).match(/(\d+)/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) return String(n);
  }
  const words: Record<string, string> = {
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
  };
  return words[raw.trim().toLowerCase()] ?? null;
};

// "grade|Subject" -> pre-rendered text slice.
const slices = new Map<string, string>();
let loaded = false;

export const curriculumStatus = (): { loaded: boolean; slices: number } => ({
  loaded,
  slices: slices.size,
});

/**
 * Return the rendered curriculum for a grade + subject, or null if unknown.
 * Pure in-memory — safe to call on the live path.
 */
export const getCurriculumSlice = (
  gradeRaw?: string,
  subjectRaw?: string,
): string | null => {
  const grade = normalizeGrade(gradeRaw);
  const subject = normalizeSubject(subjectRaw);
  if (!grade || !subject) return null;
  return slices.get(`${grade}|${subject}`) ?? null;
};

// ---------------------------------------------------------------------------
// Boot-time load
// ---------------------------------------------------------------------------

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Mint a short-lived Google access token from the service account (no deps). */
async function getAccessToken(sa: {
  client_email: string;
  private_key: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(sa.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

interface Day {
  day: string;
  topic: string;
  skill: string;
}
interface Chapter {
  num: string;
  title: string;
  days: Day[];
}

function render(
  grade: string,
  subject: string,
  chapters: Map<string, Chapter>,
): string {
  const lines = [`Grade ${grade} ${subject} curriculum (chapters and daily topics):`];
  const sorted = [...chapters.values()].sort(
    (a, b) => a.num.length - b.num.length || a.num.localeCompare(b.num),
  );
  for (const ch of sorted) {
    lines.push(`Chapter ${ch.num}: ${ch.title}`);
    for (const d of ch.days) {
      lines.push(`  ${d.day}: ${d.topic}${d.skill ? ` (${d.skill})` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Load + flatten the curriculum matrix into RAM. Call ONCE at boot. Never
 * throws; on any failure it logs and leaves curriculum disabled.
 */
export async function loadCurriculum(): Promise<void> {
  const raw = config.google.serviceAccountJson;
  if (!raw) {
    console.log(
      '[curriculum] GOOGLE_SERVICE_ACCOUNT_JSON not set — curriculum disabled',
    );
    return;
  }
  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    console.warn('[curriculum] service account JSON did not parse — disabled');
    return;
  }

  try {
    const token = await getAccessToken(sa);
    const range = `'${config.curriculum.tabName}'!A1:P5000`;
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${config.curriculum.sheetId}` +
      `/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const rows = ((await res.json()) as { values?: string[][] }).values ?? [];

    // rows[0] = title banner, rows[1] = header, rows[2:] = data.
    const cell = (r: string[], i: number): string =>
      i < r.length && r[i] ? r[i].trim() : '';
    const grouped = new Map<string, Map<string, Chapter>>();
    const metaByKey = new Map<string, { grade: string; subject: string }>();

    for (const r of rows.slice(2)) {
      const subject = normalizeSubject(cell(r, 0)) ?? cell(r, 0);
      const grade = normalizeGrade(cell(r, 1));
      if (!subject || !grade) continue;
      const key = `${grade}|${subject}`;
      metaByKey.set(key, { grade, subject });
      const chapters = grouped.get(key) ?? new Map<string, Chapter>();
      grouped.set(key, chapters);
      const chNum = cell(r, 2) || '?';
      const ch =
        chapters.get(chNum) ?? { num: chNum, title: cell(r, 3), days: [] };
      chapters.set(chNum, ch);
      ch.days.push({ day: cell(r, 4), topic: cell(r, 5), skill: cell(r, 6) });
    }

    slices.clear();
    for (const [key, chapters] of grouped) {
      const m = metaByKey.get(key);
      if (m) slices.set(key, render(m.grade, m.subject, chapters));
    }
    loaded = slices.size > 0;
    console.log(
      `[curriculum] loaded ${slices.size} grade×subject slices from the matrix`,
    );
  } catch (err) {
    console.warn('[curriculum] load failed — curriculum disabled:', String(err));
  }
}
