/**
 * RCB-146: the two card-list calculations the CLI and MCP each did their own copy of —
 * `ownerQueue` (the open-decision rows `state`/`get_state` print) and `filterCards` (`card list`'s
 * filter set, now shared with MCP `list_cards` instead of MCP re-deriving a narrower one with
 * `full: true`). One function per calculation; both surfaces call the same one.
 */
import {
  type BoardConfig,
  blockedReason,
  type Card,
  type DecisionOption,
  findColumn,
  needsDecision,
  type Size,
  stepsOf,
} from '@repoboard/core';

/** The row shape `state`/`get_state` print under OWNER QUEUE. */
export interface OwnerQueueRow {
  id: string;
  question: string;
  options: DecisionOption[];
}

/** Cards with an OPEN decision, in board order — the owner's queue. Takes the WHOLE board (not
 * a pre-filtered list): filtering by `needsDecision` is this function's job, not its caller's. */
export function ownerQueue(cards: readonly Card[]): OwnerQueueRow[] {
  return cards
    .filter((c) => needsDecision(c))
    .map((c) => ({
      id: c.id,
      question: c.decision?.question ?? '',
      options: c.decision?.options ?? [],
    }));
}

export interface CardFilterInput {
  status?: string;
  assignee?: string;
  label?: string;
  size?: Size;
  needsDecision?: boolean;
  parent?: string;
  unblocked?: boolean;
}

/** id ascending, numeric part first (RCB-<n>), same tiebreak as the table before this card. */
function idNumber(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m?.[1] ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * `cmdCardList`'s filter, lifted verbatim (RCB-104/RCB-67/RCB-68 plus RCB-146's assignee/label,
 * carried over unchanged from MCP's own `list_cards`). `parent` narrows to that phase card's steps
 * in `stepsOf` phase order — never re-sorted; with no `parent`, the result is id order, same as
 * today. `all` (not the filtered set) backs `blockedReason`/`unblocked`: a gate may point outside
 * the filtered rows. An empty filter returns every card — inert, never nothing.
 *
 * Throws a plain `Error` (never a CLI `UserError` — this module has no CLI dependency): `unknown
 * card "<id>"` for a `parent` naming no card, `unblocked requires parent` for `unblocked` with no
 * `parent`. Each caller decides how to surface that: `cmdCardList` already refuses the
 * `unblocked`-without-`parent` case itself, with its own `--flag`-worded message, before this
 * function is ever called for it; MCP `list_cards` has no such pre-check, so its callers see this
 * function's own wording.
 */
export function filterCards(all: readonly Card[], config: BoardConfig, f: CardFilterInput): Card[] {
  if (f.unblocked && f.parent === undefined) {
    throw new Error('unblocked requires parent');
  }
  const { status, assignee, label, size, parent } = f;
  let cards: Card[];
  if (parent !== undefined) {
    if (!all.some((c) => c.id === parent)) throw new Error(`unknown card "${parent}"`);
    cards = stepsOf(parent, all); // phase order — never re-sorted below
  } else {
    cards = all.slice();
  }
  if (status !== undefined) cards = cards.filter((c) => c.status === status);
  if (assignee !== undefined) cards = cards.filter((c) => c.assignee === assignee);
  if (label !== undefined) cards = cards.filter((c) => (c.labels ?? []).includes(label));
  if (size !== undefined) cards = cards.filter((c) => c.size === size);
  if (f.needsDecision) cards = cards.filter((c) => needsDecision(c));
  if (f.unblocked) {
    cards = cards.filter(
      (c) => findColumn(config, c.status)?.done !== true && blockedReason(c, all, config) === null,
    );
  }
  if (parent === undefined) {
    cards = cards.slice().sort((a, b) => idNumber(a.id) - idNumber(b.id) || (a.id < b.id ? -1 : 1));
  }
  return cards;
}
