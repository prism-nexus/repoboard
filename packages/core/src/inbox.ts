/**
 * RCB-230: `repoboard inbox <seat>` — what other seats addressed to a seat in the log
 * ("TO BUILDER ACME-283: …") that the seat has not ACKed. Seats address each other inside log
 * blocks and nothing listed what was still open, so a finding hung for hours, often because the
 * seat it went to was DOWN. Pure and I/O-free (§0.5): the store hands in the parsed days, the
 * SEATS section and the clock.
 */
import type { DatedLogBlocks } from './repolog.js';
import { listSeats, seatNameKey, zonedLogMs } from './seat.js';

export interface InboxItem {
  /** The file date of the block that holds the address. */
  date: string;
  /** The block's `ts`, verbatim (RCB-54: not guaranteed to parse). */
  ts: string;
  /** The author's leading word, UPPERCASED. */
  from: string;
  /** The addressee's canonical name, UPPERCASED. */
  to: string;
  /** `${cardPrefix}-\d+` ids on the address line, in order, deduplicated. */
  cardIds: string[];
  /** The address line, trimmed. */
  line: string;
}

export interface InboxInput {
  seat: string;
  days: readonly DatedLogBlocks[];
  /** Every seat name the addressee tokens may resolve to (SEATS rows plus block authors). */
  knownSeats: readonly string[];
  /** Card id prefix, e.g. `ACME` — what makes `ACME-12` a card id. */
  cardPrefix: string;
  /** Epoch ms: a block older than this is out of the window. */
  sinceMs: number;
}

/** The window `check` and `repoboard inbox` both default to: an address at 23:50Z must still show at 00:10Z. */
export const INBOX_DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The shortest token that may stand for a seat by prefix (`COORD` → `COORDINATOR`). */
const MIN_PREFIX_LEN = 4;

/**
 * `TO ` (case-sensitive, on a word boundary) and then the addressee list: `SEAT( PANE)?( / SEAT( PANE)?)*`,
 * PANE being four hex digits. Group 1 is the whole list.
 */
const ADDRESS_RE =
  /\bTO[ \t]+([A-Z][A-Z0-9_-]*(?:[ \t]+[0-9A-F]{4}(?![\w-]))?(?:[ \t]*\/[ \t]*[A-Z][A-Z0-9_-]*(?:[ \t]+[0-9A-F]{4}(?![\w-]))?)*)/g;

/** An OWES field's first line: first word `OWES`/`owes:` after any indent or a `- ` bullet. */
const OWES_LINE_RE = /^\s*(?:-\s+)?(?:OWES\b|owes:)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A seat name as it is COMPARED: any `[repo] ` prefix dropped, whitespace and case folded
 * (`seatNameKey`), then the LEADING word — the same rule `lastBlockFor` reads a block's seat by,
 * so `BUILDER A11E` and `builder` are one seat. `COORDINATOR/SEARCH` has no whitespace, so it is
 * its own leading word.
 */
function leadKey(name: string): string {
  const bare = name.replace(/^\s*\[[^\]]*\]\s*/, '');
  return seatNameKey(bare).split(' ', 1)[0] ?? '';
}

/** The UTC `HH:MM` of a block's `ts`: from the moment when it parses, else its first `HH:MM`. */
function utcHm(ts: string): string | null {
  const ms = zonedLogMs(ts);
  if (ms !== null) return new Date(ms).toISOString().slice(11, 16);
  return /(\d{2}:\d{2})/.exec(ts)?.[1] ?? null;
}

interface FlatBlock {
  date: string;
  ts: string;
  /** Leading word, lower-case. */
  key: string;
  /** The lines to scan, OWES lines already removed. */
  lines: string[];
  ms: number | null;
}

/**
 * The block's lines minus its OWES fields: the line whose first word is `OWES`/`owes:` and every
 * following line that starts with whitespace. `owes: Result TO COORDINATOR ACME-42` states what a
 * seat is waiting on, it does not address anyone. The heading's title counts as a line unless the
 * text already repeats it (`formatLogBlock`'s own shape does).
 */
function scanLines(title: string, text: string): string[] {
  const out: string[] = [];
  let inOwes = false;
  for (const line of text.split('\n')) {
    if (OWES_LINE_RE.test(line)) {
      inOwes = true;
      continue;
    }
    if (inOwes && /^\s/.test(line) && line.trim().length > 0) continue;
    inOwes = false;
    out.push(line);
  }
  const t = title.trim();
  if (t.length > 0 && !out.some((l) => l.trim() === t)) out.unshift(t);
  return out;
}

/**
 * `unackedAddresses`: the open addresses to `input.seat`, oldest first.
 *
 * Blocks run in (file date, index in file) order and are NEVER re-sorted by `ts` — a hand-written
 * `ts` may not parse. A line is an address to the seat when `\bTO ` is followed by an addressee
 * list that resolves to it: a token is a known seat when it equals the seat's leading word, or is a
 * prefix (at least 4 characters) of exactly one known seat — so `COORD` is COORDINATOR and never
 * BOARD-COORDINATOR; an unresolved token is ignored. Not an address: a line in an OWES field; text
 * after the list that starts with `none` or `ACK` (card ids between the list and it are skipped,
 * so `TO COORDINATOR ACME-383: ACK …` is an acknowledgement, not a new demand); the author's own seat.
 *
 * An address is ACKed by a LATER block of the addressee with `\bACK\b` on a line: every card id
 * and `HH:MMZ` after the ACK on that line counts as acked. Acked when all its card ids are; with
 * no ids, when its block's UTC `HH:MM` is. A block is in the window when its `ts` parses to at or
 * after `sinceMs`; one whose `ts` does not parse counts when its file date is not before the
 * since date. The window limits which ADDRESSES are listed, never which ACKs are read.
 */
export function unackedAddresses(input: InboxInput): InboxItem[] {
  const want = leadKey(input.seat);
  if (want.length === 0) return [];
  const known = new Set<string>([want]);
  for (const s of input.knownSeats) {
    const k = leadKey(s);
    if (k.length > 0) known.add(k);
  }
  const resolve = (token: string): string | null => {
    const t = token.toLowerCase();
    if (known.has(t)) return t;
    if (t.length < MIN_PREFIX_LEN) return null;
    const hits = [...known].filter((k) => k.startsWith(t));
    return hits.length === 1 ? (hits[0] ?? null) : null;
  };

  const prefix = input.cardPrefix.trim();
  const idSource = prefix.length > 0 ? `${escapeRe(prefix)}-\\d+` : null;
  const idsOf = (s: string): string[] =>
    idSource === null ? [] : [...new Set(s.match(new RegExp(idSource, 'g')) ?? [])];
  const leadingIds = idSource === null ? null : new RegExp(`^${idSource}`);

  // Date order, then file order; the sort is stable, so two files with one date keep caller order.
  const days = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const flat: FlatBlock[] = [];
  for (const day of days) {
    for (const b of day.blocks) {
      flat.push({
        date: day.date,
        ts: b.ts,
        key: leadKey(b.seat),
        lines: scanLines(b.title, b.text),
        ms: zonedLogMs(b.ts),
      });
    }
  }

  // What the addressee ACKed, and where: one entry per block of theirs that holds an ACK.
  const acks: { at: number; ids: Set<string>; times: Set<string> }[] = [];
  flat.forEach((b, at) => {
    if (b.key !== want) return;
    const ids = new Set<string>();
    const times = new Set<string>();
    for (const line of b.lines) {
      const m = /\bACK\b/.exec(line);
      if (!m) continue;
      const after = line.slice(m.index + m[0].length);
      for (const id of idsOf(after)) ids.add(id);
      for (const t of after.matchAll(/(\d{2}:\d{2})Z/g)) if (t[1] !== undefined) times.add(t[1]);
    }
    if (ids.size > 0 || times.size > 0) acks.push({ at, ids, times });
  });

  const sinceDate = new Date(input.sinceMs).toISOString().slice(0, 10);
  const items: InboxItem[] = [];
  flat.forEach((b, at) => {
    if (b.key === want) return; // (c) the block's own seat
    const inWindow = b.ms !== null ? b.ms >= input.sinceMs : b.date >= sinceDate;
    if (!inWindow) return;
    for (const line of b.lines) {
      if (!addressesSeat(line, want, resolve, leadingIds)) continue;
      const cardIds = idsOf(line);
      const later = acks.filter((a) => a.at > at);
      const hm = utcHm(b.ts);
      const acked =
        cardIds.length > 0
          ? cardIds.every((id) => later.some((a) => a.ids.has(id)))
          : hm !== null && later.some((a) => a.times.has(hm));
      if (acked) continue;
      items.push({
        date: b.date,
        ts: b.ts,
        from: b.key.toUpperCase(),
        to: want.toUpperCase(),
        cardIds,
        line: line.trim(),
      });
    }
  });
  return items;
}

/** True when `line` holds an address — `\bTO <list>` not followed by `none`/`ACK` — resolving to `want`. */
function addressesSeat(
  line: string,
  want: string,
  resolve: (token: string) => string | null,
  leadingIds: RegExp | null,
): boolean {
  for (const m of line.matchAll(ADDRESS_RE)) {
    const list = m[1] ?? '';
    const tokens = list.split('/').map((s) => s.trim().split(/\s+/, 1)[0] ?? '');
    if (!tokens.some((t) => resolve(t) === want)) continue;
    if (isNoneOrAck(line.slice(m.index + m[0].length), leadingIds)) continue;
    return true;
  }
  return false;
}

/** Text after an addressee list that opens with `none` or `ACK`, skipping separators and card ids. */
function isNoneOrAck(rest: string, leadingIds: RegExp | null): boolean {
  let s = rest;
  for (;;) {
    s = s.replace(/^[\s:,;()]+/, '');
    const id = leadingIds?.exec(s);
    if (!id) break;
    s = s.slice(id[0].length);
  }
  return /^(?:ACK\b|[Nn]one\b)/.test(s);
}

/** One DOWN seat's open addresses — what `check`'s `address-to-down-seat` names. */
export interface DownSeatAddresses {
  seat: string;
  count: number;
  oldestTs: string;
  oldestFrom: string;
}

/**
 * RCB-230: for each SEATS row that is DOWN, its unacked addresses since `now` − 48 h
 * (`INBOX_DEFAULT_WINDOW_MS`) — only the seats with at least one. `state.ts` cannot import
 * `seat.ts` (`seat.ts` imports it), so the caller computes this here and `CheckInput` carries it.
 */
export function downSeatAddresses(input: {
  seatsSection: string | null;
  days: readonly DatedLogBlocks[];
  cardPrefix: string;
  now: Date;
}): DownSeatAddresses[] {
  if (input.seatsSection === null) return [];
  const rows = listSeats(input.seatsSection);
  const authors = input.days.flatMap((d) => d.blocks.map((b) => b.seat));
  const knownSeats = [...rows.map((r) => r.name), ...authors];
  const sinceMs = input.now.getTime() - INBOX_DEFAULT_WINDOW_MS;
  const out: DownSeatAddresses[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.status !== 'DOWN') continue;
    // One seat on two boards is two rows, one inbox: say it once.
    const key = leadKey(row.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const items = unackedAddresses({
      seat: row.name,
      days: input.days,
      knownSeats,
      cardPrefix: input.cardPrefix,
      sinceMs,
    });
    const oldest = items[0];
    if (oldest === undefined) continue;
    out.push({
      seat: row.name.trim(),
      count: items.length,
      oldestTs: oldest.ts,
      oldestFrom: oldest.from,
    });
  }
  return out;
}
