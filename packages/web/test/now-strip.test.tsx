/**
 * P8.2, locked decision 9: the Now strip under the TopBar — held/stale/next-window, and the
 * quiet line when there is nothing to say.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeasesPayload } from '../src/wire.js';
import { card, emptyLeases, renderApp, snapshot, testStore } from './helpers.jsx';

const NOW_ISO = '2026-09-02T22:41:10Z';

// `NowStrip`'s "next window" picks against `useNow()`'s real `Date.now()`; pin the clock so the
// window fixtures below (dated 2026-09-02) are judged against that date, not whatever day the
// suite happens to run on.
beforeEach(() => vi.useFakeTimers({ now: new Date(NOW_ISO) }));
afterEach(() => vi.useRealTimers());

describe('NowStrip', () => {
  it('collapses to the quiet line when there is nothing held or scheduled', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, emptyLeases());
    renderApp(store);
    const strip = screen.getByTestId('now-strip');
    expect(strip).toHaveTextContent('no leases, no windows');
  });

  it('with no leases payload at all (pre-P8.2 server), also reads as the quiet line', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no leases arg
    renderApp(store);
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
    renderApp(store);
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
    renderApp(store);
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
    renderApp(store);
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
    renderApp(store);
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
    renderApp(store);
    expect(screen.getByTestId('now-strip-window')).toHaveTextContent('soon');
  });

  it('renders on every view (also present on the Map tab)', () => {
    const leases: LeasesPayload = {
      leases: [{ resource: 'r', holder: 'claude/ops', since: NOW_ISO }],
      windows: [],
      stale: [],
      now: NOW_ISO,
    };
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, leases);
    renderApp(store);
    store.setView('map');
    expect(screen.getByTestId('now-strip-holding-r')).toBeInTheDocument();
  });
});
