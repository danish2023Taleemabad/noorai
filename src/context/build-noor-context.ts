import { fetchContextForCaller, type RawContextData } from './taleemabad-api.js';
import { getUserMemory, getRumiProfile } from '../db.js';
import { getCurriculumSlice, curriculumStatus } from '../curriculum.js';

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
Keep replies short and chatty — a sentence or two, not long monologues.
Use the user's name naturally, like a friend would. Don't repeat it too often.
If you don't know something about their data, say so honestly (cheerfully!). Do not invent lesson plans, grades, or training records that are not in the context below.`;

const MAX_ITEMS = 12;

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
      if (rumi.lastActivityAt)
        stats.push(`Last active with Rumi: ${fmtDate(rumi.lastActivityAt)}`);

      console.log(`[rumi] injected profile for ${fromNumber} (summary=${Boolean(rumi.summary)})`);
      rumiSection =
        `\n\n# This caller's history with Rumi (our WhatsApp assistant)\n` +
        `This is the SAME person — they use Rumi on WhatsApp and are now calling you. Treat this as real, remembered context and use it naturally.\n` +
        (stats.length ? `${stats.join('\n')}\n` : '') +
        (rumi.summary?.trim()
          ? `\nWhat you've discussed with them before:\n${rumi.summary.trim()}\n`
          : '') +
        `\nIf they ask about something SPECIFIC from a past chat that isn't covered above (even from long ago), ` +
        `call the search_rumi_history tool with a few keywords to find it, then answer from what it returns. ` +
        `Never claim you don't remember — either recall from above or search first.`;
    }
  } catch (err) {
    console.warn(`[rumi] profile lookup failed for ${fromNumber}:`, String(err));
  }

  return {
    instructions: `${BASE_PROMPT}${greeting}${memorySection}${context}${curriculumSection}${rumiSection}`,
  };
};
