/**
 * WebSocket client for /ws (plan §3) with exponential reconnect capped at 10 s.
 * Pure transport: it parses frames and reports connection state, nothing else.
 */
import { isServerMessage, type Transport, type TransportHandlers } from './wire.js';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 10_000;

/** Delay before reconnect attempt `n` (0-based): 500, 1000, 2000 … capped at 10 s, ±20% jitter. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.min(RECONNECT_CAP_MS, Math.round(base + jitter));
}

/** RCB-43 slice 3: `path` defaults to `'/ws'` — the primary's socket, exactly as before this
 * slice — so every existing caller (and test) that omits it is unaffected. A repo-scoped caller
 * passes `repo-key.ts`'s `wsPath(key)` instead. */
export function defaultWsUrl(loc: Location = window.location, path = '/ws'): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

export function connectWs(handlers: TransportHandlers, url: string = defaultWsUrl()): Transport {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      handlers.onConnected(true);
      seedEvents(handlers, eventsPathFromWsUrl(url));
    };
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (isServerMessage(data)) handlers.onMessage(data);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      handlers.onConnected(false);
      if (closed) return;
      timer = setTimeout(open, reconnectDelay(attempt++));
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  };

  open();

  return {
    send(msg) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}

/**
 * RCB-43 slice 3: the events backfill must come from the SAME root as the socket, or a secondary
 * board's ticker opens showing the primary's history. Derived from the WS URL itself rather than
 * passed in separately, so the two cannot disagree: `/ws` → `/api/events`;
 * `/api/repos/<key>/ws` → `/api/repos/<key>/events`. A URL that is neither (a test's `ws://x/`)
 * falls back to the primary's, which is what it meant before.
 */
export function eventsPathFromWsUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return '/api/events';
  }
  if (pathname === '/ws') return '/api/events';
  return /^\/api\/repos\/[^/]+\/ws$/.test(pathname)
    ? pathname.replace(/\/ws$/, '/events')
    : '/api/events';
}

/** The snapshot carries no history; ask HTTP for recent events so the ticker is not blank. */
function seedEvents(handlers: TransportHandlers, path: string): void {
  if (typeof fetch !== 'function') return;
  fetch(path)
    .then((r) => (r.ok ? r.json() : []))
    .then((events: unknown) => {
      if (!Array.isArray(events)) return;
      for (const event of events.slice(-20)) handlers.onMessage({ type: 'event', event });
    })
    .catch(() => {
      // The ticker fills from live events instead.
    });
}
