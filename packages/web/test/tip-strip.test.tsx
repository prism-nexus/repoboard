/**
 * RCB-149: the tip strip's show/hide rule (`Board.tsx`: `cards.length <= 1 && !tipDismissed`) and
 * its dismissal (`Store.dismissTip()`, `store.ts#STORAGE_TIP`).
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockTransport } from '../src/mock/index.js';
import { createStore, STORAGE_TIP } from '../src/store.js';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('TipStrip', () => {
  it('0 cards: the strip shows', () => {
    const store = testStore();
    snapshot(store, []);
    renderApp(store);
    expect(screen.getByTestId('tip-strip')).toBeInTheDocument();
  });

  it('1 card: the strip shows', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    expect(screen.getByTestId('tip-strip')).toBeInTheDocument();
  });

  it('2 cards: the strip is absent', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo'), card('RB-2', 'todo')]);
    renderApp(store);
    expect(screen.queryByTestId('tip-strip')).toBeNull();
  });

  it('dismissing: the strip disappears and the choice is written to storage', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const store = createStore(createMockTransport({ tick: null }), { storage });
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByTestId('tip-strip')).toBeNull();
    expect(store.getState().tipDismissed).toBe(true);
    expect(mem.get(STORAGE_TIP)).toBe('dismissed');
  });

  it('a store created with the dismissal already in storage: the strip never shows', () => {
    const mem = new Map<string, string>([[STORAGE_TIP, 'dismissed']]);
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const store = createStore(createMockTransport({ tick: null }), { storage });
    snapshot(store, []);
    renderApp(store);
    expect(screen.queryByTestId('tip-strip')).toBeNull();
  });
});
