/**
 * RCB-43 slice 3: the top-bar repo selector, the store's `repoKey`-scoped fetches, and the
 * unknown-key fallback. See `docs/RCB-43-MULTIROOT-BRIEF.md` §"Slice 3 — detailed brief".
 *
 * `GET /api/repos` is fetched once by the store's `connect()` (`store.ts`'s `loadRepos`), so
 * every test here stubs `fetch` and calls `store.connect()`, then waits for `state.repos` to
 * land before rendering or asserting — no real WS: `connect()`'s transport factory is a
 * do-nothing stub (or a spy, when the test cares what URL it was given), never the shared
 * `createMockTransport` (which uses real timers and would make these tests racy).
 */
import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.jsx';
import { createStore, type Store } from '../src/store.js';
import type { ReposPayload, Transport, TransportHandlers } from '../src/wire.js';
import { card } from './helpers.jsx';

afterEach(() => vi.unstubAllGlobals());

function memStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  };
}

/** A transport factory that never delivers anything, and records the URL it was opened with. */
function stubFactory(): {
  factory: (h: TransportHandlers, url?: string) => Transport;
  urls: (string | undefined)[];
} {
  const urls: (string | undefined)[] = [];
  const factory = (_handlers: TransportHandlers, url?: string): Transport => {
    urls.push(url);
    return { send() {}, close() {} };
  };
  return { factory, urls };
}

function makeStore(repoKey: string | null): { store: Store; urls: (string | undefined)[] } {
  const { factory, urls } = stubFactory();
  const store = createStore(factory, { repoKey, storage: memStorage() });
  return { store, urls };
}

function reposPayload(overrides: Partial<ReposPayload> = {}): ReposPayload {
  return {
    primary: 'remember-connect-build',
    repos: [
      {
        key: 'remember-connect-build',
        root: '/repos/rcb',
        name: 'Remember Connect Build',
        hasBoard: true,
        open: true,
        scanned: true,
      },
      {
        key: 'b',
        root: '/repos/fpj',
        name: 'Fresh Picked Jobs',
        hasBoard: true,
        open: false,
        scanned: false,
      },
    ],
    ...overrides,
  };
}

function onlyPrimary(): ReposPayload {
  const p = reposPayload();
  return { primary: p.primary, repos: p.repos.slice(0, 1) };
}

function repo(): RepoSnapshot {
  return {
    root: '/repos/fpj',
    scannedAt: '2026-09-02T22:00:00Z',
    files: [
      {
        path: 'a.ts',
        bytes: 10,
        lines: 1,
        lang: 'typescript',
        commits30d: 0,
        commits90d: 0,
        lastCommitAt: null,
      },
    ],
    edges: [],
    languages: {},
    head: null,
  };
}

/** jsdom's `window.location` is non-configurable, so `vi.spyOn` cannot redefine `assign` on it;
 * stub the whole global instead (`vi.unstubAllGlobals` in `afterEach` restores it). */
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  return assign;
}

/** Records every fetched URL; `routes` answers by exact URL (falls back to `{}`). */
function stubFetch(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => routes[url] ?? {},
    };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

async function waitForRepos(store: Store): Promise<void> {
  await waitFor(() => expect(store.getState().repos).not.toBeNull());
}

describe('repo selector (RCB-43 slice 3)', () => {
  it('renders with two options, current = primary when no key', async () => {
    stubFetch({ '/api/repos': reposPayload() });
    const { store } = makeStore(null);
    store.connect();
    await waitForRepos(store);

    render(<App store={store} />);
    const select = (await screen.findByRole('combobox', { name: /repo/i })) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    expect(select.value).toBe('remember-connect-build');
  });

  it('is hidden with one repo — a one-repo server shows nothing new', async () => {
    stubFetch({ '/api/repos': onlyPrimary() });
    const { store } = makeStore(null);
    store.connect();
    await waitForRepos(store);

    render(<App store={store} />);
    expect(screen.queryByRole('combobox', { name: /repo/i })).toBeNull();
  });

  it('scopes every store fetch and the cost tile fetch to repoKey, and opens the scoped WS', async () => {
    const calls = stubFetch({
      '/api/repos': reposPayload(),
      '/api/repos/b/cost': {
        entries: [],
        totalBytes: 0,
        totalTokensApprox: 0,
        claudeMdBytes: null,
        budget: 8192,
        over: false,
        mcpServers: [],
        mcpNote: 'note',
      },
      '/api/repos/b/cards/RB-1/decide': card('RB-1', 'todo'),
      '/api/repos/b/archive': { archived: [] },
    });
    const { store, urls } = makeStore('b');
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')] },
      repo: repo(),
    });
    store.connect();
    await waitForRepos(store);
    expect(urls[0]).toBe('/api/repos/b/ws');

    await store.archiveDone();
    await store.decideCard('RB-1', { letter: 'A' });
    await store.saveColumns(defaultBoardConfig().columns);

    store.setView('map');
    render(<App store={store} />);
    await screen.findByTestId('cost-tile');

    expect(calls).toContain('/api/repos/b/archive');
    expect(calls).toContain('/api/repos/b/cards/RB-1/decide');
    expect(calls).toContain('/api/repos/b/board');
    expect(calls).toContain('/api/repos/b/cost');
  });

  it('onChange navigates via window.location.assign; back to primary strips the query', async () => {
    stubFetch({ '/api/repos': reposPayload() });
    const assign = stubLocationAssign();
    const { store } = makeStore(null);
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo(),
    });
    store.connect();
    await waitForRepos(store);

    render(<App store={store} />);
    const select = (await screen.findByRole('combobox', { name: /repo/i })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'b' } });
    expect(assign).toHaveBeenCalledWith('/?repo=b');

    fireEvent.change(select, { target: { value: 'remember-connect-build' } });
    expect(assign).toHaveBeenLastCalledWith('/');
  });

  it('an unknown ?repo= toasts and navigates to the primary', async () => {
    stubFetch({ '/api/repos': reposPayload() });
    const assign = stubLocationAssign();
    const { store } = makeStore('nope');
    store.connect();
    await waitForRepos(store);

    expect(store.getState().toasts.some((t) => t.text.includes('unknown repo'))).toBe(true);
    expect(assign).toHaveBeenCalledWith('/');
  });
});
