/**
 * P8.2, locked decision 9: the Now strip under the TopBar — held/stale/next-window, and the
 * quiet line when there is nothing to say.
 *
 * RCB-218: on the BOARD view the Now strip and the Ticker are replaced by the status line (a lease
 * pill per held lease, the newest event on the right); every other view keeps both. So the strip's
 * own tests render the Map view, and the Board tests below pin the replacement.
 */
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store.js';
import type { LeasesPayload } from '../src/wire.js';
import { card, emptyLeases, renderApp, snapshot, testStore } from './helpers.jsx';
import { sendSnapshot } from './status-fixtures.js';

const NOW_ISO = '2026-09-02T22:41:10Z';

// `NowStrip`'s "next window" picks against `useNow()`'s real `Date.now()`; pin the clock so the
// window fixtures below (dated 2026-09-02) are judged against that date, not whatever day the
// suite happens to run on.
beforeEach(() => vi.useFakeTimers({ now: new Date(NOW_ISO) }));
afterEach(() => vi.useRealTimers());

/** The Now strip lives on every view but the Board, so its own tests render the Map. */
function renderOnMap(store: Store) {
  store.setView('map');
  return renderApp(store);
}

describe('NowStrip', () => {
  it('collapses to the quiet line when there is nothing held or scheduled', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, emptyLeases());
    renderOnMap(store);
    const strip = screen.getByTestId('now-strip');
    expect(strip).toHaveTextContent('no leases, no windows');
  });

  it('with no leases payload at all (pre-P8.2 server), also reads as the quiet line', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no leases arg
    renderOnMap(store);
    expect(screen.getByTestId('now-strip')).toHaveTextContent('no leases, no windows');
  });

  it('a held lease renders "holding: <resource> · <holder> · until <time>"', () => {
    const leases: LeasesPayload = {
      leases: [
        {
          resource: 'vitest-lock',
          holder: 'claude/ops',
          since: NOW_ISO,
          until: '2026-09-02T23:30:00Z',
        },
      ],
      windows: [],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    const item = screen.getByTestId('now-strip-holding-vitest-lock');
    expect(item).toHaveTextContent('holding:');
    expect(item).toHaveTextContent('vitest-lock');
    expect(item).toHaveTextContent('ops'); // shortActor drops the claude/ prefix
    expect(item).toHaveTextContent('until 23:30Z');
    expect(screen.queryByTestId('now-strip-stale')).toBeNull();
  });

  it('a lease with no until reads "until —"', () => {
    const leases: LeasesPayload = {
      leases: [{ resource: 'r', holder: 'claude/ops', since: NOW_ISO }],
      windows: [],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    expect(screen.getByTestId('now-strip-holding-r')).toHaveTextContent('until —');
  });

  it('a stale lease is not shown as "holding" and the strip shows a stale count in the warning style', () => {
    const leases: LeasesPayload = {
      leases: [
        {
          resource: 'r',
          holder: 'claude/ops',
          since: '2026-09-02T10:00:00Z',
          until: '2026-09-02T11:00:00Z',
        },
      ],
      windows: [],
      stale: ['r'],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    expect(screen.queryByTestId('now-strip-holding-r')).toBeNull();
    const stale = screen.getByTestId('now-strip-stale');
    expect(stale).toHaveTextContent('stale ×1');
    expect(stale.className).toContain('now-strip__item--stale');
  });

  it('the next (current or upcoming) window renders "next window: <name> <start>–<end> <resource>"', () => {
    const leases: LeasesPayload = {
      leases: [],
      windows: [
        {
          resource: 'vitest-lock',
          start: '2026-09-02T22:50:00Z',
          end: '2026-09-02T23:30:00Z',
          name: 'cold4 gate',
        },
      ],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    const item = screen.getByTestId('now-strip-window');
    expect(item).toHaveTextContent('next window: cold4 gate');
    expect(item).toHaveTextContent('22:50Z');
    expect(item).toHaveTextContent('23:30Z');
    expect(item).toHaveTextContent('vitest-lock');
  });

  it('picks the SOONEST window that has not ended yet, ignoring one already past', () => {
    const leases: LeasesPayload = {
      leases: [],
      windows: [
        {
          resource: 'r',
          start: '2026-09-02T20:00:00Z',
          end: '2026-09-02T21:00:00Z',
          name: 'already over',
        },
        { resource: 'r', start: '2026-09-02T23:00:00Z', end: '2026-09-02T23:30:00Z', name: 'soon' },
        {
          resource: 'r',
          start: '2026-09-03T02:00:00Z',
          end: '2026-09-03T03:00:00Z',
          name: 'later',
        },
      ],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    expect(screen.getByTestId('now-strip-window')).toHaveTextContent('soon');
  });

  it('renders on the Map tab (every view but the Board keeps it)', () => {
    const leases: LeasesPayload = {
      leases: [{ resource: 'r', holder: 'claude/ops', since: NOW_ISO }],
      windows: [],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderOnMap(store);
    expect(screen.getByTestId('now-strip-holding-r')).toBeInTheDocument();
  });
});

describe('the Board: the status line replaces the Now strip and the Ticker (RCB-218)', () => {
  const held: LeasesPayload = {
    leases: [
      {
        resource: 'vitest-lock',
        holder: 'claude/ops',
        since: NOW_ISO,
        until: '2026-09-02T23:30:00Z',
      },
    ],
    windows: [],
    stale: [],
    now: NOW_ISO,
  };

  // CONTROL: in App.tsx render `<NowStrip>` and `<Ticker>` unconditionally (drop the
  // `state.view === 'board' ? null : …` wrapper) — both reappear on the Board and this fails.
  it('the Board has neither the strip nor the ticker; the Map has both', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')], leases: held });
    renderApp(store);
    expect(screen.queryByTestId('now-strip')).toBeNull();
    expect(document.querySelector('.ticker')).toBeNull();
    act(() => store.setView('map'));
    expect(screen.getByTestId('now-strip')).toBeInTheDocument();
    expect(document.querySelector('.ticker')).not.toBeNull();
  });

  // CONTROL: in StatusLine.tsx delete the `leases.leases.map(…)` pills — the pill is gone.
  it('a held lease is a pill: resource, holder, until — and no "holding:" strip text', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')], leases: held });
    renderApp(store);
    const pill = screen.getByTestId('lease-pill-vitest-lock');
    expect(pill).toHaveTextContent('vitest-lock');
    expect(pill).toHaveTextContent('ops'); // shortActor drops the claude/ prefix
    expect(pill).toHaveTextContent('until 23:30Z');
    expect(pill).toHaveAttribute('data-stale', 'false');
    expect(pill).not.toHaveClass('pill--stale');
    expect(screen.getByTestId('status-line')).not.toHaveTextContent('holding:');
  });

  // CONTROL: in StatusLine.tsx compute `isStale` as `false` — the pill is not amber and this fails.
  it('a stale lease is the same pill in the warning style, and says so', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [card('RB-1', 'todo')],
      leases: { ...held, stale: ['vitest-lock'] },
    });
    renderApp(store);
    const pill = screen.getByTestId('lease-pill-vitest-lock');
    expect(pill).toHaveAttribute('data-stale', 'true');
    expect(pill).toHaveClass('pill--stale');
    expect(pill).toHaveTextContent('stale');
  });

  // CONTROL: in StatusLine.tsx render one placeholder pill when `leases` is empty — the quiet case
  // grows a pill nobody holds.
  it('with no lease held there is no lease pill at all (the old quiet line is not carried over)', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')], leases: emptyLeases() });
    renderApp(store);
    expect(screen.queryAllByTestId(/^lease-pill-/)).toHaveLength(0);
    expect(screen.getByTestId('status-line')).not.toHaveTextContent('no leases, no windows');
  });

  // CONTROL: in status-model.ts `newestEvent` return `events[0]` — the older event shows.
  it('"last:" is the newest event, worded with the ticker\'s verb, and says so when there is none', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-9', 'todo')] });
    renderApp(store);
    expect(screen.getByTestId('status-last')).toHaveTextContent('last: no activity yet');
    act(() => {
      store.dispatch({
        type: 'event',
        event: {
          ts: '2026-09-02T21:00:00Z',
          actor: 'claude/builder',
          type: 'create',
          cardId: 'RB-8',
          from: null,
          to: 'todo',
        },
      });
      store.dispatch({
        type: 'event',
        event: {
          ts: '2026-09-02T22:29:10Z',
          actor: 'claude/builder',
          type: 'move',
          cardId: 'RB-9',
          from: 'todo',
          to: 'doing',
        },
      });
    });
    const last = screen.getByTestId('status-last');
    expect(last.textContent).toBe('last: builder moved RB-9 → doing · 12m ago');
  });
});

describe('the status line lease pill and window (RCB-223)', () => {
  const lease = {
    resource: 'vitest-lock',
    holder: 'claude/ops',
    since: NOW_ISO,
    until: '2026-09-02T23:30:00Z',
  };
  const win = (name: string, start: string, end: string) => ({
    resource: 'vitest-lock',
    name,
    start,
    end,
  });

  // CONTROL: in StatusLine.tsx change `until {…}` to `since {…}` (or drop the `until` word) — the
  // exact-text assertion fails; swap `shortTime(l.until)` for `shortTime(l.since)` — 22:41Z appears
  // where the lease's own end 23:30Z is wanted and it fails the other way.
  it('the pill reads "<resource> · <holder> · until <HH:MMZ>" — the lease\'s own end', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [card('RB-1', 'todo')],
      leases: { leases: [lease], windows: [], stale: [], now: NOW_ISO },
    });
    renderApp(store);
    expect(screen.getByTestId('lease-pill-vitest-lock').textContent).toBe(
      'vitest-lock · ops · until 23:30Z',
    );
  });

  // CONTROL: in StatusLine.tsx replace `nextWindow(leases.windows, now)` with `leases.windows[0]` —
  // the window that already ended (listed first) shows and this fails; replace it with
  // `[...leases.windows].sort(…)[0]` that ignores `end > now` — same failure. The text is checked
  // against the Map's Now strip, which calls the same exported `nextWindow`.
  it('a current-or-upcoming window shows its name and times, the soonest one, as the Now strip words it', () => {
    const leases: LeasesPayload = {
      leases: [lease],
      windows: [
        win('already over', '2026-09-02T20:00:00Z', '2026-09-02T21:00:00Z'),
        win('soon', '2026-09-02T23:00:00Z', '2026-09-02T23:15:00Z'),
        win('later', '2026-09-03T02:00:00Z', '2026-09-03T03:00:00Z'),
      ],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'todo')], leases });
    renderApp(store);
    const pill = screen.getByTestId('status-window');
    expect(pill.textContent).toBe('window: soon 23:00Z–23:15Z vitest-lock');
    expect(screen.getByTestId('status-line')).not.toHaveTextContent('already over');
    act(() => store.setView('map'));
    expect(screen.getByTestId('now-strip-window')).toHaveTextContent('soon 23:00Z–23:15Z');
  });

  // CONTROL: in StatusLine.tsx render the window span unconditionally (`upcoming ? … : <span
  // data-testid="status-window">window: —</span>`) — the no-window cases grow window text.
  it('no window, or only ended ones: no window text at all', () => {
    for (const windows of [[], [win('over', '2026-09-02T20:00:00Z', '2026-09-02T21:00:00Z')]]) {
      const store = testStore();
      sendSnapshot(store, {
        cards: [card('RB-1', 'todo')],
        leases: { leases: [lease], windows, stale: [], now: NOW_ISO },
      });
      const { unmount } = renderApp(store);
      expect(screen.queryByTestId('status-window')).toBeNull();
      expect(screen.getByTestId('status-line')).not.toHaveTextContent('window');
      unmount();
    }
  });
});
