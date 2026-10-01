/**
 * P8.5 (plan §5 P8.5, §11 O9): `sync-issues <path>#<heading>` turns a README's `## Known issues`
 * list into cards without copying the entry's text (O5 again: the board is a VIEW). This module
 * is the pure half — no filesystem access (§0.5): the server reads the file, finds the section
 * with `refs.ts`'s `findHeadingSection` (the SAME function `resolveRef`'s `'heading'` case uses,
 * so the two agree on what "the section under a heading" is — species 6's lesson), and hands the
 * section TEXT here.
 *
 * Item rule (locked decision 2, guards C1's species-6 control): a list item whose FIRST LINE
 * begins at COLUMN 0 with `- **K<n>` (open) or `- ~~**K<n>` (struck = closed). A `- **K` line
 * indented even one space is prose, not an item — `- **K` appearing mid-sentence, or a `Closes
 * K<n>` sentence inside an open entry's continuation lines, is never mistaken for one because
 * neither starts a line at column 0 with that exact marker. `- ~~- **K` (the E1 near-miss: a
 * strike wrapped around a SECOND list marker) is reported as malformed, never as an item.
 */

import { appendLogLine, formatLogLine } from './log.js';
import { toIso } from './time.js';
import type { BoardConfig, Card, Event } from './types.js';

/** One issue item found in a section (open or struck). */
export interface IssueItem {
  n: number;
  /** `true` = open (`- **K<n>`); `false` = struck/closed (`- ~~**K<n>`). */
  open: boolean;
  /** The raw first line, byte-for-byte, for a caller that wants to show its source. */
  firstLine: string;
  /** `K<n> ` + the text after `**K<n>` up to the first `**`/`—`, trimmed, truncated at 100. */
  title: string;
}

export interface ParseIssuesResult {
  items: IssueItem[];
  /** Raw lines that looked like a near-miss (`- ~~- **K…`) — never treated as items. */
  malformed: string[];
}

const OPEN_ITEM = /^-[ \t]\*\*K(\d+)/;
const CLOSED_ITEM = /^-[ \t]~~\*\*K(\d+)/;
const MALFORMED_STRIKE = /^-[ \t]~~-[ \t]\*\*K/;

/**
 * The text after `**K<n>` on an item's first line, up to (not including) the first `**` or `—`,
 * with a leading run of `.`/whitespace stripped (`- **K1. A full sweep…` reads as `K1 A full
 * sweep…`, not `K1 . A full sweep…` or `K1. A full sweep…`) — the brief left this open; this is
 * the choice made, noted in the brief's own §7.
 */
function computeTitle(n: number, afterMarker: string): string {
  const starIdx = afterMarker.indexOf('**');
  const dashIdx = afterMarker.indexOf('—'); // —
  let cut = afterMarker.length;
  if (starIdx >= 0) cut = Math.min(cut, starIdx);
  if (dashIdx >= 0) cut = Math.min(cut, dashIdx);
  const text = afterMarker
    .slice(0, cut)
    .replace(/^[.\s]+/, '')
    .trim();
  const title = text.length > 0 ? `K${n} ${text}` : `K${n}`;
  return title.length > 100 ? title.slice(0, 100) : title;
}

/** Lines: `\n`/`\r\n`, no phantom trailing empty line — mirrors `refs.ts`'s `splitLines`. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Parse issue items out of the TEXT of one section (already cut to the heading's span by the
 * caller — `refs.ts`'s `findHeadingSection`, uncapped). Pure, never throws.
 */
export function parseIssueItems(sectionText: string): ParseIssuesResult {
  const items: IssueItem[] = [];
  const malformed: string[] = [];
  for (const line of splitLines(sectionText)) {
    if (MALFORMED_STRIKE.test(line)) {
      malformed.push(line);
      continue;
    }
    const closed = CLOSED_ITEM.exec(line);
    if (closed?.[1] !== undefined) {
      const n = Number.parseInt(closed[1], 10);
      items.push({
        n,
        open: false,
        firstLine: line,
        title: computeTitle(n, line.slice(closed[0].length)),
      });
      continue;
    }
    const open = OPEN_ITEM.exec(line);
    if (open?.[1] !== undefined) {
      const n = Number.parseInt(open[1], 10);
      items.push({
        n,
        open: true,
        firstLine: line,
        title: computeTitle(n, line.slice(open[0].length)),
      });
    }
    // Anything else — a non-K bullet, a blank line, a `Closes K<n>` sentence, prose, or a
    // `- **K` not at column 0 (impossible here: the regexes are anchored at the line start,
    // and each element of `splitLines` IS one whole line, so "column 0" and "line start" are
    // the same test) — is not an item and is silently skipped.
  }
  return { items, malformed };
}

/** The minimal shape `planSync` needs from an existing card. */
export interface PlanCard {
  id: string;
  status: string;
  refs?: string[];
}

export interface PlanCreate {
  n: number;
  title: string;
}

export interface PlanClose {
  cardId: string;
  n: number;
}

export interface PlanSyncOptions {
  /** The `<path>` half of `<path>#<heading>` — the ref key is `<path>@K<n>`. */
  path: string;
  /** Column new cards are created in. */
  status: string;
  /** Column id a struck/vanished item's card is moved to, when it is not already there. */
  doneColumn: string;
}

export interface PlanSyncResult {
  create: PlanCreate[];
  close: PlanClose[];
  unchanged: number;
}

/**
 * What `sync-issues` would do, computed against the CURRENT cards — never against a prior run's
 * memory (idempotent by construction, not by a saved list). A card "belongs" to item `K<n>` when
 * its `refs` contains exactly `<path>@K<n>` (locked decision 2); the first card found for a given
 * ref wins if more than one somehow carries it.
 */
export function planSync(
  items: readonly IssueItem[],
  cards: readonly PlanCard[],
  opts: PlanSyncOptions,
): PlanSyncResult {
  const cardByRef = new Map<string, PlanCard>();
  const refPrefix = `${opts.path}@K`;
  for (const c of cards) {
    for (const r of c.refs ?? []) {
      if (r.startsWith(refPrefix) && !cardByRef.has(r)) cardByRef.set(r, c);
    }
  }
  const refFor = (n: number) => `${refPrefix}${n}`;

  const create: PlanCreate[] = [];
  const close: PlanClose[] = [];
  let unchanged = 0;
  const seen = new Set<number>();

  for (const item of items) {
    seen.add(item.n);
    const existing = cardByRef.get(refFor(item.n));
    if (item.open) {
      if (existing) unchanged++;
      else create.push({ n: item.n, title: item.title });
    } else if (existing) {
      if (existing.status === opts.doneColumn) unchanged++;
      else close.push({ cardId: existing.id, n: item.n });
    } else {
      // Struck, but no card was ever filed for it — nothing to close.
      unchanged++;
    }
  }

  // Vanished: a card whose ref names a K<n> the section no longer lists at all (not open, not
  // struck — gone). Same treatment as struck: close it if it is not already done.
  for (const [ref, card] of cardByRef) {
    const n = Number.parseInt(ref.slice(refPrefix.length), 10);
    if (Number.isNaN(n) || seen.has(n)) continue;
    if (card.status === opts.doneColumn) unchanged++;
    else close.push({ cardId: card.id, n });
  }

  return { create, close, unchanged };
}

export interface CloseSyncedCardOptions {
  actor: string;
  now: Date;
  config: BoardConfig;
  /** The README (or other source) path, named in the log line so the owner sees WHY it moved. */
  path: string;
  columnCounts?: Record<string, number>;
}

export type CloseSyncedCardResult =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string };

/**
 * `sync-issues`'s own close: moves a card to the board's first `done: true` column, exactly like
 * `moveCard`, but with a log line naming the CAUSE (`synced: entry closed in <path>`) instead of
 * `moveCard`'s generic `moved <from> → <to>` — the owner should see WHY a card moved on its own,
 * not just that it did. Refuses when the board has no done column, or the card is already there
 * (matches `planSync`'s own "unchanged" — a caller should not call this in that case, but calling
 * it anyway costs nothing beyond a named error).
 */
export function closeSyncedCard(card: Card, opts: CloseSyncedCardOptions): CloseSyncedCardResult {
  const doneColumn = opts.config.columns.find((c) => c.done === true);
  if (!doneColumn) return { ok: false, error: 'board has no done: true column' };
  if (card.status === doneColumn.id) {
    return { ok: false, error: `card ${card.id} is already in "${doneColumn.id}"` };
  }
  const warnings: string[] = [];
  if (opts.columnCounts && doneColumn.wip !== undefined) {
    const current = opts.columnCounts[doneColumn.id] ?? 0;
    if (current + 1 > doneColumn.wip) {
      warnings.push(
        `WIP limit exceeded: "${doneColumn.id}" allows ${doneColumn.wip}, would have ${current + 1}`,
      );
    }
  }
  const ts = toIso(opts.now);
  const from = card.status;
  const event: Event = {
    ts,
    actor: opts.actor,
    type: 'move',
    cardId: card.id,
    from,
    to: doneColumn.id,
  };
  const next: Card = {
    ...card,
    status: doneColumn.id,
    updated: ts,
    body: appendLogLine(
      card.body,
      formatLogLine(ts, opts.actor, `synced: entry closed in ${opts.path}`),
    ),
  };
  return { ok: true, card: next, event, warnings };
}
