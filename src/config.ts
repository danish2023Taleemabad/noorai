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

  // Postgres for call logs + transcripts. Railway injects DATABASE_URL when you
  // add a Postgres plugin. Empty = logging disabled (calls still work).
  databaseUrl: env('DATABASE_URL'),
  // Set DATABASE_SSL=true only for a public/proxy DB URL; Railway's in-project
  // (private) DATABASE_URL does not use SSL.
  databaseSsl: env('DATABASE_SSL') === 'true',

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
    // Cheap text model used to summarize past calls into per-user memory
    // (runs after a call ends — off the live path).
    memoryModel: env('OPENAI_MEMORY_MODEL', false, 'gpt-4o-mini'),
    // Embedding model for semantic recall of Rumi history.
    embedModel: env('OPENAI_EMBED_MODEL', false, 'text-embedding-3-small'),
  },

  taleemabad: {
    baseUrl: env('TALEEMABAD_BASE_URL', false, 'https://schools.niete.pk'),
    accessToken: env('TALEEMABAD_ACCESS_TOKEN'),
  },

  // Google service account (read-only) used ONCE at boot to load the curriculum
  // matrix into RAM. Empty = curriculum context disabled (Noor still works).
  google: {
    serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
  },
  // The Taleemabad curriculum matrix sheet + the flat "All Segments + SLOs" tab.
  curriculum: {
    sheetId: env(
      'CURRICULUM_SHEET_ID',
      false,
      '1nzrAZ0LUIRxKoGh3GsuES86P5w_E3RbYf2kZ9SAppTg',
    ),
    tabName: env('CURRICULUM_TAB', false, 'All Segments + SLOs'),
  },

  // Read-only connection to the Rumi (WhatsApp chatbot) production DB. A
  // background job syncs each caller's Rumi history into Noor's own DB, so the
  // live call path only ever reads Noor's local copy (zero added latency).
  // Enabled only when user + password are set.
  rumi: {
    host: env(
      'RUMI_DB_HOST',
      false,
      'aws-1-ap-southeast-1.pooler.supabase.com',
    ),
    port: Number(env('RUMI_DB_PORT', false, '6543')),
    user: env('RUMI_DB_USER'),
    password: env('RUMI_DB_PASSWORD'),
    database: env('RUMI_DB_NAME', false, 'postgres'),
    // How often the background sync runs (minutes). First run ~30s after boot.
    syncIntervalMinutes: Number(env('RUMI_SYNC_INTERVAL_MINUTES', false, '360')),
    // Cap on how many callers get their conversation summary (re)generated per
    // sync run, to bound summarizer cost. Most-recently-active first.
    summaryCap: Number(env('RUMI_SUMMARY_CAP', false, '150')),
    // Cap on how many Rumi documents get embedded per sync run (bounds cost/time
    // on the first backfill; embeddings are cheap so this can be generous).
    embedCap: Number(env('RUMI_EMBED_CAP', false, '5000')),
  },

  // Optional TURN relay for hosts (e.g. Railway) that can't do WebRTC over raw
  // UDP. Leave empty to use STUN-only (works locally / on UDP-friendly hosts).
  // TURN over TCP/TLS (turns:...?transport=tcp) is what makes media traverse
  // Railway's TCP-only networking. TURN_URLS may be comma-separated.
  turn: {
    urls: env('TURN_URLS'),
    username: env('TURN_USERNAME'),
    credential: env('TURN_CREDENTIAL'),
    forceRelay: env('TURN_FORCE_RELAY') === 'true',
  },
} as const;
