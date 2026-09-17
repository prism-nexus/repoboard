/**
 * P8.1 (plan §5 P8.1, §11 O10/O11): decisions live ON THE CARD. `askDecision`/`decide` are the
 * only writers of `card.decision`; both funnel a status change through `moveCard` when the board
 * names a `decision: true` column (O11), so a move's log/event/WIP shape is identical either way.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { parseCard, serializeCard } from '../src/card.js';
import { askDecision, decide, isDecided, needsDecision } from '../src/decisions.js';
import type { BoardConfig, Card, Decision } from '../src/types.js';
import { NOW, sampleCard } from './helpers.js';

const config = defaultBoardConfig(); // backlog, decide{decision:true}, todo, doing, done
const actor = 'claude/test';

/** A board with no `decision: true` column at all — the O11 "badge only" case. */
const noDecideColumn: BoardConfig = {
  ...config,
  columns: config.columns.filter((c) => c.decision !== true),
};

function mustParse(text: string): Card {
  const r = parseCard(text);
  if (!r.ok) throw new Error(r.error);
  return r.card;
}

describe('askDecision', () => {
  it('opens a decision, moves the card into the decision column, records returnTo, logs both lines', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const r = askDecision(card, {
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      actor,
      now: NOW,
      config,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('decide');
    expect(r.card.decision).toEqual({
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      askedBy: actor,
      askedAt: '2026-09-02T22:41:10Z',
      returnTo: 'todo',
      chosen: null,
      words: null,
      decidedBy: null,
      decidedAt: null,
    } satisfies Decision);
    expect(r.card.body).toBe(
      'desc\n\n## Log\n' +
        '- 2026-09-02T22:41:10Z claude/test — moved todo → decide\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it? [A|B]\n',
    );
    expect(r.event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor,
      type: 'move',
      cardId: card.id,
      from: 'todo',
      to: 'decide',
    });
    expect(r.warnings).toEqual([]);
    // pure
    expect(card.status).toBe('todo');
    expect(card.decision).toBeUndefined();
  });

  it('with no decision:true column on the board, status is untouched (badge only) — O11', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const r = askDecision(card, { question: 'Ship it?', actor, now: NOW, config: noDecideColumn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('todo');
    expect(r.card.decision?.returnTo).toBeNull();
    expect(r.card.body).toBe(
      'desc\n\n## Log\n- 2026-09-02T22:41:10Z claude/test — asked: Ship it?\n',
    );
    expect(r.event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor,
      type: 'ask',
      cardId: card.id,
      from: 'todo',
      to: 'todo',
    });
  });

  it('with no config at all, behaves the same as no decision column', () => {
    const card = sampleCard({ status: 'todo' });
    const r = askDecision(card, { question: 'Ship it?', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('todo');
    expect(r.event.type).toBe('ask');
  });

  it('options may be empty: a yes/no or free-text question', () => {
    const card = sampleCard({ status: 'todo' });
    const r = askDecision(card, { question: 'Free text?', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.decision?.options).toEqual([]);
    expect(r.card.body).toMatch(/asked: Free text\?\n$/);
  });

  it('duplicate option letters are refused', () => {
    const card = sampleCard({ status: 'todo' });
    const r = askDecision(card, {
      question: 'q',
      options: [
        { letter: 'A', text: 'x' },
        { letter: 'A', text: 'y' },
      ],
      actor,
      now: NOW,
      config,
    });
    expect(r).toEqual({ ok: false, error: 'duplicate option letter(s): A' });
  });

  it('an empty question is refused', () => {
    const card = sampleCard({ status: 'todo' });
    expect(askDecision(card, { question: '   ', actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'question must not be empty',
    });
  });

  it('asking again on an OPEN decision is an error naming the open question', () => {
    const card = sampleCard({ status: 'todo' });
    const first = askDecision(card, { question: 'First?', actor, now: NOW, config });
    if (!first.ok) throw new Error(first.error);
    const second = askDecision(first.card, { question: 'Second?', actor, now: NOW, config });
    expect(second).toEqual({
      ok: false,
      error:
        'card RB-12 already has an open decision: "First?" ' +
        '(pass --replace to withdraw it and ask a new one)',
    });
  });

  it('--replace withdraws the open question, logs it, and opens the new one', () => {
    const card = sampleCard({ status: 'todo' });
    const first = askDecision(card, { question: 'First?', actor, now: NOW, config });
    if (!first.ok) throw new Error(first.error);
    const second = askDecision(first.card, {
      question: 'Second?',
      actor,
      now: NOW,
      config,
      replace: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.card.decision?.question).toBe('Second?');
    expect(second.card.body).toContain('question withdrawn');
    expect(second.card.body).toContain('asked: Second?');
  });

  it('asking again on a DECIDED card needs no --replace: the old block is simply replaced', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'First?', actor, now: NOW, config });
    if (!asked.ok) throw new Error(asked.error);
    const answered = decide(asked.card, { words: 'yes', actor, now: NOW, config });
    if (!answered.ok) throw new Error(answered.error);
    expect(isDecided(answered.card)).toBe(true);
    const second = askDecision(answered.card, {
      question: 'Second?',
      actor,
      now: NOW,
      config,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.card.decision?.question).toBe('Second?');
    expect(second.card.body).not.toContain('question withdrawn');
  });
});

describe('decide', () => {
  function opened(status = 'todo') {
    const card = sampleCard({ status });
    const r = askDecision(card, {
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      actor,
      now: NOW,
      config,
    });
    if (!r.ok) throw new Error(r.error);
    return r.card;
  }

  it('a lettered answer moves the card back to returnTo, appends both log lines, sets the event', () => {
    const card = opened('todo');
    const r = decide(card, { letter: 'A', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('todo');
    expect(r.card.decision).toEqual({
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      askedBy: actor,
      askedAt: '2026-09-02T22:41:10Z',
      returnTo: 'todo',
      chosen: 'A',
      words: null,
      decidedBy: actor,
      decidedAt: '2026-09-02T22:41:10Z',
    } satisfies Decision);
    expect(
      r.card.body.endsWith('decided A\n- 2026-09-02T22:41:10Z claude/test — moved decide → todo\n'),
    ).toBe(true);
    expect(r.event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor,
      type: 'move',
      cardId: card.id,
      from: 'decide',
      to: 'todo',
    });
    expect(isDecided(r.card)).toBe(true);
    expect(needsDecision(r.card)).toBe(false);
  });

  it('letter and words together: "decided <letter> — "<words>""', () => {
    const card = opened();
    const r = decide(card, { letter: 'B', words: 'not ready', actor, now: NOW, config });
    expect(r.ok && r.card.body).toContain('decided B — "not ready"');
  });

  it('words only, when options is empty, sets chosen null and decidedAt', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'Free text?', actor, now: NOW, config });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { words: 'sure, go ahead', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.decision?.chosen).toBeNull();
    expect(r.card.decision?.words).toBe('sure, go ahead');
    expect(r.card.decision?.decidedAt).toBe('2026-09-02T22:41:10Z');
    expect(r.card.body).toContain('decided — "sure, go ahead"');
    expect(isDecided(r.card)).toBe(true);
  });

  it('an unknown letter is refused, naming the valid ones', () => {
    const card = opened();
    expect(decide(card, { letter: 'Z', actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'unknown option "Z" (valid: A, B)',
    });
  });

  it('a letter when there are no options is refused, saying so', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'Free text?', actor, now: NOW, config });
    if (!asked.ok) throw new Error(asked.error);
    expect(decide(asked.card, { letter: 'A', actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'unknown option "A" (valid: (this decision has no lettered options))',
    });
  });

  it('neither letter nor words is refused', () => {
    const card = opened();
    expect(decide(card, { actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'decide needs a letter, words, or both',
    });
  });

  it('nothing open is refused, naming the card', () => {
    const card = sampleCard({ status: 'todo' });
    expect(decide(card, { letter: 'A', actor, now: NOW, config })).toEqual({
      ok: false,
      error: `no decision is open on ${card.id}`,
    });
  });

  it('deciding twice (already DECIDED) is refused the same way', () => {
    const card = opened();
    const once = decide(card, { letter: 'A', actor, now: NOW, config });
    if (!once.ok) throw new Error(once.error);
    expect(decide(once.card, { letter: 'B', actor, now: NOW, config })).toEqual({
      ok: false,
      error: `no decision is open on ${card.id}`,
    });
  });

  it('with no decision:true column on the board, deciding leaves status alone', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'q', actor, now: NOW, config: noDecideColumn });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.card.status).toBe('todo');
    const answered = decide(asked.card, { words: 'ok', actor, now: NOW, config: noDecideColumn });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.card.status).toBe('todo');
    expect(answered.event.type).toBe('decide');
  });

  it('a returnTo column that no longer exists: stays, and the log says so', () => {
    const card = opened('todo');
    const shrunk: BoardConfig = {
      ...config,
      columns: config.columns.filter((c) => c.id !== 'todo'),
    };
    const r = decide(card, { letter: 'A', actor, now: NOW, config: shrunk });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('decide'); // never moved
    expect(r.card.body).toContain('returnTo todo missing; stayed');
    expect(r.event.type).toBe('decide');
    expect(r.event.from).toBe('decide');
    expect(r.event.to).toBe('decide');
  });
});

describe('needsDecision / isDecided truth table', () => {
  const base = {
    question: 'q',
    options: [],
    askedBy: 'a',
    askedAt: '2026-09-02T22:00:00Z',
    returnTo: null,
  };

  it('no decision block: neither', () => {
    const card = sampleCard({ status: 'todo' });
    expect(needsDecision(card)).toBe(false);
    expect(isDecided(card)).toBe(false);
  });

  it('neither chosen nor decidedAt: NEEDS OWNER', () => {
    const card = sampleCard({
      decision: { ...base, chosen: null, words: null, decidedBy: null, decidedAt: null },
    });
    expect(needsDecision(card)).toBe(true);
    expect(isDecided(card)).toBe(false);
  });

  it('chosen only: DECIDED', () => {
    const card = sampleCard({
      decision: { ...base, chosen: 'A', words: null, decidedBy: null, decidedAt: null },
    });
    expect(needsDecision(card)).toBe(false);
    expect(isDecided(card)).toBe(true);
  });

  it('decidedAt only: DECIDED', () => {
    const card = sampleCard({
      decision: {
        ...base,
        chosen: null,
        words: 'yes',
        decidedBy: 'a',
        decidedAt: '2026-09-02T22:10:00Z',
      },
    });
    expect(needsDecision(card)).toBe(false);
    expect(isDecided(card)).toBe(true);
  });

  it('both chosen and decidedAt: DECIDED', () => {
    const card = sampleCard({
      decision: {
        ...base,
        chosen: 'A',
        words: null,
        decidedBy: 'a',
        decidedAt: '2026-09-02T22:10:00Z',
      },
    });
    expect(needsDecision(card)).toBe(false);
    expect(isDecided(card)).toBe(true);
  });
});

describe('round-trip and K1 quoting on decision fields', () => {
  it('a card with a decision block round-trips byte-identically, key order after refs', () => {
    const card = sampleCard({ refs: ['README.md'] });
    const asked = askDecision(card, {
      question: 'q',
      options: [{ letter: 'A', text: 'x' }],
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    const text = serializeCard(asked.card);
    const lines = text.split('\n');
    const refsIdx = lines.indexOf('refs:');
    const decisionIdx = lines.indexOf('decision:');
    const createdIdx = lines.findIndex((l) => l.startsWith('created:'));
    expect(refsIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThan(refsIdx);
    expect(createdIdx).toBeGreaterThan(decisionIdx);
    expect(mustParse(text)).toEqual(asked.card);
    expect(serializeCard(mustParse(text))).toBe(text);
  });

  it('a colon in the question or an option text is quoted on serialize and survives parsing', () => {
    const card = sampleCard({ status: 'todo' });
    const r = askDecision(card, {
      question: 'Ops cost: shrink the seat or retire it?',
      options: [{ letter: 'C1', text: 'waiter scripts: fuse counted as terminal' }],
      actor,
      now: NOW,
      config,
    });
    if (!r.ok) throw new Error(r.error);
    const text = serializeCard(r.card);
    expect(text).toContain('question: "Ops cost: shrink the seat or retire it?"');
    expect(text).toContain('text: "waiter scripts: fuse counted as terminal"');
    expect(mustParse(text)).toEqual(r.card);
  });

  it('a hand edit that sets only chosen: (sed-style) still parses and reads DECIDED', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'q', actor, now: NOW, config });
    if (!asked.ok) throw new Error(asked.error);
    const text = serializeCard(asked.card).replace('chosen: null', 'chosen: C2');
    const reparsed = mustParse(text);
    expect(reparsed.decision?.chosen).toBe('C2');
    expect(reparsed.decision?.decidedAt).toBeNull();
    expect(isDecided(reparsed)).toBe(true);
    expect(needsDecision(reparsed)).toBe(false);
  });
});
