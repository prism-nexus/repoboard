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
import { isDecided, needsDecision } from './card.js';
import { appendDecisionLine, appendLogLine, formatDecisionLine, formatLogLine } from './log.js';
import { toIso } from './time.js';
import { moveCard } from './transitions.js';
import type { BoardConfig, Card, Decision, DecisionOption, Event } from './types.js';

/** RCB-69: the two predicates now live in `card.ts` (see the comment there); re-exported here so
 * every existing importer of `decisions.ts` (including `index.ts`) is untouched. */
export { isDecided, needsDecision };

export interface AskDecisionOptions {
  question: string;
  /** May be empty: a yes/no or free-text question, answered with `words` only. */
  options?: DecisionOption[];
  /** RCB-52: an owner WORK item, same queue. Must have no options (`askDecision` refuses). */
  kind?: 'task';
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

/** RCB-52: is the open (or answered) decision on this card an owner WORK item, not a question? */
export function isOwnerTask(card: Card): boolean {
  return card.decision?.kind === 'task';
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

/**
 * `asked: <question> [A1|A2|A3]` — the bracket is omitted when there are no options.
 * RCB-52: a task (always no options) logs `owner task: <question>` instead.
 */
function askedLine(question: string, options: readonly DecisionOption[], kind?: 'task'): string {
  if (kind === 'task') return `owner task: ${question}`;
  const letters = options.length > 0 ? ` [${options.map((o) => o.letter).join('|')}]` : '';
  return `asked: ${question}${letters}`;
}

/**
 * RCB-107: the `## Decision` body-section counterpart of `askedLine` — same `asked:`/`owner task:`
 * wording, but carries each option's TEXT (not just its letter) as a continuation line, so the
 * body keeps what was offered even after a re-ask replaces the frontmatter `decision:` block.
 * `formatDecisionLine` (an alias of `formatNoteLine`) turns each `\n` here into a two-space
 * continuation, nesting the options under the one bullet.
 */
function askedDecisionText(
  question: string,
  options: readonly DecisionOption[],
  kind?: 'task',
): string {
  if (kind === 'task') return `owner task: ${question}`;
  return [`asked: ${question}`, ...options.map((o) => `- ${o.letter}: ${o.text}`)].join('\n');
}

/**
 * The label an answer is recorded under: just the letter for `## Log` (`decidedLine`), or
 * `<letter>: <option text>` for the `## Decision` body section (`decidedDecisionText`) — the one
 * place the two forms differ. Shared here so neither can drift from the other.
 */
function decidedBase(label: string | undefined, words: string | undefined, kind?: 'task'): string {
  if (kind === 'task') return words !== undefined ? `done — "${words}"` : 'done';
  return label !== undefined && words !== undefined
    ? `decided ${label} — "${words}"`
    : label !== undefined
      ? `decided ${label}`
      : `decided — "${words}"`;
}

/**
 * `decided <letter> — "<words>"` · `decided <letter>` · `decided — "<words>"` (no letter).
 * RCB-52: a task (never a letter) logs `done` or `done — "<words>"` instead.
 * RCB-69: when `decide` falls back to `defaultReturnTo` (the card was asked WHILE ALREADY in the
 * decision column, so there is no real `returnTo` to honor), `defaultedTo` names where it landed
 * and the line says so: `<base> → <col> (default; asked in-column)`.
 */
function decidedLine(
  letter: string | undefined,
  words: string | undefined,
  kind?: 'task',
  defaultedTo?: string,
): string {
  const base = decidedBase(letter, words, kind);
  return defaultedTo === undefined ? base : `${base} → ${defaultedTo} (default; asked in-column)`;
}

/**
 * RCB-107: the `## Decision` body-section counterpart of `decidedLine` — identical wording except
 * a lettered answer carries the option's TEXT after the letter (`decided A: yes`, not `decided A`);
 * never carries the `defaultedTo` move annotation, which is about where the card landed, not what
 * was decided.
 */
function decidedDecisionText(
  letter: string | undefined,
  words: string | undefined,
  options: readonly DecisionOption[],
  kind?: 'task',
): string {
  const label =
    letter === undefined
      ? undefined
      : `${letter}: ${options.find((o) => o.letter === letter)?.text ?? ''}`;
  return decidedBase(label, words, kind);
}

const decisionColumnOf = (config: BoardConfig | undefined) =>
  config?.columns.find((c) => c.decision === true);

/**
 * RCB-69 (owner 2026-09-19 20:4xZ, measured root cause FPJ-33): `decide` must ALWAYS move a card
 * OUT of a `decision: true` column — the column the card returns to when there is no real
 * `returnTo` to honor (asked while already sitting in the decision column, or a pre-fix/hand-edited
 * card whose `returnTo` is `null`, names the decision column itself, or names a column that no
 * longer exists). The first column AFTER the decision column, in board order, that is neither
 * `decision: true` nor `done: true` (`todo` on the default board); if none after it, the first
 * such column anywhere; `null` only when the board has no such column at all.
 */
function defaultReturnTo(config: BoardConfig): string | null {
  const cols = config.columns;
  const decisionIdx = cols.findIndex((c) => c.decision === true);
  for (let i = decisionIdx + 1; i < cols.length; i++) {
    const c = cols[i];
    if (c && c.decision !== true && c.done !== true) return c.id;
  }
  for (const c of cols) {
    if (c.decision !== true && c.done !== true) return c.id;
  }
  return null;
}

/**
 * Open a decision on a card, or replace one that is already open (`--replace`). Asking again on
 * a DECIDED card is not an error and needs no `--replace`: the old block is simply replaced, and
 * its `decided …` log line is already there from the previous `decide` call (locked decision 2).
 *
 * O11: when `config` has a `decision: true` column and the card is not already in it, the card
 * MOVES there first (via `moveCard`, so it gets the usual `moved <from> → decide` log line, WIP
 * warning and a `move`-shaped event) and the prior status is recorded as `decision.returnTo`.
 * Without such a column, nothing about status changes and `returnTo` stays `null` (badge only).
 * RCB-69/FPJ-33: when the card is already IN that column, status also stays put, but `returnTo`
 * is set to `defaultReturnTo(config)` rather than `null` — otherwise `decide` would have nowhere
 * real to send the card back to and it would sit decided in the owner's queue column.
 * RCB-107: the question and its options are also appended to the body's `## Decision` section
 * (a `question withdrawn` line first, on `--replace`), so the text survives the frontmatter
 * `decision:` block a later re-ask replaces.
 */
export function askDecision(card: Card, opts: AskDecisionOptions): AskDecisionResult {
  const question = opts.question;
  if (question.trim().length === 0) {
    return { ok: false, error: 'question must not be empty' };
  }
  const options = (opts.options ?? []).map((o) => ({ letter: o.letter, text: o.text }));
  if (opts.kind === 'task' && options.length > 0) {
    return { ok: false, error: 'a task has no options' };
  }
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
    body = appendDecisionLine(body, formatDecisionLine(ts, opts.actor, 'question withdrawn'));
  }

  // RCB-69: the new `decision` block is set on `working` BEFORE `moveCard` runs (not after, as
  // before) — otherwise guard 2 in `transitions.ts` sees a card with no `decision` at all (a
  // first ask) or a still-DECIDED old block (a re-ask) and reacts to its own move: a spurious
  // "no open ask" warning, or a wrongful refusal. Setting it first means `moveCard` always sees
  // the fresh, NOT-YET-decided decision that this very call is opening.
  const col = decisionColumnOf(opts.config);
  const willMove = Boolean(opts.config && col && card.status !== col.id);
  const returnTo = willMove
    ? card.status
    : opts.config && col
      ? // RCB-69/FPJ-33: asked WHILE ALREADY in the decision column — there is no prior status to
        // record, so `returnTo` gets the board's default landing column instead of `null`, and
        // `decide` (below) has somewhere real to send the card once it is answered.
        defaultReturnTo(opts.config)
      : null;

  const decision: Decision = {
    question,
    // Spread conditionally: a question object must have no `kind` key at all.
    ...(opts.kind === 'task' ? { kind: 'task' as const } : {}),
    options,
    askedBy: opts.actor,
    askedAt: ts,
    returnTo,
    chosen: null,
    words: null,
    decidedBy: null,
    decidedAt: null,
  };

  let working: Card = { ...card, body, decision };
  let warnings: string[] = [];
  let event: Event;

  if (willMove && opts.config && col) {
    const moveRes = moveCard(working, col.id, {
      actor: opts.actor,
      now: opts.now,
      config: opts.config,
      columnCounts: opts.columnCounts,
    });
    if (!moveRes.ok) return { ok: false, error: moveRes.error };
    working = moveRes.card;
    warnings = moveRes.warnings;
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

  const bodyWithLog = appendLogLine(
    working.body,
    formatLogLine(ts, opts.actor, askedLine(question, options, opts.kind)),
  );
  const next: Card = {
    ...working,
    updated: ts,
    body: appendDecisionLine(
      bodyWithLog,
      formatDecisionLine(ts, opts.actor, askedDecisionText(question, options, opts.kind)),
    ),
  };
  return { ok: true, card: next, event, warnings };
}

/**
 * Answer the open decision. Refuses an unknown letter (names the valid ones), refuses when
 * nothing is open, and requires a letter or `words` (or both) — a bare `decide` with neither is
 * not an answer.
 *
 * O11: when the decision recorded a `returnTo` column that still exists in `config`, the card
 * MOVES back there (via `moveCard`, same log/event shape as any move).
 *
 * RCB-69 (owner 2026-09-19 20:4xZ, FPJ-33): a decided card must never sit in a `decision: true`
 * column. When the card is currently IN that column and `returnTo` is `null` (asked while
 * already there — today's `askDecision`, or a pre-fix card), names the decision column itself, or
 * names a column that no longer exists, `decide` falls back to `defaultReturnTo` instead of
 * staying — that fallback is what "returnTo <x> missing; stayed" used to mean and no longer does;
 * only a card that is NOT in the decision column (and has no `returnTo`) is left untouched, the
 * `askDecision` "badge only" case.
 * RCB-107: the answer is also appended to the body's `## Decision` section, a lettered answer
 * carrying the option's TEXT (`decided A: yes`), not just its letter.
 */
export function decide(card: Card, opts: DecideOptions): DecideResult {
  const decision = card.decision;
  if (!decision || !needsDecision(card)) {
    return { ok: false, error: `no decision is open on ${card.id}` };
  }
  if (opts.letter === undefined && opts.words === undefined && decision.kind !== 'task') {
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
  const returnTo = decision.returnTo;

  // RCB-69: work out where (if anywhere) the card must land BEFORE building the `decided …` log
  // line, so a forced default can be named in that same line.
  const decisionColumn = opts.config ? decisionColumnOf(opts.config) : undefined;
  const inDecisionColumn = decisionColumn !== undefined && card.status === decisionColumn.id;
  const rawTarget =
    opts.config && returnTo !== null ? findColumn(opts.config, returnTo) : undefined;
  const needsDefault =
    inDecisionColumn &&
    (returnTo === null || rawTarget === undefined || returnTo === decisionColumn?.id);
  let target = rawTarget;
  let defaultedTo: string | undefined;
  if (opts.config && needsDefault) {
    const fallbackId = defaultReturnTo(opts.config);
    target = fallbackId !== null ? findColumn(opts.config, fallbackId) : undefined;
    defaultedTo = target?.id;
  }

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
    body: appendDecisionLine(
      appendLogLine(
        card.body,
        formatLogLine(
          ts,
          opts.actor,
          decidedLine(opts.letter, opts.words, decision.kind, defaultedTo),
        ),
      ),
      formatDecisionLine(
        ts,
        opts.actor,
        decidedDecisionText(opts.letter, opts.words, decision.options, decision.kind),
      ),
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

  if (opts.config && (returnTo !== null || inDecisionColumn)) {
    if (!target) {
      const reason = needsDefault ? 'no default column available' : `returnTo ${returnTo} missing`;
      working = {
        ...working,
        body: appendLogLine(working.body, formatLogLine(ts, opts.actor, `${reason}; stayed`)),
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
