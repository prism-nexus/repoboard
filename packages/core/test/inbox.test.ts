/**
 * RCB-230: `inbox.ts` — the addresses a seat has not ACKed. Seats address each other inside log
 * blocks ("TO BUILDER ACME-283: …"); nothing listed what stayed open, so a finding hung for hours,
 * often because the seat it went to was DOWN. One case per rule: the address shape, what is NOT an
 * address, how an ACK clears one, the window, and the DOWN-seat roll-up `check` reads.
 */
import { describe, expect, it } from 'vitest';
import { downSeatAddresses, unackedAddresses } from '../src/inbox.js';
import type { DatedLogBlocks, LogBlock } from '../src/repolog.js';

const SEATS = ['coordinator', 'builder', 'ops', 'board-coordinator'];
const SINCE = Date.parse('2026-10-18T00:00:00Z');

function block(seat: string, ts: string, text: string, title = 'a block'): LogBlock {
  return { repo: null, seat: seat.toUpperCase(), ts, title, text };
}

function day(date: string, ...blocks: LogBlock[]): DatedLogBlocks {
  return { date, blocks };
}

/** Run `unackedAddresses` for `seat` with this file's seats and a window opening 2026-10-18. */
function inbox(
  seat: string,
  days: DatedLogBlocks[],
  extra: { knownSeats?: string[]; sinceMs?: number } = {},
) {
  return unackedAddresses({
    seat,
    days,
    knownSeats: extra.knownSeats ?? SEATS,
    cardPrefix: 'ACME',
    sinceMs: extra.sinceMs ?? SINCE,
  });
}

describe('unackedAddresses: what an address is', () => {
  it('lists a mid-line address with its card ids, sender and addressee', () => {
    const items = inbox('coordinator', [
      day(
        '2026-10-19',
        block(
          'builder',
          '2026-10-19T10:00:00Z',
          'Done.\nResult: TO COORDINATOR ACME-12, ACME-13: ready',
        ),
      ),
    ]);
    expect(items).toEqual([
      {
        date: '2026-10-19',
        ts: '2026-10-19T10:00:00Z',
        from: 'BUILDER',
        to: 'COORDINATOR',
        cardIds: ['ACME-12', 'ACME-13'],
        line: 'Result: TO COORDINATOR ACME-12, ACME-13: ready',
      },
    ]);
  });

  it('reads an indented continuation line as a line of its own', () => {
    const items = inbox('builder', [
      day(
        '2026-10-19',
        block(
          'coordinator',
          '2026-10-19T10:00:00Z',
          'Next:\n  TO BUILDER A11E ACME-283 (K305 step 2): take it',
        ),
      ),
    ]);
    expect(items.map((i) => i.cardIds)).toEqual([['ACME-283']]);
    expect(items[0]?.line.startsWith('TO BUILDER A11E')).toBe(true);
  });

  it('is case-sensitive and on a word boundary: `to coordinator`, `GOTO COORDINATOR` are prose', () => {
    const items = inbox('coordinator', [
      day(
        '2026-10-19',
        block('builder', '2026-10-19T10:00:00Z', 'to coordinator ACME-1\nGOTO COORDINATOR ACME-2'),
      ),
    ]);
    expect(items).toEqual([]);
  });

  it('a `/` list addresses every seat in it, each with an optional pane tag', () => {
    const days = [
      day(
        '2026-10-19',
        block('ops', '2026-10-19T10:00:00Z', 'TO COORD A996 / BUILDER F011: look at ACME-5'),
      ),
    ];
    expect(inbox('coordinator', days).map((i) => i.to)).toEqual(['COORDINATOR']);
    expect(inbox('builder', days).map((i) => i.to)).toEqual(['BUILDER']);
    expect(inbox('ops', days)).toEqual([]);
  });

  it('reads a seat token by its leading word, case and `[repo] ` prefix aside', () => {
    const days = [
      day(
        '2026-10-19',
        block('Builder A11E (fresh)', '2026-10-19T10:00:00Z', 'TO OPS    ACME-91, rerun'),
      ),
    ];
    const items = inbox('[acme] Ops', days, { knownSeats: ['[acme] ops', '[acme] Builder'] });
    expect(items.map((i) => [i.from, i.to])).toEqual([['BUILDER', 'OPS']]);
  });
});

describe('unackedAddresses: prefix resolution', () => {
  const days = [
    day(
      '2026-10-19',
      block('ops', '2026-10-19T10:00:00Z', 'TO COORD ACME-1: a'),
      block('ops', '2026-10-19T10:01:00Z', 'TO BOARD-COORDINATOR ACME-2: b'),
    ),
  ];

  it('COORD is COORDINATOR, never BOARD-COORDINATOR', () => {
    expect(inbox('coordinator', days).map((i) => i.cardIds)).toEqual([['ACME-1']]);
    expect(inbox('board-coordinator', days).map((i) => i.cardIds)).toEqual([['ACME-2']]);
  });

  it('a prefix that fits two known seats, or is under 4 characters, resolves to nothing', () => {
    const ambiguous = [
      day(
        '2026-10-19',
        block('ops', '2026-10-19T10:00:00Z', 'TO COORD ACME-1\nTO OPS ACME-2\nTO BUI ACME-3'),
      ),
    ];
    const known = ['coordinator-a', 'coordinator-b', 'builder', 'ops'];
    expect(inbox('coordinator-a', ambiguous, { knownSeats: known })).toEqual([]);
    expect(inbox('coordinator-b', ambiguous, { knownSeats: known })).toEqual([]);
    expect(inbox('builder', ambiguous, { knownSeats: known })).toEqual([]);
  });
});

describe('unackedAddresses: what is not an address', () => {
  it('an OWES field is not an address: the line and its indented continuation (RCB-230 false positive)', () => {
    const text = [
      'Landed ACME-42.',
      'owes: Result TO COORDINATOR ACME-42',
      '  and TO COORDINATOR ACME-43 once green',
      '- OWES Result TO COORDINATOR ACME-44',
      'TO COORDINATOR ACME-45: this one is real',
    ].join('\n');
    const items = inbox('coordinator', [
      day('2026-10-19', block('builder', '2026-10-19T10:00:00Z', text)),
    ]);
    expect(items.map((i) => i.cardIds)).toEqual([['ACME-45']]);
  });

  it('text after the list starting with `none` or `ACK` is not an address', () => {
    const text = 'TO OPS none\nTO COORDINATOR ACME-383: ACK the rerun\nTO COORDINATOR ACK ACME-9';
    const days = [day('2026-10-19', block('builder', '2026-10-19T10:00:00Z', text))];
    expect(inbox('ops', days)).toEqual([]);
    expect(inbox('coordinator', days)).toEqual([]);
  });

  it("the block's own seat is not an addressee", () => {
    const days = [
      day(
        '2026-10-19',
        block('coordinator', '2026-10-19T10:00:00Z', 'TO COORDINATOR ACME-1: note'),
      ),
    ];
    expect(inbox('coordinator', days)).toEqual([]);
  });

  it('an unresolved addressee token is ignored', () => {
    const days = [
      day('2026-10-19', block('builder', '2026-10-19T10:00:00Z', 'TO DO ACME-1\nTO NOBODY ACME-2')),
    ];
    expect(inbox('coordinator', days)).toEqual([]);
  });
});

describe('unackedAddresses: ACK', () => {
  const address = block('builder', '2026-10-19T10:00:00Z', 'TO COORDINATOR ACME-12: please look');

  it('a LATER block of the addressee with ACK and the id clears it', () => {
    const acked = [
      day(
        '2026-10-19',
        address,
        block('coordinator', '2026-10-19T11:00:00Z', 'ACK ACME-12, on it'),
      ),
    ];
    expect(inbox('coordinator', acked)).toEqual([]);
  });

  it('an ACK in an EARLIER block, by someone else, or with no ACK word, clears nothing', () => {
    expect(
      inbox('coordinator', [
        day('2026-10-19', block('coordinator', '2026-10-19T09:00:00Z', 'ACK ACME-12'), address),
      ]),
    ).toHaveLength(1);
    expect(
      inbox('coordinator', [
        day('2026-10-19', address, block('ops', '2026-10-19T11:00:00Z', 'ACK ACME-12')),
      ]),
    ).toHaveLength(1);
    expect(
      inbox('coordinator', [
        day('2026-10-19', address, block('coordinator', '2026-10-19T11:00:00Z', 'saw ACME-12')),
      ]),
    ).toHaveLength(1);
  });

  it('only ids AFTER the ACK on its line count', () => {
    const days = [
      day(
        '2026-10-19',
        address,
        block('coordinator', '2026-10-19T11:00:00Z', 'ACME-12 pending; ACK ACME-99'),
      ),
    ];
    expect(inbox('coordinator', days)).toHaveLength(1);
  });

  it('a partial ACK of two ids leaves the address listed; the second ACK clears it', () => {
    const two = block('builder', '2026-10-19T10:00:00Z', 'TO COORDINATOR ACME-12, ACME-13: both');
    const half = day(
      '2026-10-19',
      two,
      block('coordinator', '2026-10-19T11:00:00Z', 'ACK ACME-12'),
    );
    expect(inbox('coordinator', [half]).map((i) => i.cardIds)).toEqual([['ACME-12', 'ACME-13']]);
    const full = day(
      '2026-10-19',
      two,
      block('coordinator', '2026-10-19T11:00:00Z', 'ACK ACME-12'),
      block('coordinator', '2026-10-19T12:00:00Z', 'ACK ACME-13'),
    );
    expect(inbox('coordinator', [full])).toEqual([]);
  });

  it('an address with no card id is acked by its block HH:MMZ', () => {
    const bare = block('builder', '2026-10-19T10:05:00Z', 'TO COORDINATOR: look at the board');
    const wrong = day(
      '2026-10-19',
      bare,
      block('coordinator', '2026-10-19T11:00:00Z', 'ACK 10:06Z'),
    );
    expect(inbox('coordinator', [wrong])).toHaveLength(1);
    const right = day(
      '2026-10-19',
      bare,
      block('coordinator', '2026-10-19T11:00:00Z', 'ACK 10:05Z'),
    );
    expect(inbox('coordinator', [right])).toEqual([]);
  });

  it('an ACK on an OWES line is a debt, not an acknowledgement', () => {
    const days = [
      day('2026-10-19', address, block('coordinator', '2026-10-19T11:00:00Z', 'owes: ACK ACME-12')),
    ];
    expect(inbox('coordinator', days)).toHaveLength(1);
  });
});

describe('unackedAddresses: order and window', () => {
  it('an address at 23:50Z still shows from a block at 00:10Z the next day', () => {
    const days = [
      day('2026-10-19', block('builder', '2026-10-19T23:50:00Z', 'TO COORDINATOR ACME-7: late')),
      day('2026-10-20', block('ops', '2026-10-20T00:10:00Z', 'nothing')),
    ];
    const sinceMs = Date.parse('2026-10-20T00:10:00Z') - 48 * 3600_000;
    expect(inbox('coordinator', days, { sinceMs }).map((i) => i.cardIds)).toEqual([['ACME-7']]);
  });

  it('an ACK the next day clears it', () => {
    const days = [
      day('2026-10-20', block('coordinator', '2026-10-20T00:05:00Z', 'ACK ACME-7')),
      day('2026-10-19', block('builder', '2026-10-19T23:50:00Z', 'TO COORDINATOR ACME-7: late')),
    ];
    // Caller order is not trusted: days are read in date order.
    expect(inbox('coordinator', days)).toEqual([]);
  });

  it('never re-sorts by ts: file order decides which block is later, even with a ts out of order', () => {
    const days = [
      day(
        '2026-10-19',
        block('coordinator', '2026-10-19T09:00:00Z', 'ACK ACME-7'),
        block('builder', '2026-10-19T08:00:00Z', 'TO COORDINATOR ACME-7: hand-written ts'),
      ),
    ];
    expect(inbox('coordinator', days)).toHaveLength(1);
  });

  it('a block before the window is out; one at the boundary is in', () => {
    const days = [
      day('2026-10-17', block('builder', '2026-10-17T23:59:59Z', 'TO COORDINATOR ACME-1: old')),
      day('2026-10-18', block('builder', '2026-10-18T00:00:00Z', 'TO COORDINATOR ACME-2: edge')),
    ];
    expect(inbox('coordinator', days).map((i) => i.cardIds)).toEqual([['ACME-2']]);
  });

  it('a ts that does not parse counts by its file date against the since date', () => {
    const days = [
      day('2026-10-17', block('builder', '2026-10-17 0x:xxZ', 'TO COORDINATOR ACME-1: old')),
      day('2026-10-18', block('builder', '2026-10-18 0x:xxZ', 'TO COORDINATOR ACME-2: same day')),
    ];
    expect(inbox('coordinator', days).map((i) => i.cardIds)).toEqual([['ACME-2']]);
  });

  it('lists oldest first', () => {
    const days = [
      day(
        '2026-10-19',
        block('builder', '2026-10-19T10:00:00Z', 'TO COORDINATOR ACME-1: a'),
        block('ops', '2026-10-19T11:00:00Z', 'TO COORDINATOR ACME-2: b'),
      ),
    ];
    expect(inbox('coordinator', days).map((i) => i.from)).toEqual(['BUILDER', 'OPS']);
  });

  it('an empty seat name is inert', () => {
    expect(
      inbox('  ', [
        day('2026-10-19', block('builder', '2026-10-19T10:00:00Z', 'TO COORDINATOR ACME-1')),
      ]),
    ).toEqual([]);
  });
});

describe('downSeatAddresses', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');
  const section = [
    '- **coordinator: DOWN 2026-10-19 22:00Z.** stood down',
    '- **builder: UP 2026-10-20 11:00Z.** working',
    '- **ops: DOWN 2026-10-19 22:00Z.** stood down',
  ].join('\n');
  const days = [
    day(
      '2026-10-19',
      block('builder', '2026-10-19T23:50:00Z', 'TO COORDINATOR ACME-7: late'),
      block('builder', '2026-10-19T23:51:00Z', 'TO COORDINATOR ACME-8: later'),
      block('coordinator', '2026-10-19T23:55:00Z', 'TO BUILDER ACME-9: for an UP seat'),
      block('builder', '2026-10-19T23:56:00Z', 'TO OPS ACME-10: ack it'),
      block('ops', '2026-10-19T23:57:00Z', 'ACK ACME-10'),
    ),
  ];

  it('names each DOWN seat with open addresses: the count, the oldest ts and its sender', () => {
    expect(
      downSeatAddresses({ seatsSection: section, days, cardPrefix: 'ACME', now: NOW }),
    ).toEqual([
      { seat: 'coordinator', count: 2, oldestTs: '2026-10-19T23:50:00Z', oldestFrom: 'BUILDER' },
    ]);
  });

  it('says nothing with no SEATS section, or when the address is older than 48 h', () => {
    expect(downSeatAddresses({ seatsSection: null, days, cardPrefix: 'ACME', now: NOW })).toEqual(
      [],
    );
    const later = new Date('2026-10-22T00:00:00Z');
    expect(
      downSeatAddresses({ seatsSection: section, days, cardPrefix: 'ACME', now: later }),
    ).toEqual([]);
  });
});
