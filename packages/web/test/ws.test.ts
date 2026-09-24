/**
 * RCB-150: `connectWs` (open/close/reconnect/dispatch) — 18.8% line coverage, no direct test.
 * `ws.ts` reaches the ambient global `WebSocket`, never an import, so stubbing
 * `globalThis.WebSocket` with a small fake class lets `connectWs` run end to end against a fully
 * scripted socket: the test fires `onopen`/`onmessage`/`onclose` itself, never a real network.
 *
 * `FakeWebSocket#close()` synchronously invokes its own `onclose` — mirroring a socket whose
 * close event lands before `close()` returns, which is the only way `transport.close()`'s
 * `closed` flag (ws.ts's `if (closed) return;`) is ever reached: `close()` sets `socket = null`
 * right after calling `socket.close()`, so an onclose that arrived later (after that reassignment)
 * would already be caught by the `socket !== ws` guard instead. A spontaneous remote close (the
 * backoff/stale-socket tests) is fired directly on the instance, without going through `close()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, TransportHandlers } from '../src/wire.js';
import { connectWs, RECONNECT_CAP_MS, reconnectDelay } from '../src/ws.js';

/** `noUncheckedIndexedAccess` makes `arr[i]` an `T | undefined`; this throws instead of the
 * `!` biome's `noNonNullAssertion` forbids — a wrong index fails loudly, not silently. */
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`nth: no element at index ${i} (length ${arr.length})`);
  return v;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }
}

function openInstance(ws: FakeWebSocket) {
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.();
}

function handlers() {
  return {
    onMessage: vi.fn((_msg: ServerMessage) => {}),
    onConnected: vi.fn((_connected: boolean) => {}),
  } satisfies TransportHandlers;
}

// Fixed at 0.5: `jitter = base * 0.2 * (random() * 2 - 1)` is exactly 0 there, so every delay
// below is deterministic (matches `test/markdown.test.ts`'s `noJitter`).
const noJitter = () => 0.5;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // Never let a stray call reach a real network; a test that cares about the backfill fetch
  // overrides this with its own stub.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch not stubbed'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connectWs: open + events backfill', () => {
  it('open dispatches onConnected(true) and backfills the primary socket from /api/events, last 20 only', async () => {
    const events = Array.from({ length: 25 }, (_, i) => ({ n: i }));
    const fetchMock = vi.fn(async (_path: string) => ({ ok: true, json: async () => events }));
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();

    connectWs(h, 'ws://localhost/ws');
    openInstance(nth(FakeWebSocket.instances, 0));

    expect(h.onConnected).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(h.onMessage).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledWith('/api/events');
    expect(h.onMessage).toHaveBeenCalledTimes(20);
    expect(h.onMessage.mock.calls.map((c) => (c[0] as { event: unknown }).event)).toEqual(
      events.slice(-20),
    );
    expect(nth(nth(h.onMessage.mock.calls, 0), 0)).toMatchObject({ type: 'event' });
  });

  it('a repo socket (/api/repos/<key>/ws) backfills from /api/repos/<key>/events', async () => {
    const events = [{ n: 1 }];
    const fetchMock = vi.fn(async (_path: string) => ({ ok: true, json: async () => events }));
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();

    connectWs(h, 'ws://localhost/api/repos/fpj/ws');
    openInstance(nth(FakeWebSocket.instances, 0));
    // Wait for the dispatch itself — `fetch` is called a few microtasks before its chain settles.
    await vi.waitFor(() =>
      expect(h.onMessage).toHaveBeenCalledWith({ type: 'event', event: { n: 1 } }),
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/repos/fpj/events');
  });
});

describe('connectWs: message dispatch', () => {
  it('a valid JSON message with a string `type` calls onMessage with the parsed value', () => {
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');
    const ws = nth(FakeWebSocket.instances, 0);

    ws.onmessage?.({ data: JSON.stringify({ type: 'card:removed', id: 'RB-1' }) });

    expect(h.onMessage).toHaveBeenCalledWith({ type: 'card:removed', id: 'RB-1' });
  });

  it('invalid JSON is dropped silently', () => {
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');
    const ws = nth(FakeWebSocket.instances, 0);

    ws.onmessage?.({ data: '{not json' });

    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it('{} parses but has no string `type` — isServerMessage rejects it, so onMessage never fires', () => {
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');
    const ws = nth(FakeWebSocket.instances, 0);

    ws.onmessage?.({ data: '{}' });

    expect(h.onMessage).not.toHaveBeenCalled();
  });
});

describe('connectWs: reconnect backoff', () => {
  it('onclose fires onConnected(false); a new socket appears only once the backoff delay elapses', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');
    const first = nth(FakeWebSocket.instances, 0);

    first.onclose?.();
    expect(h.onConnected).toHaveBeenCalledWith(false);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const delay = reconnectDelay(0, noJitter);
    vi.advanceTimersByTime(delay - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('backoff grows across consecutive failures and resets to attempt 0 after a successful open', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');

    // attempt 0 fails -> scheduled at reconnectDelay(0), attempt becomes 1
    nth(FakeWebSocket.instances, 0).onclose?.();
    const d0 = reconnectDelay(0, noJitter);
    vi.advanceTimersByTime(d0);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // attempt 1 fails too (never opened) -> scheduled at reconnectDelay(1), strictly longer
    nth(FakeWebSocket.instances, 1).onclose?.();
    const d1 = reconnectDelay(1, noJitter);
    expect(d1).toBeGreaterThan(d0);
    vi.advanceTimersByTime(d1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // this one opens successfully, resetting attempt to 0, then fails again
    openInstance(nth(FakeWebSocket.instances, 2));
    nth(FakeWebSocket.instances, 2).onclose?.();
    const d2 = reconnectDelay(0, noJitter);
    expect(d2).toBe(d0); // back to the attempt-0 delay, not a continuation of d1's growth

    vi.advanceTimersByTime(d2 - 1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('close() suppresses the reconnect scheduled by its own onclose — no new socket, ever', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = handlers();
    const transport = connectWs(h, 'ws://localhost/ws');

    transport.close(); // synchronously fires the socket's own onclose (see file header)

    expect(h.onConnected).toHaveBeenCalledWith(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(10 * RECONNECT_CAP_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a late onclose from a socket already superseded by a newer one is ignored', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = handlers();
    connectWs(h, 'ws://localhost/ws');
    const first = nth(FakeWebSocket.instances, 0);

    first.onclose?.(); // spontaneous remote close, not via transport.close()
    vi.advanceTimersByTime(reconnectDelay(0, noJitter));
    expect(FakeWebSocket.instances).toHaveLength(2); // the reconnect created a second socket

    expect(h.onConnected).toHaveBeenCalledTimes(1);
    first.onclose?.(); // the old (first) socket's close event arrives late

    expect(h.onConnected).toHaveBeenCalledTimes(1); // not called again for the stale event
    vi.advanceTimersByTime(10 * RECONNECT_CAP_MS);
    expect(FakeWebSocket.instances).toHaveLength(2); // and no extra reconnect was scheduled from it
  });
});

describe('connectWs: send', () => {
  it('send only writes to the socket while readyState === OPEN', () => {
    const h = handlers();
    const transport = connectWs(h, 'ws://localhost/ws');
    const ws = nth(FakeWebSocket.instances, 0);
    const msg = { type: 'card:move', id: 'RB-1', status: 'todo' } as const;

    transport.send(msg); // still CONNECTING
    expect(ws.sent).toHaveLength(0);

    openInstance(ws);
    transport.send(msg);
    expect(ws.sent).toEqual([JSON.stringify(msg)]);

    ws.readyState = FakeWebSocket.CLOSED;
    transport.send(msg);
    expect(ws.sent).toHaveLength(1); // unchanged — no longer OPEN
  });
});
