/**
 * RCB-68: phases + gates. THREE optional card fields make a multi-part plan a first-class board
 * object with no new card kind — `parent: <card id>` makes a card a STEP of that phase card,
 * `phase: PH.<n>` (a free short label, sorted naturally) marks which step, and `gate: <card id> |
 * "<sentence>"` names what blocks it. Pure, I/O-free (§0.5): one function per guarantee, and
 * none of them takes an argument that could weaken it — every surface (CLI, MCP, HTTP, web) asks
 * the SAME question through `blockedReason`, so "blocked" cannot mean two things in two places.
 *
 * Single level only: a step's own children are never rolled into its grandparent (`rollup` reads
 * `stepsOf(card.id, ...)` — one level down — not `stepsOf`'s own steps' steps), so a `parent`
 * cycle cannot loop a computation, only misrender one card's rollup.
 */
import { findColumn } from './board.js';
import { isDecided } from './card.js';
import { resolveCardRef, type WorkspaceBoardRef } from './card-ref.js';
import type { BoardConfig, Card } from './types.js';

/** `<PREFIX>-<n>`, e.g. `RCB-9` — what makes a `gate:` value a card reference rather than a
 * sentence. Anything else (including a card id in the WRONG shape) is read as a sentence.
 * RCB-161 slice 1: exported so `systems.ts` can validate an `unblocked_by` entry the same way. */
export const CARD_ID_SHAPE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export type GateState =
  | { kind: 'none' } // no gate: never blocked (an unconfigured rule is inert)
  | { kind: 'clear'; by: string } // card-id gate, that card done or decided: "RCB-9 (done)"
  | { kind: 'blocked'; reason: string };

/**
 * RCB-153 W4/W5-gate: one member board's facts, as `gateState` needs them to try resolving a
 * WORKSPACE card's `gate:` value against a card on ANOTHER board — raw facts only (`cards`,
 * `config`), never a caller's own blocked/clear verdict, so this function computes a member's
 * gate the exact same way it computes its own board's.
 */
export interface GateMemberFacts {
  key: string;
  prefix: string;
  cards: readonly Card[];
  config: BoardConfig;
}

/**
 * `card.gate`'s state, against `cards`/`config` (the whole board — a gate can name any card on
 * it, not just a sibling step). Absent gate → `none`. A gate naming a card on this board is
 * `clear` iff that card sits in a `done: true` column OR is decided (`isDecided`, which an owner
 * `--task`'s close counts too); otherwise `blocked`. A gate that LOOKS like a card id
 * (`CARD_ID_SHAPE`) but names no card on this board is `blocked`, never a silent clear — the safe
 * direction: an unknown gate must never look free. Anything else is read as a free-text sentence,
 * `blocked`, cleared by removing the field by hand — OR, RCB-105: a card that itself sits in a
 * `done: true` column reads its own gate as history, `clear` with `by: "<gate> — card done"`
 * (a gate naming an already-clear card keeps today's `by` unchanged, e.g. `"RCB-9 (done)"`).
 *
 * RCB-153 W4/W5: `members`, when given, is a WORKSPACE's opened member boards — a gate not found
 * on THIS board is then tried against them by the SAME prefix rule `resolveCardRef` gives a typed
 * ref (this board's own prefix wins first, so this can never override the plain "no such card on
 * THIS board" case above). `members` defaults to `[]`: every existing caller (a single board —
 * `rollup` here, `state`/`seat`/MCP/web elsewhere) passes none, so this whole branch is a no-op
 * for them and their output is byte-identical to before this card.
 */
export function gateState(
  card: Card,
  cards: readonly Card[],
  config: BoardConfig,
  members: readonly GateMemberFacts[] = [],
): GateState {
  const gate = card.gate;
  if (gate === undefined) return { kind: 'none' };
  const cardIsDone = findColumn(config, card.status)?.done === true;
  const target = cards.find((c) => c.id === gate);
  if (target) {
    const column = findColumn(config, target.status);
    if (column?.done === true || isDecided(target)) {
      return { kind: 'clear', by: `${target.id} (${target.status})` };
    }
  }
  if (cardIsDone) {
    return { kind: 'clear', by: `${gate} — card done` };
  }
  if (target) {
    return { kind: 'blocked', reason: `blocked on ${target.id} (${target.status})` };
  }
  if (members.length > 0 && CARD_ID_SHAPE.test(gate)) {
    const boards: WorkspaceBoardRef[] = [
      { key: null, prefix: config.prefix },
      ...members.map((m) => ({ key: m.key, prefix: m.prefix })),
    ];
    const resolved = resolveCardRef(gate, boards);
    if (resolved.ok && resolved.key !== null) {
      const member = members.find((m) => m.key === resolved.key);
      const memberTarget = member?.cards.find((c) => c.id === resolved.id);
      if (member && memberTarget) {
        const memberColumn = findColumn(member.config, memberTarget.status);
        if (memberColumn?.done === true || isDecided(memberTarget)) {
          return { kind: 'clear', by: `${memberTarget.id} (${memberTarget.status})` };
        }
        return {
          kind: 'blocked',
          reason: `blocked on ${memberTarget.id} (${memberTarget.status})`,
        };
      }
    }
  }
  if (CARD_ID_SHAPE.test(gate)) {
    return { kind: 'blocked', reason: `blocked on ${gate} (no such card)` };
  }
  return { kind: 'blocked', reason: `blocked: ${gate}` };
}

/** `null` when not blocked. THE one code path every surface asks. */
export function blockedReason(
  card: Card,
  cards: readonly Card[],
  config: BoardConfig,
  members: readonly GateMemberFacts[] = [],
): string | null {
  const state = gateState(card, cards, config, members);
  return state.kind === 'blocked' ? state.reason : null;
}

/** Natural order: `PH.2` sorts before `PH.10`. Phase-less cards sort last; ties break by id
 * (also natural, so `RCB-2` sorts before `RCB-10`). */
function comparePhase(a: Card, b: Card): number {
  if (a.phase === undefined && b.phase === undefined) return 0;
  if (a.phase === undefined) return 1;
  if (b.phase === undefined) return -1;
  return a.phase.localeCompare(b.phase, undefined, { numeric: true, sensitivity: 'base' });
}

function compareId(a: Card, b: Card): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
}

/** Children of `parentId`: natural phase order (`PH.2` < `PH.10`), phase-less last, then by id. */
export function stepsOf(parentId: string, cards: readonly Card[]): Card[] {
  return cards
    .filter((c) => c.parent === parentId)
    .slice()
    .sort((a, b) => comparePhase(a, b) || compareId(a, b));
}

/**
 * `null` when the card has no children — a plain card is not a phase card. `done` is a step in a
 * `done: true` column. `blockedOn` is `blockedReason` of the FIRST blocked step in `stepsOf`
 * order (single level: a step's own children are not consulted — see this file's header).
 *
 * RCB-154: `members`, when given, is forwarded to `blockedReason` unchanged — the same
 * workspace-member facts `gateState` resolves a gate against. Defaults to `[]`: every existing
 * caller (none of which knows about workspace members) keeps today's single-board behaviour.
 */
export function rollup(
  card: Card,
  cards: readonly Card[],
  config: BoardConfig,
  members: readonly GateMemberFacts[] = [],
): { total: number; done: number; blockedOn: string | null } | null {
  const steps = stepsOf(card.id, cards);
  if (steps.length === 0) return null;
  const done = steps.filter((s) => findColumn(config, s.status)?.done === true).length;
  let blockedOn: string | null = null;
  for (const step of steps) {
    const reason = blockedReason(step, cards, config, members);
    if (reason !== null) {
      blockedOn = reason;
      break;
    }
  }
  return { total: steps.length, done, blockedOn };
}

/** RCB-108: a "plan parent" is any card some other card names as `parent:` — it has at least one
 * `stepsOf` result. A parent is a container that shows its progress through `rollup`, not itself
 * a unit of work in its column, which is why `wipCount` treats it specially. */
export function isPlanParent(card: Card, cards: readonly Card[]): boolean {
  return stepsOf(card.id, cards).length > 0;
}

/**
 * RCB-108, the owner's flip (2026-09-22, PH.7 gap 6): a plan parent sitting in `doing` while its
 * OWN steps do the actual work should not itself count against `doing`'s WIP limit. Reversible —
 * flip this to `true` and `wipCount`/`wipCountsForMove` count parents like any other card, no
 * other code path to change.
 */
export const WIP_COUNTS_PARENTS = false;

/**
 * THE one WIP count. Every surface that needs "how many cards are in this column, for WIP
 * purposes" — `presence.ts`'s `wipBreaches`, `store.ts`'s move-time warning, the web column
 * header — asks this, never a raw `cards.filter(...).length`. Cards in `status`, minus plan
 * parents unless `WIP_COUNTS_PARENTS` is flipped on.
 */
export function wipCount(status: string, cards: readonly Card[]): number {
  let n = 0;
  for (const c of cards) {
    if (c.status !== status) continue;
    if (!WIP_COUNTS_PARENTS && isPlanParent(c, cards)) continue;
    n++;
  }
  return n;
}

/**
 * The move-time WIP warning's `columnCounts` (`transitions.ts`'s `moveCard`/`askDecision`/
 * `decide`, all fed from `store.ts`): `undefined` when `card` itself is an uncounted plan parent —
 * it adds 0 to whatever column it lands in, so it can never breach a limit, and `moveCard` skips
 * the WIP check entirely when `columnCounts` is absent. Otherwise, `wipCount` per status over
 * every OTHER card (the mover excluded, as `store.ts` has always done) — but each card's
 * plan-parent status is still judged against `cards`, the FULL board, not the reduced set, so
 * excluding the mover from the count can never flip some other card's parent-ness.
 */
export function wipCountsForMove(
  card: Card,
  cards: readonly Card[],
): Record<string, number> | undefined {
  if (!WIP_COUNTS_PARENTS && isPlanParent(card, cards)) return undefined;
  const counts: Record<string, number> = {};
  for (const c of cards) {
    if (c.id === card.id) continue;
    if (!WIP_COUNTS_PARENTS && isPlanParent(c, cards)) continue;
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }
  return counts;
}
