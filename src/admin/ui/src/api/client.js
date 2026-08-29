/**
 * ============================================
 * ANITOKU AGENT — HTTP client
 * ============================================
 *
 * The panel and the agent share an origin, so the session cookie travels
 * automatically — there is no token to juggle. A 401 means the session
 * lapsed, and the only sane response is to show the login screen again.
 *
 * `silent: true` skips the global loading indicator, for polling that would
 * otherwise make the bar flicker every few seconds.
 */

const listeners = new Set();
let inFlight = 0;

/** Subscribe to loading state (used by the top progress bar). */
export function onLoading(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn(inFlight > 0));

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, silent = false, signal } = {}) {
  if (!silent) {
    inFlight++;
    emit();
  }
  try {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (res.status === 401) {
      window.location.href = '/login';
      throw new ApiError('unauthorized', 401);
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(`Serverdan notoʻgʻri javob (${res.status})`, res.status);
    }
    if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
    return data;
  } finally {
    if (!silent) {
      inFlight = Math.max(0, inFlight - 1);
      emit();
    }
  }
}

export const api = {
  get: (path, opts) => request(path, { ...opts }),
  post: (path, body, opts) => request(path, { method: 'POST', body, ...opts }),
  del: (path, opts) => request(path, { method: 'DELETE', ...opts }),
};

/** Log stream over server-sent events; returns an unsubscribe function. */
export function streamLogs(onEntry) {
  const es = new EventSource('/api/logs/stream');
  es.onmessage = (e) => {
    try {
      onEntry(JSON.parse(e.data));
    } catch {
      /* a malformed frame must not kill the stream */
    }
  };
  return () => es.close();
}

export async function logout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}
