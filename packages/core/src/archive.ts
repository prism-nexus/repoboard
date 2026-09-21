/**
 * P8.5 (plan §5 P8.5, §11 O9): `repoboard archive` moves `done` cards older than a cutoff out of
 * `.repoboard/cards/` into `.repoboard/archive/` — the same shape a closed README K-entry leaves
 * the running list (struck in place, moved out once someone reads it): the board should not keep
 * growing forever with cards nobody needs day to day. This module is the pure half: which cards
 * qualify, and the `--older-than` spec. The server does the actual file move (`git mv` or
 * `rename`) — a filesystem act, not something core (§0.5) can do.
 */
import type { BoardConfig } from './types.js';

/** The minimal shape `selectArchivable` needs from a card. */
export interface ArchivableCard {
  id: string;
  status: string;
  updated: string;
}

/**
 * Every card in a `done: true` column whose `updated` is STRICTLY older than `cutoff` — a card
 * updated exactly AT the cutoff stays (boundary test: `updated === cutoff` is not archived yet).
 * Order is not significant; the server keeps `cards`' own order.
 */
export function selectArchivable(
  cards: readonly ArchivableCard[],
  config: BoardConfig,
  cutoff: Date,
): string[] {
  const doneIds = new Set(config.columns.filter((c) => c.done === true).map((c) => c.id));
  const cutoffMs = cutoff.getTime();
  return cards
    .filter((c) => doneIds.has(c.status) && Date.parse(c.updated) < cutoffMs)
    .map((c) => c.id);
}

const DURATION = /^(\d+)(d|h|m)$/;
const MS_PER_UNIT: Record<'d' | 'h' | 'm', number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

export type OlderThanResult = { ok: true; cutoff: Date } | { ok: false; error: string };

/**
 * `--older-than`: a duration (`14d`, `2h`, `90m`) subtracted from `now`, or an absolute ISO-8601
 * cutoff taken as given. Pure (no `Date.now()`), like `leases.ts`'s `resolveTimeSpec` — which this
 * deliberately does NOT reuse, because that parser's `+90m` is an OFFSET INTO THE FUTURE from now
 * (a lease's `--until`), while `--older-than` means "this far INTO THE PAST" — the same syntax
 * would silently invert if the two were shared without a sign.
 */
export function resolveOlderThan(spec: string, now: Date): OlderThanResult {
  const m = DURATION.exec(spec);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const amount = Number.parseInt(m[1], 10);
    const unitMs = MS_PER_UNIT[m[2] as 'd' | 'h' | 'm'];
    return { ok: true, cutoff: new Date(now.getTime() - amount * unitMs) };
  }
  const parsed = Date.parse(spec);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: `"${spec}" is not a duration (14d, 2h, 90m) or an ISO-8601 datetime`,
    };
  }
  return { ok: true, cutoff: new Date(parsed) };
}
