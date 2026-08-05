import { initDb } from './db.js';
import { runRumiSync } from './rumi-sync.js';

/**
 * Manual one-off Rumi history sync (backfill / on-demand):
 *   npm run sync:rumi
 * Uses the same env as the server (Noor DATABASE_URL + RUMI_DB_* creds).
 */
await initDb();
await runRumiSync();
process.exit(0);
