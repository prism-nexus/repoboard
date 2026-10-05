/**
 * RCB-218: the pure half of the Board's new top (status line, Seats, Landed, Owner queue) — no
 * React, no clock of its own (`now` is passed in), so every rule here is testable on its own and
 * the components only lay the answers out.
 *
 * SEATS has ONE parser: core's (`seatRowPayloads`, which `seat list` and the server's `seats`
 * payload both read). The web used to re-parse STATE.md with its own regex (`seats.ts`) and lost
 * the holder pane, liveness, in-flight and owes; `seatRowsFor` is now only a choice between what
 * the server sent and core's parse of the same section.
 */
import {
  type BoardConfig,
  type Card,
  type Event,
  findColumn,
  needsDecision,
  seatNameKey,
  seatRowPayloads,
} from '@repoboard/core';
import { relTime, shortActor, shortTime } from '../time.js';
import type { SeatRowPayload, StatePayload } from '../wire.js';
import { tickerVerb } from './Ticker.jsx';

/** What a seat's pill and block draw: `up` ● alive, `down` ○, `dead` ⚠ (says UP, its holder's
 * process is gone), `unknown` ? (says UP, liveness cannot be told — or nothing records a holder). */
export type SeatKind = 'up' | 'down' | 'dead' | 'unknown';

export const SEAT_SYMBOL: Record<SeatKind, string> = {
  up: '●',
  down: '○',
  dead: '⚠',
  unknown: '?',
};

/**
 * DOWN is down. An UP seat is `up` only when its holder was probed and is alive; `dead` when the
 * probe says so; EVERYTHING else — another machine, no pid, no start time, and also no recorded
 * holder at all (`live: null`) — is `unknown`, because nothing measured it. A missing answer is
 * never drawn as a confident ●.
 */
export function seatKind(row: SeatRowPayload): SeatKind {
  if (row.status === 'DOWN') return 'down';
  if (row.live === 'dead') return 'dead';
  if (row.live === 'alive') return 'up';
  return 'unknown';
}

/**
 * The server's `seats` when it sent them (an empty list is an answer: no seats), else core's parse
 * of STATE.md's SEATS section (a server that predates the payload), else nothing — no STATE.md.
 * The fallback carries no holder, so every `tag`/`live` is `null`: the pills read `?`, not ●.
 */
export function seatRowsFor(
  seats: SeatRowPayload[] | null,
  state: StatePayload | null,
): SeatRowPayload[] {
  if (seats !== null) return seats;
  return state?.sections ? seatRowPayloads(state.sections.seats) : [];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `09:58Z` for a time on `now`'s UTC day, `Oct 4 23:39Z` for an earlier one; `''` when `iso` does
 * not parse. */
export function whenLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const sameDay = d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  const hhmm = shortTime(iso);
  return sameDay ? hhmm : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hhmm}`;
}

/** `12m`, `3h`, `4d`, `just now` — `relTime` without its trailing ` ago`, for a pill. `''` when
 * `iso` does not parse. */
export function ageOf(iso: string | null, now: number): string {
  if (iso === null) return '';
  return relTime(iso, now).replace(/ ago$/, '');
}

// ---- Doing cards and seats ----------------------------------------------------------------------

/** The cards in an `active` column (Doing). A board with no active column has none — inert. */
export function doingCards(cards: readonly Card[], config: BoardConfig): Card[] {
  const active = new Set(config.columns.filter((c) => c.active === true).map((c) => c.id));
  return cards.filter((c) => active.has(c.status));
}

/** A card's assignee as a seat key: `claude/builder` -> `builder`, folded the way seat names are
 * compared (core's `seatNameKey`). `null` when the card has no assignee. */
export function assigneeKey(card: Card): string | null {
  return card.assignee ? seatNameKey(shortActor(card.assignee)) : null;
}

/** The Doing cards assigned to `seat` (by name, case-insensitive). */
export function cardsOfSeat(doing: readonly Card[], seat: SeatRowPayload): Card[] {
  const key = seatNameKey(seat.name);
  return doing.filter((c) => assigneeKey(c) === key);
}

/**
 * The Doing cards no UP seat holds. With NO seats at all there is nothing that could hold or fail
 * to hold a card, so the answer is `[]` — a board that does not use seats must not read as "every
 * card unclaimed".
 */
export function unclaimedDoing(doing: readonly Card[], seats: readonly SeatRowPayload[]): Card[] {
  if (seats.length === 0) return [];
  const holders = new Set(seats.filter((s) => s.status === 'UP').map((s) => seatNameKey(s.name)));
  return doing.filter((c) => {
    const key = assigneeKey(c);
    return key === null || !holders.has(key);
  });
}

/** `seat` events of `seatName`, newest first, at most `n` (default 2). The store keeps the last
 * 50 events, so an older seat change may not be here — the panel shows what it has seen. */
export function lastSeatEvents(events: readonly Event[], seatName: string, n = 2): Event[] {
  const key = seatNameKey(seatName);
  return events
    .filter((e) => e.type === 'seat' && seatNameKey(e.actor) === key)
    .slice(-n)
    .reverse();
}

// ---- The status line's "last:" ------------------------------------------------------------------

/** The newest event the page has seen — the last one, which is what the Ticker also calls latest. */
export function newestEvent(events: readonly Event[]): Event | null {
  return events[events.length - 1] ?? null;
}

/**
 * What `last:` says after the actor, worded with the Ticker's `tickerVerb` so the two never
 * disagree about what an event type is called: `moved RCB-9 → done`, `took the seat · A7B2`,
 * `took test-lock`.
 */
export function lastEventText(e: Event): string {
  const verb = tickerVerb(e);
  const card = e.cardId ? ` ${e.cardId}` : '';
  switch (e.type) {
    case 'move':
      return `${verb}${card} → ${e.to}`;
    case 'create':
      return `${verb}${card} in ${e.to}`;
    case 'decide':
      return `${verb}${card}${e.letter ? ` → ${e.letter}` : ''}`;
    case 'lease':
      return `${verb} ${e.resource ?? ''}`.trimEnd();
    case 'window':
      return `${verb} ${e.to}${e.resource ? ` on ${e.resource}` : ''}`;
    case 'columns':
      return `${verb} → ${e.to}`;
    case 'seat':
      return e.resource ? `${verb} · ${e.resource}` : verb;
    default:
      return `${verb}${card}`;
  }
}

// ---- Owner queue and Landed ---------------------------------------------------------------------

/** The cards that need a decision, in board order — the ONE list the status pill, the panel and
 * its badge all read, so they cannot disagree about N or about which card is "first". */
export function ownerQueueCards(cards: readonly Card[]): Card[] {
  return cards.filter((c) => needsDecision(c));
}

/** A column's display name (`title`, else its id); an unconfigured status is its own name. */
export function columnLabel(config: BoardConfig, status: string): string {
  const col = findColumn(config, status);
  return col?.title ?? status;
}

/** Is `status` a `done: true` column? An unconfigured status is not. */
export function isDoneColumn(config: BoardConfig, status: string): boolean {
  return findColumn(config, status)?.done === true;
}

/** `true` only for an http(s) base — a landing's `web` comes off the wire and ends up in an `href`. */
export function isWebBase(web: string | null): web is string {
  return web !== null && /^https?:\/\//i.test(web);
}
