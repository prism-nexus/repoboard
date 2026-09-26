/**
 * RCB-48: `seat.ts` — the cold-start bundle. `findSeatLine`'s whole-word bullet match,
 * `seatBundle`'s next-card and coordinator-omission rules, `renderSeatBundle`'s fixed sections
 * with placeholders for every missing part.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import {
  checkDownFields,
  checkFieldCounts,
  findSeatLine,
  formatSeatBullet,
  keySeatBullets,
  listSeats,
  parseSeatFields,
  parseSeatStamp,
  renderSeatBundle,
  renderSeatList,
  replaceSeatBullet,
  rewriteSeatBulletBody,
  type SeatBundle,
  seatBulletTexts,
  seatBundle,
  seatUpConflict,
} from '../src/seat.js';
import { SECTION_PLACEHOLDER } from '../src/state.js';
import type { SystemsSummary } from '../src/systems-surface.js';
import type { Card, LeasesDoc } from '../src/types.js';

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

describe("seatBundle: nextCard follows a parent's steps (RCB-103)", () => {
  const config = defaultBoardConfig();

  it(
    '(1) parent in doing assigned to builder; PH.0 done, PH.1 gated on PH.0 (clear), PH.2 gated ' +
      'on PH.1 — Next = PH.1, reason parent-step, gateBy = "<PH.0 id> (done)"',
    () => {
      const cards: Card[] = [
        card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
        card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
        card({
          id: 'RCB-95',
          status: 'backlog',
          parent: 'RCB-80',
          phase: 'PH.1',
          gate: 'RCB-94',
          title: 'PH.1',
        }),
        card({
          id: 'RCB-96',
          status: 'backlog',
          parent: 'RCB-80',
          phase: 'PH.2',
          gate: 'RCB-95',
          title: 'PH.2',
        }),
        card({ id: 'RCB-97', status: 'todo', title: 'first todo, unassigned' }),
      ];
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: null,
        ownBlock: null,
        coordinatorBlock: null,
        cards,
        config,
      });
      expect(bundle.nextCard?.id).toBe('RCB-95');
      expect(bundle.nextCardReason).toBe('parent-step');
      expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: 'RCB-94 (done)' });
    },
  );

  it('(2) PH.1 blocked (gate on a backlog card) is skipped; PH.2 with no gate is picked, gateBy null', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-98', status: 'backlog', title: 'still backlog, blocks PH.1' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-98',
        title: 'PH.1',
      }),
      card({ id: 'RCB-96', status: 'backlog', parent: 'RCB-80', phase: 'PH.2', title: 'PH.2' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-96');
    expect(bundle.nextCardReason).toBe('parent-step');
    expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: null });
  });

  it('(3) every step done or blocked: falls through to the assigned todo card, as before', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-98', status: 'backlog', title: 'still backlog, blocks PH.1' }),
      card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-98',
        title: 'PH.1',
      }),
      card({ id: 'RCB-99', status: 'todo', assignee: 'builder', title: 'fallback todo' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-99');
    expect(bundle.nextCardReason).toBe('assigned');
    expect(bundle.nextCardStep).toBeNull();
  });

  it('(4) a clear step assigned to `ops` is skipped for `builder`; the next clear step wins', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        assignee: 'ops',
        title: 'PH.1, assigned to ops',
      }),
      card({ id: 'RCB-96', status: 'backlog', parent: 'RCB-80', phase: 'PH.2', title: 'PH.2' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-96');
    expect(bundle.nextCardReason).toBe('parent-step');
    expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: null });
  });

  it('(5) parent assigned to someone else is ignored entirely; first-todo rule applies', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'ops', title: 'someone else’s plan' }),
      card({ id: 'RCB-95', status: 'backlog', parent: 'RCB-80', phase: 'PH.1', title: 'PH.1' }),
      card({ id: 'RCB-99', status: 'todo', title: 'first todo, unassigned' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-99');
    expect(bundle.nextCardReason).toBe('first-todo');
    expect(bundle.nextCardStep).toBeNull();
  });

  it('(6) render text contains "(next unblocked step of RCB-80 — gate RCB-94 (done))"', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-94',
        title: 'PH.1',
      }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('(next unblocked step of RCB-80 — gate RCB-94 (done))');
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
        seatsSection: SEATS, // RCB-140: non-solo, so every section renders
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

function decisionCard(id: string): Card {
  return card({
    id,
    status: 'backlog',
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
}

describe('seatBundle: nextCardEmpty (RCB-118)', () => {
  it('non-null with distinct counts: 1 todo for another seat, 2 gated, 3 awaiting the owner', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', assignee: 'ops', title: 'not mine' }),
      card({ id: 'RCB-2', status: 'doing', gate: 'RCB-999', title: 'gated a' }),
      card({ id: 'RCB-3', status: 'doing', gate: 'RCB-998', title: 'gated b' }),
      decisionCard('RCB-4'),
      decisionCard('RCB-5'),
      decisionCard('RCB-6'),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardEmpty).toEqual({ todoForOthers: 1, gated: 2, awaitingOwner: 3 });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      '(no todo card for builder — 1 todo assigned to other seats · 2 gated · 3 waiting on the owner)',
    );
  });

  it('an all-zero empty board: nextCardEmpty is all zeros, printed as 0 not omitted', () => {
    const cards: Card[] = [];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardEmpty).toEqual({ todoForOthers: 0, gated: 0, awaitingOwner: 0 });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      '(no todo card for builder — 0 todo assigned to other seats · 0 gated · 0 waiting on the owner)',
    );
  });

  it('null when a next card exists — the empty-board question does not apply', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).not.toBeNull();
    expect(bundle.nextCardEmpty).toBeNull();
  });

  it('RCB-154: `gated` resolves a gate on a MEMBER card — done member card clears, todo one stays gated', () => {
    const cards: Card[] = [
      card({ id: 'RCB-2', status: 'doing', gate: 'MB-1', title: 'gated on a done member card' }),
      card({ id: 'RCB-3', status: 'doing', gate: 'MB-2', title: 'gated on a todo member card' }),
    ];
    const members = [
      {
        key: 'm',
        prefix: 'MB',
        cards: [card({ id: 'MB-1', status: 'done' }), card({ id: 'MB-2', status: 'todo' })],
        config: { ...defaultBoardConfig(), prefix: 'MB' },
      },
    ];
    const input = {
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    };
    const withMembers = seatBundle({ ...input, members });
    expect(withMembers.nextCard).toBeNull();
    expect(withMembers.nextCardEmpty).toEqual({ todoForOthers: 0, gated: 1, awaitingOwner: 0 });
    // No member facts: both gates read "(no such card)" — the pre-RCB-154 count.
    expect(seatBundle(input).nextCardEmpty).toEqual({
      todoForOthers: 0,
      gated: 2,
      awaitingOwner: 0,
    });
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
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: false,
      repo: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('solo board');
    expect(rendered).toContain('## In flight / owes');
    expect(rendered).toContain('in-flight: (none recorded)');
    expect(rendered).toContain('owes: (none recorded)');
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
    expect(rendered).toContain('## Answered, not acknowledged');
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
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: false,
      repo: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('RCB-1  todo  do this');
    expect(rendered).toContain('(first todo; nothing assigned, nothing prioritised)');
  });
});

describe('seatBundle: solo (RCB-140)', () => {
  it('no SEATS section at all: solo is true', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
  });

  it('a SEATS section with no bullets in it: solo is true (reverting this line to a section with a bullet must fail)', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: 'Owner tasks elsewhere: nothing to see here',
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
  });

  it('a SEATS section with at least one bullet: solo is false', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: SEATS,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(false);
  });
});

describe('renderSeatBundle: a solo board drops the placeholder sections (RCB-140)', () => {
  it('solo, every part missing: the solo line prints; the five placeholder sections are gone; Next card and Open decisions still print', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: true,
      repo: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      'solo board — seats, the log and leases apply once more than one agent runs (repoboard init --practices)',
    );
    expect(rendered).not.toContain('## In flight / owes');
    expect(rendered).not.toContain('## SEATS line');
    expect(rendered).not.toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).not.toContain('## Last block — OPS');
    expect(rendered).not.toContain('## Last block — COORDINATOR');
    expect(rendered).not.toContain('(none recorded)');
    expect(rendered).not.toContain('(no SEATS line mentions ops)');
    expect(rendered).not.toContain('(no .repoboard/local/RIG.md — run repoboard local init)');
    expect(rendered).not.toContain('(no log block for ops)');
    expect(rendered).not.toContain('(no log block for coordinator)');
    expect(rendered).toContain('## Next card');
    expect(rendered).toContain('(no todo card)');
    expect(rendered).toContain('## Open decisions');
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('(none)');
  });

  it('solo but with an ownBlock: the Last block section still prints (reverting `!b.solo || b.ownBlock !== null` to `!b.solo` alone must fail)', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: {
        date: '2026-09-18',
        block: {
          seat: 'OPS',
          ts: '2026-09-18T20:00:00Z',
          title: 'watching things',
          text: 'watching things',
        },
      },
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: true,
      repo: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      'solo board — seats, the log and leases apply once more than one agent runs (repoboard init --practices)',
    );
    expect(rendered).toContain('## Last block — OPS');
    expect(rendered).toContain('watching things');
    expect(rendered).not.toContain('## In flight / owes');
    expect(rendered).not.toContain('## SEATS line');
    expect(rendered).not.toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).not.toContain('## Last block — COORDINATOR');
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
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
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

  describe('RCB-130: an unindented "- in-flight:"/"- owes:" continuation is folded, not orphaned', () => {
    // REPRODUCTION (candidate B): a hand-edit that types a continuation as its own "- " item
    // instead of indenting it. Before the `bulletSpans` fix, this line started a NEW span with no
    // owner label, and `replaceSeatBullet` left it sitting right after the freshly replaced
    // bullet — the "coordinator's SEATS bullet carried TWO in-flight/owes pairs" shape.
    const HAND_EDITED = [
      '- **coordinator: UP 2026-09-24 22:00Z.** doing X',
      '  in-flight: sonnet A',
      '  owes: RCB-1',
      '- in-flight: sonnet B',
      '  owes: RCB-2 OWNER QUEUE = FPJ-86, FPJ-119',
      '- **ops**: watching things',
    ].join('\n');

    it('findSeatLine folds the stray "- in-flight:"/"- owes:" pair into the coordinator bullet', () => {
      const line = findSeatLine(HAND_EDITED, 'coordinator');
      expect(line).toBe(
        [
          '- **coordinator: UP 2026-09-24 22:00Z.** doing X',
          '  in-flight: sonnet A',
          '  owes: RCB-1',
          '- in-flight: sonnet B',
          '  owes: RCB-2 OWNER QUEUE = FPJ-86, FPJ-119',
        ].join('\n'),
      );
      // The unrelated "- Owner tasks elsewhere: …"-shaped bullet ("- **ops**…") is NOT folded in —
      // only a stray field line is.
      expect(line).not.toContain('ops');
    });

    it(
      'the control: replaceSeatBullet removes the stray pair along with the rest of the ' +
        'coordinator bullet — it does NOT survive as an orphan bullet after the replace (revert ' +
        'the `STRAY_FIELD_BULLET_RE` check in `bulletSpans` to make this fail)',
      () => {
        const fresh = formatSeatBullet(
          'coordinator',
          'UP',
          'doing Y',
          new Date('2026-09-25T01:56:00Z'),
        );
        const replaced = replaceSeatBullet(HAND_EDITED, 'coordinator', fresh);
        expect(replaced).toBe(
          ['- **coordinator: UP 2026-09-25 01:56Z.** doing Y', '- **ops**: watching things'].join(
            '\n',
          ),
        );
        expect(replaced).not.toContain('in-flight: sonnet B');
        expect(replaced).not.toContain('OWNER QUEUE');
      },
    );

    it('a stray field line with NO open bullet ahead of it still starts its own span (nothing to fold into) — replaceSeatBullet appends after it rather than dropping it', () => {
      const noPriorBullet = ['- in-flight: sonnet B', '  owes: RCB-2'].join('\n');
      const replaced = replaceSeatBullet(noPriorBullet, 'ops', 'X');
      expect(replaced).toBe(['- in-flight: sonnet B', '  owes: RCB-2', 'X'].join('\n'));
    });

    it('an unrelated bullet that merely STARTS with "in-flight"/"owes" text but is not the exact field shape is untouched', () => {
      const section = [
        '- **coordinator**: routes work',
        '- in-flight-notes: some card mentions this word, not a field line',
      ].join('\n');
      // Two separate bullets, not folded — the stray-line rule only matches the exact
      // "in-flight:"/"owes:" shape, not a merely similar-looking label.
      const line = findSeatLine(section, 'coordinator');
      expect(line).toBe('- **coordinator**: routes work');
    });
  });
});

describe('seatBulletTexts (RCB-130)', () => {
  it('one entry per top-level bullet, name + whole text, in section order', () => {
    const entries = seatBulletTexts(SEATS);
    expect(entries).toEqual([
      {
        name: 'repoboard builder (its own terminal, no autonomy)',
        text: '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1\n  continuation line here',
      },
      { name: 'ops', text: '- **ops**: watching things' },
      { name: 'coordinator', text: '- **coordinator**: routes work' },
    ]);
  });

  it('a malformed (unstamped) bullet still gets an entry, unlike listSeats', () => {
    const section = '- Owner tasks elsewhere: whatever';
    expect(seatBulletTexts(section)).toEqual([
      { name: 'Owner tasks elsewhere', text: '- Owner tasks elsewhere: whatever' },
    ]);
    expect(listSeats(section)).toEqual([]);
  });

  it('no bullets at all (a placeholder section) -> []', () => {
    expect(seatBulletTexts('_(nothing recorded yet)_')).toEqual([]);
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

describe('rewriteSeatBulletBody (RCB-88)', () => {
  const NOW88 = new Date('2026-09-02T22:41:10Z');

  it("(1) keeps the label/status/stamp, replaces the body — 'a' becomes 'b'", () => {
    const bullet = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten).not.toBeNull();
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 22:41Z.** b');
    expect(rewritten?.status).toBe('UP');
    expect(rewritten?.stamp).toBe('2026-09-02 22:41Z');
  });

  it('(2) a DOWN bullet keeps DOWN', () => {
    const bullet = formatSeatBullet('ops', 'DOWN', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten?.status).toBe('DOWN');
    expect(rewritten?.bullet).toBe('- **ops: DOWN 2026-09-02 22:41Z.** b');
  });

  it('(3) a stamp with a non-digit (18:0xZ) is kept verbatim', () => {
    const bullet = '- **ops: UP 2026-09-02 18:0xZ.** a';
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten?.stamp).toBe('2026-09-02 18:0xZ');
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 18:0xZ.** b');
  });

  it("(4) text 'x\\ny' becomes a continuation line 'x\\n  y'", () => {
    const bullet = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'x\ny');
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 22:41Z.** x\n  y');
  });

  it('(5) a non-seat bullet is not a seat bullet at all -> null', () => {
    expect(rewriteSeatBulletBody('- Owner tasks elsewhere: whatever', 'b')).toBeNull();
  });

  it('(6) round-trip: findSeatLine finds it, parseSeatStamp gives the ORIGINAL at', () => {
    const original = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(original, 'b');
    expect(rewritten).not.toBeNull();
    if (rewritten === null) return;
    expect(findSeatLine(rewritten.bullet, 'ops')).toBe(rewritten.bullet);
    expect(parseSeatStamp(rewritten.bullet)?.at).toEqual(parseSeatStamp(original)?.at);
  });
});

describe('RCB-89 in-flight/owes + listSeats', () => {
  const DOWN_ERR =
    'seat --down needs an "in-flight:" line (subagent ids, Monitor ids, worktree, lock holder — ' +
    'or none) and an "owes:" line';

  describe('parseSeatFields', () => {
    it('a 3-line DOWN bullet with both present', () => {
      const bullet = formatSeatBullet(
        'ops',
        'DOWN',
        'stood down\nin-flight: sonnet A, Monitor 123\nowes: RCB-1',
        NOW,
      );
      expect(bullet.split('\n')).toHaveLength(3);
      expect(parseSeatFields(bullet)).toEqual({
        inFlight: 'sonnet A, Monitor 123',
        owes: 'RCB-1',
      });
    });

    it('an UP bullet with neither -> both null', () => {
      const bullet = formatSeatBullet('ops', 'UP', 'watching things', NOW);
      expect(parseSeatFields(bullet)).toEqual({ inFlight: null, owes: null });
    });

    it("owes: with an empty value -> '', not null (present but empty is not missing)", () => {
      const bullet = formatSeatBullet('ops', 'DOWN', 'stood down\nin-flight: none\nowes:', NOW);
      expect(parseSeatFields(bullet)).toEqual({ inFlight: 'none', owes: '' });
    });
  });

  describe('checkDownFields', () => {
    it('both lines present -> null', () => {
      expect(checkDownFields('x\nin-flight: none\nowes: RCB-1')).toBeNull();
    });

    it('missing in-flight -> the exact error', () => {
      expect(checkDownFields('x\nowes: RCB-1')).toBe(DOWN_ERR);
    });

    it('missing owes -> the exact error', () => {
      expect(checkDownFields('x\nin-flight: none')).toBe(DOWN_ERR);
    });
  });

  describe('checkFieldCounts (RCB-130)', () => {
    it('at most one of each -> null', () => {
      expect(checkFieldCounts('x\nin-flight: a\nowes: b')).toBeNull();
    });

    it('no fields at all -> null (this guard is count-only, never a presence guard)', () => {
      expect(checkFieldCounts('just prose, no fields')).toBeNull();
    });

    it(
      'REPRODUCTION (fpj STATE.md, 2026-09-25 01:56Z): a --down text carrying TWO in-flight/owes ' +
        'pairs — before this guard, checkDownFields let it straight through as "ok"',
      () => {
        const text =
          'stood down\nin-flight: sonnet A\nowes: RCB-1\nin-flight: sonnet B\nowes: RCB-2 OWNER QUEUE = FPJ-86, FPJ-119';
        expect(checkFieldCounts(text)).toBe(
          'seat: text has 2 "in-flight:" lines and 2 "owes:" lines — one of each, at most',
        );
        // The control: reverting `checkDownFields` to skip `checkFieldCounts` (or reverting this
        // function to always return null) makes checkDownFields "ok" this shape again.
        expect(checkDownFields(text)).not.toBeNull();
      },
    );

    it('two in-flight, one owes -> names only the over count', () => {
      expect(checkFieldCounts('x\nin-flight: a\nin-flight: b\nowes: c')).toBe(
        'seat: text has 2 "in-flight:" lines — one of each, at most',
      );
    });

    it('one in-flight, three owes -> names only the over count', () => {
      expect(checkFieldCounts('x\nin-flight: a\nowes: b\nowes: c\nowes: d')).toBe(
        'seat: text has 3 "owes:" lines — one of each, at most',
      );
    });
  });

  describe('checkDownFields calls checkFieldCounts first (RCB-130)', () => {
    it('both present but in-flight doubled -> the count error, not null', () => {
      const text = 'x\nin-flight: a\nin-flight: b\nowes: c';
      expect(checkDownFields(text)).toBe(
        'seat: text has 2 "in-flight:" lines — one of each, at most',
      );
    });
  });

  describe('listSeats', () => {
    const section = [
      formatSeatBullet('coordinator', 'UP', 'routing work', NOW),
      formatSeatBullet('builder', 'DOWN', 'stood down\nin-flight: sonnet B\nowes: RCB-2', NOW),
      '- Owner tasks elsewhere: whatever',
    ].join('\n');

    it('2 rows — the non-seat bullet is skipped, never an error; builder carries its in-flight', () => {
      const rows = listSeats(section);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        name: 'coordinator',
        status: 'UP',
        stamp: '2026-09-18 21:00Z',
        inFlight: null,
      });
      expect(rows[1]).toEqual({
        name: 'builder',
        status: 'DOWN',
        stamp: '2026-09-18 21:00Z',
        inFlight: 'sonnet B',
      });
    });

    it('renderSeatList: exact text, columns padded to the widest value', () => {
      const rendered = renderSeatList(listSeats(section));
      expect(rendered).toBe(
        'NAME         STATUS  STAMP              IN-FLIGHT\n' +
          'coordinator  UP      2026-09-18 21:00Z  -\n' +
          'builder      DOWN    2026-09-18 21:00Z  sonnet B\n',
      );
    });

    it('renderSeatList: no rows -> one placeholder line', () => {
      expect(renderSeatList([])).toBe('(no seat bullets in SEATS)\n');
    });
  });

  describe('renderSeatBundle: In flight / owes section', () => {
    it('sits FIRST, before ## SEATS line', () => {
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: [
          formatSeatBullet('builder', 'DOWN', 'stood down\nin-flight: none\nowes: RCB-1', NOW),
        ].join('\n'),
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      expect(bundle.inFlight).toBe('none');
      expect(bundle.owes).toBe('RCB-1');
      const rendered = renderSeatBundle(bundle, NOW);
      const inFlightIdx = rendered.indexOf('## In flight / owes');
      const seatsIdx = rendered.indexOf('## SEATS line');
      const firstHeadingIdx = rendered.indexOf('## ');
      expect(inFlightIdx).toBeGreaterThan(0);
      expect(inFlightIdx).toBe(firstHeadingIdx);
      expect(seatsIdx).toBeGreaterThan(inFlightIdx);
      expect(rendered).toContain('in-flight: none');
      expect(rendered).toContain('owes: RCB-1');
    });
  });
});

describe('systems line (RCB-97)', () => {
  const summary: SystemsSummary = {
    systems: 3,
    connections: 2,
    envs: 'dev+prod',
    line: 'Systems: 3 systems, 2 connections, dev+prod — repoboard systems',
  };

  it('seatBundle carries input.systems through, null when absent', () => {
    const withSummary = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      systems: summary,
    });
    expect(withSummary.systems).toEqual(summary);

    const without = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(without.systems).toBeNull();
  });

  it('with a summary: exactly one line, starting "Systems:", right after "owes:"', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      systems: summary,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const lines = rendered.split('\n');
    const owesIdx = lines.findIndex((l) => l.startsWith('owes:'));
    expect(owesIdx).toBeGreaterThanOrEqual(0);
    expect(lines[owesIdx + 1]).toBe(summary.line);
    expect(lines.filter((l) => l.startsWith('Systems:'))).toEqual([summary.line]);
  });

  it('without a summary: output contains no "Systems:" line', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('Systems:');
  });
});

/** A card whose decision has already been answered, `decision` built directly (not via
 * `askDecision`/`decide`) so each test controls `decidedAt`/`decidedBy` and the body's
 * `## Log`/`## Notes` bullets exactly. */
function answeredCard(
  id: string,
  opts: { decidedBy: string; decidedAt: string; chosen?: string | null; body?: string },
): Card {
  return card({
    id,
    body: opts.body ?? '',
    decision: {
      question: 'Ship it?',
      options: [{ letter: 'A', text: 'yes' }],
      askedBy: 'claude/coordinator',
      askedAt: '2026-09-24T18:00:00Z',
      returnTo: null,
      chosen: opts.chosen ?? 'A',
      words: null,
      decidedBy: opts.decidedBy,
      decidedAt: opts.decidedAt,
    },
  });
}

describe('seatBundle: answeredNotAck (RCB-129)', () => {
  it('an answered, unacknowledged decision appears in answeredNotAck and the render block', () => {
    const cards = [
      answeredCard('RCB-1', { decidedBy: 'owner', decidedAt: '2026-09-24T18:19:51Z' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.answeredNotAck).toHaveLength(1);
    expect(bundle.answeredNotAck[0]).toMatchObject({ id: 'RCB-1', acknowledged: false });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('RCB-1 · Ship it? → A: yes (decided 2026-09-24T18:19:51Z by owner)');
  });

  it('a ## Notes line after decidedAt by another actor (card note) acknowledges it — drops out', () => {
    const cards = [
      answeredCard('RCB-1', {
        decidedBy: 'owner',
        decidedAt: '2026-09-24T18:19:51Z',
        body: '\n## Notes\n- 2026-09-24T18:26:00Z builder — ack\n',
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
    expect(bundle.answeredNotAck).toEqual([]);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('(none)');
  });

  it('no answered decisions at all: the block prints (none)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.answeredNotAck).toEqual([]);
    const rendered = renderSeatBundle(bundle, NOW);
    const idx = rendered.indexOf('## Answered, not acknowledged');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(rendered.slice(idx)).toContain('(none)');
  });
});

describe('leases surfaced in seat <name> (RCB-131)', () => {
  function leasesDoc(...leases: LeasesDoc['leases']): LeasesDoc {
    return { leases, windows: [] };
  }

  it('seatBundle carries only LIVE leases through — a stale one is excluded', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc(
        { resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
        {
          resource: 'dev-server',
          holder: 'claude/builder',
          since: '2026-09-18T10:00:00Z',
          until: '2026-09-18T11:00:00Z', // stale: before NOW (21:00Z)
        },
      ),
    });
    expect(bundle.leases).toEqual([
      { resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
    ]);
  });

  it('defaults to [] when input.leases is absent — no live leases, not a throw', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.leases).toEqual([]);
  });

  it('renders "## Leases" right after "## SEATS line", before "## Rig", one line per live lease', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop',
      leases: leasesDoc({
        resource: 'vitest-lock',
        holder: 'claude/ops',
        since: '2026-09-18T20:00:00Z',
        until: '2026-09-18T21:30:00Z',
        note: 'running the suite',
      }),
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const seatsIdx = rendered.indexOf('## SEATS line');
    const leasesIdx = rendered.indexOf('## Leases');
    const rigIdx = rendered.indexOf('## Rig');
    expect(seatsIdx).toBeGreaterThanOrEqual(0);
    expect(leasesIdx).toBeGreaterThan(seatsIdx);
    expect(rigIdx).toBeGreaterThan(leasesIdx);
    expect(rendered).toContain(
      'vitest-lock · claude/ops · since 20:00Z · until 21:30Z · "running the suite"',
    );
  });

  it('suffixes " (yours)" when the lease holder matches the seat name, case-insensitive/trimmed', () => {
    const bundle = seatBundle({
      name: ' Builder ',
      now: NOW,
      seatsSection: SEATS,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc(
        { resource: 'dev-server', holder: 'builder', since: '2026-09-18T20:00:00Z' },
        { resource: 'lane-a', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
      ),
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('dev-server · builder · since 20:00Z · until — (yours)');
    expect(rendered).toContain('lane-a · claude/ops · since 20:00Z · until —');
    expect(rendered).not.toContain('lane-a · claude/ops · since 20:00Z · until — (yours)');
  });

  it(
    'no live leases: "(no live leases)", never an empty section — the control: reverting this ' +
      'line to `renderLeaseLines(b.leases, now)` with an unfiltered stale lease must fail',
    () => {
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: SEATS,
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      const rendered = renderSeatBundle(bundle, NOW);
      expect(rendered).toContain('## Leases\n(no live leases)');
    },
  );

  it('solo board with no live leases: the "## Leases" section is dropped, like the other placeholders (RCB-140)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('## Leases');
  });

  it('solo board WITH a live lease: the "## Leases" section still prints (mirrors ownBlock/rig)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc({
        resource: 'dev-server',
        holder: 'claude/ops',
        since: '2026-09-18T20:00:00Z',
      }),
    });
    expect(bundle.solo).toBe(true);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Leases');
    expect(rendered).toContain('dev-server · claude/ops · since 20:00Z · until —');
  });
});

/**
 * RCB-160: automatic from the board — `formatSeatBullet`/`rewriteSeatBulletBody` write a
 * `[repo] ` prefix INSIDE the bold span, ahead of the seat name; every reader that derives a
 * label/name (`findSeatLine`'s `locateSeatBullet`, `parseSeatStamp`, `listSeats`) must strip it
 * back out, so a repo name can never be mistaken for a seat's own name.
 */
describe('RCB-160: the [repo] prefix on a SEATS bullet', () => {
  it('(1) formatSeatBullet writes a `[repo] ` prefix inside the bold span, ahead of the name', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'holding RCB-160', NOW, 'repoboard');
    expect(bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160');
  });

  it('(2) an old, unprefixed bullet still parses exactly as before — findSeatLine finds it, parseSeatStamp reads it', () => {
    const seats = [
      '- **coordinator**: routes work',
      '- **builder: UP 2026-09-18 21:00Z.** holding RCB-1',
    ].join('\n');
    const line = findSeatLine(seats, 'builder');
    expect(line).toBe('- **builder: UP 2026-09-18 21:00Z.** holding RCB-1');
    expect(parseSeatStamp(line ?? '')).toEqual({
      status: 'UP',
      at: new Date('2026-09-18T21:00:00Z'),
    });
  });

  it('(3) `seat repoboard` does not match a bullet merely PREFIXED `[repoboard]` — the label is stripped before the match', () => {
    const seats = [
      '- **coordinator**: routes work',
      '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ].join('\n');
    expect(findSeatLine(seats, 'repoboard')).toBeNull();
    // The real seat still matches, prefix and all.
    expect(findSeatLine(seats, 'builder')).toBe(
      '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    );
  });

  it("a prefixed bullet's NAME (listSeats) is the bare seat name, never the repo", () => {
    const seats = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    const rows = listSeats(seats);
    expect(rows).toEqual([
      { name: 'builder', status: 'UP', stamp: '2026-09-18 21:00Z', inFlight: null },
    ]);
  });

  it("rewriteSeatBulletBody: omitting `repo` keeps the bullet's own existing prefix byte-for-byte", () => {
    const bullet = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** a';
    const res = rewriteSeatBulletBody(bullet, 'b');
    expect(res?.bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** b');
  });

  it('rewriteSeatBulletBody: passing `repo` replaces whatever prefix (if any) was there', () => {
    const bullet = '- **builder: UP 2026-09-18 21:00Z.** a';
    const res = rewriteSeatBulletBody(bullet, 'b', 'repoboard');
    expect(res?.bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** b');
  });
});

/**
 * RCB-160 slice 2: `keySeatBullets` is what the WORKSPACE view uses to show a member's SEATS
 * bullets under the `repos[].key` OWNER QUEUE/LEASES already print — never under whatever the
 * member calls itself (slice 1's own `[repo] ` prefix).
 */
describe('keySeatBullets (RCB-160 slice 2)', () => {
  it('replace: an existing `[x] ` prefix is REPLACED by `[key] `', () => {
    const seats = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    expect(keySeatBullets(seats, 'aa')).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ]);
  });

  it('insert: an unprefixed bold bullet gets `[key] ` right after `- **`', () => {
    const seats = '- **builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    expect(keySeatBullets(seats, 'aa')).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ]);
  });

  it('insert: an unprefixed, non-bold bullet gets `[key] ` right after `- `', () => {
    expect(keySeatBullets('- ops: watching things', 'aa')).toEqual(['- [aa] ops: watching things']);
  });

  it('continuation lines: whole bullet text kept, only the FIRST line is re-prefixed', () => {
    const seats = [
      '- **builder: UP 2026-09-18 21:00Z.** on RCB-1',
      '  continuation line here',
    ].join('\n');
    expect(keySeatBullets(seats, 'aa')).toEqual([
      ['- **[aa] builder: UP 2026-09-18 21:00Z.** on RCB-1', '  continuation line here'].join('\n'),
    ]);
  });

  it('one entry per top-level bullet, in section order', () => {
    expect(keySeatBullets(SEATS, 'aa')).toEqual([
      [
        '- **[aa] repoboard builder (its own terminal, no autonomy)**: on RCB-1',
        '  continuation line here',
      ].join('\n'),
      '- **[aa] ops**: watching things',
      '- **[aa] coordinator**: routes work',
    ]);
  });

  it('placeholder: a section with no "- " line -> []', () => {
    expect(keySeatBullets(SECTION_PLACEHOLDER, 'aa')).toEqual([]);
  });
});
