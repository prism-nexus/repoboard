/**
 * RCB-68: phases + gates. `gateState`/`blockedReason` (the one code path every surface asks),
 * `stepsOf` (natural phase order) and `rollup` (single level, never grandchildren).
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { blockedReason, gateState, rollup, stepsOf } from '../src/phases.js';
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
