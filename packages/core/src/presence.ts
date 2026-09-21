import { findColumn } from './board.js';
import { needsDecision } from './decisions.js';
import type { BoardConfig, Card } from './types.js';

/**
 * D8: a card is "active" when its column has `active: true` AND its `updated` timestamp is
 * within `activeWindowMinutes` of `now`. A future `updated` (clock skew) counts as active.
 */
export function isActive(card: Card, config: BoardConfig, now: Date): boolean {
  const column = findColumn(config, card.status);
  if (!column?.active) return false;
  const updated = Date.parse(card.updated);
  if (Number.isNaN(updated)) return false;
  return now.getTime() - updated <= config.activeWindowMinutes * 60_000;
}

/** Curated, friendly, and all render as a single glyph in common fonts. */
export const AVATAR_EMOJI: readonly string[] = [
  '🦊',
  '🐼',
  '🐸',
  '🦉',
  '🐙',
  '🦄',
  '🐝',
  '🦋',
  '🐢',
  '🐧',
  '🦁',
  '🐨',
  '🐯',
  '🦒',
  '🦓',
  '🐳',
  '🐬',
  '🦈',
  '🦜',
  '🦩',
  '🐲',
  '🦖',
  '🍄',
  '🌵',
  '🌻',
  '🍉',
  '🍓',
  '🥑',
  '🍩',
  '🧁',
  '⭐',
  '🌈',
  '🔥',
  '⚡',
  '🎈',
  '🎨',
  '🎸',
  '🚀',
  '🛸',
  '🧭',
];

/** 12 distinct hues, saturated enough to read as an outline on light and dark grounds. */
export const AVATAR_COLORS: readonly string[] = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#469990',
  '#dcbeff',
  '#9a6324',
  '#ffe119',
];

/** FNV-1a 32-bit. Small, stable, and good enough to spread short strings. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Avatar {
  emoji: string;
  color: string;
}

/** Deterministic: the same assignee string always gets the same emoji and color (D8). */
export function avatarFor(assignee: string): Avatar {
  const h = fnv1a(assignee);
  // Use different bit ranges so emoji and color do not vary in lockstep.
  const emoji = AVATAR_EMOJI[h % AVATAR_EMOJI.length] ?? '🙂';
  const color = AVATAR_COLORS[(h >>> 8) % AVATAR_COLORS.length] ?? '#888888';
  return { emoji, color };
}

export interface WipBreach {
  column: string;
  count: number;
  wip: number;
}

export interface BoardSummary {
  /** Every configured column (0 when empty), plus any status seen on a card that is not configured. */
  perColumn: Record<string, number>;
  active: Card[];
  wipBreaches: WipBreach[];
  /** P8.1: cards with an open decision (`needsDecision`), total and per column. */
  needsDecision: number;
  needsDecisionByColumn: Record<string, number>;
}

export function computeBoardSummary(cards: Card[], config: BoardConfig, now: Date): BoardSummary {
  const perColumn: Record<string, number> = {};
  for (const col of config.columns) perColumn[col.id] = 0;
  for (const card of cards) perColumn[card.status] = (perColumn[card.status] ?? 0) + 1;

  const active = cards.filter((c) => isActive(c, config, now));

  const wipBreaches: WipBreach[] = [];
  for (const col of config.columns) {
    const count = perColumn[col.id] ?? 0;
    if (col.wip !== undefined && count > col.wip) {
      wipBreaches.push({ column: col.id, count, wip: col.wip });
    }
  }

  const needsDecisionByColumn: Record<string, number> = {};
  let needsDecisionTotal = 0;
  for (const card of cards) {
    if (!needsDecision(card)) continue;
    needsDecisionTotal++;
    needsDecisionByColumn[card.status] = (needsDecisionByColumn[card.status] ?? 0) + 1;
  }

  return {
    perColumn,
    active,
    wipBreaches,
    needsDecision: needsDecisionTotal,
    needsDecisionByColumn,
  };
}
