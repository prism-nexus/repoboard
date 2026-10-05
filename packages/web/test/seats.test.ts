/**
 * RCB-218: the seat pills in the Board's status line and the Seats panel under them. Before this
 * card the file tested `parseSeats`, the web's own regex over STATE.md's SEATS section (RCB-85);
 * that parser is retired — core's `seatRowPayloads` is the one parser, and the server sends its
 * rows. Each test names its CONTROL: the perturbation of the source that makes it fail. None was
 * run (the brief forbids any runner); the seat that gates them watches each fail.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardsOfSeat } from '../src/components/status-model.js';
import type { SeatRowPayload } from '../src/wire.js';
import { card, mockState, renderApp, testStore } from './helpers.jsx';
import { NOW_ISO, seatEvent, seatRow, sendSnapshot } from './status-fixtures.js';

beforeEach(() => vi.useFakeTimers({ now: new Date(NOW_ISO) }));
afterEach(() => vi.useRealTimers());

type PillCase = [label: string, over: Partial<SeatRowPayload>, symbol: string, kind: string];
const PILL_CASES: PillCase[] = [
  ['UP, holder alive draws ●', { status: 'UP', live: 'alive' }, '●', 'up'],
  ['DOWN draws ○', { status: 'DOWN', live: null, tag: null }, '○', 'down'],
  ['UP, holder dead draws ⚠', { status: 'UP', live: 'dead' }, '⚠', 'dead'],
  ['UP, liveness unknown draws ?', { status: 'UP', live: 'unknown' }, '?', 'unknown'],
  // RCB-223: no holder recorded is the seat's own UP claim, drawn ●; only a probed-and-undecidable
  // holder (`live: 'unknown'`) is ?.
  ['UP, no holder recorded draws ●', { status: 'UP', live: null, tag: null }, '●', 'up'],
];

describe('status line: a pill per seat', () => {
  // CONTROL: in status-model.ts `seatKind`, return 'up' for `live === 'dead'` — the ⚠ row fails;
  // return 'up' for `live === 'unknown'` — the ? row fails (an undecidable holder drawn as a
  // confident ●); return 'unknown' for `live === null` (the pre-RCB-223 rule) — the null row fails
  // the other way, ? where ● is wanted; return 'up' for `status === 'DOWN'` — the ○ row fails.
  // (RCB-223 test 2, pill half.)
  it.each(PILL_CASES)('%s', (_label, over, symbol, kind) => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow(over)] });
    renderApp(store);
    const pill = screen.getByTestId('seat-pill-builder');
    expect(pill).toHaveAttribute('data-kind', kind);
    expect(within(pill).getByRole('img').textContent).toBe(symbol);
  });

  // CONTROL (RCB-223 test 2, seat-block half): in SeatsPanel.tsx replace `SEAT_SYMBOL[kind]` with
  // `kind === 'up' && row.live === null ? '?' : SEAT_SYMBOL[kind]` — the null row fails (block ?,
  // pill ●: the two disagree); replace it with `'●'` — the dead and unknown rows fail.
  it.each(PILL_CASES)('seat block: %s', (_label, over, symbol, kind) => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow(over)] });
    renderApp(store);
    const block = screen.getByTestId('seat-block-builder');
    expect(block).toHaveAttribute('data-kind', kind);
    expect(within(block).getAllByRole('img')[0]?.textContent).toBe(symbol);
  });

  // CONTROL: in StatusLine.tsx drop the `{row.tag ...}` or the `{age ...}` child — the pane or the
  // age is missing from the pill and this fails.
  it('a pill reads name, pane and a compact age', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow()] });
    renderApp(store);
    const pill = screen.getByTestId('seat-pill-builder');
    expect(pill).toHaveTextContent('builder');
    expect(pill).toHaveTextContent('A7B2');
    expect(pill).toHaveTextContent('· 12m');
    expect(pill).not.toHaveTextContent('ago');
    expect(pill).toHaveAttribute('title', 'up since 22:29Z');
  });

  // CONTROL: in StatusLine.tsx replace the `{row.tag ? … : null}` child with an unconditional
  // `<span className="mono">{row.tag}</span>` — a DOWN seat with no holder then gets an empty mono
  // span and the `.mono` assertion fails.
  it('a DOWN seat with no holder shows no pane and never the words null or undefined', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow({ status: 'DOWN', live: null, tag: null })] });
    renderApp(store);
    const pill = screen.getByTestId('seat-pill-builder');
    expect(pill.querySelector('.mono')).toBeNull();
    expect(pill.textContent).not.toMatch(/null|undefined/);
    expect(pill).toHaveTextContent('· 12m');
  });
});

const BULLETS = [
  '- **builder: UP 2026-09-02 22:00Z.** on RB-85.',
  '  in-flight: sonnet on the brief',
  '  owes: RB-90 decision',
  '- **coordinator: DOWN 2026-09-02 21:00Z.** handed off.',
  '- Owner tasks elsewhere: RB-90.',
].join('\n');

describe('seats from an older server (no `seats` payload)', () => {
  // CONTROL: in status-model.ts `seatRowsFor`, return `[]` when `seats === null` — no pills, fails.
  // Also fails if the fallback is a regex instead of core's parse: in-flight/owes are core-only.
  it('reads STATE.md SEATS with core\'s parser: pills, in-flight and owes — and no holder, so "●" with no pane (RCB-223)', () => {
    const store = testStore();
    sendSnapshot(store, {
      state: mockState({ sections: { live: 'x', lastLandings: 'y', seats: BULLETS } }),
    });
    renderApp(store);
    const builder = screen.getByTestId('seat-pill-builder');
    expect(builder).toHaveAttribute('data-kind', 'up');
    expect(builder.querySelector('.mono')).toBeNull();
    expect(screen.getByTestId('seat-pill-coordinator')).toHaveAttribute('data-kind', 'down');
    // The non-seat bullet is not a seat.
    expect(screen.getAllByTestId(/^seat-pill-/)).toHaveLength(2);
    const block = screen.getByTestId('seat-block-builder');
    expect(block).toHaveTextContent('sonnet on the brief');
    expect(block).toHaveTextContent('RB-90 decision');
    expect(block).toHaveTextContent('up since 22:00Z');
  });

  // CONTROL: in `seatRowsFor` use `seats?.length ? seats : <fallback>` — the empty list falls back
  // to STATE.md, two pills appear, and this fails.
  it('an EMPTY `seats` payload is an answer, not a reason to fall back', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [],
      state: mockState({ sections: { live: 'x', lastLandings: 'y', seats: BULLETS } }),
    });
    renderApp(store);
    expect(screen.queryAllByTestId(/^seat-pill-/)).toHaveLength(0);
    expect(screen.getByTestId('status-no-seats')).toHaveTextContent('no seats recorded');
  });

  // CONTROL: in StatusLine.tsx replace the `stateMissing` branch's text with 'no seats recorded'.
  it('no payload and no STATE.md: the line says how to make one', () => {
    const store = testStore();
    sendSnapshot(store, {});
    renderApp(store);
    expect(screen.getByTestId('status-no-seats')).toHaveTextContent('no STATE.md yet');
  });
});

describe('seats messages', () => {
  // CONTROL: delete `case 'seats'` from store.ts `dispatch` — the pill stays ● and this fails.
  it('a `seats` message redraws the pills without a snapshot', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow()] });
    renderApp(store);
    expect(screen.getByTestId('seat-pill-builder')).toHaveAttribute('data-kind', 'up');
    act(() => store.dispatch({ type: 'seats', seats: [seatRow({ live: 'dead' })] }));
    expect(screen.getByTestId('seat-pill-builder')).toHaveAttribute('data-kind', 'dead');
    act(() =>
      store.dispatch({
        type: 'seats',
        seats: [seatRow({ status: 'DOWN', live: null, tag: null })],
      }),
    );
    expect(screen.getByTestId('seat-pill-builder')).toHaveAttribute('data-kind', 'down');
  });
});

describe('Seats panel', () => {
  // CONTROL: in SeatsPanel.tsx change `kind === 'dead'` (the warning) to `kind === 'down'`.
  it('a dead holder says how to take the seat over; an alive one does not', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow({ live: 'dead' }), seatRow({ name: 'reviewer', tag: '3F0C' })],
    });
    renderApp(store);
    expect(screen.getByTestId('seat-takeover-builder')).toHaveTextContent('seat builder --up');
    expect(screen.queryByTestId('seat-takeover-reviewer')).toBeNull();
  });

  // CONTROL: in SeatsPanel.tsx `Field`, drop the `value === null` branch — null renders as nothing
  // (or "null"), and the "not recorded" assertion fails.
  it('in flight and owes show what the bullet says; a missing line reads "not recorded", never "none"', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow({ inFlight: 'subagent on RB-9, lock held', owes: null })],
    });
    renderApp(store);
    const block = screen.getByTestId('seat-block-builder');
    expect(block).toHaveTextContent('subagent on RB-9, lock held');
    const owes = [...block.querySelectorAll('dt')].find((dt) => dt.textContent === 'owes');
    expect(owes?.nextElementSibling).toHaveTextContent('not recorded');
    expect(owes?.nextElementSibling).not.toHaveTextContent('none');
  });

  // CONTROL: in SeatsPanel.tsx `SeatBlock`, drop the `row.status === 'UP'` guard on `working` — the
  // DOWN seat then lists its cards; or drop `status-model.ts` `doingCards`' active filter — RB-4 (in
  // To do) shows up under the builder.
  it('working on lists the Doing cards assigned to that UP seat, matched by name, and only those', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow(), seatRow({ name: 'reviewer', status: 'DOWN', live: null, tag: null })],
      cards: [
        card('RB-1', 'doing', { assignee: 'claude/builder' }),
        card('RB-2', 'doing', { assignee: 'reviewer' }),
        card('RB-3', 'doing'),
        card('RB-4', 'todo', { assignee: 'builder' }),
      ],
    });
    renderApp(store);
    const working = screen.getByTestId('seat-working-builder');
    expect(working).toHaveTextContent('RB-1');
    expect(working).not.toHaveTextContent('RB-2');
    expect(working).not.toHaveTextContent('RB-3');
    expect(working).not.toHaveTextContent('RB-4');
    expect(screen.queryByTestId('seat-working-reviewer')).toBeNull();
  });

  // CONTROL: in status-model.ts `unclaimedDoing`, build `holders` from ALL seats (drop the
  // `status === 'UP'` filter) — RB-2 (assigned to a DOWN seat) disappears and this fails; or drop
  // the `assignee` check — RB-1 is listed.
  it('Doing cards no UP seat holds are listed as unclaimed (no assignee, or a DOWN assignee)', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow(), seatRow({ name: 'reviewer', status: 'DOWN', live: null, tag: null })],
      cards: [
        card('RB-1', 'doing', { assignee: 'claude/builder' }),
        card('RB-2', 'doing', { assignee: 'reviewer' }),
        card('RB-3', 'doing'),
      ],
    });
    renderApp(store);
    const unclaimed = screen.getByTestId('seats-unclaimed');
    expect(unclaimed).toHaveTextContent('RB-2');
    expect(unclaimed).toHaveTextContent('assigned to reviewer');
    expect(unclaimed).toHaveTextContent('RB-3');
    expect(unclaimed).not.toHaveTextContent('RB-1');
  });

  // CONTROL: in `unclaimedDoing` delete the `seats.length === 0` early return — every Doing card of a
  // board that does not use seats reads "unclaimed", and this fails.
  it('a board with no seats at all lists nothing as unclaimed', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [], cards: [card('RB-3', 'doing')] });
    renderApp(store);
    expect(screen.queryByTestId('seats-unclaimed')).toBeNull();
  });

  // CONTROL: in status-model.ts `lastSeatEvents` change `slice(-n)` to `slice(-1)` — one event, fails;
  // drop the actor filter — the reviewer's event leaks into the builder's line, fails.
  it("shows the seat's last two seat events, newest first, and not another seat's", () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow(), seatRow({ name: 'reviewer', tag: '3F0C' })] });
    for (const event of [
      seatEvent('builder', 'UP', '2026-09-01T20:00:00Z', 'A7B2'),
      seatEvent('builder', 'DOWN', '2026-09-01T23:39:00Z'),
      seatEvent('reviewer', 'UP', '2026-09-02T07:12:00Z', '3F0C'),
      seatEvent('builder', 'UP', '2026-09-02T09:58:00Z', 'A7B2'),
    ]) {
      store.dispatch({ type: 'event', event });
    }
    renderApp(store);
    const line = screen.getByTestId('seat-events-builder');
    expect(line.textContent).toBe('took the seat 09:58Z · stood down Sep 1 23:39Z');
    expect(screen.getByTestId('seat-events-reviewer').textContent).toBe('took the seat 07:12Z');
  });

  it('up since / down since read the stamp, with the age', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [
        seatRow(),
        seatRow({
          name: 'reviewer',
          status: 'DOWN',
          live: null,
          tag: null,
          at: '2026-09-01T23:39:00Z',
        }),
        seatRow({ name: 'ops', at: null }),
      ],
    });
    renderApp(store);
    expect(screen.getByTestId('seat-block-builder')).toHaveTextContent('up since 22:29Z (12m ago)');
    expect(screen.getByTestId('seat-block-reviewer')).toHaveTextContent('down since Sep 1 23:39Z');
    // An unparseable stamp is said so, never a plausible time.
    expect(screen.getByTestId('seat-block-ops')).toHaveTextContent('up, stamp not readable');
  });

  // CONTROL: delete the `seats.length > 0 && up + dead === 0 && doing.length === 0` block.
  it('nobody up and nothing in Doing says so', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow({ status: 'DOWN', live: null, tag: null })],
      cards: [card('RB-1', 'todo')],
    });
    renderApp(store);
    expect(screen.getByTestId('seats-quiet')).toHaveTextContent(
      'Nobody is on a seat and Doing is empty.',
    );
  });
});

describe('a seat pill goes to its block', () => {
  function stubScrollIntoView() {
    const scrolled: Element[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    return {
      scrolled,
      restore: () => {
        delete proto.scrollIntoView;
      },
    };
  }

  // CONTROL: in SeatsPanel.tsx delete the `el.scrollIntoView(...)` call — `scrolled` stays empty;
  // delete `setFlashName(name)` — the flash class assertion fails.
  it("scrolls that seat's block into view and flashes it, then stops flashing", () => {
    const { scrolled, restore } = stubScrollIntoView();
    try {
      const store = testStore();
      sendSnapshot(store, { seats: [seatRow(), seatRow({ name: 'reviewer', tag: '3F0C' })] });
      renderApp(store);
      fireEvent.click(screen.getByTestId('seat-pill-reviewer'));
      const block = screen.getByTestId('seat-block-reviewer');
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toBe(block);
      expect(block).toHaveClass('seat--flash');
      expect(screen.getByTestId('seat-block-builder')).not.toHaveClass('seat--flash');
      act(() => {
        vi.advanceTimersByTime(1700);
      });
      expect(block).not.toHaveClass('seat--flash');
    } finally {
      restore();
    }
  });

  // CONTROL: in StatePanel.tsx `onSeat`, delete the `if (!detailsOpen) { setRows … }` branch — the
  // deck stays hidden and `seats-panel` is never found.
  it('opens the details first when they are hidden', () => {
    const { scrolled, restore } = stubScrollIntoView();
    try {
      // This jsdom's ambient `localStorage` has no working `setItem`; a Map stands in.
      const mem = new Map([['repoboard.panelRows', JSON.stringify({ details: false })]]);
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
      });
      const store = testStore();
      sendSnapshot(store, { seats: [seatRow()] });
      renderApp(store);
      expect(screen.queryByTestId('seats-panel')).toBeNull();
      fireEvent.click(screen.getByTestId('seat-pill-builder'));
      expect(screen.getByTestId('seats-panel')).toBeInTheDocument();
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toBe(screen.getByTestId('seat-block-builder'));
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });
});

// ---- RCB-184 slice 2: the home board's seats, read-only ------------------------------------------
//
// CONTROLS (run by the seat, not part of the suite):
//  - SeatsPanel.tsx `SeatBlock`: drop `&& !isHome` on `working` — "no working-on" fails (the Doing
//    card assigned to `coordinator` shows under the home's row).
//  - status-model.ts `cardsOfSeat`: delete the `seat.home !== null` guard — only the direct
//    `cardsOfSeat` test fails (measured: no rendering test sees it, the panel hides working-on).
//  - SeatsPanel.tsx / StatusLine.tsx: key by `row.name` instead of `seatKey(row)` — harmless while
//    the two names differ, so the collision test also pins `seatKey` itself: make `seatKey` return
//    `row.name` for a home row and "both render" fails on the testids.
//  - SeatsPanel.tsx: drop the `home · read-only` span — "shows the marker" fails.
//  - status-model.ts `unclaimedDoing`: use `seats` instead of `own` — the home's UP `coordinator`
//    then claims RB-1 and the unclaimed test fails.
describe('home rows (RCB-184)', () => {
  const homeRow = (over: Partial<SeatRowPayload> = {}) =>
    seatRow({
      name: '[acme] coordinator',
      home: 'acme',
      tag: '1D3F',
      owes: 'RCB-9',
      inFlight: 'a brief',
      ...over,
    });

  // CONTROL: delete `cardsOfSeat`'s `seat.home !== null` guard — this test fails. The panel hides
  // working-on for a home row on its own, so no rendering test can see that guard.
  it('cardsOfSeat gives a home row no cards, even one assigned to its exact name', () => {
    const doing = [card('RB-1', 'doing', { assignee: 'claude/[acme] coordinator' })];
    expect(cardsOfSeat(doing, seatRow({ name: '[acme] coordinator' }))).toHaveLength(1);
    expect(cardsOfSeat(doing, homeRow())).toEqual([]);
  });

  it('a home row shows the home · read-only marker; an own row does not', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow(), homeRow()] });
    renderApp(store);
    const home = screen.getByTestId('seat-block-home:acme:[acme] coordinator');
    expect(home).toHaveTextContent('home · read-only');
    expect(home).toHaveTextContent('RCB-9');
    expect(screen.getByTestId('seat-block-builder')).not.toHaveTextContent('read-only');
  });

  it('a home row has no working-on, no seat events and no takeover hint, even with a Doing card assigned to that seat name', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [homeRow({ live: 'dead' })],
      cards: [card('RB-1', 'doing', { assignee: 'claude/[acme] coordinator' })],
    });
    store.dispatch({
      type: 'event',
      event: seatEvent('[acme] coordinator', 'UP', '2026-09-02T22:00:00Z'),
    });
    renderApp(store);
    const key = 'home:acme:[acme] coordinator';
    expect(screen.getByTestId(`seat-block-${key}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`seat-working-${key}`)).toBeNull();
    expect(screen.queryByTestId(`seat-events-${key}`)).toBeNull();
    expect(screen.queryByTestId(`seat-takeover-${key}`)).toBeNull();
    expect(screen.getByTestId(`seat-block-${key}`)).not.toHaveTextContent('RB-1');
  });

  it('a Doing card assigned to the bare name of a home seat is still unclaimed: only own seats hold cards', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow(), homeRow({ name: 'coordinator' })],
      cards: [card('RB-1', 'doing', { assignee: 'coordinator' })],
    });
    renderApp(store);
    expect(screen.getByTestId('seats-unclaimed')).toHaveTextContent('RB-1');
    expect(screen.queryByTestId('seat-working-home:acme:coordinator')).toBeNull();
  });

  it('own coordinator and the home [acme] coordinator both render, with distinct blocks and pills', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow({ name: 'coordinator' }), homeRow()],
      cards: [card('RB-1', 'doing', { assignee: 'coordinator' })],
    });
    renderApp(store);
    expect(screen.getByTestId('seat-block-coordinator')).toBeInTheDocument();
    expect(screen.getByTestId('seat-block-home:acme:[acme] coordinator')).toBeInTheDocument();
    expect(screen.getByTestId('seat-pill-coordinator')).toBeInTheDocument();
    expect(screen.getByTestId('seat-pill-home:acme:[acme] coordinator')).toBeInTheDocument();
    // The own seat still lists its card; the home's does not.
    expect(screen.getByTestId('seat-working-coordinator')).toHaveTextContent('RB-1');
  });

  it('a home row after own rows, in the order sent', () => {
    const store = testStore();
    sendSnapshot(store, { seats: [seatRow(), homeRow()] });
    renderApp(store);
    const blocks = [
      ...screen.getByTestId('seats-panel').querySelectorAll('[data-testid^="seat-block-"]'),
    ];
    expect(blocks.map((b) => b.getAttribute('data-home'))).toEqual([null, 'true']);
  });
});

describe('the Seats panel header and quiet note (RCB-223)', () => {
  // CONTROL (test 3): in SeatsPanel.tsx drop the `live · ` prefix from the three `meta` strings —
  // the first word is then `nobody` / `1`, not `live`, and this fails for every branch below.
  it('the meta starts with the word "live", whether nobody is up, some are, or one needs a look', () => {
    const cases: Array<[SeatRowPayload[], string]> = [
      [[seatRow({ status: 'DOWN', live: null, tag: null })], 'live · nobody up'],
      [[seatRow()], 'live · 1 up'],
      [[seatRow(), seatRow({ name: 'reviewer', live: 'dead' })], 'live · 1 up · 1 needs a look'],
    ];
    for (const [seats, meta] of cases) {
      const store = testStore();
      sendSnapshot(store, { seats });
      const { unmount } = renderApp(store);
      const el = within(screen.getByTestId('seats-panel')).getByText(/^live/);
      expect(el.textContent?.split(' ')[0]).toBe('live');
      expect(el.textContent).toBe(meta);
      unmount();
    }
  });

  const DOWN_OLD = {
    name: 'reviewer',
    status: 'DOWN',
    live: null,
    tag: null,
    at: '2026-09-01T23:39:00Z',
    owes: 'ACME-215 decision',
  } as const;

  // CONTROL (test 4b): in SeatsPanel.tsx drop the `owing ? … : ''` part — the first assertion
  // loses `, owing …`; make `owingText` return the raw string — "none" and null rows grow a
  // dangling `, owing none.` / `, owing null.`; swap `lastStoodDown`'s `t <= bestAt` for `t >= bestAt`
  // — the OLDER stand-down wins and the seat name assertion fails (the wrong direction: oldest).
  it('quiet board: "Last: <seat> stood down <when> (<rel>), owing <owes>." from the NEWEST DOWN row', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [
        seatRow({ ...DOWN_OLD }),
        seatRow({
          ...DOWN_OLD,
          name: 'coordinator',
          at: '2026-09-02T20:41:00Z',
          owes: 'the ACME-9 review',
        }),
        seatRow({ ...DOWN_OLD, name: 'ops', at: null, owes: 'never ranked' }),
      ],
      cards: [card('RB-1', 'todo')],
    });
    renderApp(store);
    expect(screen.getByTestId('seats-quiet').textContent).toBe(
      'Nobody is on a seat and Doing is empty. Last: coordinator stood down 20:41Z (2h ago), owing the ACME-9 review.',
    );
  });

  it('owes "none" or no owes line: the sentence ends after the age, with no ", owing"', () => {
    for (const owes of ['none', 'None', null]) {
      const store = testStore();
      sendSnapshot(store, {
        seats: [seatRow({ ...DOWN_OLD, owes })],
        cards: [card('RB-1', 'todo')],
      });
      const { unmount } = renderApp(store);
      expect(screen.getByTestId('seats-quiet').textContent).toBe(
        'Nobody is on a seat and Doing is empty. Last: reviewer stood down Sep 1 23:39Z (23h ago).',
      );
      unmount();
    }
  });

  it('no DOWN row with a stamp: today\'s note, no "Last:"', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow({ ...DOWN_OLD, at: null })],
      cards: [card('RB-1', 'todo')],
    });
    renderApp(store);
    expect(screen.getByTestId('seats-quiet').textContent).toBe(
      'Nobody is on a seat and Doing is empty.',
    );
  });

  // CONTROL: in SeatsPanel.tsx compute `stood` without the `quiet ?` guard (always `lastStoodDown(seats)`)
  // — the note then appears wherever the quiet note's own guard is true; to catch the guard
  // itself, change `doing.length === 0` to `true` — the Doing-non-empty case grows the whole note.
  it('absent when a seat is UP, and absent when Doing is not empty', () => {
    const store = testStore();
    sendSnapshot(store, {
      seats: [seatRow(), seatRow({ ...DOWN_OLD })],
      cards: [card('RB-1', 'todo')],
    });
    const first = renderApp(store);
    expect(screen.queryByTestId('seats-quiet')).toBeNull();
    expect(screen.getByTestId('seats-panel')).not.toHaveTextContent('Last:');
    first.unmount();

    const store2 = testStore();
    sendSnapshot(store2, {
      seats: [seatRow({ ...DOWN_OLD })],
      cards: [card('RB-2', 'doing')],
    });
    renderApp(store2);
    expect(screen.queryByTestId('seats-quiet')).toBeNull();
    expect(screen.queryByText(/Last:/)).toBeNull();
  });
});
