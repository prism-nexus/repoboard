/**
 * RCB-200: `seat-check.ts` — `check`'s SEATS findings, the pure half. The section, the recorded
 * holders and the log blocks are all handed in; nothing here reads a file, a clock or a process.
 * One seeded bad input fires each of the six kinds exactly once; the edges below it pin the rules
 * a reader would otherwise have to take on trust (the DOWN-minute boundary, the future-stamp
 * tolerance, board scoping, tag prefixes, `holders: null`).
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import {
  type SeatHolder,
  type SeatHolderInfo,
  type SeatLeaseView,
  seatHolderInfos,
} from '../src/holder.js';
import type { LogBlock } from '../src/repolog.js';
import { stampedSeatBullets, zonedLogMs } from '../src/seat.js';
import { type SeatCheckInput, seatCheckFindings } from '../src/seat-check.js';
import {
  checkFindings,
  exitCodeForFindings,
  type Finding,
  FUTURE_STAMP_TOLERANCE_MS,
  initialStateText,
  type LogFileInfo,
  parseState,
  type StateDoc,
} from '../src/state.js';

const BOARD = 'repoboard';
const NOW = new Date('2026-09-30T01:00:00Z');
const STARTED = 'Tue Sep 29 12:34:56 2026';

type LeaseState = 'alive' | 'dead' | 'reused' | 'unknown';

/** A recorded `seat:<name>` lease. `pid` is explicit: two leases with one pid ARE one holder. */
function lease(
  seat: string,
  pane: string | null,
  pid: number,
  state: LeaseState = 'alive',
  extra: Partial<SeatHolder> = {},
): SeatLeaseView {
  const liveness: SeatLeaseView['liveness'] =
    state === 'alive'
      ? { state: 'alive' }
      : state === 'dead'
        ? { state: 'dead', reason: 'no-process' }
        : state === 'reused'
          ? { state: 'dead', reason: 'pid-reused' }
          : { state: 'unknown', reason: 'other-host' };
  return {
    seat,
    holder: { pane, session: null, start: STARTED, host: 'mac-mini', pid, ...extra },
    since: '2026-09-29T12:00:00Z',
    liveness,
  };
}

/** The holders as the store hands them over: tags and labels computed by `seatHolderInfos`. */
function holdersOf(...views: SeatLeaseView[]): SeatHolderInfo[] {
  return seatHolderInfos(views, BOARD);
}

function block(seat: string, ts: string, repo: string | null = null): LogBlock {
  return { seat, ts, title: 't', text: 'x', repo };
}

function logOf(...blocks: LogBlock[]): LogFileInfo {
  return { date: '2026-09-30', mtimeMs: 0, blocks };
}

function run(overrides: Partial<SeatCheckInput>): Finding[] {
  return seatCheckFindings({
    seatsSection: '',
    boardName: BOARD,
    holders: null,
    logs: [],
    now: NOW,
    ...overrides,
  });
}

const up = (name: string, label?: string): string =>
  `- **[repoboard] ${name}: UP 2026-09-29 18:00Z${label === undefined ? '' : ` · ${label}`}.** working`;
const down = (name: string): string =>
  `- **[repoboard] ${name}: DOWN 2026-09-29 20:16Z.** stood down\n  in-flight: none\n  owes: none`;

/** ONE seeded bad input — bullets 1 and 3 are one seat, `ops` is on two boards, and so on. */
const BAD_SEATS = [
  '- **[repoboard] builder: UP 2026-09-29 18:00Z · A7B2 · repoboard builder.** in-flight: none',
  '- Owner tasks elsewhere: ACME-9',
  '- **[repoboard] builder: UP 2026-09-29 19:00Z · A7B2 · repoboard builder.** in-flight: none',
  '- **[repoboard] ops: UP 2026-09-29 18:30Z · 1D3F · repoboard ops.** watching CI',
  '- **[acme] ops: UP 2026-09-29 18:40Z.** watching the acme board',
  '- **[repoboard] scout: UP 2026-09-29 18:50Z · D00D · repoboard scout.** reading',
  '- **[repoboard] coordinator: DOWN 2026-09-29 20:16Z.** stood down',
  '  in-flight: none',
  '  owes: none',
].join('\n');

const BAD_HOLDERS = holdersOf(
  lease('builder', 'A7B21234-AAAA', 4001),
  lease('ops', '1D3F9999-BBBB', 4002),
  lease('writer', '1D3F9999-BBBB', 4003),
  lease('scout', 'D00D7777-CCCC', 4004, 'dead'),
);

const BAD_LOGS = [logOf(block('COORDINATOR', '2026-09-30T00:38:12Z'))];

describe('seatCheckFindings: the seeded bad input (RCB-200)', () => {
  it('fires each of the six kinds exactly once, at the right level, in kind order', () => {
    const findings = run({ seatsSection: BAD_SEATS, holders: BAD_HOLDERS, logs: BAD_LOGS });
    expect(findings).toEqual([
      {
        kind: 'seat-duplicate-bullet',
        level: 'error',
        message:
          'seat-duplicate-bullet: SEATS bullets 1 and 3 are both seat "builder" — seat verbs ' +
          'rewrite only bullet 1; merge them',
      },
      {
        kind: 'seat-name-ambiguous',
        level: 'warning',
        message:
          'seat-name-ambiguous: seat "ops" is stamped on 2 boards — [repoboard] bullet 4, ' +
          '[acme] bullet 5 — a seat verb matches the name alone, whichever board a bullet is ' +
          "stamped for; give each board's seat its own name — a seat verb takes bullet 4",
      },
      {
        kind: 'seat-log-while-down',
        level: 'warning',
        message:
          'seat-log-while-down: seat "coordinator" is DOWN since 2026-09-29 20:16Z but its ' +
          'newest log block is 2026-09-30T00:38:12Z — it logged after it stood down: stale ' +
          'DOWN, or a session working without holding the seat',
      },
      {
        kind: 'seat-up-dead-holder',
        level: 'warning',
        message:
          'seat-up-dead-holder: seat "scout" is UP but its holder D00D is dead: no process — ' +
          'the session is gone; stand the seat down or take it over',
      },
      {
        kind: 'pane-holds-two-seats',
        level: 'error',
        message: 'pane-holds-two-seats: 1D3F holds ops and writer',
      },
      {
        kind: 'seat-lease-bullet-drift',
        level: 'warning',
        message:
          'seat-lease-bullet-drift: seat "writer": lease says held by 1D3F; SEATS has no ' +
          'bullet for it',
      },
    ]);
  });

  it('holders null (seats.yml unreadable): only kinds 1-3 — the holder checks say nothing', () => {
    const findings = run({ seatsSection: BAD_SEATS, holders: null, logs: BAD_LOGS });
    expect(findings.map((f) => f.kind)).toEqual([
      'seat-duplicate-bullet',
      'seat-name-ambiguous',
      'seat-log-while-down',
    ]);
  });

  it('a null SEATS section (no STATE.md) is inert whatever else is handed in', () => {
    expect(run({ seatsSection: null, holders: BAD_HOLDERS, logs: BAD_LOGS })).toEqual([]);
  });

  it('CLEAN: an UP builder labelled by its live holder, a DOWN coordinator last logged in its DOWN minute', () => {
    const findings = run({
      seatsSection: [up('builder', 'A7B2 · repoboard builder'), down('coordinator')].join('\n'),
      holders: holdersOf(lease('builder', 'A7B21234-AAAA', 4001)),
      logs: [
        logOf(
          block('BUILDER', '2026-09-30T00:59:00Z'),
          block('COORDINATOR', '2026-09-29T19:50:00Z'),
          block('COORDINATOR', '2026-09-29T20:16:40Z'),
        ),
      ],
    });
    expect(findings).toEqual([]);
  });

  it('an empty section and no holders at all: nothing', () => {
    expect(run({ seatsSection: '', holders: [] })).toEqual([]);
  });
});

describe('seat-duplicate-bullet (RCB-200)', () => {
  it('an unprefixed, a [Board] and a legacy "[board] board name" bullet are ONE seat on ONE board', () => {
    const section = [
      '- **builder: UP 2026-09-29 18:00Z.** a',
      '- **[RepoBoard] builder: UP 2026-09-29 18:05Z.** b',
      '- **[repoboard] repoboard builder: UP 2026-09-29 18:10Z.** c',
    ].join('\n');
    expect(run({ seatsSection: section })).toEqual([
      {
        kind: 'seat-duplicate-bullet',
        level: 'error',
        message:
          'seat-duplicate-bullet: SEATS bullets 1, 2 and 3 are all seat "builder" — seat ' +
          'verbs rewrite only bullet 1; merge them',
      },
    ]);
  });

  it('the same name on ANOTHER board is not a duplicate (that is the ambiguity finding)', () => {
    const section = [up('ops'), '- **[acme] ops: UP 2026-09-29 18:40Z.** x'].join('\n');
    expect(run({ seatsSection: section }).map((f) => f.kind)).toEqual(['seat-name-ambiguous']);
  });

  it('builder and builder-2, or a name folded only by case and spacing, are told apart correctly', () => {
    expect(run({ seatsSection: [up('builder'), up('builder-2')].join('\n') })).toEqual([]);
    const folded = [up('web  Builder'), up('web builder')].join('\n');
    expect(run({ seatsSection: folded }).map((f) => f.kind)).toEqual(['seat-duplicate-bullet']);
  });

  it('an unstamped bullet is no fact, but it still counts in the bullet numbers', () => {
    const section = ['- Owner tasks: none', '- Notes: x', up('ops'), up('ops')].join('\n');
    expect(run({ seatsSection: section })[0]?.message).toContain('SEATS bullets 3 and 4');
  });
});

describe('seat-name-ambiguous (RCB-200)', () => {
  it('an unprefixed bullet is THIS board, named with the board name', () => {
    const section = [
      '- **ops: UP 2026-09-29 18:00Z.** a',
      '- **[acme] ops: UP 2026-09-29 18:00Z.** b',
    ];
    const [f] = run({ seatsSection: section.join('\n') });
    expect(f?.level).toBe('warning');
    expect(f?.message).toContain(
      'is stamped on 2 boards — [repoboard] bullet 1, [acme] bullet 2 —',
    );
    expect(f?.message.endsWith(' its own name — a seat verb takes bullet 1')).toBe(true);
  });

  it('names the FIRST matching bullet in section order — the one a seat verb rewrites — by its bullet number, unstamped bullets counted', () => {
    const section = [
      '- Owner tasks: none',
      '- **[acme] ops: UP 2026-09-29 18:00Z.** a',
      '- **[repoboard] ops: UP 2026-09-29 18:00Z.** b',
    ];
    const [f] = run({ seatsSection: section.join('\n') });
    expect(f?.kind).toBe('seat-name-ambiguous');
    expect(f?.message).toContain(
      'is stamped on 2 boards — [acme] bullet 2, [repoboard] bullet 3 —',
    );
    expect(f?.message.endsWith(' — a seat verb takes bullet 2')).toBe(true);
  });

  it('with no board name at all, an unprefixed bullet is named "(unprefixed)"', () => {
    const section = [
      '- **ops: UP 2026-09-29 18:00Z.** a',
      '- **[acme] ops: UP 2026-09-29 18:00Z.** b',
    ];
    const [f] = run({ seatsSection: section.join('\n'), boardName: '' });
    expect(f?.message).toContain('— (unprefixed) bullet 1, [acme] bullet 2 —');
  });
});

describe('seat-log-while-down (RCB-200)', () => {
  const section = down('coordinator');
  const only = (blocks: LogBlock[], now: Date = NOW): Finding[] =>
    run({ seatsSection: section, logs: [logOf(...blocks)], now });

  it("a block in the DOWN minute is the seat's last block, not a finding — the next minute fires", () => {
    expect(only([block('COORDINATOR', '2026-09-29T20:16:00Z')])).toEqual([]);
    expect(only([block('COORDINATOR', '2026-09-29T20:16:59Z')])).toEqual([]);
    expect(only([block('COORDINATOR', '2026-09-29T20:15:59Z')])).toEqual([]);
    const fires = only([block('COORDINATOR', '2026-09-29T20:17:00Z')]);
    expect(fires.map((f) => f.kind)).toEqual(['seat-log-while-down']);
    expect(fires[0]?.message).toContain('newest log block is 2026-09-29T20:17:00Z');
  });

  it('the NEWEST block is the one named', () => {
    const [f] = only([
      block('COORDINATOR', '2026-09-29T21:00:00Z'),
      block('COORDINATOR', '2026-09-30T00:38:12Z'),
      block('COORDINATOR', '2026-09-29T22:00:00Z'),
    ]);
    expect(f?.message).toContain('newest log block is 2026-09-30T00:38:12Z');
  });

  it("a stamp more than 60 s ahead of the clock is not evidence (it is future-stamp's finding)", () => {
    expect(FUTURE_STAMP_TOLERANCE_MS).toBe(60_000);
    expect(only([block('COORDINATOR', '2026-09-30T01:01:01Z')])).toEqual([]);
    // Exactly at the tolerance still counts, like `newestMomentOf`.
    expect(only([block('COORDINATOR', '2026-09-30T01:01:00Z')]).map((f) => f.kind)).toEqual([
      'seat-log-while-down',
    ]);
  });

  it('an ignored future block does not hide an older one that counts', () => {
    const [f] = only([
      block('COORDINATOR', '2026-09-30T05:00:00Z'),
      block('COORDINATOR', '2026-09-30T00:38:12Z'),
    ]);
    expect(f?.message).toContain('newest log block is 2026-09-30T00:38:12Z');
  });

  it("ANOTHER board's block says nothing; this board's own prefix (any case) or none does", () => {
    expect(only([block('COORDINATOR', '2026-09-30T00:38:00Z', 'acme')])).toEqual([]);
    expect(only([block('COORDINATOR', '2026-09-30T00:38:00Z', 'REPOBOARD')]).length).toBe(1);
    expect(only([block('COORDINATOR', '2026-09-30T00:38:00Z', null)]).length).toBe(1);
  });

  it('a block under the board\'s own name ("REPOBOARD COORDINATOR") is the same seat; another seat\'s is not', () => {
    expect(only([block('REPOBOARD COORDINATOR', '2026-09-30T00:38:00Z')]).length).toBe(1);
    expect(only([block('BUILDER', '2026-09-30T00:38:00Z')])).toEqual([]);
  });

  it('a ts that is not a moment (no zone, date only, unparseable) counts for nothing', () => {
    expect(only([block('COORDINATOR', '2026-09-30T00:38:00')])).toEqual([]);
    expect(only([block('COORDINATOR', '2026-09-30')])).toEqual([]);
    expect(only([block('COORDINATOR', '2026-09-30 0x:xxZ')])).toEqual([]);
  });

  it('a DOWN stamp that does not parse has nothing to compare; an UP bullet is never judged', () => {
    const late = [block('COORDINATOR', '2026-09-30T00:38:00Z')];
    const garbled = '- **[repoboard] coordinator: DOWN 2026-09-29 20:0xZ.** x';
    expect(run({ seatsSection: garbled, logs: [logOf(...late)] })).toEqual([]);
    expect(run({ seatsSection: up('coordinator'), logs: [logOf(...late)] })).toEqual([]);
  });

  it("only THIS board's DOWN bullet is judged, not another board's of the same name", () => {
    const other = '- **[acme] coordinator: DOWN 2026-09-29 20:16Z.** x';
    expect(
      run({ seatsSection: other, logs: [logOf(block('COORDINATOR', '2026-09-30T00:38:00Z'))] }),
    ).toEqual([]);
  });
});

describe('seat-up-dead-holder (RCB-200)', () => {
  const dead = (state: LeaseState, pane: string | null = 'D00D7777-CCCC') =>
    run({
      seatsSection: up('scout', 'D00D · repoboard scout'),
      holders: holdersOf(lease('scout', pane, 4004, state)),
    }).filter((f) => f.kind === 'seat-up-dead-holder');

  it('a DEAD holder fires, worded by describeLiveness (pid reuse included)', () => {
    expect(dead('dead')[0]?.message).toContain('its holder D00D is dead: no process —');
    expect(dead('reused')[0]?.message).toContain('its holder D00D is dead: pid reused —');
  });

  it('a holder with no pane is named "(no pane)"', () => {
    expect(dead('dead', null)[0]?.message).toContain('its holder (no pane) is dead: no process');
  });

  it('alive and unknown say nothing; a DOWN bullet is never "UP with a dead holder"', () => {
    expect(dead('alive')).toEqual([]);
    expect(dead('unknown')).toEqual([]);
    const found = run({
      seatsSection: down('scout'),
      holders: holdersOf(lease('scout', 'D00D7777-CCCC', 4004, 'dead')),
    });
    expect(found.some((f) => f.kind === 'seat-up-dead-holder')).toBe(false);
  });
});

describe('pane-holds-two-seats (RCB-200)', () => {
  const messagesOf = (holders: SeatHolderInfo[]): string[] =>
    run({ seatsSection: '- Notes: none', holders })
      .filter((f) => f.kind === 'pane-holds-two-seats')
      .map((f) => f.message);

  it('the same pane in any letter case is one holder; the tag names it', () => {
    expect(
      messagesOf(holdersOf(lease('builder', '1d3f9999', 4001), lease('ops', '1D3F9999', 4002))),
    ).toEqual(['pane-holds-two-seats: 1D3F holds builder and ops']);
  });

  it('three seats on one pane: one finding naming all three', () => {
    expect(
      messagesOf(
        holdersOf(lease('a', '1D3F9999', 1), lease('b', '1D3F9999', 2), lease('c', '1D3F9999', 3)),
      ),
    ).toEqual(['pane-holds-two-seats: 1D3F holds a, b and c']);
  });

  it('a holder joins the first EARLIER group whose head matches, not the neighbour', () => {
    expect(
      messagesOf(
        holdersOf(lease('a', '1D3F9999', 1), lease('b', 'A7B21234', 2), lease('c', '1D3F9999', 3)),
      ),
    ).toEqual(['pane-holds-two-seats: 1D3F holds a and c']);
  });

  it('two different panes are two holders', () => {
    expect(messagesOf(holdersOf(lease('a', '1D3F9999', 1), lease('b', 'A7B21234', 2)))).toEqual([]);
  });

  it('no pane on either side: the same host + pid + start is still one holder, tagged "(no pane)"', () => {
    expect(messagesOf(holdersOf(lease('a', null, 4001), lease('b', null, 4001)))).toEqual([
      'pane-holds-two-seats: (no pane) holds a and b',
    ]);
    // A different pid, or a missing start time, is not the same holder.
    expect(messagesOf(holdersOf(lease('a', null, 4001), lease('b', null, 4002)))).toEqual([]);
    expect(
      messagesOf(
        holdersOf(
          lease('a', null, 4001, 'alive', { start: null }),
          lease('b', null, 4001, 'alive', { start: null }),
        ),
      ),
    ).toEqual([]);
  });

  it('it is an error: it blocks `check` without --strict', () => {
    const findings = run({
      seatsSection: '- Notes: none',
      holders: holdersOf(lease('a', '1D3F9999', 1), lease('b', '1D3F9999', 2)),
    });
    expect(findings.find((f) => f.kind === 'pane-holds-two-seats')?.level).toBe('error');
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });
});

describe('seat-lease-bullet-drift (RCB-200)', () => {
  const drift = (section: string[], holders: SeatHolderInfo[]): string[] =>
    run({ seatsSection: section.join('\n'), holders })
      .filter((f) => f.kind === 'seat-lease-bullet-drift')
      .map((f) => f.message);
  const PREFIX = 'seat-lease-bullet-drift: seat ';

  it('UP, and the bullet tag is a prefix of the pane (4 characters, or a widened 6): no drift', () => {
    const a7b2 = holdersOf(lease('builder', 'A7B21234-AAAA', 1));
    expect(drift([up('builder', 'A7B2 · repoboard builder')], a7b2)).toEqual([]);
    // Letter case is not a difference.
    expect(drift([up('builder', 'a7b2 · repoboard builder')], a7b2)).toEqual([]);
    // Two live panes sharing A7B2 widen both tags to 6, and the bullet carries the 6.
    const widened = holdersOf(lease('builder', 'A7B2AA11', 1), lease('ops', 'A7B2BB22', 2));
    expect(widened.map((h) => h.tag)).toEqual(['A7B2AA', 'A7B2BB']);
    expect(
      drift(
        [up('builder', 'A7B2AA · repoboard builder'), up('ops', 'A7B2BB · repoboard ops')],
        widened,
      ),
    ).toEqual([]);
    // A 4-character tag on a bullet written before the widening is still a prefix of the pane.
    expect(
      drift(
        [up('builder', 'A7B2 · repoboard builder'), up('ops', 'A7B2 · repoboard ops')],
        widened,
      ),
    ).toEqual([]);
  });

  it('UP with a lease, and the tag is NOT a prefix of the pane', () => {
    expect(
      drift(
        [up('builder', 'A7B2 · repoboard builder')],
        holdersOf(lease('builder', 'D00D1234', 1)),
      ),
    ).toEqual([`${PREFIX}"builder": bullet says UP, holder label A7B2; lease says held by D00D`]);
    // 6-character tag, right first 4, wrong last 2.
    expect(
      drift(
        [up('builder', 'A7B2AA · repoboard builder')],
        holdersOf(lease('builder', 'A7B2BB11', 1)),
      ),
    ).toHaveLength(1);
  });

  it('UP with a lease that has a pane, and a bullet with no label at all', () => {
    expect(drift([up('builder')], holdersOf(lease('builder', 'A7B21234', 1)))).toEqual([
      `${PREFIX}"builder": bullet says UP, no holder label; lease says held by A7B2`,
    ]);
  });

  it('UP with a lease that has NO pane: a bullet tag is drift, a bullet with none is not', () => {
    const noPane = holdersOf(lease('builder', null, 1));
    expect(drift([up('builder', 'A7B2 · repoboard builder')], noPane)).toEqual([
      `${PREFIX}"builder": bullet says UP, holder label A7B2; lease says held by (no pane)`,
    ]);
    expect(drift([up('builder')], noPane)).toEqual([]);
  });

  it('UP with NO lease: a tag on the bullet names a holder nothing records; none is fine', () => {
    expect(drift([up('builder', 'A7B2 · repoboard builder')], [])).toEqual([
      `${PREFIX}"builder": bullet says UP, holder label A7B2; lease says no holder`,
    ]);
    expect(drift([up('builder')], [])).toEqual([]);
  });

  it('DOWN with a lease is drift; DOWN with none is the normal stand-down', () => {
    expect(drift([down('builder')], holdersOf(lease('builder', 'A7B21234', 1)))).toEqual([
      `${PREFIX}"builder": bullet says DOWN; lease says held by A7B2`,
    ]);
    expect(drift([down('builder')], [])).toEqual([]);
  });

  it('a lease with no bullet of its key ON THIS BOARD, however many boards have one', () => {
    const held = holdersOf(lease('builder', 'A7B21234', 1));
    const message = `${PREFIX}"builder": lease says held by A7B2; SEATS has no bullet for it`;
    expect(drift(['- Notes: none'], held)).toEqual([message]);
    expect(drift(['- **[acme] builder: UP 2026-09-29 18:00Z.** x'], held)).toEqual([message]);
  });

  it('a lease is found by the seat key, not its letter case or spacing', () => {
    expect(
      drift(
        [up('web builder', 'A7B2 · repoboard web builder')],
        holdersOf(lease('Web  Builder', 'A7B21234', 1)),
      ),
    ).toEqual([]);
  });

  it("two leases for one seat name: the FIRST one is the seat's holder, and the pair is reported once", () => {
    const holders = holdersOf(lease('builder', 'A7B21234', 1), lease('builder', 'D00D1234', 2));
    expect(drift([up('builder', 'A7B2 · repoboard builder')], holders)).toEqual([]);
  });

  it('two bullets for one seat: the FIRST is judged, so a duplicate is not also drift', () => {
    const findings = run({
      seatsSection: [up('builder', 'A7B2 · repoboard builder'), up('builder', 'D00D · x')].join(
        '\n',
      ),
      holders: holdersOf(lease('builder', 'A7B21234', 1)),
    });
    expect(findings.map((f) => f.kind)).toEqual(['seat-duplicate-bullet']);
  });

  it('holders [] (a readable, empty seats.yml) is not holders null', () => {
    const section = up('builder', 'A7B2 · repoboard builder');
    expect(run({ seatsSection: section, holders: null })).toEqual([]);
    expect(run({ seatsSection: section, holders: [] }).map((f) => f.kind)).toEqual([
      'seat-lease-bullet-drift',
    ]);
  });
});

describe('stampedSeatBullets (RCB-200)', () => {
  it('one fact per stamped bullet; position counts every top-level bullet', () => {
    const facts = stampedSeatBullets(BAD_SEATS);
    expect(facts.map((f) => f.position)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(facts[0]).toEqual({
      position: 1,
      board: 'repoboard',
      name: 'builder',
      key: 'builder',
      status: 'UP',
      at: new Date('2026-09-29T18:00:00Z'),
      label: 'A7B2 · repoboard builder',
    });
    expect(facts[3]).toMatchObject({ position: 5, board: 'acme', name: 'ops', label: null });
    expect(facts[5]).toMatchObject({ position: 7, status: 'DOWN', label: null });
  });

  it('the name is the one the seat verbs find: a legacy "[board] board name" is the bare name', () => {
    const [f] = stampedSeatBullets('- **[repoboard] repoboard Builder: UP 2026-09-29 18:00Z.** x');
    expect(f).toMatchObject({ board: 'repoboard', name: 'Builder', key: 'builder' });
    expect(stampedSeatBullets('- **web  builder: UP 2026-09-29 18:00Z.** x')[0]?.key).toBe(
      'web builder',
    );
  });

  it('an unparseable stamp is a fact with at null, never a guessed moment', () => {
    const [f] = stampedSeatBullets('- **ops: DOWN 2026-09-29 18:0xZ.** x');
    expect(f).toMatchObject({ status: 'DOWN', at: null, board: null });
  });

  it('a section with no stamped bullet (placeholder, prose, unstamped bullets): []', () => {
    expect(stampedSeatBullets('')).toEqual([]);
    expect(stampedSeatBullets('(none yet)')).toEqual([]);
    expect(stampedSeatBullets('- Owner tasks: none\n- **ops**: watching')).toEqual([]);
  });
});

describe('zonedLogMs (RCB-200)', () => {
  it('a date, a time AND a zone: the epoch milliseconds', () => {
    expect(zonedLogMs('2026-09-30T00:38:12Z')).toBe(Date.parse('2026-09-30T00:38:12Z'));
    expect(zonedLogMs('2026-09-30 00:38+02:00')).toBe(Date.parse('2026-09-29T22:38:00Z'));
  });

  it("anything else is null — never midnight UTC, never the host's local time", () => {
    expect(zonedLogMs('2026-09-30')).toBeNull();
    expect(zonedLogMs('2026-09-30T00:38:12')).toBeNull();
    expect(zonedLogMs('2026-09-30T99:99:00Z')).toBeNull();
    expect(zonedLogMs('2026-09-30 0x:xxZ')).toBeNull();
    expect(zonedLogMs('')).toBeNull();
  });
});

describe('checkFindings: CheckInput.seatFindings (RCB-200)', () => {
  const config = defaultBoardConfig();
  const at = new Date('2026-09-17T21:00:00Z');

  function stateAt(iso: string): StateDoc {
    const parsed = parseState(initialStateText({ now: new Date(iso), actor: 'claude/ops' }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.doc;
  }

  const base = {
    state: stateAt('2026-09-17T21:00:00Z'),
    logs: [],
    cards: [],
    config,
    leases: { leases: [], windows: [] },
    now: at,
  };

  const seatFindings = run({ seatsSection: BAD_SEATS, holders: BAD_HOLDERS, logs: BAD_LOGS });

  it("the caller's findings are pushed unchanged, right after seat-owner-queue-drift", () => {
    const findings = checkFindings({
      ...base,
      seatBullets: [{ name: 'coordinator', text: 'owes: OWNER QUEUE = ACME-86' }],
      seatFindings,
    });
    expect(findings[0]?.kind).toBe('seat-owner-queue-drift');
    expect(findings.slice(1)).toEqual(seatFindings);
    expect(findings).toHaveLength(1 + 6);
  });

  it('absent, null and [] are all inert', () => {
    expect(checkFindings(base)).toEqual([]);
    expect(checkFindings({ ...base, seatFindings: null })).toEqual([]);
    expect(checkFindings({ ...base, seatFindings: [] })).toEqual([]);
  });

  it('levels carry through exitCodeForFindings: an error blocks, a warning only with --strict', () => {
    const errors = seatFindings.filter((f) => f.level === 'error');
    const warnings = seatFindings.filter((f) => f.level === 'warning');
    expect(errors.map((f) => f.kind)).toEqual(['seat-duplicate-bullet', 'pane-holds-two-seats']);
    expect(exitCodeForFindings(checkFindings({ ...base, seatFindings: errors }), false)).toBe(1);
    expect(exitCodeForFindings(checkFindings({ ...base, seatFindings: warnings }), false)).toBe(0);
    expect(exitCodeForFindings(checkFindings({ ...base, seatFindings: warnings }), true)).toBe(1);
  });
});

describe('seatCheckFindings: the workspace: link (RCB-184)', () => {
  const copy = '- **[acme] coordinator: DOWN 2026-10-04 09:00Z.** stale copy';
  const own = '- **[repoboard] builder: UP 2026-10-05 09:00Z.** building';
  const section = [own, copy].join('\n');
  const readable = { ok: true, configured: '../acme', name: 'acme', listsMember: true } as const;
  const unreadable = {
    ok: false,
    configured: '../acme',
    error: '.repoboard/STATE.md: not found',
  } as const;

  it('no home (absent or null): exactly the findings there were — a copy-shaped bullet is silent', () => {
    const before = run({ seatsSection: section });
    expect(run({ seatsSection: section, home: null })).toEqual(before);
    expect(before.map((f) => f.kind)).toEqual([]);
  });

  it('seat-copy: one warning per own stamped bullet prefixed with the home name, naming the bullet', () => {
    const findings = run({
      seatsSection: [own, copy, '- **[ACME] ops: UP 2026-10-05 09:00Z.** copy too'].join('\n'),
      home: readable,
    });
    expect(findings).toEqual([
      {
        kind: 'seat-copy',
        level: 'warning',
        message:
          "seat-copy: SEATS bullet 2 ([acme] coordinator) is a copy of home board acme's seat — " +
          "delete it; the home's bullet is read live",
      },
      {
        kind: 'seat-copy',
        level: 'warning',
        message:
          "seat-copy: SEATS bullet 3 ([ACME] ops) is a copy of home board acme's seat — " +
          "delete it; the home's bullet is read live",
      },
    ]);
  });

  it("a bullet for a third board, and this board's own, are not copies", () => {
    const findings = run({
      seatsSection: [own, '- **[other] scout: UP 2026-10-05 09:00Z.** x'].join('\n'),
      home: readable,
    });
    expect(findings.map((f) => f.kind)).toEqual([]);
  });

  it('seat-home-not-member: one warning when the home lists no root resolving to this repo', () => {
    const findings = run({ seatsSection: own, home: { ...readable, listsMember: false } });
    expect(findings).toEqual([
      {
        kind: 'seat-home-not-member',
        level: 'warning',
        message:
          'seat-home-not-member: home board acme (workspace: ../acme) lists no repos: root that ' +
          'resolves to this repo — add this repo to its board.yml, or drop workspace:',
      },
    ]);
  });

  it('seat-home-unreadable: names the path as written and why; copies cannot be judged, so none', () => {
    const findings = run({ seatsSection: section, home: unreadable });
    expect(findings).toEqual([
      {
        kind: 'seat-home-unreadable',
        level: 'warning',
        message:
          'seat-home-unreadable: workspace: ../acme cannot be read (.repoboard/STATE.md: not ' +
          'found) — its seats are not listed here; fix the path, or drop workspace:',
      },
    ]);
  });

  it('the home findings need no SEATS section: unreadable and not-member still fire, copy cannot', () => {
    expect(run({ seatsSection: null, home: unreadable }).map((f) => f.kind)).toEqual([
      'seat-home-unreadable',
    ]);
    expect(
      run({ seatsSection: null, home: { ...readable, listsMember: false } }).map((f) => f.kind),
    ).toEqual(['seat-home-not-member']);
    expect(run({ seatsSection: null, home: readable })).toEqual([]);
  });

  it('all three are warnings: they block only with --strict', () => {
    const findings = run({
      seatsSection: section,
      home: { ...readable, listsMember: false },
    });
    expect(findings.map((f) => f.kind)).toEqual(['seat-copy', 'seat-home-not-member']);
    expect(findings.every((f) => f.level === 'warning')).toBe(true);
  });
});
