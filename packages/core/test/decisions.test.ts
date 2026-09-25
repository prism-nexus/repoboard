/**
 * P8.1 (plan §5 P8.1, §11 O10/O11): decisions live ON THE CARD. `askDecision`/`decide` are the
 * only writers of `card.decision`; both funnel a status change through `moveCard` when the board
 * names a `decision: true` column (O11), so a move's log/event/WIP shape is identical either way.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { parseCard, serializeCard } from '../src/card.js';
import {
  answeredDecisions,
  askDecision,
  decide,
  formatAnsweredChoice,
  isDecided,
  isOwnerTask,
  needsDecision,
  resolveSince,
} from '../src/decisions.js';
import { ownerQueueLine } from '../src/state.js';
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
      'desc\n\n## Decision\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it?\n' +
        '  - A: yes\n' +
        '  - B: no\n\n' +
        '## Log\n' +
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
      'desc\n\n## Decision\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it?\n\n' +
        '## Log\n- 2026-09-02T22:41:10Z claude/test — asked: Ship it?\n',
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

  it('RCB-69/FPJ-33: asking a card ALREADY in the decision column sets returnTo to defaultReturnTo, not null', () => {
    const card = sampleCard({ status: 'decide' });
    const r = askDecision(card, { question: 'Ship it?', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('decide'); // unchanged: already there
    expect(r.card.decision?.returnTo).toBe('todo');
    expect(r.event.type).toBe('ask');
    expect(r.warnings).toEqual([]); // moveCard's own "no open ask" guard must not fire on this move
  });

  it('RCB-69: when the decision column is LAST in board order, the fallback picks the first eligible column anywhere', () => {
    const decideLastConfig: BoardConfig = {
      ...config,
      columns: [
        { id: 'backlog', title: 'Backlog' },
        { id: 'todo', title: 'To do' },
        { id: 'doing', title: 'Doing', active: true, wip: 3 },
        { id: 'done', title: 'Done', done: true },
        { id: 'decide', title: 'Needs decision', decision: true },
      ],
    };
    const card = sampleCard({ status: 'decide' });
    const r = askDecision(card, {
      question: 'Ship it?',
      actor,
      now: NOW,
      config: decideLastConfig,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.decision?.returnTo).toBe('backlog');
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

  it('RCB-69: a returnTo column that no longer exists falls back to defaultReturnTo, not "stays" (was: stays, log says so)', () => {
    // Before RCB-69 this asserted the card NEVER moved ('decide', log "returnTo todo missing;
    // stayed"). The owner's fourth guarantee (20:4xZ) makes that the bug: `decide` must ALWAYS
    // move a card out of a `decision: true` column, so a missing `returnTo` now falls back to
    // `defaultReturnTo` (here: `doing`, the first non-decision, non-done column after `decide`
    // once `todo` is removed) instead of leaving it stranded.
    const card = opened('todo');
    const shrunk: BoardConfig = {
      ...config,
      columns: config.columns.filter((c) => c.id !== 'todo'),
    };
    const r = decide(card, { letter: 'A', actor, now: NOW, config: shrunk });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('doing'); // moved to the default, not stranded in "decide"
    expect(r.card.body).toContain('decided A → doing (default; asked in-column)');
    expect(r.card.body).toContain('moved decide → doing');
    expect(r.event.type).toBe('move');
    expect(r.event.from).toBe('decide');
    expect(r.event.to).toBe('doing');
  });

  it('RCB-69: decide of a card asked WHILE ALREADY in the decision column moves it out (via the returnTo askDecision itself set)', () => {
    const card = sampleCard({ status: 'decide' });
    const asked = askDecision(card, {
      question: 'Ship it?',
      options: [{ letter: 'A', text: 'yes' }],
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.card.decision?.returnTo).toBe('todo');
    const r = decide(asked.card, { letter: 'A', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // askDecision already resolved a real `returnTo` ('todo'), so `decide` moves there as an
    // ordinary returnTo move — no "(default; asked in-column)" annotation needed here; that
    // annotation is for `decide`'s OWN fallback, exercised by the pre-fix-card test below.
    expect(r.card.status).toBe('todo');
    expect(r.card.body).toContain('decided A');
    expect(r.card.body).toContain('moved decide → todo');
    expect(r.card.body).not.toContain('(default; asked in-column)');
  });

  it('RCB-69 (FPJ-33): a pre-fix card — returnTo null, status already "decide" — decide moves it out via the default, no re-ask needed', () => {
    const card = sampleCard({
      status: 'decide',
      decision: {
        question: 'Ship it?',
        options: [],
        askedBy: 'claude/old',
        askedAt: '2026-09-01T00:00:00Z',
        returnTo: null,
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    const r = decide(card, { words: 'yes', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('todo');
    expect(r.card.body).toContain('(default; asked in-column)');
    expect(r.event.type).toBe('move');
    expect(r.event.from).toBe('decide');
    expect(r.event.to).toBe('todo');
  });
});

describe(
  'RCB-70 companion rule (owner 2026-09-19): a decided card leaves the decision column ' +
    'for To do — asked from todo, and asked in-column',
  () => {
    it('(a) asked from todo, decide A → status todo', () => {
      const card = sampleCard({ status: 'todo' });
      const asked = askDecision(card, {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        actor,
        now: NOW,
        config,
      });
      if (!asked.ok) throw new Error(asked.error);
      const r = decide(asked.card, { letter: 'A', actor, now: NOW, config });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.card.status).toBe('todo');
    });

    it('(b) card already in decide, ask, decide → todo', () => {
      const card = sampleCard({ status: 'decide' });
      const asked = askDecision(card, {
        question: 'Ship it?',
        options: [{ letter: 'A', text: 'yes' }],
        actor,
        now: NOW,
        config,
      });
      if (!asked.ok) throw new Error(asked.error);
      const r = decide(asked.card, { letter: 'A', actor, now: NOW, config });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.card.status).toBe('todo');
    });
  },
);

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

describe('owner tasks (RCB-52): askDecision/decide with kind: task', () => {
  it('asks a task: kind "task", options [], log line "owner task: …", moves to decide like a question', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const r = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      actor,
      now: NOW,
      config,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('decide');
    expect(r.card.decision?.kind).toBe('task');
    expect(r.card.decision?.options).toEqual([]);
    expect(r.card.body).toContain('owner task: buy the domain');
    expect(isOwnerTask(r.card)).toBe(true);
    expect(needsDecision(r.card)).toBe(true);
  });

  it('a task with options is refused: "a task has no options"', () => {
    const card = sampleCard({ status: 'todo' });
    const r = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      options: [{ letter: 'A', text: 'x' }],
      actor,
      now: NOW,
      config,
    });
    expect(r).toEqual({ ok: false, error: 'a task has no options' });
  });

  it('decide with nothing on a task: decided, chosen null, words null, decidedAt set, log "done", moves back to returnTo', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.status).toBe('todo'); // moved back to returnTo
    expect(r.card.decision?.chosen).toBeNull();
    expect(r.card.decision?.words).toBeNull();
    expect(r.card.decision?.decidedAt).toBe('2026-09-02T22:41:10Z');
    expect(r.card.body).toContain('done');
    expect(r.card.body).not.toContain('decided');
    expect(isDecided(r.card)).toBe(true);
  });

  it('decide with --words on a task: log line "done — \\"<words>\\""', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { words: 'done, renewed for a year', actor, now: NOW, config });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.decision?.words).toBe('done, renewed for a year');
    expect(r.card.body).toContain('done — "done, renewed for a year"');
  });

  it('a letter on a task is refused with the existing unknown-option message', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(decide(asked.card, { letter: 'A', actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'unknown option "A" (valid: (this decision has no lettered options))',
    });
  });

  /**
   * Control C2: `decide` on a plain QUESTION with neither letter nor words must still be
   * refused — only a task (`kind === 'task'`) waives that requirement. Removing the
   * `&& decision.kind !== 'task'` guard in `decide` (decisions.ts) makes this test fail: bare
   * `decide` on a question would then wrongly succeed. Verified per CLAUDE.md: see the agent's
   * report for the perturbation applied, the failing assertion, and the restore proof.
   */
  it('control C2: decide with nothing on a plain QUESTION (no kind) is still refused', () => {
    const card = sampleCard({ status: 'todo' });
    const asked = askDecision(card, { question: 'Ship it?', actor, now: NOW, config });
    if (!asked.ok) throw new Error(asked.error);
    expect(decide(asked.card, { actor, now: NOW, config })).toEqual({
      ok: false,
      error: 'decide needs a letter, words, or both',
    });
  });

  it('ownerQueueLine for a task omits letters: "RCB-9 · owner: buy the domain"', () => {
    const card = sampleCard({ id: 'RCB-9', status: 'todo' });
    const asked = askDecision(card, {
      question: 'buy the domain',
      kind: 'task',
      actor,
      now: NOW,
      config,
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(ownerQueueLine(asked.card)).toBe('RCB-9 · owner: buy the domain');
  });
});

describe('## Decision body section (RCB-107)', () => {
  it('ask with options A/B on body "desc\\n" → body is exactly the Decision section then Log', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const r = askDecision(card, {
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      actor,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.body).toBe(
      'desc\n\n## Decision\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it?\n' +
        '  - A: yes\n' +
        '  - B: no\n\n' +
        '## Log\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it? [A|B]\n',
    );
  });

  it('then decide A → ## Decision gains "decided A: yes" as its LAST bullet, Log unchanged in shape, section still before ## Log', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const asked = askDecision(card, {
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
      actor,
      now: NOW,
    });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { letter: 'A', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decisionIdx = r.card.body.indexOf('## Decision');
    const logIdx = r.card.body.indexOf('## Log');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeLessThan(logIdx);
    const decisionSection = r.card.body.slice(decisionIdx, logIdx);
    const askedIdx = decisionSection.indexOf('asked: Ship it?');
    const decidedIdx = decisionSection.indexOf('decided A: yes');
    expect(askedIdx).toBeGreaterThanOrEqual(0);
    expect(decidedIdx).toBeGreaterThan(askedIdx);
    expect(decisionSection.trimEnd().endsWith('decided A: yes')).toBe(true);
    expect(r.card.body).toContain(
      '## Log\n' +
        '- 2026-09-02T22:41:10Z claude/test — asked: Ship it? [A|B]\n' +
        '- 2026-09-02T22:41:10Z claude/test — decided A\n',
    );
  });

  it('body already has ## Notes and ## Log → ## Decision is created before ## Notes', () => {
    const card = sampleCard({
      status: 'todo',
      body: 'desc\n\n## Notes\n- a note\n\n## Log\n- something\n',
    });
    const r = askDecision(card, { question: 'Ship it?', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decisionIdx = r.card.body.indexOf('## Decision');
    const notesIdx = r.card.body.indexOf('## Notes');
    const logIdx = r.card.body.indexOf('## Log');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeLessThan(notesIdx);
    expect(notesIdx).toBeLessThan(logIdx);
    expect(r.card.body).toContain('## Notes\n- a note\n');
  });

  it('re-ask with --replace: Decision has asked #1, question withdrawn, asked #2; frontmatter is #2 but body still keeps #1 options', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const first = askDecision(card, {
      question: 'First?',
      options: [{ letter: 'A', text: 'yes' }],
      actor,
      now: NOW,
    });
    if (!first.ok) throw new Error(first.error);
    const second = askDecision(first.card, {
      question: 'Second?',
      actor,
      now: NOW,
      replace: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.card.decision?.question).toBe('Second?');
    const decisionIdx = second.card.body.indexOf('## Decision');
    const logIdx = second.card.body.indexOf('## Log');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    const decisionSection = second.card.body.slice(decisionIdx, logIdx);
    const askedFirstIdx = decisionSection.indexOf('asked: First?');
    const withdrawnIdx = decisionSection.indexOf('question withdrawn');
    const askedSecondIdx = decisionSection.indexOf('asked: Second?');
    expect(askedFirstIdx).toBeGreaterThanOrEqual(0);
    expect(withdrawnIdx).toBeGreaterThan(askedFirstIdx);
    expect(askedSecondIdx).toBeGreaterThan(withdrawnIdx);
    expect(decisionSection).toContain('- A: yes');
  });

  it('task ask + done with words: Decision gets "owner task: buy it" then "done — \\"renewed\\""', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const asked = askDecision(card, { question: 'buy it', kind: 'task', actor, now: NOW });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { words: 'renewed', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decisionIdx = r.card.body.indexOf('## Decision');
    const logIdx = r.card.body.indexOf('## Log');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    const decisionSection = r.card.body.slice(decisionIdx, logIdx);
    const ownerIdx = decisionSection.indexOf('owner task: buy it');
    const doneIdx = decisionSection.indexOf('done — "renewed"');
    expect(ownerIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(ownerIdx);
  });

  it('words-only decide (no letter, no kind): Decision gets decided — "sure"', () => {
    const card = sampleCard({ status: 'todo', body: 'desc\n' });
    const asked = askDecision(card, { question: 'Free text?', actor, now: NOW });
    if (!asked.ok) throw new Error(asked.error);
    const r = decide(asked.card, { words: 'sure', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.body).toContain('decided — "sure"');
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

/** A fully answered decision on `card` — `askDecision` then `decide`, no board config (badge
 * only, status untouched) — so every test below controls exactly the log/notes bullets on top of
 * it, rather than depending on `moveCard`'s own log lines. */
function answeredCard(
  card: Card,
  opts: { question?: string; letter?: string; words?: string; decidedBy: string; decidedAt: Date },
): Card {
  const asked = askDecision(card, {
    question: opts.question ?? 'Ship it?',
    options: [
      { letter: 'A', text: 'yes' },
      { letter: 'B', text: 'no' },
    ],
    actor: 'claude/coordinator',
    now: NOW,
  });
  if (!asked.ok) throw new Error(asked.error);
  const decided = decide(asked.card, {
    letter: opts.letter,
    words: opts.words,
    actor: opts.decidedBy,
    now: opts.decidedAt,
  });
  if (!decided.ok) throw new Error(decided.error);
  return decided.card;
}

describe('answeredDecisions (RCB-129)', () => {
  const decidedAt = new Date('2026-09-24T18:19:51Z');

  it('an answered card with nothing after decidedAt is unacknowledged', () => {
    const card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    const [row] = answeredDecisions([card]);
    expect(row).toMatchObject({
      id: 'RB-1',
      chosen: 'A',
      chosenText: 'yes',
      words: null,
      decidedAt: '2026-09-24T18:19:51Z',
      decidedBy: 'owner',
      acknowledged: false,
    });
  });

  it('a ## Log line strictly after decidedAt by another actor acknowledges it', () => {
    let card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    card = {
      ...card,
      body: `${card.body}- 2026-09-24T18:26:00Z builder — moved decide → doing\n`,
    };
    const [row] = answeredDecisions([card]);
    expect(row?.acknowledged).toBe(true);
  });

  it('a ## Notes line strictly after decidedAt by another actor also acknowledges it (card note)', () => {
    let card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    // Same shape `appendNoteLine`/`card note` writes: a `## Notes` bullet, not `## Log`.
    card = {
      ...card,
      body: card.body.replace('## Log', '## Notes\n- 2026-09-24T18:26:00Z builder — ack\n\n## Log'),
    };
    const [row] = answeredDecisions([card]);
    expect(row?.acknowledged).toBe(true);
  });

  it('a line at the SAME ts as decidedAt does not acknowledge (strictly later only)', () => {
    let card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    card = {
      ...card,
      body: `${card.body}- 2026-09-24T18:19:51Z builder — same instant\n`,
    };
    const [row] = answeredDecisions([card]);
    expect(row?.acknowledged).toBe(false);
  });

  it('a line by the SAME actor as decidedBy does not acknowledge, even later', () => {
    let card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    card = {
      ...card,
      body: `${card.body}- 2026-09-24T19:00:00Z owner — talking to myself\n`,
    };
    const [row] = answeredDecisions([card]);
    expect(row?.acknowledged).toBe(false);
  });

  it('a words-only answer with no options carries chosen: null, chosenText: null', () => {
    const card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      words: 'do it',
      decidedBy: 'owner',
      decidedAt,
    });
    const [row] = answeredDecisions([card]);
    expect(row).toMatchObject({ chosen: null, chosenText: null, words: 'do it' });
  });

  it('an open (unanswered) decision is excluded entirely', () => {
    const card = askDecision(sampleCard({ id: 'RB-1' }), {
      question: 'open?',
      actor: 'claude/coordinator',
      now: NOW,
    });
    if (!card.ok) throw new Error(card.error);
    expect(answeredDecisions([card.card])).toEqual([]);
  });

  it('a hand-edited chosen: with no decidedAt stamp is excluded — no answer TIME to report', () => {
    const asked = askDecision(sampleCard({ id: 'RB-1' }), {
      question: 'q',
      actor: 'claude/coordinator',
      now: NOW,
    });
    if (!asked.ok) throw new Error(asked.error);
    const handEdited: Card = {
      ...asked.card,
      decision: { ...(asked.card.decision as Decision), chosen: 'A' },
    };
    expect(isDecided(handEdited)).toBe(true);
    expect(answeredDecisions([handEdited])).toEqual([]);
  });

  it('newest decidedAt first, across cards', () => {
    const older = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt: new Date('2026-09-24T10:00:00Z'),
    });
    const newer = answeredCard(sampleCard({ id: 'RB-2', body: 'desc\n' }), {
      letter: 'B',
      decidedBy: 'owner',
      decidedAt: new Date('2026-09-24T20:00:00Z'),
    });
    const rows = answeredDecisions([older, newer]);
    expect(rows.map((r) => r.id)).toEqual(['RB-2', 'RB-1']);
  });

  it('since drops rows decided before it, keeps rows decided at or after it', () => {
    const card = answeredCard(sampleCard({ id: 'RB-1', body: 'desc\n' }), {
      letter: 'A',
      decidedBy: 'owner',
      decidedAt,
    });
    expect(answeredDecisions([card], { since: '2026-09-24T18:19:52Z' })).toEqual([]);
    expect(answeredDecisions([card], { since: '2026-09-24T18:19:51Z' })).toHaveLength(1);
    expect(answeredDecisions([card], { since: '2026-09-24T18:00:00Z' })).toHaveLength(1);
  });
});

describe('formatAnsweredChoice', () => {
  it('renders a lettered answer as "<letter>: <text>"', () => {
    expect(
      formatAnsweredChoice({
        id: 'RB-1',
        title: 't',
        assignee: null,
        question: 'q',
        chosen: 'A',
        chosenText: 'yes',
        words: null,
        decidedAt: NOW.toISOString(),
        decidedBy: 'owner',
        acknowledged: false,
      }),
    ).toBe('A: yes');
  });

  it('renders a words-only answer quoted', () => {
    expect(
      formatAnsweredChoice({
        id: 'RB-1',
        title: 't',
        assignee: null,
        question: 'q',
        chosen: null,
        chosenText: null,
        words: 'go ahead',
        decidedAt: NOW.toISOString(),
        decidedBy: 'owner',
        acknowledged: false,
      }),
    ).toBe('"go ahead"');
  });

  it('renders neither chosen nor words as "-"', () => {
    expect(
      formatAnsweredChoice({
        id: 'RB-1',
        title: 't',
        assignee: null,
        question: 'q',
        chosen: null,
        chosenText: null,
        words: null,
        decidedAt: NOW.toISOString(),
        decidedBy: 'owner',
        acknowledged: false,
      }),
    ).toBe('-');
  });
});

describe('resolveSince', () => {
  const now = new Date('2026-09-24T20:00:00Z');

  it('HH:MMZ resolves against now’s own UTC date', () => {
    const r = resolveSince('18:19Z', now);
    expect(r).toEqual({ ok: true, iso: '2026-09-24T18:19:00Z' });
  });

  it('a full ISO-8601 datetime passes through, normalized', () => {
    const r = resolveSince('2026-09-20T00:00:00.000Z', now);
    expect(r).toEqual({ ok: true, iso: '2026-09-20T00:00:00Z' });
  });

  it('garbage is refused, naming what was rejected', () => {
    const r = resolveSince('not a time', now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('not a time');
  });
});
