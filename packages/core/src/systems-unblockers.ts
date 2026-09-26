/**
 * RCB-161 slice 2 (moved from `packages/server/src/cli.ts`, unchanged): one `unblocked_by` id's
 * resolution against a board's cards — `card: null` when the id names no card here (printed as
 * "(not on this board)" by `formatUnblockerLines` in cli.ts, or by the Flow view); otherwise its
 * title/status, plus EITHER `decision` (an open ask, letters and text) OR `nextStep` (the first
 * `stepsOf` child not in a done column with a clear gate) — never both, and both `null` when the
 * card has neither. `formatUnblockerLines` (the CLI's text rendering) stays in cli.ts; only the
 * data shape and its resolution move here so the Flow view (`systems.ts`'s consumer, PH.2-PH.4)
 * can call the SAME function the CLI does, never a second implementation.
 */
import { findColumn } from './board.js';
import { needsDecision } from './decisions.js';
import { blockedReason, stepsOf } from './phases.js';
import type { BoardConfig, Card, DecisionOption } from './types.js';

export interface UnblockerInfo {
  id: string;
  card: { title: string; status: string } | null;
  decision: { question: string; options: DecisionOption[] } | null;
  nextStep: { id: string; title: string } | null;
}

export function unblockerInfo(
  id: string,
  cards: readonly Card[],
  config: BoardConfig,
): UnblockerInfo {
  const card = cards.find((c) => c.id === id);
  if (!card) return { id, card: null, decision: null, nextStep: null };
  const cardInfo = { title: card.title, status: card.status };
  if (needsDecision(card)) {
    const d = card.decision;
    return {
      id,
      card: cardInfo,
      decision: d ? { question: d.question, options: d.options } : null,
      nextStep: null,
    };
  }
  const step = stepsOf(id, cards).find(
    (s) => findColumn(config, s.status)?.done !== true && blockedReason(s, cards, config) === null,
  );
  return {
    id,
    card: cardInfo,
    decision: null,
    nextStep: step ? { id: step.id, title: step.title } : null,
  };
}
