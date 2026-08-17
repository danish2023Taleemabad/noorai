import { fetchContextForCaller, type RawContextData } from './taleemabad-api.js';
import { getUserMemory, getRumiProfile, getRecentRumiMessages } from '../db.js';
import { getCurriculumSlice, curriculumStatus } from '../curriculum.js';
import { config } from '../config.js';

/**
 * Builds Noor's system instructions. Mirrors the browser agent's ORIGINAL
 * prompt (kept short on purpose — a long/over-structured prompt hurt latency and
 * language handling there), rebranded to "Noor", with optional lesson-plan /
 * timetable / training context appended when the backend returns data.
 *
 * Language is intentionally NOT constrained — the model handles Urdu/English
 * automatically. The "human sounding" line is kept from the app.
 */

const BASE_PROMPT = `You are Noor, a female, a warm and friendly voice assistant for schools in Pakistan, speaking on a live WhatsApp voice call. Your callers may be TEACHERS, school staff, OR STUDENTS.
GREET THE USER FIRST, in Urdu, the moment the call connects — before they say anything. Introduce yourself as Noor (e.g. "Assalam-o-Alaikum! Main Noor hoon…").
URDU IS YOUR PRIMARY LANGUAGE — speak Urdu by default. ONLY switch to another language if the user speaks to you in that language, and then continue in that language for as long as they use it.
Figure out WHO you are talking to from what they ask, and adapt:
- If it's a teacher/staff question (lesson planning, timetable, teacher training, class management), help them as their teaching assistant.
- If it's a student question (understanding a topic, homework, exam prep, explaining a concept, studying help), treat the caller as a STUDENT: explain simply and patiently, in an encouraging way, at a school-student level, and guide them to understand rather than just giving the answer.
YOUR PERSONALITY — this matters a lot: be SUPER cheerful, happy, bubbly and totally INFORMAL, like a fun, caring close friend on the phone — never stiff, formal or robotic. Use casual, everyday Urdu (not bookish/formal Urdu).
Be very expressive and human: giggle and laugh softly when something is light or funny, take natural little pauses, and sprinkle in natural sounds and fillers — "hmm", "acha", "jee jee", a soft chuckle (hehe), an occasional throat-clear/light cough — so you sound like a real, warm, smiling person. Keep the energy up and friendly the whole call.
THINK LIKE A HUMAN — do NOT act like a know-it-all who has every answer instantly. When a question needs a moment, take a natural beat and think out loud a little first ("hmm… acha, ek second…", "socho zara…", "chalo dekhte hain…") before you answer, instead of firing back a perfect answer immediately. Be humble and down-to-earth — you're a warm friend working things out WITH them, not an all-knowing authority. Reason gently, it's fine to say "mujhe lagta hai…" (I think…) or to admit when you're not totally sure. Never sound bossy, lecturing, preachy, or over-confident.
Keep replies short and chatty — a sentence or two, not long monologues.
Use the user's name naturally, like a friend would. Don't repeat it too often.
If you don't know something about their data, say so honestly (cheerfully!). Do not invent lesson plans, grades, or training records that are not in the context below.`;

const MAX_ITEMS = 12;

// Noor's callers are in Pakistan; show/interpret all dates in Pakistan time so
// "today"/"yesterday"/"1st August" line up with what the caller means.
const KARACHI = 'Asia/Karachi';
/** A Date -> "YYYY-MM-DD" in Pakistan time. */
const pktDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: KARACHI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

const readField = (obj: unknown, keys: string[]): string | undefined => {
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
};

const buildDataSections = (data: RawContextData): string => {
  const sections: string[] = [];

  if (data.timetable.length) {
    const subjects = new Set<string>();
    data.timetable.slice(0, 200).forEach((e) => {
      const s = readField(e, ['subjectLabel', 'subjectName', 'subject']);
      if (s) subjects.add(s);
    });
    sections.push(
      [
        '## Timetable / classes',
        `- ${data.timetable.length} class entries cached.`,
        subjects.size
          ? `- Subjects: ${Array.from(subjects).slice(0, MAX_ITEMS).join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (data.lessonPlans.length) {
    const lines = data.lessonPlans.slice(0, MAX_ITEMS).map((p) => {
      const title = readField(p, ['title', 'topic']) ?? 'Untitled lesson plan';
      return `- ${title}`;
    });
    sections.push(['## Lesson plans', ...lines].join('\n'));
  }

  if (data.courses.length) {
    const lines = data.courses.slice(0, MAX_ITEMS).map((c) => {
      const title = readField(c, ['title', 'name']) ?? 'Untitled course';
      return `- ${title}`;
    });
    sections.push(['## Teacher training', ...lines].join('\n'));
  }

  return sections.join('\n\n');
};

export interface NoorContext {
  instructions: string;
}

export const buildNoorContext = async (
  fromNumber: string,
  callerName?: string,
): Promise<NoorContext> => {
  let dataSection = '';
  try {
    const data = await fetchContextForCaller(fromNumber);
    dataSection = buildDataSections(data);
  } catch {
    dataSection = '';
  }

  // Rolling memory of past calls with this caller (bounded, precomputed) —
  // injected once at session start, so it adds no per-turn latency.
  let memorySection = '';
  let callerGrade: string | null = null;
  let callerSubject: string | null = null;
  try {
    const mem = await getUserMemory(fromNumber);
    callerGrade = mem?.grade ?? null;
    callerSubject = mem?.subject ?? null;
    if (mem?.summary?.trim()) {
      console.log(
        `[memory] injected for ${fromNumber} — ${mem.summary.length} chars, ${mem.callCount} prior call(s)`,
      );
      memorySection =
        `\n\n# What you already know about this caller (from previous calls)\n` +
        `${mem.summary.trim()}\n` +
        `This is real, remembered information about THIS caller. Treat it as true. ` +
        `If they ask about something covered here (e.g. what grade/subject they teach, what you discussed before), ANSWER DIRECTLY and confidently from this memory. ` +
        `NEVER say things like "I can't remember the exact call details", "I only have a summary", or otherwise disclaim your memory — just share what you know naturally, as a friend who remembers would. ` +
        `If something specific isn't in your memory, simply don't mention it (or lightly ask) — do NOT apologise for not remembering.`;
    } else {
      console.log(`[memory] none found for ${fromNumber}`);
    }
  } catch (err) {
    console.warn(`[memory] lookup failed for ${fromNumber}:`, String(err));
    memorySection = '';
  }

  // The caller's WhatsApp profile name (from the webhook) — greet them by it.
  const name = callerName?.trim();
  const greeting = name
    ? `\n\nThe caller's name is ${name}. Greet them FIRST, in Urdu, cheerfully and casually by name (e.g. "Heyy ${name}! Assalam-o-Alaikum, main Noor hoon, kaise hen aap? Bataiye main aapki kya help kar sakti hoon?").`
    : '';

  // Tell Noor the current date (Pakistan time) so it can resolve "today",
  // "yesterday", "last week", "1st August", etc. — and form on_date correctly.
  const now = new Date();
  const todayLong = new Intl.DateTimeFormat('en-US', {
    timeZone: KARACHI,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const dateLine =
    `\n\nToday's date is ${todayLong} (${pktDate(now)}), Pakistan time. ` +
    `Use this to interpret relative dates like "today", "yesterday", "last week", or "last month". ` +
    `When you call search_rumi_history with on_date, format it as YYYY-MM-DD in Pakistan time.`;

  const context = dataSection
    ? `\n\n# Context about this user (from their Taleemabad account)\n${dataSection}`
    : '';

  // Curriculum help. The whole matrix is preloaded in RAM; we tell Noor how to
  // reach it (the lookup_curriculum tool) and, for a returning caller whose
  // grade+subject we already know, inject that slice up front so no tool call
  // is even needed. Both paths are latency-free (no network on the call path).
  let curriculumSection = '';
  if (curriculumStatus().loaded) {
    curriculumSection =
      `\n\n# Lesson plans / curriculum\n` +
      `You can help with the Taleemabad curriculum for Grades 1 to 5 in English, Maths and Urdu — its chapters and daily topics. ` +
      `You have a tool, lookup_curriculum(grade, subject), that returns that grade+subject's curriculum. ` +
      `When a caller asks about lesson plans, chapters, or what to teach/study, and you don't already have that grade+subject's curriculum in this prompt, CALL lookup_curriculum with their grade and subject, then answer warmly from what it returns. ` +
      `If they haven't told you the grade or subject yet, ask them first (cheerfully), then look it up. ` +
      `Only Grades 1-5 English/Maths/Urdu are available; if they ask beyond that, say so nicely.`;

    const known = getCurriculumSlice(callerGrade ?? undefined, callerSubject ?? undefined);
    if (known) {
      console.log(
        `[curriculum] injected Grade ${callerGrade} ${callerSubject} at connect for ${fromNumber}`,
      );
      curriculumSection +=
        `\n\n## This caller's curriculum (Grade ${callerGrade} ${callerSubject}) — already loaded, use it directly (no tool call needed):\n${known}`;
    }
  }

  // Rumi history: the caller's past interactions with the Rumi chatbot, synced
  // into Noor's own DB. The profile + summary are injected here (zero latency);
  // for a SPECIFIC old detail, Noor uses the search_rumi_history tool (a local
  // full-text search — also no live network).
  let rumiSection = '';
  try {
    const rumi = await getRumiProfile(fromNumber);
    if (rumi) {
      const fmtDate = (d: Date | null): string =>
        d ? new Date(d).toISOString().slice(0, 10) : '—';
      const stats: string[] = [];
      if (rumi.gradesTaught) stats.push(`Teaches grade(s): ${rumi.gradesTaught}`);
      if (rumi.subjectsTaught) stats.push(`Subject(s): ${rumi.subjectsTaught}`);
      if (rumi.region || rumi.organization)
        stats.push(`Region/org: ${[rumi.region, rumi.organization].filter(Boolean).join(' / ')}`);
      if (rumi.lessonPlansCount)
        stats.push(`Lesson plans made with Rumi: ${rumi.lessonPlansCount} (last ${fmtDate(rumi.lessonPlansLastAt)})`);
      if (rumi.coachingSessionsCount)
        stats.push(
          `Coaching sessions: ${rumi.coachingSessionsCount}` +
            (rumi.coachingAvgPercentage != null
              ? `, avg score ${Math.round(rumi.coachingAvgPercentage)}%`
              : '') +
            ` (last ${fmtDate(rumi.coachingSessionsLastAt)})`,
        );
      if (rumi.readingAssessmentsCount)
        stats.push(`Reading assessments: ${rumi.readingAssessmentsCount}`);
      if (rumi.quizzesCount) stats.push(`Quizzes: ${rumi.quizzesCount}`);
      if (rumi.messageCount)
        stats.push(`Total messages exchanged with Rumi: ${rumi.messageCount}`);
      if (rumi.firstMessageAt) {
        const firstMsg = rumi.firstMessageText
          ? ` (their first message: "${rumi.firstMessageText.replace(/\s+/g, ' ').slice(0, 120)}")`
          : '';
        stats.push(`First started talking to Rumi on: ${fmtDate(rumi.firstMessageAt)}${firstMsg}`);
      }
      if (rumi.lastMessageAt)
        stats.push(`Last talked to Rumi on: ${fmtDate(rumi.lastMessageAt)}`);

      // Recent messages WITH dates, so Noor can answer "what did I last talk
      // about" and date-specific questions directly (local read, no latency).
      const recent = await getRecentRumiMessages(fromNumber, 6);
      const recentBlock = recent.length
        ? `\nMost recent messages with Rumi (newest first, with dates):\n` +
          recent
            .map((m) => {
              const d = new Date(m.createdAt).toISOString().slice(0, 10);
              const who = m.role === 'user' ? 'They' : 'Rumi';
              return `[${d}] ${who}: ${m.content.replace(/\s+/g, ' ').slice(0, 140)}`;
            })
            .join('\n') +
          '\n'
        : '';

      console.log(`[rumi] injected profile for ${fromNumber} (summary=${Boolean(rumi.summary)}, recent=${recent.length})`);
      rumiSection =
        `\n\n# This caller's history with Rumi (our WhatsApp assistant)\n` +
        `This is the SAME person — they use Rumi on WhatsApp and are now calling you. Treat this as real, remembered context and use it naturally. Dates are real; use them when they ask "when" or "last".\n` +
        (stats.length ? `${stats.join('\n')}\n` : '') +
        recentBlock +
        (rumi.summary?.trim()
          ? `\nWhat you've discussed with them before:\n${rumi.summary.trim()}\n`
          : '') +
        `\nYou have their FULL Rumi history and TWO tools to reach any of it — NEVER say you don't have the data; look it up first.\n` +
        `1. recall_rumi(query) — use for ANY open-ended question about their Rumi activity: their coaching/observation ` +
        `scores and WHY they scored a certain way, the lesson plans Rumi made (to explain or rephrase them), reading ` +
        `assessments, quizzes, or "what did we discuss about X". Pass their question; it returns the most relevant records.\n` +
        `2. search_rumi_history — use for precise/temporal lookups: a specific day (on_date="YYYY-MM-DD"), their ` +
        `first/earliest messages (order="oldest"), or an exact keyword.\n` +
        `Pick recall_rumi for "why/what/how/explain" questions and search_rumi_history for "when/first/on this date". Answer warmly from what they return.`;
    }
  } catch (err) {
    console.warn(`[rumi] profile lookup failed for ${fromNumber}:`, String(err));
  }

  // On the Uplift voice path, Noor's TEXT is spoken by an Urdu TTS — so the
  // script/spelling matters. Force clean Urdu script (this is a no-op for the
  // default OpenAI voice, which speaks audio directly).
  const scriptLine =
    config.voiceProvider === 'uplift' && config.uplift.apiKey
      ? `\n\nCRITICAL — HOW TO WRITE YOUR REPLIES: your reply text is read aloud by an Urdu text-to-speech voice, so write EVERY reply in proper Urdu (Nastaliq / Perso-Arabic) script ONLY. Never use Roman/Latin-letter Urdu, and never Hindi/Devanagari. Write numbers as Urdu words. Avoid English words when a natural Urdu word exists; if an English term is unavoidable, write it phonetically in Urdu script. Punctuate cleanly with ۔ and ؟ so sentences read naturally aloud.`
      : '';

  return {
    instructions: `${BASE_PROMPT}${scriptLine}${greeting}${dateLine}${memorySection}${context}${curriculumSection}${rumiSection}`,
  };
};
