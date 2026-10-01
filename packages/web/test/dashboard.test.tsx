/**
 * RCB-112 B: the fourth top-level view, "Repo" — `GET /api/dashboard` (RCB-112 A, core's
 * `RepoDashboard`). Follows `flow.test.tsx`'s pattern: seed a board snapshot with a raw
 * `dispatch` (no socket), switch view, then stub `fetch` per URL (`flow.test.tsx`'s `stubFetch`).
 *
 * The "realistic" fixture below is pasted from the brief, which pasted it from this repo's own
 * `git log`/`.repoboard/gate.jsonl` shape — not re-derived.
 */
import { defaultBoardConfig, type RepoDashboard } from '@repoboard/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store.js';
import { card, renderApp, testStore } from './helpers.jsx';

function openDashboard(cards = [card('RB-1', 'todo')]): { store: Store } {
  const store = testStore();
  store.dispatch({
    type: 'snapshot',
    board: { config: defaultBoardConfig(), cards },
    repo: null,
  });
  store.setView('dashboard');
  renderApp(store);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());

function stubDashboardFetch(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== '/api/dashboard') throw new Error(`unexpected fetch: ${url}`);
    return { ok: status < 400, status, json: async () => payload, url };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NOW = '2026-09-22T20:00:00Z';

function allNullDashboard(): RepoDashboard {
  return {
    now: NOW,
    health: {
      checks: { tests: null, typecheck: null, lint: null, build: null },
      ledger: null,
      errors: [],
      source: '.repoboard/gate.jsonl',
    },
    commits: {
      branch: null,
      head: null,
      originMain: null,
      perDay: null,
      byWho: null,
      source: 'git log (HEAD -n 10, origin/main -n 10; ...)',
    },
    coverage: null,
    coverageSource: 'static: test files that import or name a pointer, read live',
  };
}

const LONG_SUBJECT =
  'board: RCB-112 → doing (repoboard builder, standing order); this subject keeps going well past any reasonable line length so the dashboard has to truncate it visually with CSS ellipsis while keeping the whole sentence available in a title attribute for anyone who hovers or reads the DOM directly '.padEnd(
    320,
    '.',
  );

function perDay14(counts: number[]): { date: string; count: number }[] {
  // 2026-09-22 is "today" in the fixtures below; 14 UTC dates ending there.
  const out: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 8, 22) - i * 86_400_000);
    out.push({ date: d.toISOString().slice(0, 10), count: counts[13 - i] ?? 0 });
  }
  return out;
}

function realisticDashboard(): RepoDashboard {
  return {
    now: NOW,
    health: {
      checks: { tests: null, typecheck: null, lint: null, build: null },
      ledger: null,
      errors: [],
      source: '.repoboard/gate.jsonl',
    },
    commits: {
      branch: 'main',
      head: [
        {
          sha: 'd32a45c',
          at: '2026-09-22T12:15:15-07:00',
          author: 'Matt Jahn',
          agent: 'Claude Opus 5.5 (1M context)',
          subject: LONG_SUBJECT,
        },
        {
          sha: '73e23d6',
          at: '2026-09-22T11:00:00-07:00',
          author: 'Matt Jahn',
          agent: null,
          subject: 'board: RCB-110 → done (letter A) + lease released',
        },
      ],
      originMain: [
        {
          sha: '8bf9ebd',
          at: '2026-09-21T18:50:00-07:00',
          author: 'Matt Jahn',
          agent: null,
          subject: 'board: leases RCB-109 + RCB-111 released',
        },
      ],
      perDay: perDay14([1, 0, 2, 0, 0, 3, 1, 0, 0, 2, 1, 0, 4, 5]),
      byWho: [
        { who: 'Claude Opus 5.5 (1M context)', count: 5 },
        { who: 'Matt Jahn', count: 2 },
      ],
      source: 'git log (HEAD -n 10, origin/main -n 10; ...)',
    },
    coverage: [
      { id: 'repoboard', line: 'tests: 11 files' },
      { id: 'ci', line: 'tests: n/a (no source pointers)' },
    ],
    coverageSource: 'static: test files that import or name a pointer, read live',
  };
}

describe('Dashboard view (RCB-112 B)', () => {
  it('1. the Repo tab renders and clicking it switches to the dashboard view', () => {
    stubDashboardFetch(allNullDashboard());
    const store = testStore();
    store.dispatch({
      type: 'snapshot',
      board: { config: defaultBoardConfig(), cards: [] },
      repo: null,
    });
    renderApp(store);
    expect(screen.queryByTestId('dashboard')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Repo' }));
    expect(store.getState().view).toBe('dashboard');
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('2. a realistic payload renders all three bands: branch, commit rows (full subject in title, ellipsis class on screen), 14 UTC bars, byWho, and coverage lines', async () => {
    stubDashboardFetch(realisticDashboard());
    openDashboard();

    await screen.findByTestId('dash-health');
    const health = screen.getByTestId('dash-health');
    for (const name of ['tests', 'typecheck', 'lint', 'build']) {
      expect(within(screen.getByTestId(`dash-health-${name}`))).toBeTruthy();
      expect(screen.getByTestId(`dash-health-${name}`)).toHaveTextContent('no gate recorded');
    }
    expect(within(health).getByTestId('dash-ledger')).toHaveTextContent('no ledger');

    const commits = screen.getByTestId('dash-commits');
    expect(within(commits).getByTestId('dash-branch')).toHaveTextContent('main');
    const subjectEls = within(commits).getAllByText(LONG_SUBJECT, { exact: false });
    expect(subjectEls.length).toBeGreaterThan(0);
    const subjectEl = subjectEls[0] as HTMLElement;
    expect(subjectEl.className).toContain('dash__commit-subject');
    expect(subjectEl.getAttribute('title')).toBe(LONG_SUBJECT);

    const bars = within(commits).getByTestId('dash-bars');
    const barEls = bars.querySelectorAll('.dash__bar');
    expect(barEls).toHaveLength(14);
    expect(barEls[0]?.getAttribute('title')).toBe('2026-09-09: 1');
    expect(barEls[0]?.getAttribute('aria-label')).toBe('2026-09-09: 1');
    expect(barEls[13]?.getAttribute('title')).toBe('2026-09-22: 5');
    expect(commits).toHaveTextContent('UTC');

    expect(within(commits).getByTestId('dash-bywho')).toHaveTextContent(
      'Claude Opus 5.5 (1M context)',
    );

    const coverage = screen.getByTestId('dash-coverage');
    expect(coverage).toHaveTextContent('repoboard');
    expect(coverage).toHaveTextContent('tests: 11 files');
    expect(coverage).toHaveTextContent('ci');
    expect(coverage).toHaveTextContent('tests: n/a (no source pointers)');
  });

  it('3. CONTROL: a payload with every field null renders all three null states, and no alert', async () => {
    stubDashboardFetch(allNullDashboard());
    openDashboard();

    await screen.findByTestId('dash-health');
    for (const name of ['tests', 'typecheck', 'lint', 'build']) {
      expect(screen.getByTestId(`dash-health-${name}`)).toHaveTextContent('no gate recorded');
    }
    expect(screen.getByTestId('dash-ledger')).toHaveTextContent('no ledger');

    expect(screen.getByTestId('dash-branch')).toHaveTextContent('no git history');
    expect(screen.getByTestId('dash-head')).toHaveTextContent('no git history');
    expect(screen.getByTestId('dash-origin-main')).toHaveTextContent('no git history');
    expect(screen.getByTestId('dash-bars')).toHaveTextContent('no git history');
    expect(screen.getByTestId('dash-bywho')).toHaveTextContent('no git history');

    expect(screen.getByTestId('dash-coverage')).toHaveTextContent(
      'no systems.yml — the Flow view can plan one',
    );

    expect(within(screen.getByTestId('dashboard')).queryByRole('alert')).toBeNull();
  });

  it('4. CONTROL: originMain rule — same first sha as head renders "origin/main = HEAD" once, not the list twice', async () => {
    const data = realisticDashboard();
    // biome-ignore lint/style/noNonNullAssertion: fixture has 1 head row
    data.commits.originMain = [{ ...data.commits.head![0]! }];
    stubDashboardFetch(data);
    openDashboard();

    const originMain = await screen.findByTestId('dash-origin-main');
    expect(originMain).toHaveTextContent('origin/main = HEAD');
    // The one shared sha must appear exactly once across the whole commits band — not once in
    // `head`'s list and again in a duplicated `originMain` list.
    const commits = screen.getByTestId('dash-commits');
    expect(within(commits).getAllByText('d32a45c')).toHaveLength(1);
  });

  it("5. CONTROL: originMain rule — a different first sha renders originMain's own commit rows", async () => {
    stubDashboardFetch(realisticDashboard());
    openDashboard();

    const originMain = await screen.findByTestId('dash-origin-main');
    expect(originMain).not.toHaveTextContent('origin/main = HEAD');
    expect(originMain).toHaveTextContent('8bf9ebd');
    expect(originMain).toHaveTextContent('leases RCB-109 + RCB-111 released');
  });

  it('6. CONTROL: a 500 from /api/dashboard renders the error block, and the tab bar still works', async () => {
    stubDashboardFetch({}, 500);
    openDashboard();

    const error = await screen.findByTestId('dash-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('/api/dashboard');
    expect(error).toHaveTextContent('500');

    const boardTab = screen.getByRole('button', { name: 'Board' });
    fireEvent.click(boardTab);
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('7. the refresh button re-fetches /api/dashboard', async () => {
    const fetchMock = stubDashboardFetch(allNullDashboard());
    openDashboard();
    await screen.findByTestId('dash-health');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
