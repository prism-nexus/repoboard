import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CHURN_FLOOR } from '../src/map/model.js';
import { card, renderApp, testStore } from './helpers.jsx';

type File = RepoSnapshot['files'][number];

function file(path: string, bytes: number, lang: string, commits30d = 0): File {
  return { path, bytes, lines: null, lang, commits30d, commits90d: commits30d, lastCommitAt: null };
}

function repo(files: File[], edges: RepoSnapshot['edges'] = []): RepoSnapshot {
  return {
    root: '/tmp/demo',
    scannedAt: '2026-09-02T22:00:00Z',
    files,
    edges,
    languages: {},
    head: null,
  };
}

const FIVE = [
  file('src/a.ts', 4000, 'typescript', 5),
  file('src/b.ts', 3000, 'typescript', 0),
  file('src/c.tsx', 2000, 'tsx', 1),
  file('docs/readme.md', 1000, 'markdown', 0),
  file('package.json', 500, 'json', 0),
];

function openMap(files: File[], cards = [card('RB-1', 'todo')]) {
  const store = testStore();
  store.dispatch({
    type: 'snapshot',
    board: { config: defaultBoardConfig(), cards },
    repo: repo(files),
  });
  store.setView('map');
  const view = renderApp(store);
  return { store, view };
}

describe('treemap (P4.1)', () => {
  it('renders one tile per file for a 5-file snapshot, plus a directory per folder', () => {
    openMap(FIVE);
    const svg = screen.getByRole('img', { name: 'Repository treemap' });
    const tiles = svg.querySelectorAll('[data-tile]');
    expect(tiles).toHaveLength(5);
    expect([...tiles].map((t) => t.getAttribute('data-tile')).sort()).toEqual(
      FIVE.map((f) => f.path).sort(),
    );
    expect([...svg.querySelectorAll('[data-dir]')].map((d) => d.getAttribute('data-dir'))).toEqual(
      expect.arrayContaining(['src', 'docs']),
    );
    // Every tile has a positive area: 5 files on a 960×600 default canvas.
    for (const t of tiles) {
      expect(Number(t.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(t.getAttribute('height'))).toBeGreaterThan(0);
    }
  });

  it('zooms into a directory on click and back out via the breadcrumb', () => {
    openMap(FIVE);
    const svg = screen.getByRole('img', { name: 'Repository treemap' });
    fireEvent.click(svg.querySelector('[data-dir="src"]') as Element);
    const zoomed = screen.getByRole('img', { name: 'Repository treemap' });
    expect(zoomed.querySelectorAll('[data-tile]')).toHaveLength(3);
    const crumbs = screen.getByRole('navigation', { name: 'Directory' });
    expect(within(crumbs).getByText('src')).toBeInTheDocument();
    fireEvent.click(within(crumbs).getByText('demo'));
    expect(
      screen.getByRole('img', { name: 'Repository treemap' }).querySelectorAll('[data-tile]'),
    ).toHaveLength(5);
  });
});

describe('activity heat (P4.2)', () => {
  it('churn mode changes tile opacity: sqrt of commits with a 0.15 floor', () => {
    openMap(FIVE);
    const opacity = (path: string) =>
      Number(
        screen
          .getByRole('img', { name: 'Repository treemap' })
          .querySelector(`[data-tile="${path}"]`)
          ?.getAttribute('fill-opacity'),
      );
    const before = opacity('src/b.ts');
    expect(opacity('src/a.ts')).toBe(before); // size mode: uniform

    fireEvent.click(screen.getByRole('button', { name: 'Churn 30d' }));
    expect(opacity('src/a.ts')).toBe(1); // the max
    expect(opacity('src/b.ts')).toBe(CHURN_FLOOR); // zero commits: floor, not invisible
    expect(opacity('src/c.tsx')).toBeCloseTo(Math.sqrt(1 / 5), 5);
    expect(opacity('src/b.ts')).not.toBe(before);
  });
});

describe('who is where (P4.3)', () => {
  it("an active card's file tile carries data-active-by with the assignee", () => {
    const active = card('RB-7', 'doing', {
      assignee: 'claude/map-agent',
      updated: new Date().toISOString(),
      files: ['src/a.ts', 'src/gone.ts'],
    });
    const idle = card('RB-8', 'todo', { assignee: 'matt', files: ['src/b.ts'] });
    openMap(FIVE, [active, idle]);
    const svg = screen.getByRole('img', { name: 'Repository treemap' });
    expect(svg.querySelector('[data-tile="src/a.ts"]')?.getAttribute('data-active-by')).toBe(
      'claude/map-agent',
    );
    expect(svg.querySelector('[data-tile="src/b.ts"]')?.getAttribute('data-active-by')).toBeNull();
    // A file the card names but the repo lacks is a ghost tile, not a silent drop.
    expect(svg.querySelector('[data-tile="src/gone.ts"]')?.getAttribute('data-kind')).toBe('ghost');
    // The rail lists the active card; the file panel lists every card naming a path.
    expect(screen.getByTestId('who-RB-7')).toBeInTheDocument();
    fireEvent.click(svg.querySelector('[data-tile="src/b.ts"]') as Element);
    const panel = screen.getByTestId('file-panel');
    expect(within(panel).getByText('RB-8')).toBeInTheDocument();
  });

  it('pinning a card on the board keeps its files highlighted on the map', () => {
    const idle = card('RB-8', 'todo', { assignee: 'matt', files: ['src/b.ts'] });
    const { store } = openMap(FIVE, [idle]);
    let svg = screen.getByRole('img', { name: 'Repository treemap' });
    expect(svg.querySelector('[data-tile="src/b.ts"]')?.getAttribute('data-active-by')).toBeNull();
    expect(svg.querySelectorAll('.tm-hl')).toHaveLength(0);

    act(() => store.setView('board'));
    fireEvent.click(screen.getByTestId('pin-RB-8'));
    act(() => store.setView('map'));
    svg = screen.getByRole('img', { name: 'Repository treemap' });
    expect(svg.querySelectorAll('.tm-hl')).toHaveLength(1);
    // Pinned, not active: outlined but no data-active-by.
    expect(svg.querySelector('[data-tile="src/b.ts"]')?.getAttribute('data-active-by')).toBeNull();
    expect(within(screen.getByTestId('who-RB-8')).getByText('pinned')).toBeInTheDocument();
  });
});

describe('import graph (P4.4)', () => {
  it('renders one node per file with an edge and one line per edge', () => {
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: repo(FIVE, [
        { from: 'src/a.ts', to: 'src/b.ts' },
        { from: 'src/c.tsx', to: 'src/b.ts' },
      ]),
    });
    store.setView('map');
    renderApp(store);
    fireEvent.click(screen.getByRole('button', { name: /^Imports/ }));
    const svg = screen.getByRole('img', { name: 'Import graph' });
    expect(svg.querySelectorAll('[data-node]')).toHaveLength(3);
    expect(svg.querySelectorAll('line')).toHaveLength(2);
    // In-degree sizes the node: b (2 importers) is bigger than a (0).
    const r = (id: string) =>
      Number(svg.querySelector(`[data-node="${id}"] circle`)?.getAttribute('r'));
    expect(r('src/b.ts')).toBeGreaterThan(r('src/a.ts'));
  });
});
