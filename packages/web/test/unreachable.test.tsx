/**
 * RCB-138: launch review #8 — opening the board while `repoboard serve` is not running (or dies
 * before the first snapshot) left `Board.tsx` showing "Waiting for the board…" forever, with no
 * hint the server is gone. `App.tsx`'s "Disconnected… reconnecting" banner does not help: it is
 * gated on `everConnected`, which only covers a DROP *after* the first snapshot, not a server
 * that never answers at all. `store.ts`'s `UNREACHABLE_AFTER_MS` timer, armed by `connect()`, is
 * the only thing that flips `state.unreachable`.
 */
import { defaultBoardConfig } from '@repoboard/core';
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, UNREACHABLE_AFTER_MS } from '../src/store.js';
import { renderApp, snapshot } from './helpers.jsx';

afterEach(() => vi.unstubAllGlobals());

/**
 * A store whose transport never answers — no `onConnected`, no snapshot, ever — so
 * `UNREACHABLE_AFTER_MS` is the only thing that can change `state.unreachable`. `testStore()`
 * (helpers.jsx) uses the mock transport, which answers at 0ms and is therefore never actually
 * unreachable; these tests need a transport that stays silent.
 */
function deadStore() {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  return createStore(() => ({ send() {}, close() {} }), { storage });
}

describe('unreachable server alert (RCB-138)', () => {
  it('stays on "Waiting…" through 4999ms, then shows the alert at 5000ms', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.useFakeTimers();
    try {
      const store = deadStore();
      store.connect();
      renderApp(store);

      act(() => {
        vi.advanceTimersByTime(UNREACHABLE_AFTER_MS - 1);
      });
      expect(screen.getByText('Waiting for the board…')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain("Can't reach the repoboard server");
      expect(store.getState().unreachable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a snapshot before the timer fires means the alert never appears', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.useFakeTimers();
    try {
      const store = deadStore();
      store.connect();
      renderApp(store);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        snapshot(store, [], defaultBoardConfig(), true);
      });

      act(() => {
        vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + 1000);
      });
      // Only the unreachable notice: the dead transport never calls onConnected(true), so App.tsx's
      // "Disconnected" banner (a different alert) legitimately shows once a snapshot has arrived.
      expect(screen.queryByText(/Can't reach the repoboard server/)).toBeNull();
      expect(store.getState().unreachable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a snapshot arriving while the alert is showing clears it and renders the board', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.useFakeTimers();
    try {
      const store = deadStore();
      store.connect();
      renderApp(store);

      act(() => {
        vi.advanceTimersByTime(UNREACHABLE_AFTER_MS);
      });
      expect(screen.getByRole('alert')).toBeTruthy();

      act(() => {
        snapshot(store, [], defaultBoardConfig(), true);
      });
      // Only the unreachable notice: the dead transport never calls onConnected(true), so App.tsx's
      // "Disconnected" banner (a different alert) legitimately shows once a snapshot has arrived.
      expect(screen.queryByText(/Can't reach the repoboard server/)).toBeNull();
      expect(screen.getByTestId('board')).toBeTruthy();
      expect(store.getState().unreachable).toBe(false); // the snapshot itself clears the flag
    } finally {
      vi.useRealTimers();
    }
  });
});
