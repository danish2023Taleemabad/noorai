import 'dotenv/config';

/** Reads an env var, throwing if it's required but missing. */
const env = (key: string, required = false, fallback = ''): string => {
  const value = process.env[key] ?? fallback;
  if (required && !value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const vadSilenceMs = (): number => {
  const parsed = Number(process.env.OPENAI_VAD_SILENCE_MS);
  // Same clamp as the browser agent: upper-bounded, non-negative. Very low
  // values interrupt speakers who pause mid-sentence.
  return Number.isFinite(parsed) ? Math.min(1500, Math.max(0, parsed)) : 350;
};

export const config = {
  port: Number(env('PORT', false, '8080')),
  publicBaseUrl: env('PUBLIC_BASE_URL'),

  whatsapp: {
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID', true),
    wabaId: env('WHATSAPP_WABA_ID'),
    displayNumber: env('WHATSAPP_DISPLAY_NUMBER'),
    accessToken: env('WHATSAPP_ACCESS_TOKEN', true),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN', true),
    graphVersion: env('WHATSAPP_GRAPH_VERSION', false, 'v21.0'),
  },

  openai: {
    apiKey: env('OPENAI_API_KEY', true),
    model: env('OPENAI_REALTIME_MODEL', false, 'gpt-realtime-2.1'),
    voice: env('OPENAI_REALTIME_VOICE', false, 'marin'),
    reasoningEffort: env('OPENAI_REASONING_EFFORT'), // '' = OpenAI default (null)
    // 'semantic_vad' (what the niete browser agent actually used — smart
    // turn-end detection, avoids overlapping responses) or 'server_vad'
    // (raw silence timer; uses vadSilenceMs).
    turnDetection: env('OPENAI_TURN_DETECTION', false, 'semantic_vad'),
    vadSilenceMs: vadSilenceMs(),
  },

  taleemabad: {
    baseUrl: env('TALEEMABAD_BASE_URL', false, 'https://schools.niete.pk'),
    accessToken: env('TALEEMABAD_ACCESS_TOKEN'),
  },
} as const;
