/**
 * RCB-48: `seat.ts` — the cold-start bundle. `findSeatLine`'s whole-word bullet match,
 * `seatBundle`'s next-card and coordinator-omission rules, `renderSeatBundle`'s fixed sections
 * with placeholders for every missing part.
 */
import { describe, expect, it } from 'vitest';
import {
  findSeatLine,
  formatSeatBullet,
  parseSeatStamp,
  renderSeatBundle,
  replaceSeatBullet,
  type SeatBundle,
  seatBundle,
  seatUpConflict,
} from '../src/seat.js';
import { SECTION_PLACEHOLDER } from '../src/state.js';
import type { Card } from '../src/types.js';

const NOW = new Date('2026-09-18T21:00:00Z');

const SEATS = [
  '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1',
  '  continuation line here',
  '- **ops**: watching things',
  '- **coordinator**: routes work',
].join('\n');

function card(overrides: Partial<Card> & { id: string }): Card {
  return {
    title: 'a card',
    status: 'todo',
    created: '2026-09-18T20:00:00Z',
    updated: '2026-09-18T20:00:00Z',
    body: '',
    ...overrides,
  };
}

describe('findSeatLine', () => {
  it('matches the bullet whose first line contains name as a whole word (a)', () => {
    const line = findSeatLine(SEATS, 'builder');
    expect(line).not.toBeNull();
    expect(line?.startsWith('- **repoboard builder')).toBe(true);
  });

  it('matches the coordinator bullet (b)', () => {
    const line = findSeatLine(SEATS, 'coordinator');
    expect(line).toBe('- **coordinator**: routes work');
  });

  it('"ordinator" matches nothing — whole word only (c)', () => {
    expect(findSeatLine(SEATS, 'ordinator')).toBeNull();
  });

  it('keeps continuation lines in the returned bullet text', () => {
    const line = findSeatLine(SEATS, 'builder');
    expect(line).toContain('continuation line here');
    expect(line).toBe(
      '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1\n  continuation line here',
    );
  });

  it('a placeholder section (no "- " line) yields null', () => {
    expect(findSeatLine(SECTION_PLACEHOLDER, 'builder')).toBeNull();
  });

  it('no match anywhere yields null', () => {
    expect(findSeatLine(SEATS, 'nonexistent')).toBeNull();
  });
});

describe('findSeatLine: label pass (RCB-48 dogfood fix, 2026-09-18 21:07Z)', () => {
  // This repo's real SEATS shape: the coordinator's bullet is prose-heavy and genuinely says
  // "the builder's" and "each builder" — whole-word "builder" hits, in the FIRST bullet, ahead of
  // the actual builder bullet. The label pass must see past that.
  const REAL_SHAPE = [
    '- **coordinator (shared with freshpickedjobs): UP 2026-09-18 20:2xZ, cold-started from ' +
      'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
      "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
      'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
      'card, restamp.',
    '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
  ].join('\n');

  it("C4 (control): `builder` returns the actual builder bullet, not the coordinator's prose mention", () => {
    const line = findSeatLine(REAL_SHAPE, 'builder');
    expect(line).toBe(
      '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
    );
  });

  it('fallback: a plain "label: text" bullet with no bold still matches on the label', () => {
    expect(findSeatLine('- ops: on the run', 'ops')).toBe('- ops: on the run');
  });
});

describe('seatBundle: nextCard', () => {
  it('C1: the card assigned to this seat wins over the first todo card in list order', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'builder', title: 'assigned to builder' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it('falls back to the first todo card (list order) when none is assigned to this seat', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'ops', title: 'assigned to someone else' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('first-todo');
  });

  it('no todo card at all: null, reason null', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'doing', title: 'in progress' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardReason).toBeNull();
  });

  it('the assignee match is case-insensitive', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'todo', assignee: 'BUILDER' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it(
    'RCB-57 B1 control fixture: an OLDER low-priority todo listed FIRST loses to a NEWER ' +
      'high-priority todo listed second (both unassigned)',
    () => {
      const cards: Card[] = [
        card({
          id: 'RCB-1',
          status: 'todo',
          priority: 'low',
          created: '2026-09-01T00:00:00Z',
          title: 'older, low priority',
        }),
        card({
          id: 'RCB-2',
          status: 'todo',
          priority: 'high',
          created: '2026-09-18T00:00:00Z',
          title: 'newer, high priority',
        }),
      ];
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: null,
        ownBlock: null,
        coordinatorBlock: null,
        cards,
      });
      expect(bundle.nextCard?.id).toBe('RCB-2');
      expect(bundle.nextCardReason).toBe('priority');
      const rendered = renderSeatBundle(bundle, NOW);
      expect(rendered).toContain('(first high-priority todo)');
    },
  );

  it('two `high` cards: the first in list order wins (stability)', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', priority: 'high', title: 'first high' }),
      card({ id: 'RCB-2', status: 'todo', priority: 'high', title: 'second high' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('a `medium` listed after an unset-priority card wins over it', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'unset priority, listed first' }),
      card({ id: 'RCB-2', status: 'todo', priority: 'medium', title: 'medium, listed second' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('a todo card assigned to ANOTHER seat is skipped even if high priority and listed first', () => {
    const cards: Card[] = [
      card({
        id: 'RCB-1',
        status: 'todo',
        priority: 'high',
        assignee: 'ops',
        title: 'high priority but assigned to ops',
      }),
      card({ id: 'RCB-2', status: 'todo', priority: 'low', title: 'low, unassigned' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('`assigned` still beats a higher-priority unassigned card', () => {
    const cards: Card[] = [
      card({
        id: 'RCB-1',
        status: 'todo',
        priority: 'high',
        title: 'high priority, unassigned',
      }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'builder', title: 'assigned to builder' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it('nothing prioritised: reason is `first-todo`, render shows the no-priority string', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first, unset' }),
      card({ id: 'RCB-2', status: 'todo', title: 'second, unset' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('first-todo');
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('(first todo; nothing assigned, nothing prioritised)');
  });

  it('renders the exact "Next card" lines for a `medium`-priority pick', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', priority: 'medium', title: 'the medium one' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('RCB-1  todo  the medium one\n(first medium-priority todo)');
  });
});

describe('seatBundle: coordinator section', () => {
  it('C2: coordinatorBlock is forced null when name IS the coordinator, even if one was gathered', () => {
    const gathered = {
      date: '2026-09-18',
      block: { seat: 'COORDINATOR', ts: NOW.toISOString(), title: 't', text: 'x' },
    };
    const bundle = seatBundle({
      name: 'coordinator',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: gathered,
      cards: [],
    });
    expect(bundle.coordinatorBlock).toBeNull();
  });

  it(
    'C2: the rendered bundle has exactly one "Last block — COORDINATOR" heading for the ' +
      'coordinator seat (its own; the separate coordinator section is omitted)',
    () => {
      const bundle = seatBundle({
        name: 'coordinator',
        now: NOW,
        seatsSection: null,
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      const rendered = renderSeatBundle(bundle, NOW);
      const headingCount = (rendered.match(/^## Last block — COORDINATOR$/gm) ?? []).length;
      expect(headingCount).toBe(1);
    },
  );

  it('a non-coordinator seat keeps its coordinatorBlock and the section', () => {
    const gathered = {
      date: '2026-09-18',
      block: { seat: 'COORDINATOR', ts: NOW.toISOString(), title: 't', text: 'x' },
    };
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: gathered,
      cards: [],
    });
    expect(bundle.coordinatorBlock).toEqual(gathered);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Last block — COORDINATOR');
  });
});

describe('seatBundle: openDecisions', () => {
  it('reuses needsDecision — only cards with an open decision appear, in list order', () => {
    const open = card({
      id: 'RCB-3',
      decision: {
        question: 'pick one',
        options: [],
        askedBy: 'coordinator',
        askedAt: '2026-09-18T20:00:00Z',
        returnTo: null,
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    const decided = card({
      id: 'RCB-4',
      decision: {
        question: 'already answered',
        options: [],
        askedBy: 'coordinator',
        askedAt: '2026-09-18T20:00:00Z',
        returnTo: null,
        chosen: null,
        words: 'yes',
        decidedBy: 'owner',
        decidedAt: '2026-09-18T20:30:00Z',
      },
    });
    const plain = card({ id: 'RCB-5' });
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [decided, open, plain],
    });
    expect(bundle.openDecisions.map((c) => c.id)).toEqual(['RCB-3']);
  });
});

describe('renderSeatBundle: placeholders for every missing part', () => {
  it('an entirely empty bundle renders a one-line placeholder per section, never an empty section', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      openDecisions: [],
      rig: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## SEATS line');
    expect(rendered).toContain('(no SEATS line mentions ops)');
    expect(rendered).toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).toContain('(no .repoboard/local/RIG.md — run repoboard local init)');
    expect(rendered).toContain('## Last block — OPS');
    expect(rendered).toContain('(no log block for ops)');
    expect(rendered).toContain('## Last block — COORDINATOR');
    expect(rendered).toContain('(no log block for coordinator)');
    expect(rendered).toContain('## Next card');
    expect(rendered).toContain('(no todo card)');
    expect(rendered).toContain('## Open decisions');
    expect(rendered).toContain('(none)');
  });

  it('a first-todo (unassigned) next card prints "(first todo; nothing assigned, nothing prioritised)"', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: card({ id: 'RCB-1', title: 'do this' }),
      nextCardReason: 'first-todo',
      openDecisions: [],
      rig: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('RCB-1  todo  do this');
    expect(rendered).toContain('(first todo; nothing assigned, nothing prioritised)');
  });
});

describe('seatBundle: rig (RCB-83)', () => {
  it('carries input.rig through untouched', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop\n\n## Build\npnpm build\n',
    });
    expect(bundle.rig).toBe('# RIG — laptop\n\n## Build\npnpm build\n');
  });

  it('defaults to null when input.rig is absent', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.rig).toBeNull();
  });

  it('renders the rig text after the SEATS line, before the last-block sections', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop',
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const seatsIdx = rendered.indexOf('## SEATS line');
    const rigIdx = rendered.indexOf('## Rig (.repoboard/local/RIG.md)');
    const lastBlockIdx = rendered.indexOf('## Last block');
    expect(seatsIdx).toBeGreaterThanOrEqual(0);
    expect(rigIdx).toBeGreaterThan(seatsIdx);
    expect(lastBlockIdx).toBeGreaterThan(rigIdx);
    expect(rendered).toContain('# RIG — laptop');
  });
});

describe('replaceSeatBullet / formatSeatBullet (RCB-58)', () => {
  const THREE = [
    '- **coordinator**: routes work',
    '- **repoboard builder (its own terminal)**: on RCB-1',
    '  continuation one',
    '  continuation two',
    '- **ops**: watching things',
  ].join('\n');

  it('test 1: replaces ONLY the builder bullet; coordinator and ops bullets are byte-identical, all 3 old builder lines gone', () => {
    const result = replaceSeatBullet(THREE, 'builder', 'X');
    expect(result).toBe(
      ['- **coordinator**: routes work', 'X', '- **ops**: watching things'].join('\n'),
    );
  });

  it('test 2a: appends as the last bullet when the seat has none yet', () => {
    const twoBullets = ['- **coordinator**: routes work', '- **ops**: watching things'].join('\n');
    const result = replaceSeatBullet(twoBullets, 'builder', 'X');
    expect(result).toBe(
      ['- **coordinator**: routes work', '- **ops**: watching things', 'X'].join('\n'),
    );
  });

  it('test 2b: a placeholder section becomes just the bullet', () => {
    expect(replaceSeatBullet(SECTION_PLACEHOLDER, 'builder', 'X')).toBe('X');
  });

  it('test 3: label-pass precedence — the coordinator prose-mentions "the builder" ahead of the builder\'s own bullet, but the builder\'s own is the one replaced (RCB-48 dogfood case)', () => {
    const REAL_SHAPE = [
      '- **coordinator (shared with freshpickedjobs): UP 2026-09-18 20:2xZ, cold-started from ' +
        'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
        "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
        'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
        'card, restamp.',
      '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
    ].join('\n');
    const result = replaceSeatBullet(REAL_SHAPE, 'builder', 'X');
    expect(result).toBe(
      [
        '- **coordinator (shared with freshpickedjobs): UP 2026-09-18 20:2xZ, cold-started from ' +
          'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
          "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
          'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
          'card, restamp.',
        'X',
      ].join('\n'),
    );
  });

  it('test 4: formatSeatBullet produces the exact bullet text, with a 2-line continuation indented', () => {
    const bullet = formatSeatBullet(
      'repoboard builder',
      'DOWN',
      'x\ny',
      new Date('2026-09-19T01:55:00Z'),
    );
    expect(bullet).toBe('- **repoboard builder: DOWN 2026-09-19 01:55Z.** x\n  y');
  });

  it('test 5: round trip — format → replace → findSeatLine returns exactly the new bullet', () => {
    const bullet = formatSeatBullet(
      'builder',
      'UP',
      'holding RCB-58',
      new Date('2026-09-19T02:00:00Z'),
    );
    const replaced = replaceSeatBullet(THREE, 'builder', bullet);
    expect(findSeatLine(replaced, 'builder')).toBe(bullet);
  });
});

describe('parseSeatStamp / seatUpConflict (RCB-87)', () => {
  const NOW87 = new Date('2026-09-21T22:37:00Z');

  it('(1) a formatted UP bullet 5 min old, window 30 -> conflict, minutesAgo 5', () => {
    const at = new Date(NOW87.getTime() - 5 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    expect(parseSeatStamp(bullet)).toEqual({ status: 'UP', at });
    expect(seatUpConflict(bullet, NOW87, 30)).toEqual({
      stamp: '2026-09-21 22:32Z',
      minutesAgo: 5,
    });
  });

  it('(2) UP 31 min old, window 30 -> no conflict', () => {
    const at = new Date(NOW87.getTime() - 31 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    expect(seatUpConflict(bullet, NOW87, 30)).toBeNull();
  });

  it('(3) DOWN 1 min old -> no conflict, --down is never guarded', () => {
    const at = new Date(NOW87.getTime() - 60_000);
    const bullet = formatSeatBullet('ops', 'DOWN', 'stood down', at);
    expect(parseSeatStamp(bullet)).toEqual({ status: 'DOWN', at });
    expect(seatUpConflict(bullet, NOW87, 30)).toBeNull();
  });

  it('(4) a stamp with a non-digit (18:0xZ) parses with at null; conflict null', () => {
    const bullet = '- **ops: UP 2026-09-21 18:0xZ.** watching things';
    expect(parseSeatStamp(bullet)).toEqual({ status: 'UP', at: null });
    expect(seatUpConflict(bullet, NOW87, 30)).toBeNull();
  });

  it('(5) a non-seat bullet is not a seat bullet at all', () => {
    expect(parseSeatStamp('- Owner tasks elsewhere: whatever')).toBeNull();
  });

  it('(6) a future stamp (clock skew) still counts as a conflict', () => {
    const at = new Date(NOW87.getTime() + 5 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    const conflict = seatUpConflict(bullet, NOW87, 30);
    expect(conflict).not.toBeNull();
    expect(conflict?.stamp).toBe('2026-09-21 22:42Z');
  });
});
