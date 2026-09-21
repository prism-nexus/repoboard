/**
 * RCB-85: `parseSeats` on the STATE.md `## SEATS` section — the two real line shapes `seat
 * --up/--down` writes (cli.ts `restamped SEATS`) plus the hand-written fpj-board shape with an
 * `x` for an unknown digit, and a non-seat bullet that must be ignored.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSeats } from '../src/seats.js';
import { card, mockState, renderApp, snapshot, testStore } from './helpers.jsx';

const SEATS_BODY = `- **repoboard builder: UP 2026-09-21 18:01Z.** on RCB-85.
- **coordinator: DOWN 2026-09-21 18:0xZ (11:0x Pacific)** handed off.
- **owner: UP 2026-09-20 09:15Z.** reviewing.
- Owner tasks elsewhere: RCB-90, RCB-91.
`;

describe('parseSeats', () => {
  it('extracts one entry per seat line, in order, ignoring non-seat bullets', () => {
    const seats = parseSeats(SEATS_BODY);
    expect(seats).toHaveLength(3);
    expect(seats.map((s) => s.name)).toEqual(['repoboard builder', 'coordinator', 'owner']);
    expect(seats.map((s) => s.status)).toEqual(['UP', 'DOWN', 'UP']);
    expect(seats.map((s) => s.iso)).toEqual([
      '2026-09-21T18:01:00Z',
      '2026-09-21T18:00:00Z',
      '2026-09-20T09:15:00Z',
    ]);
  });

  it('a seat line with no date/time still counts, with iso: null', () => {
    const seats = parseSeats('- **builder: UP** no timestamp here.\n');
    expect(seats).toEqual([{ name: 'builder', status: 'UP', iso: null }]);
  });

  it('no input, no seats', () => {
    expect(parseSeats('- Owner tasks elsewhere: RCB-90.\n')).toEqual([]);
  });
});

describe('StatePanel SEATS live-preview strip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') });
    try {
      localStorage.removeItem('repoboard.panelRows');
    } catch {
      // No real localStorage in this environment — nothing to clear.
    }
  });
  afterEach(() => vi.useRealTimers());

  it('shows a chip per seat on the closed row, without opening it', () => {
    const store = testStore();
    snapshot(
      store,
      [card('RB-1', 'todo')],
      undefined,
      undefined,
      undefined,
      mockState({
        sections: {
          live: 'Tree is dev.',
          lastLandings: 'K117 landed.',
          seats: [
            '- **repoboard builder: UP 2026-09-02 22:00Z.** on RCB-85.',
            '- **coordinator: DOWN 2026-09-02 21:00Z.** handed off.',
          ].join('\n'),
        },
      }),
    );
    renderApp(store);
    expect(screen.getByRole('button', { name: /^SEATS/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByTestId('state-panel-seats')).toBeInTheDocument();
    const chips = screen.getAllByTestId('seat-chip');
    expect(chips).toHaveLength(2);
    const [first, second] = chips;
    expect(first).toHaveTextContent('repoboard builder');
    expect(first).toHaveTextContent('UP');
    expect(second).toHaveTextContent('coordinator');
    expect(second).toHaveTextContent('DOWN');
  });

  it('with only non-seat bullets, the strip is absent', () => {
    const store = testStore();
    snapshot(
      store,
      [card('RB-1', 'todo')],
      undefined,
      undefined,
      undefined,
      mockState({
        sections: {
          live: 'Tree is dev.',
          lastLandings: 'K117 landed.',
          seats: '- Owner tasks elsewhere: RCB-90, RCB-91.',
        },
      }),
    );
    renderApp(store);
    expect(screen.queryByTestId('state-panel-seats')).toBeNull();
  });
});
