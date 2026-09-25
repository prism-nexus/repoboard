/**
 * RCB-68: phases + gates. `gateState`/`blockedReason` (the one code path every surface asks),
 * `stepsOf` (natural phase order) and `rollup` (single level, never grandchildren).
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import {
  blockedReason,
  type GateMemberFacts,
  gateState,
  rollup,
  stepsOf,
  wipCount,
  wipCountsForMove,
} from '../src/phases.js';
import type { BoardConfig, Card, Decision } from '../src/types.js';

const CREATED = '2026-09-19T00:00:00Z';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'RB-1',
    title: 't',
    status: 'todo',
    created: CREATED,
    updated: CREATED,
    body: '',
    ...overrides,
  };
}

function decidedDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    question: 'q',
    options: [],
    askedBy: 'claude/test',
    askedAt: CREATED,
    returnTo: null,
    chosen: 'A',
    words: null,
    decidedBy: 'human/matt',
    decidedAt: CREATED,
    ...overrides,
  };
}

describe('gateState / blockedReason', () => {
  const config = defaultBoardConfig(); // columns: backlog, decide, todo, doing, done{done:true}

  it('no gate → none, never blocked', () => {
    const card = makeCard();
    expect(gateState(card, [card], config)).toEqual({ kind: 'none' });
    expect(blockedReason(card, [card], config)).toBeNull();
  });

  it('a card-id gate on a card in todo → blocked, with the exact reason', () => {
    const target = makeCard({ id: 'RB-9', status: 'todo' });
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    expect(gateState(card, [card, target], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked on RB-9 (todo)',
    });
    expect(blockedReason(card, [card, target], config)).toBe('blocked on RB-9 (todo)');
  });

  it('the same card, now in a done:true column → clear', () => {
    const target = makeCard({ id: 'RB-9', status: 'done' });
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    expect(gateState(card, [card, target], config)).toEqual({
      kind: 'clear',
      by: 'RB-9 (done)',
    });
    expect(blockedReason(card, [card, target], config)).toBeNull();
  });

  it('the same card, decided (chosen set, status still todo) → clear', () => {
    const target = makeCard({ id: 'RB-9', status: 'todo', decision: decidedDecision() });
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    expect(gateState(card, [card, target], config).kind).toBe('clear');
    expect(blockedReason(card, [card, target], config)).toBeNull();
  });

  it('an owner task, decided (decidedAt set, no letter/words) → clear', () => {
    const target = makeCard({
      id: 'RB-9',
      status: 'todo',
      decision: decidedDecision({ kind: 'task', chosen: null, decidedBy: 'human/matt' }),
    });
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    expect(gateState(card, [card, target], config).kind).toBe('clear');
    expect(blockedReason(card, [card, target], config)).toBeNull();
  });

  it('an id-shaped gate naming NO card on this board → blocked "(no such card)", never a silent clear', () => {
    const card = makeCard({ id: 'RB-1', gate: 'RB-404' });
    expect(gateState(card, [card], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked on RB-404 (no such card)',
    });
  });

  it('a free-text sentence gate → blocked "blocked: <sentence>", cleared only by removing the field', () => {
    const card = makeCard({ id: 'RB-1', gate: 'owner buys the domain' });
    expect(gateState(card, [card], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked: owner buys the domain',
    });
  });

  it('a board whose columns have NO done:true column → a card-id gate never clears by column (honest, not inert)', () => {
    const noDone: BoardConfig = {
      ...config,
      columns: config.columns.map((c) => ({ ...c, done: undefined })),
    };
    const target = makeCard({ id: 'RB-9', status: 'done' }); // "done" is just a column id here
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    expect(gateState(card, [card, target], noDone)).toEqual({
      kind: 'blocked',
      reason: 'blocked on RB-9 (done)',
    });
  });

  it("a board whose columns have NO done:true column → a sentence gate never clears via the card's own done-looking status either", () => {
    const noDone: BoardConfig = {
      ...config,
      columns: config.columns.map((c) => ({ ...c, done: undefined })),
    };
    const card = makeCard({ id: 'RB-1', status: 'done', gate: 'owner buys the domain' });
    expect(gateState(card, [card], noDone)).toEqual({
      kind: 'blocked',
      reason: 'blocked: owner buys the domain',
    });
  });
});

describe('gateState with member facts (RCB-153 W4/W5 gate) — additive', () => {
  const config = defaultBoardConfig(); // this board's own prefix is 'RB'

  function memberFacts(overrides: Partial<GateMemberFacts> = {}): GateMemberFacts {
    return { key: 'bb', prefix: 'BB', cards: [], config, ...overrides };
  }

  it('a gate not found on THIS board resolves against a member by prefix (W4) — blocked while todo', () => {
    const memberTarget = makeCard({ id: 'BB-1', status: 'todo' });
    const card = makeCard({ id: 'RB-1', gate: 'BB-1' });
    const members = [memberFacts({ cards: [memberTarget] })];
    expect(gateState(card, [card], config, members)).toEqual({
      kind: 'blocked',
      reason: 'blocked on BB-1 (todo)',
    });
    expect(blockedReason(card, [card], config, members)).toBe('blocked on BB-1 (todo)');
  });

  it('the same member card, now done → clear, decided by the MEMBER’s own column, not this board’s', () => {
    const memberTarget = makeCard({ id: 'BB-1', status: 'done' });
    const card = makeCard({ id: 'RB-1', gate: 'BB-1' });
    const members = [memberFacts({ cards: [memberTarget] })];
    expect(gateState(card, [card], config, members)).toEqual({ kind: 'clear', by: 'BB-1 (done)' });
    expect(blockedReason(card, [card], config, members)).toBeNull();
  });

  it('this board’s own prefix still wins first (W4 workspace-first), even with members passed', () => {
    const ownTarget = makeCard({ id: 'RB-9', status: 'todo' });
    const card = makeCard({ id: 'RB-1', gate: 'RB-9' });
    // A member ALSO carrying an "RB-9" is never even consulted: the plain `cards.find` above any
    // member lookup already found this board's own RB-9 first.
    const members = [memberFacts({ cards: [makeCard({ id: 'RB-9', status: 'done' })] })];
    expect(gateState(card, [card, ownTarget], config, members)).toEqual({
      kind: 'blocked',
      reason: 'blocked on RB-9 (todo)',
    });
  });

  it('a gate matching no board’s prefix at all stays "no such card", members or not', () => {
    const card = makeCard({ id: 'RB-1', gate: 'ZZ-9' });
    const members = [memberFacts({ cards: [makeCard({ id: 'BB-1' })] })];
    expect(gateState(card, [card], config, members)).toEqual({
      kind: 'blocked',
      reason: 'blocked on ZZ-9 (no such card)',
    });
  });

  it('omitting `members` entirely (every single-board caller today) never resolves a foreign gate', () => {
    const card = makeCard({ id: 'RB-1', gate: 'BB-1' });
    // No 4th argument at all — the exact call every existing caller (rollup, seat, MCP, web) makes.
    expect(gateState(card, [card], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked on BB-1 (no such card)',
    });
  });
});

describe('a gate on a DONE card is history (RCB-105)', () => {
  const config = defaultBoardConfig(); // columns: backlog, decide, todo, doing, done{done:true}

  it('sentence gate, card in done → clear "<sentence> — card done"; same card in todo → still blocked', () => {
    const doneCard = makeCard({ id: 'RB-1', status: 'done', gate: 'owner buys the domain' });
    expect(gateState(doneCard, [doneCard], config)).toEqual({
      kind: 'clear',
      by: 'owner buys the domain — card done',
    });
    expect(blockedReason(doneCard, [doneCard], config)).toBeNull();

    const todoCard = makeCard({ id: 'RB-1', status: 'todo', gate: 'owner buys the domain' });
    expect(gateState(todoCard, [todoCard], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked: owner buys the domain',
    });
  });

  it('id gate naming a todo card, this card in done → clear "RB-9 — card done"', () => {
    const target = makeCard({ id: 'RB-9', status: 'todo' });
    const card = makeCard({ id: 'RB-1', status: 'done', gate: 'RB-9' });
    expect(gateState(card, [card, target], config)).toEqual({
      kind: 'clear',
      by: 'RB-9 — card done',
    });
    expect(blockedReason(card, [card, target], config)).toBeNull();
  });

  it('id gate naming a done card, this card in done → by = "RB-9 (done)" (unchanged shape)', () => {
    const target = makeCard({ id: 'RB-9', status: 'done' });
    const card = makeCard({ id: 'RB-1', status: 'done', gate: 'RB-9' });
    expect(gateState(card, [card, target], config)).toEqual({
      kind: 'clear',
      by: 'RB-9 (done)',
    });
  });

  it('id-shaped gate naming NO card, this card in done → clear "NOPE-1 — card done"; same card in todo → still blocked (no such card)', () => {
    const doneCard = makeCard({ id: 'RB-1', status: 'done', gate: 'NOPE-1' });
    expect(gateState(doneCard, [doneCard], config)).toEqual({
      kind: 'clear',
      by: 'NOPE-1 — card done',
    });

    const todoCard = makeCard({ id: 'RB-1', status: 'todo', gate: 'NOPE-1' });
    expect(gateState(todoCard, [todoCard], config)).toEqual({
      kind: 'blocked',
      reason: 'blocked on NOPE-1 (no such card)',
    });
  });

  it('rollup: PH.0 done + sentence gate, PH.1 backlog gates on PH.0 → blockedOn null, done 1 of 2', () => {
    const parent = makeCard({ id: 'RCB-1' });
    const ph0 = makeCard({
      id: 'RCB-2',
      parent: 'RCB-1',
      phase: 'PH.0',
      status: 'done',
      gate: 'owner buys the domain', // before this change, this sentence would have set blockedOn
    });
    const ph1 = makeCard({
      id: 'RCB-3',
      parent: 'RCB-1',
      phase: 'PH.1',
      status: 'backlog',
      gate: 'RCB-2', // gates on PH.0
    });
    const all = [parent, ph0, ph1];
    expect(rollup(parent, all, config)).toEqual({ total: 2, done: 1, blockedOn: null });
  });
});

describe('stepsOf', () => {
  it('natural phase order: PH.2 before PH.10; phase-less last; then by id', () => {
    const parent = makeCard({ id: 'RCB-1' });
    const ph10 = makeCard({ id: 'RCB-10', parent: 'RCB-1', phase: 'PH.10' });
    const ph2 = makeCard({ id: 'RCB-2', parent: 'RCB-1', phase: 'PH.2' });
    const noPhaseB = makeCard({ id: 'RCB-8', parent: 'RCB-1' });
    const noPhaseA = makeCard({ id: 'RCB-3', parent: 'RCB-1' });
    const other = makeCard({ id: 'RCB-99', parent: 'RCB-2' }); // not a child of RCB-1
    const steps = stepsOf('RCB-1', [ph10, ph2, noPhaseB, noPhaseA, other, parent]);
    expect(steps.map((s) => s.id)).toEqual(['RCB-2', 'RCB-10', 'RCB-3', 'RCB-8']);
  });

  it('no children → empty list', () => {
    expect(stepsOf('RCB-1', [makeCard({ id: 'RCB-1' })])).toEqual([]);
  });
});

describe('rollup', () => {
  const config = defaultBoardConfig();

  it('null when the card has no children', () => {
    const card = makeCard({ id: 'RCB-1' });
    expect(rollup(card, [card], config)).toBeNull();
  });

  it('total/done counts, and blockedOn = the first blocked step in stepsOf order', () => {
    const parent = makeCard({ id: 'RCB-1' });
    const gateCard = makeCard({ id: 'RCB-9', status: 'todo' });
    const steps = [
      makeCard({ id: 'RCB-2', parent: 'RCB-1', phase: 'PH.1', status: 'done' }),
      makeCard({ id: 'RCB-3', parent: 'RCB-1', phase: 'PH.2', status: 'todo', gate: 'RCB-9' }),
      makeCard({ id: 'RCB-4', parent: 'RCB-1', phase: 'PH.3', status: 'todo' }),
      makeCard({ id: 'RCB-5', parent: 'RCB-1', phase: 'PH.4', status: 'done' }),
      makeCard({ id: 'RCB-6', parent: 'RCB-1', phase: 'PH.5', status: 'todo' }),
      makeCard({ id: 'RCB-7', parent: 'RCB-1', phase: 'PH.6', status: 'todo' }),
      makeCard({ id: 'RCB-8', parent: 'RCB-1', phase: 'PH.7', status: 'todo' }),
      makeCard({ id: 'RCB-10', parent: 'RCB-1', phase: 'PH.8', status: 'todo' }),
      makeCard({ id: 'RCB-11', parent: 'RCB-1', phase: 'PH.9', status: 'done' }),
    ];
    const all = [parent, gateCard, ...steps];
    const r = rollup(parent, all, config);
    expect(r).toEqual({ total: 9, done: 3, blockedOn: 'blocked on RCB-9 (todo)' });
  });

  it('grandchildren are never rolled up into the grandparent (single level only)', () => {
    const grandparent = makeCard({ id: 'RCB-1' });
    const child = makeCard({ id: 'RCB-2', parent: 'RCB-1', status: 'todo' });
    const grandchild = makeCard({ id: 'RCB-3', parent: 'RCB-2', status: 'done' });
    const all = [grandparent, child, grandchild];
    // The grandparent's rollup only ever sees its OWN children (RCB-2) — total is 1, not 2.
    expect(rollup(grandparent, all, config)).toEqual({ total: 1, done: 0, blockedOn: null });
    // The child IS a phase card of its own, with its own rollup over the grandchild.
    expect(rollup(child, all, config)).toEqual({ total: 1, done: 1, blockedOn: null });
  });
});

describe('wipCount / wipCountsForMove (RCB-108: parents not counted for WIP)', () => {
  it('wipCount excludes a plan parent, but counts a step and a plain card', () => {
    const parent = makeCard({ id: 'RCB-1', status: 'doing' });
    const step = makeCard({ id: 'RCB-2', parent: 'RCB-1', phase: 'PH.1', status: 'doing' });
    const plain = makeCard({ id: 'RCB-3', status: 'doing' });
    const elsewhere = makeCard({ id: 'RCB-4', status: 'todo' });
    const all = [parent, step, plain, elsewhere];
    expect(wipCount('doing', all)).toBe(2); // step + plain; parent excluded
  });

  it('wipCountsForMove is undefined for a parent mover — it adds 0, so it cannot breach', () => {
    const parent = makeCard({ id: 'RCB-1', status: 'backlog' });
    const step = makeCard({ id: 'RCB-2', parent: 'RCB-1', phase: 'PH.1', status: 'doing' });
    const plain = makeCard({ id: 'RCB-3', status: 'doing' });
    const all = [parent, step, plain];
    expect(wipCountsForMove(parent, all)).toBeUndefined();
  });

  it('wipCountsForMove excludes the mover itself otherwise, and still excludes other parents', () => {
    const parent = makeCard({ id: 'RCB-1', status: 'doing' });
    const step = makeCard({ id: 'RCB-2', parent: 'RCB-1', phase: 'PH.1', status: 'doing' });
    const mover = makeCard({ id: 'RCB-3', status: 'todo' });
    const other = makeCard({ id: 'RCB-4', status: 'doing' });
    const all = [parent, step, mover, other];
    // doing has step + other = 2 — the mover (not in doing anyway) and the parent are excluded.
    expect(wipCountsForMove(mover, all)).toEqual({ doing: 2 });
  });
});
