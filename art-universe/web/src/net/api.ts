import type {
  ArtworkDetail, MyUniverse, ReactionKind, UniverseView, UploadSessionPublic, Visibility
} from '../../../shared/types.js';

const ANON_KEY = 'au.anon';
const ART_KEY_SESSION = 'au.keysession';
const REMEMBERED_KEY = 'au.artkey';

const readLocal = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeLocal = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode — the app works, it just will not remember */
  }
};

/**
 * A random per-browser token. It is not an account and never leaves this
 * device in raw form except to deduplicate reactions and to bucket anonymous
 * analytics — the server only ever stores hashes of it.
 */
function anonToken(): string {
  let token = readLocal(ANON_KEY);
  if (!token) {
    token = crypto.randomUUID();
    writeLocal(ANON_KEY, token);
  }
  return token;
}

export const rememberedArtKey = () => readLocal(REMEMBERED_KEY);
export const rememberArtKey = (key: string | null) => writeLocal(REMEMBERED_KEY, key);
export const keySession = () => readLocal(ART_KEY_SESSION);
export const setKeySession = (token: string | null) => writeLocal(ART_KEY_SESSION, token);
export const hasKey = () => !!keySession() || !!rememberedArtKey();

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { 'x-anon': anonToken(), ...extra };
  const session = keySession();
  if (session) out['x-art-key-session'] = session;
  return out;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: headers({
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...((init.headers as Record<string, string>) ?? {})
    })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? 'request_failed', body);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: unknown = {}) {
    super(code);
    this.name = 'ApiError';
  }
}

export const api = {
  universe: (box: { minX: number; minY: number; maxX: number; maxY: number }, limit = 220) =>
    json<UniverseView>(
      `/api/universe?minX=${box.minX | 0}&minY=${box.minY | 0}&maxX=${box.maxX | 0}&maxY=${box.maxY | 0}&limit=${limit}`
    ),

  around: (ref: string) => json<UniverseView>(`/api/universe/around/${ref}`),

  search: (query: string) =>
    json<UniverseView>('/api/search', { method: 'POST', body: JSON.stringify({ query }) }),

  similar: (ref: string) => json<UniverseView>(`/api/art/${ref}/similar`),

  artwork: (ref: string) => json<ArtworkDetail>(`/api/art/${ref}`),

  react: (ref: string, kind: ReactionKind) =>
    json<{ ok: boolean }>(`/api/art/${ref}/react`, {
      method: 'POST',
      body: JSON.stringify({ kind })
    }),

  report: (ref: string, reason: string) =>
    json<{ ok: boolean }>(`/api/art/${ref}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }),

  startUpload: (input: { visibility: Visibility; respondsTo?: string | null; title?: string | null }) =>
    json<UploadSessionPublic & { token: string }>('/api/upload/session', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  updateUpload: (id: string, token: string, patch: { title?: string | null; visibility?: Visibility }) =>
    json<UploadSessionPublic>(`/api/upload/${id}`, {
      method: 'PATCH',
      headers: { 'x-session-token': token },
      body: JSON.stringify(patch)
    }),

  sendArtwork: (id: string, token: string, file: Blob) =>
    json<UploadSessionPublic>(`/api/upload/${id}/file`, {
      method: 'POST',
      headers: { 'x-session-token': token, 'content-type': file.type || 'application/octet-stream' },
      body: file
    }),

  heartbeat: (id: string, token: string) =>
    json<UploadSessionPublic>(`/api/upload/${id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-session-token': token }
    }),

  cancelUpload: (id: string, token: string) => {
    // Must survive the page going away, so this one is a beacon-style call.
    const url = `/api/upload/${id}/cancel`;
    const blob = new Blob([JSON.stringify({})], { type: 'application/json' });
    if (navigator.sendBeacon && !document.hasFocus()) navigator.sendBeacon(url, blob);
    return fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: headers({ 'x-session-token': token, 'content-type': 'application/json' }),
      body: '{}'
    }).catch(() => undefined);
  },

  returnWithKey: (key: string) =>
    json<{ session: string }>('/api/key/return', {
      method: 'POST',
      body: JSON.stringify({ key })
    }),

  myUniverse: () => json<MyUniverse>('/api/me/universe'),

  updateMine: (ref: string, patch: { title?: string | null; visibility?: Visibility }) =>
    json<unknown>(`/api/me/art/${ref}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  withdraw: (ref: string) => json<unknown>(`/api/me/art/${ref}`, { method: 'DELETE' }),

  assignment: () => json<{ variant: Record<string, unknown> }>('/api/experiments/assignment'),

  events: (events: { name: string; props?: Record<string, unknown> }[]) =>
    fetch('/api/events', {
      method: 'POST',
      keepalive: true,
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ events })
    }).catch(() => undefined)
};

export { anonToken };
