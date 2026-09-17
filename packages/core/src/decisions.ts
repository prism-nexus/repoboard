/**
 * P8.1 (plan §5 P8.1, §11 O10/O11): a decision lives ON THE CARD — one optional `decision:`
 * block, asked and answered through the two pure functions here, exactly like
 * `moveCard`/`updateCard` (§0.4: one function per guarantee). No new file type, no array of
 * decisions: history is the `## Log`, and only one decision is ever open on a card at a time.
 *
 * O11: when the board has a column with `decision: true` ("Needs decision", the default board's
 * `decide`), `askDecision` moves the card there and records the prior status as
 * `decision.returnTo`; `decide` moves it back. A board with no such column leaves status alone —
 * the decision is badge-only. Both functions reuse `moveCard` for that move, so the log line,
 * the WIP warning and the event shape are identical to any other move.
 */
import { findColumn } from './board.js';
import { appendLogLine, formatLogLine } from './log.js';
import { toIso } from './time.js';
import { moveCard } from './transitions.js';
import type { BoardConfig, Card, Decision, DecisionOption, Event } from './types.js';

export interface AskDecisionOptions {
  question: string;
  /** May be empty: a yes/no or free-text question, answered with `words` only. */
  options?: DecisionOption[];
  actor: string;
  now: Date;
  /** Withdraw an already-open decision instead of erroring; logs `question withdrawn` first. */
  replace?: boolean;
  /** O11: when given and it has a `decision: true` column, ask moves the card there. */
  config?: BoardConfig;
  /** Cards per column, NOT counting this card (same shape as `MoveOptions`), for the WIP check. */
  columnCounts?: Record<string, number>;
}

export type AskDecisionResult =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string };

export interface DecideOptions {
  /** Must name one of the open decision's `options`, when it has any. */
  letter?: string;
  /** The owner's words, verbatim, optional even when a letter is given. */
  words?: string;
  actor: string;
  now: Date;
  /** O11: needed to move the card back to `decision.returnTo`, and for the WIP check. */
  config?: BoardConfig;
  columnCounts?: Record<string, number>;
}

export type DecideResult =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string };

/**
 * Locked decision 1: `chosen !== null || decidedAt !== null` means DECIDED. A block with
 * neither set (freshly asked, or a hand edit that cleared both) means NEEDS OWNER.
 */
export function needsDecision(card: Card): boolean {
  const d = card.decision;
  if (!d) return false;
  return d.chosen === null && d.decidedAt === null;
}

export function isDecided(card: Card): boolean {
  const d = card.decision;
  if (!d) return false;
  return d.chosen !== null || d.decidedAt !== null;
}

function duplicateLetters(options: readonly DecisionOption[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const o of options) {
    if (seen.has(o.letter)) dups.add(o.letter);
    seen.add(o.letter);
  }
  return [...dups];
}

/** `asked: <question> [A1|A2|A3]` — the bracket is omitted when there are no options. */
function askedLine(question: string, options: readonly DecisionOption[]): string {
  const letters = options.length > 0 ? ` [${options.map((o) => o.letter).join('|')}]` : '';
  return `asked: ${question}${letters}`;
}

/** `decided <letter> — "<words>"` · `decided <letter>` · `decided — "<words>"` (no letter). */
function decidedLine(letter: string | undefined, words: string | undefined): string {
  if (letter !== undefined && words !== undefined) return `decided ${letter} — "${words}"`;
  if (letter !== undefined) return `decided ${letter}`;
  return `decided — "${words}"`;
}

const decisionColumnOf = (config: BoardConfig | undefined) =>
  config?.columns.find((c) => c.decision === true);

/**
 * Open a decision on a card, or replace one that is already open (`--replace`). Asking again on
 * a DECIDED card is not an error and needs no `--replace`: the old block is simply replaced, and
 * its `decided …` log line is already there from the previous `decide` call (locked decision 2).
 *
 * O11: when `config` has a `decision: true` column and the card is not already in it, the card
 * MOVES there first (via `moveCard`, so it gets the usual `moved <from> → decide` log line, WIP
 * warning and a `move`-shaped event) and the prior status is recorded as `decision.returnTo`.
 * Without such a column — or when the card is already in it — nothing about status changes and
 * `returnTo` stays `null`.
 */
export function askDecision(card: Card, opts: AskDecisionOptions): AskDecisionResult {
  const question = opts.question;
  if (question.trim().length === 0) {
    return { ok: false, error: 'question must not be empty' };
  }
  const options = (opts.options ?? []).map((o) => ({ letter: o.letter, text: o.text }));
  const dups = duplicateLetters(options);
  if (dups.length > 0) {
    return { ok: false, error: `duplicate option letter(s): ${dups.join(', ')}` };
  }
  const ts = toIso(opts.now);
  let body = card.body;
  if (needsDecision(card)) {
    if (!opts.replace) {
      return {
        ok: false,
        error:
          `card ${card.id} already has an open decision: "${card.decision?.question}" ` +
          '(pass --replace to withdraw it and ask a new one)',
      };
    }
    body = appendLogLine(body, formatLogLine(ts, opts.actor, 'question withdrawn'));
  }

  let working: Card = { ...card, body };
  let warnings: string[] = [];
  let returnTo: string | null = null;
  let event: Event;

  const col = decisionColumnOf(opts.config);
  if (opts.config && col && card.status !== col.id) {
    const moveRes = moveCard(working, col.id, {
      actor: opts.actor,
      now: opts.now,
      config: opts.config,
      columnCounts: opts.columnCounts,
    });
    if (!moveRes.ok) return { ok: false, error: moveRes.error };
    working = moveRes.card;
    warnings = moveRes.warnings;
    returnTo = card.status;
    event = moveRes.event;
  } else {
    event = {
      ts,
      actor: opts.actor,
      type: 'ask',
      cardId: card.id,
      from: card.status,
      to: card.status,
    };
  }

  const decision: Decision = {
    question,
    options,
    askedBy: opts.actor,
    askedAt: ts,
    returnTo,
    chosen: null,
    words: null,
    decidedBy: null,
    decidedAt: null,
  };
  const next: Card = {
    ...working,
    decision,
    updated: ts,
    body: appendLogLine(working.body, formatLogLine(ts, opts.actor, askedLine(question, options))),
  };
  return { ok: true, card: next, event, warnings };
}

/**
 * Answer the open decision. Refuses an unknown letter (names the valid ones), refuses when
 * nothing is open, and requires a letter or `words` (or both) — a bare `decide` with neither is
 * not an answer.
 *
 * O11: when the decision recorded a `returnTo` column that still exists in `config`, the card
 * MOVES back there (via `moveCard`, same log/event shape as any move). When `returnTo` no longer
 * names a column, the card stays and the log says so (`returnTo <x> missing; stayed`) rather than
 * silently doing nothing.
 */
export function decide(card: Card, opts: DecideOptions): DecideResult {
  const decision = card.decision;
  if (!decision || !needsDecision(card)) {
    return { ok: false, error: `no decision is open on ${card.id}` };
  }
  if (opts.letter === undefined && opts.words === undefined) {
    return { ok: false, error: 'decide needs a letter, words, or both' };
  }
  if (opts.letter !== undefined) {
    const known = decision.options.map((o) => o.letter);
    if (!known.includes(opts.letter)) {
      const valid = known.length > 0 ? known.join(', ') : '(this decision has no lettered options)';
      return { ok: false, error: `unknown option "${opts.letter}" (valid: ${valid})` };
    }
  }
  const ts = toIso(opts.now);
  const nextDecision: Decision = {
    ...decision,
    chosen: opts.letter ?? null,
    words: opts.words ?? null,
    decidedBy: opts.actor,
    decidedAt: ts,
  };
  let working: Card = {
    ...card,
    decision: nextDecision,
    updated: ts,
    body: appendLogLine(
      card.body,
      formatLogLine(ts, opts.actor, decidedLine(opts.letter, opts.words)),
    ),
  };
  let warnings: string[] = [];
  let event: Event = {
    ts,
    actor: opts.actor,
    type: 'decide',
    cardId: card.id,
    from: card.status,
    to: card.status,
    ...(opts.letter !== undefined ? { letter: opts.letter } : {}),
  };

  const returnTo = decision.returnTo;
  if (opts.config && returnTo !== null) {
    const target = findColumn(opts.config, returnTo);
    if (!target) {
      working = {
        ...working,
        body: appendLogLine(
          working.body,
          formatLogLine(ts, opts.actor, `returnTo ${returnTo} missing; stayed`),
        ),
      };
    } else if (card.status !== target.id) {
      const moveRes = moveCard(working, target.id, {
        actor: opts.actor,
        now: opts.now,
        config: opts.config,
        columnCounts: opts.columnCounts,
      });
      if (!moveRes.ok) return { ok: false, error: moveRes.error };
      working = moveRes.card;
      warnings = moveRes.warnings;
      event = moveRes.event;
    }
  }

  return { ok: true, card: working, event, warnings };
}
