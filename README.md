# Noor — WhatsApp Voice Agent

Noor answers **WhatsApp voice calls** and talks to the caller using the **OpenAI
Realtime API**. A WhatsApp user calls the business number; Noor picks up and has
a natural, Urdu-first spoken conversation — helping teachers (lesson plans,
timetable, training) and students (explaining topics, homework, exam prep),
adapting to whoever is on the line.

It also **logs every call** (name, number, duration, full transcript) to Postgres
and keeps a **per-caller memory**, so Noor remembers returning callers across
days or months.

Model `gpt-realtime-2.1`, voice `marin`, `reasoning.effort: minimal`,
`server_vad` turn detection.

---

## How it works

```
WhatsApp caller
   │  (voice call — WebRTC: ICE + DTLS + SRTP, Opus)
   ▼
Meta WhatsApp Cloud API  ──webhook 'calls' (connect + SDP offer)──►  Noor server
                          ◄──── POST /{PHID}/calls  action=accept (SDP answer) ──
   │
   ▼  (this server)
CallSession
   ├─ @roamhq/wrtc peer  ── caller audio (PCM 16k) ─► resample 24k ─► OpenAI Realtime (WS)
   └─ OpenAI Realtime  ── Noor audio (PCM 24k) ─► resample ─► wrtc peer ─► caller
   └─ transcripts (caller + Noor) ─► Postgres `calls`
after hang-up:  transcript ─► gpt-4o-mini summary ─► Postgres `user_memory`
```

- **`src/whatsapp/webhook.ts`** — verifies the webhook, handles `connect` /
  `terminate` events; logs calls + triggers the memory summary.
- **`src/whatsapp/calls-api.ts`** — `POST /{PHONE_NUMBER_ID}/calls` (pre_accept /
  accept / reject / terminate).
- **`src/bridge/call-session.ts`** — one WebRTC peer per call, bridged to OpenAI,
  with a jitter buffer for smooth playback and full session isolation.
- **`src/bridge/openai-realtime.ts`** — the OpenAI Realtime WebSocket session
  (Noor's settings + transcription live here).
- **`src/bridge/audio.ts`** — PCM16 resampling + base64 helpers.
- **`src/context/`** — builds Noor's prompt: personality, greeting by name,
  per-caller memory, and (optional) lesson-plan/timetable/training data.
- **`src/db.ts`** — Postgres: `calls` (log + transcript) and `user_memory`.
- **`src/memory.ts`** — async post-call summarizer (bounded rolling memory).

---

## Setup

### 1. Install

```bash
cd noor-whatsapp-voice-agent
npm install
```

> `@roamhq/wrtc` is a native module (prebuilt glibc binary). On Windows you may
> need build tools if the prebuilt binary doesn't match; the Docker image uses
> `node:22-bookworm` (glibc), which works out of the box.

### 2. Configure (`.env`, git-ignored)

| Var | Meaning |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Business phone number id (PHID) |
| `WHATSAPP_ACCESS_TOKEN` | Meta access token |
| `WHATSAPP_VERIFY_TOKEN` | You choose — must match the Meta webhook UI |
| `WHATSAPP_GRAPH_VERSION` | Graph API version (e.g. `v21.0`) |
| `OPENAI_API_KEY` | OpenAI key |
| `OPENAI_REALTIME_MODEL` / `_VOICE` | `gpt-realtime-2.1` / `marin` |
| `OPENAI_REASONING_EFFORT` | `minimal` (blank = OpenAI default) |
| `OPENAI_TURN_DETECTION` / `OPENAI_VAD_SILENCE_MS` | `server_vad` / silence ms |
| `OPENAI_MEMORY_MODEL` | summarizer model (default `gpt-4o-mini`) |
| `DATABASE_URL` | Postgres (Railway injects it); blank = logging/memory off |
| `TALEEMABAD_BASE_URL` / `TALEEMABAD_ACCESS_TOKEN` | Optional backend context |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Optional TURN fallback |

### 3. Run locally + expose

```bash
npm run dev        # server on :8080
npm run tunnel     # ngrok on your reserved static domain (for local Meta webhook)
```

Point Meta's webhook Callback URL at `https://<your-tunnel>/webhook`, verify token
= `WHATSAPP_VERIFY_TOKEN`, subscribe to the **`calls`** field, and **enable
Calling** on the number. Then call the number — Noor answers. (For production,
use the Railway deployment below instead of a local tunnel.)

---

## Deploy on Railway (production)

Runs live on Railway. The webhook is served over Railway's HTTPS domain, and the
call **audio works over Railway's outbound UDP without a TURN server** (WhatsApp
is `ice-lite`, so Noor initiates the media path outbound).

1. Create a Railway project from this repo — Railway builds the `Dockerfile`
   automatically (`railway.toml` pins the builder + `/` healthcheck).
2. Add a **PostgreSQL** plugin. In the Noor service → **Variables**, set
   `DATABASE_URL = ${{ Postgres.DATABASE_URL }}` (private network, no SSL), plus
   all the `WHATSAPP_*` / `OPENAI_*` values. **Do not set `PORT`** — Railway
   injects it.
3. Generate a domain (Settings → Networking) and set Meta's webhook to
   `https://<app>.up.railway.app/webhook` (verify token + subscribe `calls`).
4. Call and test. The `calls` and `user_memory` tables auto-create on boot
   (`[db] connected — call logging + memory enabled`).

**TURN (optional fallback):** if a host ever blocks outbound UDP, set
`TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` (managed TURN over TCP/TLS, or
self-hosted `coturn`); `TURN_FORCE_RELAY=true` forces the relay path. It's a
no-op when the `TURN_*` vars are empty.

---

## Greeting by name

Noor addresses the caller by their **WhatsApp profile name** from the webhook
(`value.contacts[].profile.name`, matched to the caller's `wa_id`) — no auth
needed. Falls back to a generic greeting if the name is absent.

## Call logs & transcripts (Postgres)

Every call writes a row to the **`calls`** table: `caller_name`, `caller_number`,
`started_at` / `ended_at`, `duration_seconds`, `status`, and the full
**`transcript`** (both sides). Caller speech is transcribed with
`gpt-4o-mini-transcribe`; Noor's transcript comes natively from the realtime
model. Transcription runs in parallel and does not affect call latency.

## Per-caller memory

After each call, `memory.ts` folds the transcript into a **bounded rolling
summary** (≤1,500 chars, rewritten not appended via `gpt-4o-mini`) stored in
**`user_memory`** keyed by phone number. On the next call, that summary is
injected into Noor's system prompt **at connect** — so Noor remembers the caller
with **no per-turn latency** and the memory never grows unbounded.

## Dashboard (Metabase)

Deploy **Metabase** as a second service in the same Railway project, connect it
to the Postgres (`postgres.railway.internal`, private, no SSL), and build
dashboards over `calls` / `user_memory`: volume trends, top callers, peak-hour
heatmap, retention cohorts, and a searchable transcript viewer.

---

## Scripts

```bash
npm run dev        # run with reload (tsx watch)
npm start          # run once
npm run tunnel     # ngrok on the reserved static domain (local dev)
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```
