import { config } from '../config.js';

/**
 * Thin client for the WhatsApp Business Calling API call-control endpoint:
 *   POST /{PHONE_NUMBER_ID}/calls
 * with an `action` of pre_accept | accept | reject | terminate.
 * Docs: developers.facebook.com/docs/whatsapp/cloud-api/calling
 */

const callsUrl = (): string =>
  `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/calls`;

const post = async (body: Record<string, unknown>): Promise<unknown> => {
  const res = await fetch(callsUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    console.warn('[whatsapp] calls API error', res.status, JSON.stringify(json));
  }
  return json;
};

/** Accept the call, handing WhatsApp our SDP answer so media can flow. */
export const acceptCall = (callId: string, sdpAnswer: string): Promise<unknown> =>
  post({
    call_id: callId,
    action: 'accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
  });

/** Optional low-latency handshake step before `accept`. */
export const preAcceptCall = (
  callId: string,
  sdpAnswer: string,
): Promise<unknown> =>
  post({
    call_id: callId,
    action: 'pre_accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
  });

export const rejectCall = (callId: string): Promise<unknown> =>
  post({ call_id: callId, action: 'reject' });

export const terminateCall = (callId: string): Promise<unknown> =>
  post({ call_id: callId, action: 'terminate' });
