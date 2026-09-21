/**
 * P8.3, locked decision 7: STATE.md as a panel at the top of the Board view. OWNER ISSUES is
 * recomputed from the live `cards` (not trusted from a possibly-stale wire payload), and a queue
 * line scrolls to the `decide` column rather than toggling a filter (O11 dropped the TopBar
 * filter; orchestrator note 2).
 *
 * RCB-66: five collapsible rows (LIVE, LAST LANDINGS, OWNER ISSUES, SEATS, LOG), all closed by
 * default, independent of one another, remembered per row in one localStorage key
 * (`repoboard.panelRows`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, emptyState, mockState, renderApp, snapshot, testStore } from './helpers.jsx';

// Not `fileURLToPath(new URL(…, import.meta.url))`: under the jsdom environment that throws
// "The URL must be of scheme file". vitest shims `__dirname` for ESM test modules.
const STYLES_PATH = join(__dirname, '..', 'src', 'styles.css');

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') });
  // The real ambient `localStorage` (jsdom/Node) is not test-isolated — it can carry a
  // `repoboard.panelRows` value left behind by a previous test or a previous run of this suite,
  // which would make "all closed by default" tests depend on execution history rather than on
  // the code under test. Tests that stub `localStorage` (below) are unaffected either way.
  try {
    localStorage.removeItem('repoboard.panelRows');
  } catch {
    // No real localStorage in this environment — nothing to clear.
  }
});
afterEach(() => vi.useRealTimers());

function openRow(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('StatePanel', () => {
  it('before any STATE.md exists: says so, no crash, and the four STATE rows are not rendered', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, emptyState());
    renderApp(store);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('no STATE.md yet');
    expect(screen.queryByRole('button', { name: /^LIVE/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^LAST LANDINGS/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^OWNER ISSUES/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^SEATS/ })).toBeNull();
    // The LOG row still is.
    expect(screen.getByRole('button', { name: /^LOG/ })).toBeInTheDocument();
  });

  it('with no state payload at all (pre-P8.3 server), also reads as "no STATE.md yet"', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no state arg
    renderApp(store);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('no STATE.md yet');
  });

  it('all five rows are closed on first render', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('K117 landed.');
    expect(screen.queryByTestId('state-panel-queue')).toBeNull();
    expect(screen.queryByTestId('log-timeline')).toBeNull();
    for (const name of [/^LIVE/, /^LAST LANDINGS/, /^OWNER ISSUES/, /^SEATS/, /^LOG/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('opening LIVE shows its text and the window; the other rows stay closed', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LIVE/);
    expect(screen.getByTestId('state-panel-live')).toHaveTextContent('Tree is dev.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('K117 landed.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('ops watching.');
    expect(screen.queryByTestId('state-panel-queue')).toBeNull();
    expect(screen.queryByTestId('log-timeline')).toBeNull();
  });

  it('opening LAST LANDINGS shows its text; the other rows stay closed', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LAST LANDINGS/);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('K117 landed.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('ops watching.');
    expect(screen.queryByTestId('state-panel-live')).toBeNull();
  });

  it('opening SEATS shows its text; the other rows stay closed', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^SEATS/);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('ops watching.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
    expect(screen.getByTestId('state-panel')).not.toHaveTextContent('K117 landed.');
    expect(screen.queryByTestId('state-panel-live')).toBeNull();
  });

  it('renders LIVE, LAST LANDINGS and SEATS from the payload once each is open', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LIVE/);
    openRow(/^LAST LANDINGS/);
    openRow(/^SEATS/);
    const panel = screen.getByTestId('state-panel');
    expect(panel).toHaveTextContent('Tree is dev.');
    expect(panel).toHaveTextContent('K117 landed.');
    expect(panel).toHaveTextContent('ops watching.');
    expect(panel).toHaveTextContent('written');
    expect(panel).toHaveTextContent('claude/p8-3');
  });

  it('the OWNER ISSUES badge is visible while the row is closed; opening it shows the queue', () => {
    const store = testStore();
    const asked = card('RCB-40', 'decide', {
      decision: {
        question: 'sync-issues column?',
        options: [
          { letter: 'A', text: 'todo' },
          { letter: 'B', text: 'backlog' },
        ],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: 'doing',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    snapshot(store, [asked], undefined, undefined, undefined, mockState());
    renderApp(store);
    const badge = screen.getByTestId('state-panel-queue-count');
    expect(badge).toHaveTextContent('1 needs decision');
    expect(screen.queryByTestId('state-panel-queue')).toBeNull();
    openRow(/^OWNER ISSUES/);
    const queue = screen.getByTestId('state-panel-queue');
    expect(queue).toHaveTextContent('RCB-40 · sync-issues column? · [A B]');
  });

  it('the OWNER ISSUES line for a task reads owner: <text>, not a question with letters (RCB-52)', () => {
    const store = testStore();
    const asked = card('RCB-52', 'decide', {
      decision: {
        question: 'buy the domain',
        kind: 'task',
        options: [],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: 'doing',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    snapshot(store, [asked], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^OWNER ISSUES/);
    const queue = screen.getByTestId('state-panel-queue');
    expect(queue).toHaveTextContent('RCB-52 · owner: buy the domain');
  });

  it('a decided card never appears in the queue; no badge while closed', () => {
    const store = testStore();
    const decided = card('RCB-41', 'todo', {
      decision: {
        question: 'q',
        options: [],
        askedBy: 'a',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: null,
        chosen: null,
        words: 'done',
        decidedBy: 'web',
        decidedAt: '2026-09-02T22:05:00Z',
      },
    });
    snapshot(store, [decided], undefined, undefined, undefined, mockState());
    renderApp(store);
    expect(screen.queryByTestId('state-panel-queue-count')).toBeNull();
    openRow(/^OWNER ISSUES/);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('No open decisions.');
  });

  it('clicking a queue line scrolls the decide column into view (row opened first)', () => {
    const store = testStore();
    const asked = card('RCB-40', 'decide', {
      decision: {
        question: 'q',
        options: [{ letter: 'A', text: 'x' }],
        askedBy: 'a',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: 'doing',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    snapshot(store, [asked], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^OWNER ISSUES/);
    const decideColumn = document.querySelector('[data-column="decide"]');
    expect(decideColumn).not.toBeNull();
    const scrollSpy = vi.fn();
    if (decideColumn) (decideColumn as HTMLElement).scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByText('RCB-40 · q · [A]'));
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('localStorage remembers which rows are open across a re-render, one row at a time', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    });
    try {
      const store = testStore();
      snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
      const { unmount } = renderApp(store);
      openRow(/^LIVE/);
      expect(screen.getByTestId('state-panel-live')).toHaveTextContent('Tree is dev.');
      unmount();

      // A fresh mount reads the remembered rows back: LIVE open, the other four closed.
      renderApp(store);
      expect(screen.getByTestId('state-panel-live')).toHaveTextContent('Tree is dev.');
      expect(screen.getByRole('button', { name: /^LIVE/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      for (const name of [/^LAST LANDINGS/, /^OWNER ISSUES/, /^SEATS/, /^LOG/]) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a localStorage whose getItem throws: all rows closed, no crash', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    try {
      const store = testStore();
      snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
      renderApp(store);
      expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
      for (const name of [/^LIVE/, /^LAST LANDINGS/, /^OWNER ISSUES/, /^SEATS/, /^LOG/]) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
      }
      // Toggling still doesn't crash even though the write also throws.
      openRow(/^LIVE/);
      expect(screen.getByTestId('state-panel-live')).toHaveTextContent('Tree is dev.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // RCB-45: LIVE is window-locked — fixed height, scrolls inside, pinned width, no reflow.
  it('the LIVE section renders inside a window-locked box, once open', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LIVE/);
    const live = screen.getByTestId('state-panel-live');
    expect(live).toHaveClass('state-panel__window');
    expect(live).toHaveTextContent('Tree is dev.');
  });

  it('only LIVE is window-locked', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LIVE/);
    openRow(/^LAST LANDINGS/);
    openRow(/^SEATS/);
    const windows = document.querySelectorAll('.state-panel__window');
    expect(windows.length).toBe(1);
    expect(windows[0]).not.toHaveTextContent('K117 landed.');
  });

  it('closing LIVE again hides the window', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    openRow(/^LIVE/);
    expect(screen.getByTestId('state-panel-live')).toBeInTheDocument();
    openRow(/^LIVE/); // toggle closed
    expect(screen.queryByTestId('state-panel-live')).toBeNull();
  });

  // jsdom does not compute layout, so the fixed height is asserted from the CSS source itself.
  it('the .state-panel__window rule fixes a 160px height with its own scroll', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.state-panel__window\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    // A bare `height`, not `max-height` (which `toContain` would also match): a max lets the
    // box shrink and the panel reflow — the thing this card exists to stop.
    expect(rule?.[0]).toMatch(/[^-]height: 160px;/);
    expect(rule?.[0]).not.toMatch(/max-height/);
    expect(rule?.[0]).toContain('overflow-y: auto');
  });

  // Pinned width: a grid item's automatic minimum is its min-content width, so a wide table in
  // LIVE (the fpj board has one) would widen the section past its track and the window's opaque
  // background would cover the other three sections. `min-width: 0` on the section is the pin.
  it('the .state-panel__section rule pins the section to its grid track (min-width: 0)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.state-panel__section\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/min-width:\s*0;/);
  });

  // RCB-53: `.state-panel__window { overflow-wrap: anywhere }` (RCB-45, for prose) starves a
  // table's narrow column to one character under auto table layout (fpj's LIVE table, header
  // "row" rendered as "ro"/"w"). Cells must keep whole words yet still wrap at spaces (nowrap hid
  // the value column behind a sideways scroll on the fpj board). Sliced from the selector to the
  // next `}` (not the whole file) so a `keep-all` elsewhere cannot satisfy this vacuously
  // (RCB-44's `toContain('height: 160px')` matching a `max-height` is exactly that failure mode).
  it('the .state-panel__window :is(th, td) rule keeps whole words yet wraps: overflow-wrap normal, word-break keep-all, white-space normal', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const selector = '.state-panel__window :is(th, td)';
    const selectorIndex = css.indexOf(selector);
    expect(selectorIndex).toBeGreaterThan(-1);
    const braceStart = css.indexOf('{', selectorIndex);
    const braceEnd = css.indexOf('}', braceStart);
    const block = css.slice(braceStart, braceEnd + 1);
    expect(block).toContain('overflow-wrap: normal');
    expect(block).toContain('word-break: keep-all');
    expect(block).toContain('white-space: normal');
    expect(block).not.toContain('nowrap');
  });

  // RCB-66: five collapsible rows fit the window — one open row scrolls inside itself instead of
  // growing the panel past the viewport.
  it('the .panel-row__body rule caps at min(45vh, 360px) with its own scroll', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.panel-row__body\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('max-height: min(45vh, 360px);');
    expect(rule?.[0]).toContain('overflow-y: auto');
  });

  // RCB-66: the ticker is one full-width line again; the LogTimeline strip beside it is gone.
  it('.status-row no longer exists in styles.css', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    expect(css).not.toMatch(/\.status-row\b/);
  });

  it('.log-timeline has no width declaration (it scrolls inside the LOG row body now)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.log-timeline\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).not.toMatch(/width:/);
  });

  // RCB-66: RCB-45's bug species, one level up. `.main` had no column definition, so its implicit
  // `auto` column sized `.board-view` (and the wide LIVE table inside it) to max-content, blowing
  // the board out past the viewport — measured `.board-view` 2235px / `.state-panel__window
  // table` 2193px in a 1316px viewport. `minmax(0, 1fr)` pins the column, same fix as `.app`.
  it('the .main rule pins its column to the viewport (grid-template-columns: minmax(0, 1fr))', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.main\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  // RCB-66: two open rows (e.g. LIVE + LOG) could together push the board below the fold even
  // though each row body caps itself — measured `.state-panel` 707px / `.board` clientHeight 20px
  // in an 844px-tall viewport. Capping the panel itself keeps the board at ≥45vh.
  it('the .state-panel rule caps the whole panel at 55vh with its own scroll', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.state-panel\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('max-height: 55vh;');
    expect(rule?.[0]).toContain('overflow-y: auto');
  });
});
