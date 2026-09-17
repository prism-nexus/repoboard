/**
 * P8.4 locked decision 5: the Map view header tile — `cold context ≈Nk tok · CLAUDE.md X ✓/✗` —
 * and clicking it opens the full table. Fetched via `GET /api/cost` (K7's `useRefs` pattern), so
 * `fetch` is stubbed the same way `refs.test.tsx` stubs it.
 */
import type { CostReport } from '@repoboard/core';
import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, testStore } from './helpers.jsx';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(report: CostReport) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => report,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function repo(): RepoSnapshot {
  return {
    root: '/tmp/demo',
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

function okReport(): CostReport {
  return {
    entries: [{ file: 'CLAUDE.md', bytes: 4996, why: 'root' }],
    totalBytes: 4996,
    totalTokensApprox: 1249,
    claudeMdBytes: 4996,
    budget: 8192,
    over: false,
    mcpServers: [],
    mcpNote: 'note',
  };
}

function overReport(): CostReport {
  return {
    entries: [{ file: 'CLAUDE.md', bytes: 32620, why: 'root' }],
    totalBytes: 32620,
    totalTokensApprox: 8155,
    claudeMdBytes: 32620,
    budget: 8192,
    over: true,
    mcpServers: ['repoboard'],
    mcpNote: "schema bytes are per-harness; repoboard's own is measured in AGENTS.md",
  };
}

function openMap() {
  const store = testStore();
  store.dispatch({
    type: 'snapshot',
    board: { config: defaultBoardConfig(), cards: [card('RB-1', 'todo')] },
    repo: repo(),
  });
  store.setView('map');
  renderApp(store);
  return store;
}

describe('CostTile (P8.4)', () => {
  it('renders OK: the checkmark, tokens, and CLAUDE.md size', async () => {
    stubFetch(okReport());
    openMap();
    const tile = await screen.findByTestId('cost-tile');
    expect(tile).toHaveTextContent('cold context');
    expect(tile).toHaveTextContent('1.2k tok');
    expect(tile).toHaveTextContent('CLAUDE.md 4.9 KB');
    expect(screen.getByTestId('cost-tile-mark')).toHaveTextContent('✓');
    expect(screen.getByTestId('cost-tile-mark')).not.toHaveClass('cost-tile__mark--over');
  });

  it('renders OVER: the cross mark in the warning class, and CLAUDE.md size still shown', async () => {
    stubFetch(overReport());
    openMap();
    await screen.findByTestId('cost-tile');
    const mark = screen.getByTestId('cost-tile-mark');
    expect(mark).toHaveTextContent('✗');
    expect(mark).toHaveClass('cost-tile__mark--over');
  });

  it('clicking the tile opens the panel with the full table; Escape closes it', async () => {
    stubFetch(overReport());
    openMap();
    const tile = await screen.findByTestId('cost-tile');
    await act(async () => {
      fireEvent.click(tile);
    });
    const panel = await screen.findByTestId('cost-panel');
    expect(panel).toHaveTextContent('CLAUDE.md');
    expect(panel).toHaveTextContent('32620 of budget 8192');
    expect(panel).toHaveTextContent('OVER');
    expect(panel).toHaveTextContent('repoboard');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('cost-panel')).toBeNull();
  });

  it('an absent CLAUDE.md tile reads "CLAUDE.md absent"', async () => {
    stubFetch({
      entries: [],
      totalBytes: 0,
      totalTokensApprox: 0,
      claudeMdBytes: null,
      budget: 8192,
      over: false,
      mcpServers: [],
      mcpNote: 'note',
    });
    openMap();
    const tile = await screen.findByTestId('cost-tile');
    expect(tile).toHaveTextContent('CLAUDE.md absent');
  });
});
