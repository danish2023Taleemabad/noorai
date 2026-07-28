import type { Request, Response } from 'express';
import { config } from '../config.js';
import { CallSession } from '../bridge/call-session.js';
import { acceptCall, preAcceptCall, terminateCall } from './calls-api.js';
import { logCallStart, logCallEnd } from '../db.js';
import { summarizeAndStore } from '../memory.js';

/**
 * WhatsApp webhook: GET verifies the endpoint (hub.challenge), POST receives
 * events. We only act on the `calls` field: a `connect` event (incoming call
 * with an SDP offer) opens a bridge and accepts; `terminate` tears it down.
 */

// Live calls, keyed by WhatsApp call id.
const sessions = new Map<string, CallSession>();

export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
};

interface WhatsAppCallEvent {
  id: string;
  from?: string;
  event?: string; // 'connect' | 'terminate' | ...
  status?: string; // e.g. 'RINGING' | 'ACCEPTED' | 'COMPLETED' | 'FAILED'
  duration?: number; // seconds, present on some terminate events
  session?: { sdp_type?: string; sdp?: string };
}

const handleCallEvent = async (
  call: WhatsAppCallEvent,
  callerName?: string,
): Promise<void> => {
  const tag = `[call ${call.id}]`;

  switch (call.event) {
    case 'connect': {
      if (!call.session?.sdp) {
        console.warn(`${tag} connect event with no SDP offer — ignoring`);
        return;
      }
      console.log(
        `${tag} ▶ connect from ${call.from}` +
          (callerName ? ` (${callerName})` : ''),
      );

      // Clean slate: forcibly tear down ANY existing session before starting a
      // new one. This is the number's single call line, so any lingering session
      // is stale (e.g. a prior `terminate` was missed or its id didn't match).
      // Guarantees each caller gets a fresh, isolated session — no previous
      // caller's audio/state can bleed in.
      if (sessions.size > 0) {
        console.log(`${tag} clearing ${sessions.size} stale session(s)`);
        for (const [id, stale] of sessions) {
          stale.close();
          sessions.delete(id);
        }
      }

      const session = new CallSession(call.id, call.from ?? 'unknown', callerName);
      sessions.set(call.id, session);

      // Log the call start (fire-and-forget; no-op if DB not configured).
      void logCallStart({
        waCallId: call.id,
        callerName,
        callerNumber: call.from,
        startedAt: new Date(),
      });

      const startedAt = Date.now();
      try {
        const sdpAnswer = await session.createAnswer(call.session.sdp);
        console.log(`${tag} SDP answer ready (${Date.now() - startedAt}ms)`);

        // pre_accept warms the media path so audio flows the instant we accept.
        // If it fails we still try accept (pre_accept is an optimization).
        try {
          await preAcceptCall(call.id, sdpAnswer);
          console.log(`${tag} pre-accepted`);
        } catch (err) {
          console.warn(`${tag} pre_accept failed (continuing):`, String(err));
        }

        await acceptCall(call.id, sdpAnswer);
        console.log(`${tag} ✅ accepted (setup ${Date.now() - startedAt}ms)`);
      } catch (err) {
        console.warn(`${tag} ❌ failed to accept:`, String(err));
        session.close();
        sessions.delete(call.id);
        await terminateCall(call.id).catch(() => undefined);
      }
      return;
    }

    case 'terminate': {
      const session = sessions.get(call.id);
      // Grab the transcript + number BEFORE closing the session.
      const transcript = session?.getTranscriptText();
      const number = session?.fromNumber ?? call.from;
      session?.close();
      sessions.delete(call.id);

      void logCallEnd({
        waCallId: call.id,
        endedAt: new Date(),
        durationSeconds: call.duration,
        status: call.status,
        transcript,
      });

      // Fold this call into the caller's rolling memory (async, off the live
      // path; no-op if DB disabled or transcript empty).
      if (number && transcript) void summarizeAndStore(number, transcript);

      console.log(
        `${tag} ⏹ terminated${call.status ? ` (status=${call.status})` : ''}` +
          (call.duration != null ? ` duration=${call.duration}s` : ''),
      );
      return;
    }

    default:
      // Any other call lifecycle event (ringing, status updates, etc.).
      console.log(`${tag} event=${call.event ?? '(none)'} status=${call.status ?? '-'}`);
  }
};

export const receiveWebhook = (req: Request, res: Response): void => {
  // Ack immediately — Meta expects a fast 200; call setup runs async.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        // Log the raw call-related payload — invaluable for first live testing
        // (shows the exact event shape, the caller-name field, SDP presence).
        if (value.calls) {
          console.log(
            `[webhook] field=${change.field} value=${JSON.stringify(value).slice(0, 1500)}`,
          );
        }
        // WhatsApp includes the caller's profile name in `contacts[].profile.name`,
        // keyed by wa_id. Build a lookup so Noor can greet by name.
        const nameByWaId = new Map<string, string>();
        for (const contact of value.contacts ?? []) {
          const waId = contact?.wa_id;
          const name = contact?.profile?.name;
          if (waId && name) nameByWaId.set(String(waId), String(name));
        }
        const calls: WhatsAppCallEvent[] = value.calls ?? [];
        for (const call of calls) {
          const callerName =
            (call.from && nameByWaId.get(String(call.from))) ||
            // Some payloads carry the name on the call object itself.
            (call as { contact?: { profile?: { name?: string } } }).contact
              ?.profile?.name;
          void handleCallEvent(call, callerName);
        }
      }
    }
  } catch (err) {
    console.warn('[webhook] parse error', String(err));
  }
};

export const activeCallCount = (): number => sessions.size;
