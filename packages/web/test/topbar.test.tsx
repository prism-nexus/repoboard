/**
 * RCB-41: the repo's display name (`board.yml`'s optional `name:`, else the served folder's
 * name) in the top bar, and `document.title = "<name> · repoboard"` once a connect snapshot has
 * arrived. `helpers.tsx`'s `snapshot()` always sends `repo: null`, so these tests dispatch a
 * `snapshot` message directly (the `map.test.tsx` / `cost-tile.test.tsx` pattern) to carry a real
 * `RepoSnapshot` alongside the config.
 */
import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { card, renderApp, testStore } from './helpers.jsx';

function repo(root: string): RepoSnapshot {
  return {
    root,
    scannedAt: '2026-09-02T22:00:00Z',
    files: [],
    edges: [],
    languages: {},
    head: null,
  };
}

describe('TopBar display name (RCB-41)', () => {
  it('shows the explicit board.yml name', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: {
        config: { ...defaultBoardConfig(), name: 'Fresh Picked Jobs' },
        cards: [card('RB-1', 'todo')],
      },
      repo: repo('/repos/freshpickedjobs'),
    });
    renderApp(store);
    expect(screen.getByText('Fresh Picked Jobs')).toBeTruthy();
    expect(screen.queryByText('freshpickedjobs')).toBeNull();
  });

  it('falls back to the served folder name when board.yml has no name', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')] },
      repo: repo('/repos/freshpickedjobs'),
    });
    renderApp(store);
    expect(screen.getByText('freshpickedjobs')).toBeTruthy();
  });
});

describe('document.title (RCB-41)', () => {
  it('stays the index.html constant before any snapshot', () => {
    document.title = 'repoboard';
    const store = testStore();
    // No dispatch at all yet.
    expect(store.getState().repo).toBeNull();
    expect(document.title).toBe('repoboard');
  });

  it('becomes "<name> · repoboard" once a connect snapshot names the board', () => {
    document.title = 'repoboard';
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: { ...defaultBoardConfig(), name: 'Fresh Picked Jobs' }, cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    expect(document.title).toBe('Fresh Picked Jobs · repoboard');
  });

  it('falls back to the folder name in the title too, when board.yml has no name', () => {
    document.title = 'repoboard';
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    expect(document.title).toBe('freshpickedjobs · repoboard');
  });

  it('updates again on a later `config` message (a live board.yml rename), without a reconnect', () => {
    document.title = 'repoboard';
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    expect(document.title).toBe('freshpickedjobs · repoboard');

    store.dispatch({ type: 'config', config: { ...defaultBoardConfig(), name: 'Renamed Board' } });
    expect(document.title).toBe('Renamed Board · repoboard');
    expect(store.getState().config?.name).toBe('Renamed Board');
  });
});
