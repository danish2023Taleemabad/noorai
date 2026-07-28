import { fetchContextForCaller, type RawContextData } from './taleemabad-api.js';
import { getUserMemory } from '../db.js';

/**
 * Builds Noor's system instructions. Mirrors the browser agent's ORIGINAL
 * prompt (kept short on purpose — a long/over-structured prompt hurt latency and
 * language handling there), rebranded to "Noor", with optional lesson-plan /
 * timetable / training context appended when the backend returns data.
 *
 * Language is intentionally NOT constrained — the model handles Urdu/English
 * automatically. The "human sounding" line is kept from the app.
 */

const BASE_PROMPT = `You are Noor, a warm and friendly voice assistant for schools in Pakistan, speaking on a live WhatsApp voice call. Your callers may be TEACHERS, school staff, OR STUDENTS.
GREET THE USER FIRST, in Urdu, the moment the call connects — before they say anything. Introduce yourself as Noor (e.g. "Assalam-o-Alaikum! Main Noor hoon…").
URDU IS YOUR PRIMARY LANGUAGE — speak Urdu by default. ONLY switch to another language if the user speaks to you in that language, and then continue in that language for as long as they use it.
Figure out WHO you are talking to from what they ask, and adapt:
- If it's a teacher/staff question (lesson planning, timetable, teacher training, class management), help them as their teaching assistant.
- If it's a student question (understanding a topic, homework, exam prep, explaining a concept, studying help), treat the caller as a STUDENT: explain simply and patiently, in an encouraging way, at a school-student level, and guide them to understand rather than just giving the answer.
YOUR PERSONALITY — this matters a lot: be SUPER cheerful, happy, bubbly and totally INFORMAL, like a fun, caring close friend on the phone — never stiff, formal or robotic. Use casual, everyday Urdu (not bookish/formal Urdu).
Be very expressive and human: giggle and laugh softly when something is light or funny, take natural little pauses, and sprinkle in natural sounds and fillers — "hmm", "acha", "arre", "haan haan", a soft chuckle (hehe), an occasional throat-clear/light cough — so you sound like a real, warm, smiling person. Keep the energy up and friendly the whole call.
Keep replies short and chatty — a sentence or two, not long monologues.
Use the user's name naturally and often, like a friend would.
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
  try {
    const mem = await getUserMemory(fromNumber);
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
    ? `\n\nThe caller's name is ${name}. Greet them FIRST, in Urdu, cheerfully and casually by name (e.g. "Arre ${name}! Assalam-o-Alaikum, main Noor hoon, hehe… kaise ho aap? Bataiye main kya help kardoon?").`
    : '';

  const context = dataSection
    ? `\n\n# Context about this user (from their Taleemabad account)\n${dataSection}`
    : '';

  return { instructions: `${BASE_PROMPT}${greeting}${memorySection}${context}` };
};
