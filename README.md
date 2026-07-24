# Noor — WhatsApp Voice Agent

Noor answers **WhatsApp voice calls** and talks to the caller using the **OpenAI
Realtime API**. A WhatsApp user calls your business number; Noor picks up and
has a natural spoken conversation, with the same model/voice/latency settings as
the in-app browser voice agent.

It reuses the browser agent's behaviour (model `gpt-realtime-2.1`, voice `marin`,
`reasoning.effort: minimal`, `server_vad` turn detection), rebranded to **Noor**,
and can surface lesson-plan / timetable / training context from the Taleemabad
backend APIs.

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
   ├─ @roamhq/wrtc peer  ── caller audio (PCM 48k) ─► downsample 24k ─► OpenAI Realtime (WS)
   └─ OpenAI Realtime  ── Noor audio (PCM 24k) ─► upsample 48k ─► wrtc peer ─► caller
```

- **`src/whatsapp/webhook.ts`** — verifies the webhook, handles `connect` /
  `terminate` call events.
- **`src/whatsapp/calls-api.ts`** — `POST /{PHONE_NUMBER_ID}/calls` (accept /
  pre_accept / reject / terminate).
- **`src/bridge/call-session.ts`** — one WebRTC peer per call, bridged to…
- **`src/bridge/openai-realtime.ts`** — the OpenAI Realtime WebSocket session
  (Noor's settings live here).
- **`src/bridge/audio.ts`** — PCM16 48k↔24k resampling + base64 helpers.
- **`src/context/`** — builds Noor's prompt and (optionally) pulls lesson-plan /
  timetable / training data from the backend.

---

## Setup

### 1. Install

```bash
cd noor-whatsapp-voice-agent
npm install
```

> `@roamhq/wrtc` is a native module — it downloads a prebuilt binary. If install
> fails on your platform you may need build tools (Windows: "Desktop development
> with C++"; or use WSL/Linux).

### 2. Configure

Secrets already live in `.env` (git-ignored). Confirm/adjust:

| Var | Meaning |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Your PHID (`1240650455798073`) |
| `WHATSAPP_ACCESS_TOKEN` | Meta access token |
| `WHATSAPP_VERIFY_TOKEN` | **You choose** — must match the Meta webhook UI |
| `OPENAI_API_KEY` | OpenAI key (reused from the app) |
| `OPENAI_REALTIME_MODEL` / `_VOICE` / `_REASONING_EFFORT` / `_VAD_SILENCE_MS` | Same as the browser agent |
| `TALEEMABAD_BASE_URL` / `TALEEMABAD_ACCESS_TOKEN` | Backend for context data |

### 3. Run + expose

Two terminals (the tunnel uses the reserved static ngrok domain, so the public
URL never changes):

```bash
npm run dev        # terminal 1 — server on :8080
npm run tunnel     # terminal 2 — ngrok on your static domain
```

Stable public webhook URL:
```
https://reliance-conical-karate.ngrok-free.dev/webhook
```

> ngrok binary lives at `C:\Users\danis\Downloads\ngrok\ngrok.exe` and the
> authtoken is already saved in `%LOCALAPPDATA%\ngrok\ngrok.yml`. The static
> domain is reserved to your ngrok account, so `npm run tunnel` always gives the
> same URL — you only paste it into Meta once.

### 4. Wire up Meta (one time)

1. Meta app → **WhatsApp → Configuration → Webhooks**:
   - **Callback URL:** `https://reliance-conical-karate.ngrok-free.dev/webhook`
   - **Verify token:** value of `WHATSAPP_VERIFY_TOKEN` in `.env`
   - **Verify and Save**, then subscribe to the **`calls`** field.
2. **Enable Calling** on your business phone number (WhatsApp → Phone Numbers →
   Calling). The webhook prerequisite is now satisfied, so it won't block.
3. Place a WhatsApp voice call **to** your business number — Noor answers.

---

## Greeting by name

Noor addresses the caller by their **WhatsApp profile name**, taken from the
webhook (`value.contacts[].profile.name`, matched to the caller's `wa_id`). No
authentication is needed for this — it comes free in the call webhook. If the
name is absent, Noor greets generically.

## Context data (lesson plans / timetable / training) — optional

The browser app reads this from the logged-in user's offline cache. On a phone
call there is **no logged-in session** — we only know the caller's number and
name. Fetching a specific caller's lesson-plan/timetable data is therefore
optional and, if you want it, needs:

1. **Caller → user mapping**: WhatsApp `from` number → a Taleemabad user.
2. **Auth**: a JWT for that user, or an internal/service API, to call the
   `sync-*` endpoints (`/api/v4/sync-school-class-timetable/`,
   `/api/v1/sync-lesson-plans-detail/`, `/api/v2/sync-courses/`).

Until that's decided, `src/context/taleemabad-api.ts` fetches **only** when
`TALEEMABAD_ACCESS_TOKEN` is set (single-user / testing); otherwise Noor runs as
a general assistant. The endpoint paths mirror the app's api layer, but the
`sync-*` request bodies may need the real sync cursors filled in.

---

## Status / honest limitations

- **Built, not yet call-tested.** The WhatsApp WebRTC↔OpenAI media bridge is
  implemented but has **not** been verified against a real WhatsApp call (that
  needs a public webhook, Calling enabled on the number, and a live call). Expect
  to iterate on SDP/ICE and audio framing once you test on-device.
- **Access token** in `.env` is short-lived unless you swap in a permanent/System
  User token. If calls stop authorizing, refresh it.
- **Codec**: assumes Opus at 48 kHz via `@roamhq/wrtc` (it transcodes to/from
  PCM for us). If WhatsApp negotiates PCMA/PCMU in your region, the bridge may
  need codec handling.
- This is a **backend service** — there is no UI. Noor's "voice" and behaviour
  are configured entirely via `.env` + the prompt in
  `src/context/build-noor-context.ts`.

---

## Scripts

```bash
npm run dev        # run with reload (tsx watch)
npm start          # run once
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```
