import { type BoardConfig, type Card, defaultBoardConfig } from '@repoboard/core';
import { render } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { createMockTransport } from '../src/mock/index.js';
import { createStore, type Store } from '../src/store.js';
import type { ClientMessage } from '../src/wire.js';

export function card(id: string, status: string, extra: Partial<Card> = {}): Card {
  return {
    id,
    title: `Card ${id}`,
    status,
    created: '2026-09-02T20:00:00Z',
    updated: '2026-09-02T22:00:00Z',
    body: '',
    ...extra,
  };
}

/** A store with a silent mock transport (no timers), a memory `Storage`, and captured sends. */
export function testStore(
  opts: { echoTimeoutMs?: number } = {},
): Store & { sent: ClientMessage[] } {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  return createStore(createMockTransport({ tick: null }), { storage, ...opts });
}

export function snapshot(store: Store, cards: Card[], config: BoardConfig = defaultBoardConfig()) {
  store.dispatch({ type: 'snapshot', board: { config, cards }, repo: null });
}

export function renderApp(store: Store) {
  return render(<App store={store} />);
}
