import { type BoardConfig, type Card, defaultBoardConfig } from '@repoboard/core';
import { render } from '@testing-library/react';
import { App } from '../src/App.jsx';
import { createMockTransport } from '../src/mock/index.js';
import { createStore, type Store } from '../src/store.js';
import type { ClientMessage, LeasesPayload, LogPayload, StatePayload } from '../src/wire.js';

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

export function snapshot(
  store: Store,
  cards: Card[],
  config: BoardConfig = defaultBoardConfig(),
  /** P7.2. Omit to send a payload with no `hasBoard` at all (a pre-P7.2 server). */
  hasBoard?: boolean,
  /** P8.2. Omit to send a payload with no `leases` at all (a pre-P8.2 server; reads as empty). */
  leases?: LeasesPayload,
  /** P8.3. Omit to send a payload with no `state` at all (before any STATE.md exists). */
  state?: StatePayload,
  /** P8.3. Omit to send a payload with no `log` at all. */
  log?: LogPayload,
) {
  const board = hasBoard === undefined ? { config, cards } : { config, cards, hasBoard };
  store.dispatch({
    type: 'snapshot',
    board,
    repo: null,
    ...(leases ? { leases } : {}),
    ...(state ? { state } : {}),
    ...(log ? { log } : {}),
  });
}

export function emptyLeases(): LeasesPayload {
  return { leases: [], windows: [], stale: [], now: '2026-09-02T22:41:10Z' };
}

export function emptyState(): StatePayload {
  return { stamp: null, actor: null, sections: null, ownerQueue: [], text: null };
}

export function mockState(overrides: Partial<StatePayload> = {}): StatePayload {
  return {
    stamp: '2026-09-02T22:41:10Z',
    actor: 'claude/p8-3',
    sections: {
      live: 'Tree is dev.',
      lastLandings: 'K117 landed.',
      seats: 'ops watching.',
    },
    ownerQueue: [],
    text: '# STATE',
    ...overrides,
  };
}

export function renderApp(store: Store) {
  return render(<App store={store} />);
}
