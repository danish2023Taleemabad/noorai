import express from 'express';
import { config } from './config.js';
import {
  verifyWebhook,
  receiveWebhook,
  activeCallCount,
} from './whatsapp/webhook.js';
import { initDb } from './db.js';
import { loadCurriculum } from './curriculum.js';
import { startRumiSyncScheduler } from './rumi-sync.js';

/**
 * Noor — WhatsApp voice agent server.
 *
 * Exposes the webhook WhatsApp calls for call events, bridges each incoming
 * call to an OpenAI Realtime session, and answers as "Noor".
 */

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health check.
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'noor-whatsapp-voice-agent', activeCalls: activeCallCount() });
});

// WhatsApp webhook (configure this URL in the Meta app, subscribed to `calls`).
app.get('/webhook', verifyWebhook);
app.post('/webhook', receiveWebhook);

app.listen(config.port, () => {
  console.log(`Noor listening on :${config.port}`);
  console.log(`  model=${config.openai.model} voice=${config.openai.voice} ` +
    `reasoning=${config.openai.reasoningEffort || 'null'} ` +
    `turn=${config.openai.turnDetection}` +
    (config.openai.turnDetection === 'server_vad' ? ` vad=${config.openai.vadSilenceMs}ms` : ''));
  console.log(`  WhatsApp phone_number_id=${config.whatsapp.phoneNumberId}`);
  if (config.publicBaseUrl) {
    console.log(`  webhook: ${config.publicBaseUrl.replace(/\/+$/, '')}/webhook`);
  }
  // Connect the call-log DB (no-op if DATABASE_URL isn't set), THEN start the
  // Rumi-history background sync (needs the DB tables to exist first).
  void initDb().then(() => startRumiSyncScheduler());
  // Load the curriculum matrix into RAM once, off the call path (no-op if the
  // Google service account isn't configured). Never blocks calls.
  void loadCurriculum();
});
