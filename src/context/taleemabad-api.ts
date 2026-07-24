import { config } from '../config.js';

/**
 * Client for the Taleemabad backend — the SAME APIs the app uses for lesson
 * plans, timetable and teacher-training data.
 *
 * ⚠️ OPEN ITEM — caller identity & auth:
 * In the browser app this data comes from the logged-in user's Dexie cache,
 * populated by the `sync-*` endpoints using that user's JWT. On a WhatsApp call
 * there is no logged-in session — we only know the caller's phone number
 * (`from`). To fetch a specific caller's data server-side you must:
 *   1. Map the WhatsApp number -> a Taleemabad user, AND
 *   2. Obtain an auth token for that user (JWT) or use an internal/service API.
 * Neither is defined yet, so for now this client fetches ONLY when a
 * `TALEEMABAD_ACCESS_TOKEN` is configured (single-user / testing), and returns
 * empty otherwise. Noor still works as a general assistant when data is absent.
 *
 * The endpoint paths below mirror the app's api layer
 * (frontend/libs/db/src/api): `/api/v4/sync-school-class-timetable/`,
 * `/api/v1/sync-lesson-plans-detail/`, `/api/v2/sync-courses/`.
 */

const timeoutFetch = async (
  url: string,
  init: RequestInit,
  ms = 8000,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.taleemabad.accessToken) {
    headers.Authorization = `Bearer ${config.taleemabad.accessToken}`;
  }
  return headers;
};

const base = (): string => config.taleemabad.baseUrl.replace(/\/+$/, '');

/** Returns true when we have enough config to attempt authenticated fetches. */
export const canFetchContext = (): boolean =>
  Boolean(config.taleemabad.baseUrl && config.taleemabad.accessToken);

export interface RawContextData {
  timetable: unknown[];
  lessonPlans: unknown[];
  courses: unknown[];
}

/**
 * Best-effort pull of the caller's data. Each source is independent and failures
 * are swallowed so one missing/renamed endpoint never breaks the call.
 *
 * NOTE: the `sync-*` endpoints are offline-sync APIs whose exact request bodies
 * (last-synced cursors etc.) depend on the client. The calls below are a
 * best-effort starting point and will likely need the real sync payloads filled
 * in once caller auth is settled — see the OPEN ITEM above.
 */
export const fetchContextForCaller = async (
  _fromNumber: string,
): Promise<RawContextData> => {
  const empty: RawContextData = { timetable: [], lessonPlans: [], courses: [] };
  if (!canFetchContext()) return empty;

  const getJson = async (path: string): Promise<unknown[]> => {
    try {
      const res = await timeoutFetch(`${base()}${path}`, {
        method: 'GET',
        headers: authHeaders(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as unknown;
      return Array.isArray(data)
        ? data
        : Array.isArray((data as { results?: unknown[] })?.results)
          ? ((data as { results: unknown[] }).results)
          : [];
    } catch {
      return [];
    }
  };

  const [timetable, lessonPlans, courses] = await Promise.all([
    getJson('/api/v4/sync-school-class-timetable/'),
    getJson('/api/v1/sync-lesson-plans-detail/'),
    getJson('/api/v2/sync-courses/'),
  ]);

  return { timetable, lessonPlans, courses };
};
