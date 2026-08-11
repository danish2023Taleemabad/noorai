# Noor — WhatsApp Voice Agent

Noor answers **WhatsApp voice calls** and talks to the caller using the **OpenAI
Realtime API**. A WhatsApp user calls the business number; Noor picks up and has
a natural, Urdu-first spoken conversation — helping teachers (lesson plans,
timetable, training) and students (explaining topics, homework, exam prep),
adapting to whoever is on the line.

It also **logs every call** (name, number, duration, full transcript) to Postgres
and keeps a **per-caller memory**, so Noor remembers returning callers across
days or months.

Noor is also connected to **Rumi** (Taleemabad's WhatsApp chatbot): it knows each
caller's Rumi history — coaching/observation scores, the lesson plans Rumi made for
them, reading assessments, quizzes, and past chats — and can answer **open-ended
questions about any of it** via semantic search ("why did Rumi score me lower?",
"rephrase my lesson plan", "what did I ask on 1st August?"). It can also help with
the **Taleemabad curriculum** (Grades 1–5, English / Maths / Urdu), and it logs its
own **response latency** for analytics.

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
- **`src/db.ts`** — Postgres: `calls`, `user_memory`, the Rumi mirror
  (`rumi_profile` / `rumi_message` / `rumi_doc`), and `response_latency`.
- **`src/memory.ts`** — async post-call summarizer (bounded rolling memory).
- **`src/curriculum.ts`** — boot-time load of the curriculum matrix into RAM +
  the `lookup_curriculum` tool's in-memory lookup (grade × subject).
- **`src/rumi-sync.ts`** — pulls each caller's Rumi history from Rumi's prod DB
  (read-only) into Noor's own DB at connect, and the `recall_rumi` /
  `search_rumi_history` retrieval; also the manual full backfill.
- **`src/embeddings.ts`** — OpenAI embeddings (`text-embedding-3-small`, 512-dim)
  for the semantic recall corpus.

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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Read-only Google service-account (one-line JSON) for the curriculum matrix; blank = curriculum off |
| `CURRICULUM_SHEET_ID` / `CURRICULUM_TAB` | Curriculum matrix sheet + tab (defaults baked in) |
| `RUMI_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | Read-only connection to Rumi's prod DB. Blank user/password = Rumi history disabled. Host/port/name default to the Supabase pooler. |
| `OPENAI_EMBED_MODEL` | Embedding model (default `text-embedding-3-small`) |
| `RUMI_SUMMARY_CAP` / `RUMI_EMBED_CAP` | Per-run caps for the **manual** full backfill (`npm run sync:rumi`) |
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

## Curriculum / lesson plans

Noor can help with the Taleemabad curriculum (Grades 1–5, English / Maths / Urdu)
— chapters and daily topics. At **boot**, `curriculum.ts` reads the curriculum
matrix (a Google Sheet, "All Segments + SLOs" tab) **once** and flattens it into
per-(grade × subject) slices held in RAM. Every lookup after that is an in-memory
read, so there is **no network on the live call path and no added latency**.

Two paths, both latency-free:
- **Returning caller** whose grade + subject we already know → the matching slice
  is injected into the prompt at connect (no tool call).
- **First-time / unknown caller** → Noor calls the `lookup_curriculum(grade, subject)`
  function tool, which does the RAM lookup and **remembers** the grade + subject
  in `user_memory` (so the next call injects it automatically).

Auth is a read-only Google service account (`GOOGLE_SERVICE_ACCOUNT_JSON`) used
only at boot; no extra npm dependency (JWT is minted with Node's `crypto`). If the
service account isn't set, curriculum is simply disabled and Noor runs as before.

## Rumi history & semantic recall

Noor is linked to **Rumi** (Taleemabad's WhatsApp chatbot) so a caller's entire
Rumi history is available on the call. The join is trivial because both are
WhatsApp: the caller's `wa_id` **is** Rumi's `users.phone_number` (digits + country
code, e.g. `923…`).

**Freshness is per-caller, not a global scan.** When a call connects,
`syncCallerDelta(phone)` runs **fire-and-forget** (off the call path — zero added
latency) and does a complete refresh for *that one caller*: new chat messages +
coaching observations + lesson plans + reading assessments + quizzes + profile
stats. Every query is an index-backed single-user lookup, so there's **no
recurring load on Rumi's prod DB** (no full-table scans). It handles first-time
callers too, and is fail-open — if Rumi's DB is slow or down, the call proceeds.

The data lands in Noor's own Postgres:
- **`rumi_profile`** — per-caller stats (grades/subjects taught, lesson-plan /
  coaching / reading / quiz counts, coaching average, first/last activity) + a
  bounded LLM summary. Injected into the prompt **at connect**.
- **`rumi_message`** — a local copy of the caller's chats (for date / earliest
  lookups).
- **`rumi_doc`** — the unified **semantic recall corpus**: every retrievable item
  (chat messages, coaching observations, lesson plans, reading, quizzes) as text,
  each with a vector embedding.

**Two retrieval tools** (both local — no live Rumi-prod call on the turn):
- **`recall_rumi(query)`** — the general one. Embeds the caller's question and
  does a semantic (vector) search over their `rumi_doc` corpus. Handles
  open-ended "why / what / how" questions: *"why did Rumi score me lower in
  classroom management?"*, *"rephrase the lesson plan Rumi made"*.
- **`search_rumi_history`** — precise/temporal: a specific day (`on_date`), their
  first/earliest messages (`order="oldest"`), or an exact keyword.

### How embeddings work

- Every `rumi_doc` is embedded with **`text-embedding-3-small` at 512 dimensions**
  (small + cheap: ~$0.02 / 1M tokens) and stored in a **pgvector** column.
- Because retrieval always filters by the caller's phone first, a plain cosine
  sort over that (small) per-caller subset is fast **without** an ANN index.
- `recall_rumi` embeds the question at query time (one small call, ~100 ms) and
  runs `ORDER BY embedding <=> query LIMIT k`.
- **Embeddings are still generated** — but event-driven, not on a schedule:
  - **at connect**, `syncCallerDelta` embeds the caller's newly-synced docs;
  - **`npm run sync:rumi`** embeds everything (used for the initial/one-off
    backfill; `RUMI_EMBED_CAP` bounds how many per run).
- Batching is by a **character budget** (2,000 chars/input, 70k chars/request),
  not a fixed count, because Urdu/Arabic script is many tokens per character and
  would otherwise blow OpenAI's per-input (8k) and per-request (300k) token limits.
- **Graceful fallback:** if the Postgres lacks the `vector` extension, semantic
  recall is disabled and `recall_rumi` falls back to keyword full-text search. The
  boot log shows `semantic recall: on` or `keyword-only`.

> Initial setup: after first deploy, run **`npm run sync:rumi`** once (optionally
> with a high `RUMI_EMBED_CAP`) to backfill + embed the whole corpus. After that,
> per-caller sync keeps everyone who actually calls up to date automatically.

## Response-time logging

Every Noor response records its latency — the time from the caller finishing their
turn (`speech_stopped`) to Noor's first audio — as one row in **`response_latency`**
(`wa_call_id`, `caller_number`, `latency_ms`, `created_at`). It's a timestamp diff
written fire-and-forget, so it **doesn't affect** Noor's actual latency. Query it in
Metabase for average / p50 / p95 and trends.

## Current date awareness

Noor is told **today's date in Pakistan time** at connect, so it correctly resolves
relative dates ("yesterday", "last week") and absolute ones ("1st August") when
looking up Rumi history.

## Dashboard (Metabase)

Deploy **Metabase** as a second service in the same Railway project, connect it
to the Postgres (`postgres.railway.internal`, private, no SSL), and build
dashboards over `calls` / `user_memory` / `rumi_profile` / `response_latency`:
volume trends, top callers, peak-hour heatmap, retention cohorts, a searchable
transcript viewer, and Noor's response-time distribution.


## Scripts

```bash
npm run dev        # run with reload (tsx watch)
npm start          # run once
npm run sync:rumi  # one-off full Rumi backfill + embed (initial setup / re-embed)
npm run tunnel     # ngrok on the reserved static domain (local dev)
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```
