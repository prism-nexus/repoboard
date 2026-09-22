/**
 * RCB-41: the repo's display name (`board.yml`'s optional `name:`, else the served folder's
 * name) in the top bar, and `document.title = "<name> · repoboard"` once a connect snapshot has
 * arrived. `helpers.tsx`'s `snapshot()` always sends `repo: null`, so these tests dispatch a
 * `snapshot` message directly (the `map.test.tsx` / `cost-tile.test.tsx` pattern) to carry a real
 * `RepoSnapshot` alongside the config.
 */
import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { act, fireEvent, screen, within } from '@testing-library/react';
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

describe('TopBar siblings (RCB-42)', () => {
  it('renders nothing when there are no siblings — no empty container, no separator', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    const { container } = renderApp(store);
    expect(container.querySelector('.topbar__siblings')).toBeNull();
  });

  it('renders two links with the given names, hrefs, target=_blank, and rel containing noopener', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: {
        config: defaultBoardConfig(),
        cards: [],
        siblings: [
          { name: 'fpj', url: 'http://localhost:4243' },
          { name: 'stable', url: 'http://localhost:4244' },
        ],
      },
      repo: repo('/repos/freshpickedjobs'),
    });
    renderApp(store);
    const fpj = screen.getByRole('link', { name: 'fpj' });
    const stable = screen.getByRole('link', { name: 'stable' });
    expect(fpj.getAttribute('href')).toBe('http://localhost:4243');
    expect(fpj.getAttribute('target')).toBe('_blank');
    expect(fpj.getAttribute('rel')).toContain('noopener');
    expect(stable.getAttribute('href')).toBe('http://localhost:4244');
  });

  it('updates on a later `config` message (a live board.yml edit), without a reconnect', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    const { container } = renderApp(store);
    expect(container.querySelector('.topbar__siblings')).toBeNull();

    act(() =>
      store.dispatch({
        type: 'config',
        config: defaultBoardConfig(),
        siblings: [{ name: 'fpj', url: 'http://localhost:4243' }],
      }),
    );
    expect(screen.getByRole('link', { name: 'fpj' })).toBeTruthy();
  });
});

describe('TopBar Flow tab (RCB-98)', () => {
  it('renders a third tab, and clicking it sets view: "flow"', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    renderApp(store);
    const flowTab = screen.getByRole('button', { name: 'Flow' });
    expect(flowTab.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(flowTab);
    expect(store.getState().view).toBe('flow');
    expect(flowTab.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('TopBar Repo tab (RCB-112 B)', () => {
  it('renders a fourth tab, "Repo", after Flow, and clicking it sets view: "dashboard"', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo('/repos/freshpickedjobs'),
    });
    renderApp(store);
    const tabs = within(screen.getByRole('navigation', { name: 'View' })).getAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual(['Board', 'Map', 'Flow', 'Repo']);
    const repoTab = screen.getByRole('button', { name: 'Repo' });
    expect(repoTab.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(repoTab);
    expect(store.getState().view).toBe('dashboard');
    expect(repoTab.getAttribute('aria-pressed')).toBe('true');
  });
});
