import { defaultBoardConfig } from '@repoboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { columnsWithCards } from '../src/store.js';
import { handleDragEnd, resolveDropStatus } from '../src/views/Board.jsx';
import { card, snapshot, testStore } from './helpers.jsx';

describe('drop handler (P3.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends card:move with the target column on drop', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    handleDragEnd(store, { active: { id: 'RB-1' }, over: { id: 'doing' } } as never);
    expect(store.sent).toEqual([{ type: 'card:move', id: 'RB-1', status: 'doing' }]);
    expect(store.getState().cards[0]?.status).toBe('doing');
  });

  it("resolves a drop onto another card to that card's column", () => {
    const cols = columnsWithCards(defaultBoardConfig(), [
      card('RB-1', 'todo'),
      card('RB-2', 'review'),
    ]);
    expect(resolveDropStatus('RB-2', cols)).toBe('review');
    expect(resolveDropStatus('review', cols)).toBe('review');
    expect(resolveDropStatus('nope', cols)).toBeNull();
    expect(resolveDropStatus(null, cols)).toBeNull();
  });

  it('does nothing when dropped back on its own column', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    handleDragEnd(store, { active: { id: 'RB-1' }, over: { id: 'todo' } } as never);
    expect(store.sent).toEqual([]);
  });

  it('snaps back with a toast when no card echo arrives within the timeout', () => {
    const store = testStore({ echoTimeoutMs: 3000 });
    snapshot(store, [card('RB-1', 'todo')]);
    store.moveCard('RB-1', 'doing');
    expect(store.getState().cards[0]?.status).toBe('doing');
    vi.advanceTimersByTime(2999);
    expect(store.getState().cards[0]?.status).toBe('doing');
    vi.advanceTimersByTime(1);
    expect(store.getState().cards[0]?.status).toBe('todo');
    expect(store.getState().toasts.map((t) => t.text)).toEqual([
      'Move of RB-1 did not reach disk — snapped back',
    ]);
  });

  it('keeps the move when the echo arrives in time', () => {
    const store = testStore({ echoTimeoutMs: 3000 });
    const c = card('RB-1', 'todo');
    snapshot(store, [c]);
    store.moveCard('RB-1', 'doing');
    vi.advanceTimersByTime(500);
    store.dispatch({ type: 'card', card: { ...c, status: 'doing' } });
    vi.advanceTimersByTime(5000);
    expect(store.getState().cards[0]?.status).toBe('doing');
    expect(store.getState().toasts).toEqual([]);
  });
});
