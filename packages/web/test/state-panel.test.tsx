/**
 * The top of the Board. P8.3: STATE.md as a panel above the columns, the Owner queue recomputed from
 * the live `cards`. RCB-66: collapsible rows remembered in `repoboard.panelRows`. RCB-218: a status
 * line, three detail panels (Seats, Landed, Owner queue) behind one Hide/Show details toggle, and
 * the LOG row; the LIVE and LAST LANDINGS rows are gone, and an Owner-queue item opens its card
 * instead of scrolling to a column. Each test names its CONTROL — the perturbation of the source
 * that makes it fail; none was run (the brief forbids any runner), the gating seat watches each fail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, emptyState, mockState, renderApp, testStore } from './helpers.jsx';
import { NOW_ISO, openDecision, sendSnapshot } from './status-fixtures.js';

// Not `fileURLToPath(new URL(…, import.meta.url))`: under the jsdom environment that throws
// "The URL must be of scheme file". vitest shims `__dirname` for ESM test modules.
const STYLES_PATH = join(__dirname, '..', 'src', 'styles.css');

const KEY = 'repoboard.panelRows';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW_ISO) });
  // The real ambient `localStorage` (jsdom/Node) is not test-isolated — it can carry a
  // `repoboard.panelRows` value left behind by a previous test or a previous run of this suite,
  // which would make the "details shown by default" tests depend on execution history rather than
  // on the code under test. Tests that stub `localStorage` (below) are unaffected either way.
  try {
    localStorage.removeItem(KEY);
  } catch {
    // No real localStorage in this environment — nothing to clear.
  }
});
afterEach(() => vi.useRealTimers());

/** A `localStorage` stand-in backed by a Map, so a test can read back what the panel wrote. */
function stubStorage() {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  });
  return mem;
}

describe('StatePanel', () => {
  // CONTROL: in StatePanel.tsx `stateMissing`, make it always `false` — the line says "no seats
  // recorded" and the first assertion fails.
  it('before any STATE.md exists: says so, no crash, no seat pill — and the LOG row is still there', () => {
    const store = testStore();
    sendSnapshot(store, { state: emptyState() });
    renderApp(store);
    expect(screen.getByTestId('status-no-seats')).toHaveTextContent('no STATE.md yet');
    expect(screen.queryAllByTestId(/^seat-pill-/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^LOG/ })).toBeInTheDocument();
  });

  it('with no state payload at all (pre-P8.3 server), also reads as "no STATE.md yet"', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')] });
    renderApp(store);
    expect(screen.getByTestId('status-no-seats')).toHaveTextContent('no STATE.md yet');
  });

  // CONTROL: re-add `<PanelRow title="LIVE" …>` (or LAST LANDINGS / OWNER ISSUES) to StatePanel.tsx
  // and render `sections.live` in it — the row button, the heading text and 'Tree is dev.' all
  // reappear and this fails. STATE.md still HAS those sections; the Board just no longer shows them.
  it('no LIVE row, no LAST LANDINGS row, no OWNER ISSUES row — and none of their text in the DOM', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')], state: mockState() });
    renderApp(store);
    expect(screen.queryByRole('button', { name: /^LIVE/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^LAST LANDINGS/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^OWNER ISSUES/ })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bLIVE\b/);
    expect(text).not.toContain('LAST LANDINGS');
    expect(text).not.toContain('OWNER ISSUES');
    expect(text).not.toContain('Tree is dev.');
    expect(text).not.toContain('K117 landed.');
    expect(text).not.toContain('STATE written');
  });

  it('shows the three detail panels by default: SEATS, LANDED, OWNER QUEUE', () => {
    const store = testStore();
    sendSnapshot(store, { state: mockState() });
    renderApp(store);
    const deck = screen.getByTestId('state-deck');
    expect(deck).toContainElement(screen.getByTestId('seats-panel'));
    expect(deck).toContainElement(screen.getByTestId('landed-panel'));
    expect(deck).toContainElement(screen.getByTestId('owner-panel'));
    expect(screen.getByTestId('seats-panel')).toHaveTextContent('SEATS');
    expect(screen.getByTestId('landed-panel')).toHaveTextContent('LANDED');
    expect(screen.getByTestId('owner-panel')).toHaveTextContent('OWNER QUEUE');
  });
});

describe('Hide / Show details', () => {
  // CONTROL: in StatusLine.tsx wire `onClick` to nothing — the deck never goes away; or in
  // StatePanel.tsx render the deck unconditionally — the first `toBeNull` fails.
  it('hides and shows the three panels together; the status line stays', () => {
    const store = testStore();
    sendSnapshot(store, { state: mockState() });
    renderApp(store);
    const toggle = screen.getByTestId('status-toggle');
    expect(toggle).toHaveTextContent('Hide details');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('state-deck')).toBeNull();
    expect(screen.queryByTestId('seats-panel')).toBeNull();
    expect(screen.getByTestId('status-line')).toBeInTheDocument();
    expect(screen.getByTestId('status-toggle')).toHaveTextContent('Show details');
    expect(screen.getByTestId('status-toggle')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('status-toggle'));
    expect(screen.getByTestId('state-deck')).toBeInTheDocument();
  });

  // CONTROL: in StatePanel.tsx `toggle`, delete the `writePanelRows(next)` call — nothing is
  // written and the remount shows the deck again.
  it('is remembered in repoboard.panelRows across a remount, next to whether LOG is open', () => {
    const mem = stubStorage();
    try {
      const store = testStore();
      sendSnapshot(store, { state: mockState() });
      const { unmount } = renderApp(store);
      fireEvent.click(screen.getByTestId('status-toggle'));
      fireEvent.click(screen.getByRole('button', { name: /^LOG/ }));
      expect(JSON.parse(mem.get(KEY) ?? 'null')).toEqual({ details: false, log: true });
      unmount();

      renderApp(store);
      expect(screen.queryByTestId('state-deck')).toBeNull();
      expect(screen.getByTestId('status-toggle')).toHaveTextContent('Show details');
      expect(screen.getByRole('button', { name: /^LOG/ })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // CONTROL: in StatePanel.tsx change `rows.details !== false` to `rows.details === true` — a value
  // with no `details` key (every pre-RCB-218 value) then hides the deck and this fails. Only an
  // explicit `false` hides: an unconfigured rule is inert, not dangerous.
  it('a value left by the five-row panel (no `details` key) reads as shown', () => {
    const mem = stubStorage();
    mem.set(KEY, JSON.stringify({ live: true, seats: false, ownerIssues: true }));
    try {
      const store = testStore();
      sendSnapshot(store, { state: mockState() });
      renderApp(store);
      expect(screen.getByTestId('state-deck')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // CONTROL: in StatePanel.tsx `readPanelRows`, drop its try/catch — the throwing getItem crashes
  // the render and this fails.
  it('a localStorage whose getItem throws: details shown, no crash, and toggling still works', () => {
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
      sendSnapshot(store, { state: mockState() });
      renderApp(store);
      expect(screen.getByTestId('state-deck')).toBeInTheDocument();
      // The write also throws; the in-memory state still flips.
      fireEvent.click(screen.getByTestId('status-toggle'));
      expect(screen.queryByTestId('state-deck')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Owner queue', () => {
  const ask = (id: string, status: string, question = 'sync-issues column?') =>
    card(id, status, { decision: openDecision(question) });

  // CONTROL: in OwnerQueuePanel.tsx render `c.title` instead of `ownerQueueLine(c)` — the line
  // text (and its letters) is gone and this fails.
  it('lists each open decision as core words it: id, question and letters', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [ask('RCB-40', 'decide')], state: mockState() });
    renderApp(store);
    expect(screen.getByTestId('owner-item-RCB-40')).toHaveTextContent(
      'RCB-40 · sync-issues column? · [A B]',
    );
    expect(screen.getByTestId('owner-panel')).toHaveTextContent('1 waiting');
    expect(screen.getByTestId('owner-pill')).toHaveTextContent('Owner queue 1');
  });

  it('an owner task reads owner: <text>, not a question with letters (RCB-52)', () => {
    const store = testStore();
    const task = card('RCB-52', 'decide', {
      decision: openDecision('buy the domain', { kind: 'task', options: [] }),
    });
    sendSnapshot(store, { cards: [task], state: mockState() });
    renderApp(store);
    expect(screen.getByTestId('owner-item-RCB-52')).toHaveTextContent(
      'RCB-52 · owner: buy the domain',
    );
  });

  // CONTROL: in status-model.ts `ownerQueueCards` filter on `c.decision !== undefined` instead of
  // `needsDecision` — the decided card is listed and the count reads 1.
  it('a decided card is never in the queue: the panel says so and the pill reads 0, disabled', () => {
    const store = testStore();
    const decided = card('RCB-41', 'todo', {
      decision: openDecision('q', {
        options: [],
        chosen: null,
        words: 'done',
        decidedBy: 'web',
        decidedAt: '2026-09-02T22:05:00Z',
      }),
    });
    sendSnapshot(store, { cards: [decided], state: mockState() });
    renderApp(store);
    expect(screen.getByTestId('owner-empty')).toHaveTextContent('No open decisions.');
    expect(screen.getByTestId('owner-pill')).toHaveTextContent('Owner queue 0');
    expect(screen.getByTestId('owner-pill')).toBeDisabled();
  });

  // CONTROL: in OwnerQueuePanel.tsx drop the `c.status !== decideColumnId` condition — the
  // decide-column card gets a badge too and the `toBeNull` fails; make the badge never render —
  // the Done card has none and `toHaveTextContent('in Done')` fails.
  it("a badge names the card's column when it is not the decide column — and only then", () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [ask('RCB-40', 'decide'), ask('RCB-41', 'done', 'which reconcile default?')],
      state: mockState(),
    });
    renderApp(store);
    expect(screen.queryByTestId('owner-where-RCB-40')).toBeNull();
    expect(screen.getByTestId('owner-where-RCB-41')).toHaveTextContent('in Done');
  });

  // CONTROL: in OwnerQueuePanel.tsx replace `onOpenCard(c.id)` with a scroll of
  // `[data-column="decide"]` (the old behaviour) — `selectedId` stays null, the spy is called, and
  // the drawer never opens: all three assertions fail.
  it("clicking an item opens that card's drawer — it does not scroll to a column", () => {
    const store = testStore();
    sendSnapshot(store, { cards: [ask('RCB-40', 'decide')], state: mockState() });
    renderApp(store);
    const decideColumn = document.querySelector('[data-column="decide"]');
    expect(decideColumn).not.toBeNull();
    const scrollSpy = vi.fn();
    if (decideColumn) (decideColumn as HTMLElement).scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByTestId('owner-item-RCB-40'));
    expect(store.getState().selectedId).toBe('RCB-40');
    expect(screen.getByTestId('drawer')).toBeInTheDocument();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  // The reason for the change: the waiting card can sit in Done, where the old scroll found an
  // empty Needs-decision column. CONTROL: the same as above.
  it('an item whose card sits in Done opens it all the same', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [ask('RCB-41', 'done')], state: mockState() });
    renderApp(store);
    fireEvent.click(screen.getByTestId('owner-item-RCB-41'));
    expect(store.getState().selectedId).toBe('RCB-41');
    expect(screen.getByTestId('decision-section')).toBeInTheDocument();
  });

  // CONTROL: in StatusLine.tsx open `queue[queue.length - 1]` instead of `queue[0]` — RCB-41 opens.
  it("the status line's Owner queue pill opens the first queued card", () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [ask('RCB-40', 'decide'), ask('RCB-41', 'done', 'second question')],
      state: mockState(),
    });
    renderApp(store);
    fireEvent.click(screen.getByTestId('owner-pill'));
    expect(store.getState().selectedId).toBe('RCB-40');
  });

  // CONTROL: build the list from `state.ownerQueue` (the wire payload) instead of the live `cards`
  // — the `card` message below changes nothing and the pill still reads 1.
  it('recomputes from the live cards: an answered decision leaves the queue on the card message alone', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [ask('RCB-40', 'decide')], state: mockState() });
    renderApp(store);
    expect(screen.getByTestId('owner-pill')).toHaveTextContent('Owner queue 1');
    act(() =>
      store.dispatch({
        type: 'card',
        card: card('RCB-40', 'todo', {
          decision: openDecision('sync-issues column?', {
            chosen: 'A',
            decidedBy: 'web',
            decidedAt: '2026-09-02T22:30:00Z',
          }),
        }),
      }),
    );
    expect(screen.getByTestId('owner-pill')).toHaveTextContent('Owner queue 0');
    expect(screen.queryByTestId('owner-item-RCB-40')).toBeNull();
  });
});

// jsdom does not compute layout, so the caps are asserted from the CSS source itself. Each rule is
// sliced from its selector to the next `}`, never the whole file, so a matching declaration
// elsewhere cannot satisfy it vacuously.
describe('styles.css: the top of the Board', () => {
  const css = readFileSync(STYLES_PATH, 'utf8');
  const rule = (selector: RegExp) => css.match(selector)?.[0];

  // RCB-66: the open LOG row scrolls inside itself instead of growing the panel.
  it('the .panel-row__body rule caps at min(45vh, 360px) with its own scroll', () => {
    const r = rule(/\.panel-row__body\s*\{[^}]*\}/);
    expect(r).toBeDefined();
    expect(r).toContain('max-height: min(45vh, 360px);');
    expect(r).toContain('overflow-y: auto');
  });

  // RCB-66: two open parts could together push the board below the fold; capping the panel keeps
  // the board at >= 45vh.
  it('the .state-panel rule caps the whole panel at 55vh with its own scroll', () => {
    const r = rule(/\.state-panel\s*\{[^}]*\}/);
    expect(r).toBeDefined();
    expect(r).toContain('max-height: 55vh;');
    expect(r).toContain('overflow-y: auto');
  });

  // RCB-218: one long Seats list must not push the columns off the screen — each panel caps itself
  // and scrolls its own body.
  it('each detail panel caps its height and its body scrolls', () => {
    expect(rule(/\.panel\s*\{[^}]*\}/)).toContain('max-height: 300px;');
    expect(rule(/\.panel__body\s*\{[^}]*\}/)).toContain('overflow-y: auto');
  });

  it('the deck is three tracks wide, each min-width 0, and one track on a narrow window', () => {
    expect(rule(/\.deck\s*\{[^}]*\}/)).toContain(
      'grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);',
    );
    expect(css).toMatch(
      /@media \(max-width: 900px\) \{\s*\.deck \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });

  // RCB-66 (RCB-45's bug species, one level up): with no column definition, `.main`'s implicit
  // `auto` column sized the board to its widest child and blew it out past the viewport.
  it('the .main rule pins its column to the viewport (grid-template-columns: minmax(0, 1fr))', () => {
    expect(rule(/\.main\s*\{[^}]*\}/)).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it("the LIVE row's window rules are gone, and so is .status-row", () => {
    expect(css).not.toMatch(/\.state-panel__window\b/);
    expect(css).not.toMatch(/\.status-row\b/);
  });

  it('.log-timeline has no width declaration (it scrolls inside the LOG row body)', () => {
    const r = rule(/\.log-timeline\s*\{[^}]*\}/);
    expect(r).toBeDefined();
    expect(r).not.toMatch(/width:/);
  });
});
