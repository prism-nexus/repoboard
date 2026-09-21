/**
 * RCB-69: the server sends `{type:'error', id, message}` for a refused `card:move` (a decided
 * card headed back into a decision column) and `{type:'warning', id, message}` for an allowed
 * one (a never-asked card). Before this, `wire.ts`'s `ServerMessage` union had neither and
 * `store.ts`'s `switch (msg.type)` silently dropped both — a refused drag sat optimistically
 * moved until the echo timeout snapped it back with the generic "did not reach disk" toast.
 */
import { describe, expect, it, vi } from 'vitest';
import { card, snapshot, testStore } from './helpers.jsx';

describe('server error/warning on a pending move (RCB-69)', () => {
  it('an error for a pending move snaps the card back immediately (no timeout wait) and toasts the message', () => {
    const store = testStore({ echoTimeoutMs: 3000 });
    snapshot(store, [card('RB-1', 'todo')]);
    store.moveCard('RB-1', 'decide');
    expect(store.getState().cards[0]?.status).toBe('decide');

    store.dispatch({
      type: 'error',
      id: 'RB-1',
      message:
        'card RB-1 was decided A by human/matt at 2026-09-19T19:09:00Z — a decided card does ' +
        'not go back to "decide"; ask a new question: repoboard card ask RB-1 "<question>" ' +
        '[--option ...] | --task',
    });

    // Snapped back immediately — no need to advance any timer.
    expect(store.getState().cards[0]?.status).toBe('todo');
    expect(store.getState().toasts.map((t) => t.text)).toEqual([
      'card RB-1 was decided A by human/matt at 2026-09-19T19:09:00Z — a decided card does not ' +
        'go back to "decide"; ask a new question: repoboard card ask RB-1 "<question>" ' +
        '[--option ...] | --task',
    ]);
  });

  it('a warning for a pending move keeps the optimistic move and toasts the message', () => {
    vi.useFakeTimers();
    try {
      const store = testStore({ echoTimeoutMs: 3000 });
      snapshot(store, [card('RB-1', 'todo')]);
      store.moveCard('RB-1', 'decide');
      expect(store.getState().cards[0]?.status).toBe('decide');

      store.dispatch({
        type: 'warning',
        id: 'RB-1',
        message:
          'card RB-1 moved into "decide" with no open ask — start the discussion: repoboard ' +
          'card ask RB-1 "<question>" [--option ...] | --task',
      });

      // The move is left as-is (still pending, the echo will confirm it); the warning just toasts.
      expect(store.getState().cards[0]?.status).toBe('decide');
      expect(store.getState().toasts.map((t) => t.text)).toEqual([
        'card RB-1 moved into "decide" with no open ask — start the discussion: repoboard card ' +
          'ask RB-1 "<question>" [--option ...] | --task',
      ]);

      // And the pending timer is still armed — an echo (or a later error) still resolves it.
      vi.advanceTimersByTime(3000);
      expect(store.getState().cards[0]?.status).toBe('todo'); // snapped back: no echo ever arrived
    } finally {
      vi.useRealTimers();
    }
  });

  it('an error with an id that is not pending just toasts — nothing to snap back', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    store.dispatch({ type: 'error', id: 'RB-1', message: 'some unrelated failure' });
    expect(store.getState().cards[0]?.status).toBe('todo');
    expect(store.getState().toasts.map((t) => t.text)).toEqual(['some unrelated failure']);
  });
});
