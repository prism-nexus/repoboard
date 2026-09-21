import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { parseCard, serializeCard } from '../src/card.js';
import { allocateCardId, createCard, moveCard, updateCard } from '../src/transitions.js';
import type { Event } from '../src/types.js';
import { NOW, sampleCard } from './helpers.js';

const config = defaultBoardConfig();
const actor = 'claude/test';

describe('moveCard', () => {
  it('moves, stamps updated, appends a log line, returns the event', () => {
    const card = sampleCard({ status: 'todo', body: 'Just a description.\n' });
    const r = moveCard(card, 'doing', { actor, now: new Date('2026-09-03T01:02:03.456Z'), config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('doing');
    expect(r.card.updated).toBe('2026-09-03T01:02:03Z');
    expect(r.card.created).toBe(card.created);
    expect(r.card.body).toBe(
      'Just a description.\n\n## Log\n- 2026-09-03T01:02:03Z claude/test — moved todo → doing\n',
    );
    expect(r.event).toEqual({
      ts: '2026-09-03T01:02:03Z',
      actor,
      type: 'move',
      cardId: 'RB-12',
      from: 'todo',
      to: 'doing',
    });
    expect(r.warnings).toEqual([]);
    // pure: input untouched
    expect(card.status).toBe('todo');
    expect(card.body).toBe('Just a description.\n');
  });

  it('appends under an existing ## Log heading and keeps unknown keys', () => {
    const card = sampleCard({ status: 'doing', foo: 'bar' });
    const r = moveCard(card, 'backlog', { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.foo).toBe('bar');
    expect(
      r.card.body.endsWith(
        'moved to doing\n- 2026-09-02T22:41:10Z claude/test — moved doing → backlog\n',
      ),
    ).toBe(true);
    // and the result is a valid file
    const reparsed = parseCard(serializeCard(r.card));
    expect(reparsed).toEqual({ ok: true, card: r.card });
  });

  it('unknown column is an error', () => {
    const r = moveCard(sampleCard(), 'shipped', { actor, now: NOW, config });
    expect(r).toEqual({
      ok: false,
      error: 'unknown column "shipped" (columns: backlog, decide, todo, doing, done)',
    });
  });

  it('WIP exceeded is a warning, never an error', () => {
    const card = sampleCard({ status: 'todo' });
    const full = moveCard(card, 'doing', { actor, now: NOW, config, columnCounts: { doing: 3 } });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.card.status).toBe('doing');
    expect(full.warnings).toEqual(['WIP limit exceeded: "doing" allows 3, would have 4']);

    const room = moveCard(card, 'doing', { actor, now: NOW, config, columnCounts: { doing: 2 } });
    expect(room.ok && room.warnings).toEqual([]);

    const noCounts = moveCard(card, 'doing', { actor, now: NOW, config });
    expect(noCounts.ok && noCounts.warnings).toEqual([]);

    const noWip = moveCard(card, 'backlog', {
      actor,
      now: NOW,
      config,
      columnCounts: { backlog: 99 },
    });
    expect(noWip.ok && noWip.warnings).toEqual([]);
  });

  it('moving to the current column succeeds with a warning and no WIP check', () => {
    const r = moveCard(sampleCard({ status: 'doing' }), 'doing', {
      actor,
      now: NOW,
      config,
      columnCounts: { doing: 10 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(['card RB-12 is already in "doing"']);
    expect(r.event.from).toBe('doing');
  });
});

describe('moveCard: decision-column guard (RCB-69, FPJ-28)', () => {
  it('refuses a DECIDED card moving back into a decision:true column, naming the letter and card ask', () => {
    const card = sampleCard({
      status: 'todo',
      decision: {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-19T19:00:00Z',
        returnTo: null,
        chosen: 'A',
        words: null,
        decidedBy: 'human/matt',
        decidedAt: '2026-09-19T19:09:00Z',
      },
    });
    const r = moveCard(card, 'decide', { actor, now: NOW, config });
    expect(r).toEqual({
      ok: false,
      error:
        'card RB-12 was decided A by human/matt at 2026-09-19T19:09:00Z — a decided card does ' +
        'not go back to "decide"; ask a new question: repoboard card ask RB-12 "<question>" ' +
        '[--option ...] | --task',
    });
  });

  it('refuses a words-only decided card, naming the letter as "—"', () => {
    const card = sampleCard({
      status: 'todo',
      decision: {
        question: 'Ship it?',
        options: [],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-19T19:00:00Z',
        returnTo: null,
        chosen: null,
        words: 'yes, ship it',
        decidedBy: 'human/matt',
        decidedAt: '2026-09-19T19:09:00Z',
      },
    });
    const r = moveCard(card, 'decide', { actor, now: NOW, config });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('was decided — by human/matt');
  });

  it('warns (but allows) a never-asked card moving into a decision:true column', () => {
    const card = sampleCard({ status: 'todo' });
    const r = moveCard(card, 'decide', { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([
      'card RB-12 moved into "decide" with no open ask — start the discussion: repoboard card ' +
        'ask RB-12 "<question>" [--option ...] | --task',
    ]);
    expect(r.card.status).toBe('decide');
  });

  it('an OPEN ask moving into a decision:true column is neither refused nor warned', () => {
    const card = sampleCard({
      status: 'todo',
      decision: {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-19T19:00:00Z',
        returnTo: null,
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    const r = moveCard(card, 'decide', { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
  });

  it('a decided card moved into a NON-decision column is fine — the guard only fires on the decision column itself', () => {
    const card = sampleCard({
      status: 'decide',
      decision: {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-19T19:00:00Z',
        returnTo: 'todo',
        chosen: 'A',
        words: null,
        decidedBy: 'human/matt',
        decidedAt: '2026-09-19T19:09:00Z',
      },
    });
    const r = moveCard(card, 'todo', { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.card.status).toBe('todo');
  });

  it('same-column no-op is unchanged by the guard even for a decided card', () => {
    const card = sampleCard({
      status: 'decide',
      decision: {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-19T19:00:00Z',
        returnTo: null,
        chosen: 'A',
        words: null,
        decidedBy: 'human/matt',
        decidedAt: '2026-09-19T19:09:00Z',
      },
    });
    const r = moveCard(card, 'decide', { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(['card RB-12 is already in "decide"']);
  });
});

describe('allocateCardId / createCard', () => {
  it('allocates max+1 for the prefix, ignoring other prefixes and gaps', () => {
    expect(allocateCardId([], 'RB')).toBe('RB-1');
    expect(allocateCardId(['RB-1', 'RB-7', 'RB-3'], 'RB')).toBe('RB-8');
    expect(allocateCardId(['K-40', 'RB-2', 'RBX-99', 'RB-abc', 'repoboard-50'], 'RB')).toBe('RB-3');
    expect(allocateCardId(['K-40'], 'RB')).toBe('RB-1');
    expect(allocateCardId(['A.B-4'], 'A.B')).toBe('A.B-5');
    expect(allocateCardId(['AXB-4'], 'A.B')).toBe('A.B-1');
  });

  it('creates a card with defaults: first column, empty body, created == updated', () => {
    const res = createCard({ title: 'New thing' }, { existingIds: ['RB-2'], now: NOW, config });
    if (!res.ok) throw new Error(res.error);
    const card = res.card;
    expect(card).toEqual({
      id: 'RB-3',
      title: 'New thing',
      status: 'backlog',
      created: '2026-09-02T22:41:10Z',
      updated: '2026-09-02T22:41:10Z',
      body: '',
    });
    expect(parseCard(serializeCard(card))).toEqual({ ok: true, card });
  });

  it('honors every optional input and copies arrays', () => {
    const labels = ['a'];
    const res = createCard(
      {
        title: 't',
        status: 'doing',
        assignee: 'me',
        priority: 'low',
        labels,
        files: ['f'],
        body: 'b\n',
      },
      { existingIds: [], now: NOW, config },
    );
    if (!res.ok) throw new Error(res.error);
    const card = res.card;
    expect(card.status).toBe('doing');
    expect(card.assignee).toBe('me');
    expect(card.priority).toBe('low');
    expect(card.labels).toEqual(['a']);
    expect(card.labels).not.toBe(labels);
    expect(card.files).toEqual(['f']);
    expect(card.body).toBe('b\n');
  });

  it('RCB-67: honors size on create', () => {
    const res = createCard({ title: 't', size: 'L' }, { existingIds: [], now: NOW, config });
    if (!res.ok) throw new Error(res.error);
    expect(res.card.size).toBe('L');
  });

  it('returns ok:false (never throws) on an unknown status, no columns, or an empty title', () => {
    expect(
      createCard({ title: 't', status: 'nope' }, { existingIds: [], now: NOW, config }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/unknown column "nope" \(columns: backlog/),
    });
    expect(
      createCard({ title: 't' }, { existingIds: [], now: NOW, config: { ...config, columns: [] } }),
    ).toEqual({ ok: false, error: expect.stringMatching(/no columns/) });
    expect(createCard({ title: '' }, { existingIds: [], now: NOW, config })).toEqual({
      ok: false,
      error: expect.stringMatching(/title/),
    });
  });

  it('core Event accepts every type the store writes (K2): move, update, create', () => {
    const events: Event[] = [
      { ts: 't', actor: 'a', type: 'move', cardId: 'RB-1', from: 'todo', to: 'doing' },
      { ts: 't', actor: 'a', type: 'update', cardId: 'RB-1', from: 'doing', to: 'doing' },
      { ts: 't', actor: 'a', type: 'create', cardId: 'RB-1', from: null, to: 'backlog' },
    ];
    expect(events.map((e) => e.type)).toEqual(['move', 'update', 'create']);
    expect(events[2]?.from).toBeNull();
  });
});

describe('RCB-68: createCard with parent/phase/gate', () => {
  it('sets all three when given', () => {
    const res = createCard(
      { title: 't', parent: 'RB-1', phase: 'PH.3', gate: 'RB-2' },
      { existingIds: ['RB-1', 'RB-2'], now: NOW, config },
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.card.parent).toBe('RB-1');
    expect(res.card.phase).toBe('PH.3');
    expect(res.card.gate).toBe('RB-2');
  });

  it('refuses a card that names itself as parent (id allocated first, then compared)', () => {
    // No existing ids of this prefix: the next allocated id is RB-1.
    const res = createCard({ title: 't', parent: 'RB-1' }, { existingIds: [], now: NOW, config });
    expect(res).toEqual({ ok: false, error: 'a card cannot be its own parent' });
  });

  it('refuses an empty or whitespace-only parent/phase/gate', () => {
    for (const field of ['parent', 'phase', 'gate'] as const) {
      const res = createCard({ title: 't', [field]: '   ' }, { existingIds: [], now: NOW, config });
      expect(res).toEqual({ ok: false, error: `${field} must not be empty` });
    }
  });
});

describe('updateCard', () => {
  it('sets fields, clears with null, stamps updated, logs the changed fields', () => {
    const card = sampleCard({ body: '' });
    const r = updateCard(
      card,
      { title: 'Renamed', priority: null, labels: ['x'], assignee: 'human/matt' },
      { actor, now: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.title).toBe('Renamed');
    expect('priority' in r.card).toBe(false);
    expect(r.card.labels).toEqual(['x']);
    expect(r.card.assignee).toBe('human/matt');
    expect(r.card.files).toEqual(card.files);
    expect(r.card.status).toBe(card.status);
    expect(r.card.updated).toBe('2026-09-02T22:41:10Z');
    expect(r.card.body).toBe(
      '\n## Log\n- 2026-09-02T22:41:10Z claude/test — updated title, assignee, priority, labels\n',
    );
    expect(card.title).toBe('Treemap view of the repo');
  });

  it('body patch replaces the body, then the log line is appended', () => {
    const r = updateCard(sampleCard(), { body: 'fresh\n' }, { actor, now: NOW });
    expect(r.ok && r.card.body).toBe(
      'fresh\n\n## Log\n- 2026-09-02T22:41:10Z claude/test — updated body\n',
    );
  });

  it('RCB-68: sets parent/phase/gate, clears each with null, and the Log line names them', () => {
    const card = sampleCard({ parent: 'RB-1', phase: 'PH.1', gate: 'RB-2' });
    const set = updateCard(card, { phase: 'PH.2' }, { actor, now: NOW });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.card.phase).toBe('PH.2');
    expect(set.card.body).toContain('updated phase');

    const cleared = updateCard(
      card,
      { parent: null, phase: null, gate: null },
      { actor, now: NOW },
    );
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect('parent' in cleared.card).toBe(false);
    expect('phase' in cleared.card).toBe(false);
    expect('gate' in cleared.card).toBe(false);
    expect(cleared.card.body).toContain('updated parent, phase, gate');
  });

  it('RCB-68: refuses a parent equal to the card’s own id', () => {
    const card = sampleCard({ id: 'RB-12' });
    const r = updateCard(card, { parent: 'RB-12' }, { actor, now: NOW });
    expect(r).toEqual({ ok: false, error: 'a card cannot be its own parent' });
  });

  it('RCB-68: refuses an empty or whitespace-only parent/phase/gate', () => {
    for (const field of ['parent', 'phase', 'gate'] as const) {
      const r = updateCard(sampleCard(), { [field]: '  ' }, { actor, now: NOW });
      expect(r).toEqual({ ok: false, error: `${field} must not be empty` });
    }
  });

  it('rejects status, empty title, bad priority, empty patch', () => {
    const p = { status: 'done' } as unknown as Parameters<typeof updateCard>[1];
    expect(updateCard(sampleCard(), p, { actor, now: NOW })).toEqual({
      ok: false,
      error: 'updateCard cannot change status; use moveCard',
    });
    expect(updateCard(sampleCard(), { title: '' }, { actor, now: NOW }).ok).toBe(false);
    const bad = { priority: 'urgent' } as unknown as Parameters<typeof updateCard>[1];
    expect(updateCard(sampleCard(), bad, { actor, now: NOW }).ok).toBe(false);
    expect(updateCard(sampleCard(), {}, { actor, now: NOW })).toEqual({
      ok: false,
      error: 'patch is empty',
    });
  });

  it('RCB-67: sets size, clears with null, and the Log line says "updated size"', () => {
    const card = sampleCard({ size: 'S' });
    const set = updateCard(card, { size: 'XL' }, { actor, now: NOW });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.card.size).toBe('XL');
    expect(set.card.body).toContain('updated size');

    const cleared = updateCard(card, { size: null }, { actor, now: NOW });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect('size' in cleared.card).toBe(false);
    expect(cleared.card.body).toContain('updated size');
  });

  it('RCB-67: rejects a bad size with the "size: …" message (zod\'s enum message, prefixed like priority\'s)', () => {
    const bad = { size: 'huge' } as unknown as Parameters<typeof updateCard>[1];
    const r = updateCard(sampleCard(), bad, { actor, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^size: /);
    expect(r.error).toMatch(/S.*M.*L.*XL/);
  });
});
