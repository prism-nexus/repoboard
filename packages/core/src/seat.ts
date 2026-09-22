/**
 * RCB-48: `repoboard seat <name>` — the cold-start bundle, packaging RCB-47's rule (STATE.md →
 * your own seat's last block → the coordinator's → `card list --status todo` → open decisions)
 * as one read instead of the three-file ritual. Pure, I/O-free (§0.5): the store gathers
 * `SeatBundleInput`, this file turns it into a `SeatBundle` and renders it.
 */
import { needsDecision } from './decisions.js';
import { formatLogBlock, type LogBlock } from './repolog.js';
import { ownerQueueLine } from './state.js';
import { toIso } from './time.js';
import type { Card } from './types.js';

export interface SeatBundleInput {
  /** As typed on the command line — never normalized, so the render echoes what the seat asked. */
  name: string;
  now: Date;
  /** `StateDoc.sections.seats`, `null` when there is no STATE.md. */
  seatsSection: string | null;
  ownBlock: { date: string; block: LogBlock } | null;
  /** `null` when `name` IS the coordinator — there is no "the coordinator's block" for it. */
  coordinatorBlock: { date: string; block: LogBlock } | null;
  cards: readonly Card[];
  /** RCB-83: `.repoboard/local/RIG.md`'s text, or `null`/absent when there is none. */
  rig?: string | null;
}

/** Which rule picked `nextCard`, so the render (and a reader) can say so instead of guessing. */
export type NextCardReason = 'assigned' | 'priority' | 'first-todo' | null;

/**
 * RCB-57 (B1): rank for the priority fallback — high wins, unset loses. A plain object (not a
 * `Map`) so `card.priority` (possibly absent) indexes it directly; `?? 3` covers the absent case
 * without a branch. The ONLY place this order is encoded — `pickNextCard` never re-sorts by id,
 * date, or anything else, so this map is the one thing a control has to break to change the rule.
 */
const PRIORITY_RANK: Record<Card['priority'] & string, number> = { high: 0, medium: 1, low: 2 };

function priorityRank(c: Card): number {
  return c.priority !== undefined ? PRIORITY_RANK[c.priority] : 3;
}

export interface SeatBundle {
  name: string;
  /** The matching SEATS bullet, whole bullet incl. continuation lines; `null` on no match. */
  seatsLine: string | null;
  ownBlock: { date: string; block: LogBlock } | null;
  coordinatorBlock: { date: string; block: LogBlock } | null;
  nextCard: Card | null;
  nextCardReason: NextCardReason;
  /** `needsDecision(c)`, list order — reused from `decisions.ts`, never re-derived. */
  openDecisions: Card[];
  /** RCB-83: `.repoboard/local/RIG.md`'s text, `null` when there is none. */
  rig: string | null;
  /** RCB-89: `parseSeatFields(seatsLine)` when `seatsLine` is non-null, else `null`. */
  inFlight: string | null;
  /** RCB-89: `parseSeatFields(seatsLine)` when `seatsLine` is non-null, else `null`. */
  owes: string | null;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The coordinator's seat name is `coordinator`, compared case-insensitively — the ONE place that
 * decides it, so `seatBundle` (nulling `coordinatorBlock`) and `renderSeatBundle` (omitting the
 * section) can never disagree about which seat is the coordinator.
 */
function isCoordinatorSeat(name: string): boolean {
  return name.trim().toLowerCase() === 'coordinator';
}

const LEADING_BOLD = /^\*\*(.+?)\*\*/;

/**
 * A bullet's LABEL: the leading `**…**` span of its first line when present (a bullet is almost
 * always written `- **<seat name…>**: …`), else the first line up to the first `:` (so a plain
 * `- ops: watching` still has a label). This is what a human means by "the ops bullet" — the
 * seat's own name at the HEAD of its own bullet — as opposed to any bullet whose prose merely
 * mentions another seat's name in passing.
 */
function bulletLabel(firstLine: string): string {
  const content = firstLine.replace(/^- /, '');
  const bold = LEADING_BOLD.exec(content);
  if (bold?.[1] !== undefined) return bold[1];
  const colon = content.indexOf(':');
  return colon === -1 ? content : content.slice(0, colon);
}

/**
 * Line-index spans (end exclusive) of `lines`' top-level bullets — a line starting with `- `, plus
 * every following line up to the next `- ` line as its continuation. Lines before the first bullet
 * (if any) belong to no span, same as the old inline splitter this replaces. Shared by
 * `findSeatLine` and `replaceSeatBullet` (RCB-58) so both split a SEATS section identically —
 * `bulletSpans` is the one place that decides where a bullet starts and ends.
 */
function bulletSpans(lines: readonly string[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- /.test(lines[i] ?? '')) {
      if (start !== -1) spans.push({ start, end: i });
      start = i;
    }
  }
  if (start !== -1) spans.push({ start, end: lines.length });
  return spans;
}

/**
 * The seat's own bullet among `bullets` (each already split into its lines) — two-pass match,
 * case-insensitive whole word (`\b`), against `name`:
 *
 * 1. The bullet whose LABEL (see `bulletLabel`) contains `name` — this is the seat's own bullet.
 * 2. Only when no bullet's label matches at all: the old rule, `name` anywhere in the first line.
 *
 * Pass 1 exists because a bullet's PROSE routinely mentions another seat by name — RCB-48's own
 * dogfood (2026-09-18 21:07Z) found `repoboard seat builder` returning the COORDINATOR's bullet
 * on this repo's real SEATS section, because the coordinator's bullet says "the builder's RCB-47
 * card move" and "verify each builder sha" ahead of the actual `- **repoboard builder (its own
 * terminal)**…` bullet later in the section — a whole-word match on the first line alone cannot
 * tell "the builder bullet" from "a bullet about the builder". The label pass can, because it
 * only looks at the name the bullet is FOR, not everything it says.
 *
 * `builder` matches `- **repoboard builder (its own terminal…)**`; `ordinator` matches nothing
 * even though `coordinator` is a substring, because the match is word-bounded. Returns the
 * bullet's index in `bullets`, or -1 when nothing matches in either pass — including an empty
 * `bullets` array, which a placeholder section (no `- ` line) always produces. RCB-58: this is the
 * ONE private helper `findSeatLine` and `replaceSeatBullet` both call, so the two can never
 * disagree about which bullet is "mine".
 */
function locateSeatBullet(bullets: readonly (readonly string[])[], name: string): number {
  const wanted = name.trim();
  if (wanted.length === 0) return -1;
  const wordRe = new RegExp(`\\b${escapeRegExp(wanted)}\\b`, 'i');

  for (let i = 0; i < bullets.length; i++) {
    if (wordRe.test(bulletLabel(bullets[i]?.[0] ?? ''))) return i;
  }
  for (let i = 0; i < bullets.length; i++) {
    if (wordRe.test(bullets[i]?.[0] ?? '')) return i;
  }
  return -1;
}

/**
 * Split `seatsSection` into top-level bullets and return the one that is `name`'s own, whole text
 * (continuation lines kept), trimmed — or `null` when nothing matches, including a placeholder
 * section, which has no `- ` line to begin with. See `locateSeatBullet` for the match rule.
 */
export function findSeatLine(seatsSection: string, name: string): string | null {
  const lines = seatsSection.split('\n');
  const spans = bulletSpans(lines);
  const bullets = spans.map((s) => lines.slice(s.start, s.end));
  const idx = locateSeatBullet(bullets, name);
  return idx === -1 ? null : (bullets[idx] ?? []).join('\n').trim();
}

/**
 * RCB-58: replace ONLY `name`'s own SEATS bullet — found the SAME way `findSeatLine` finds it
 * (`locateSeatBullet`, so the two can never disagree) — with `bullet`, preserving every other byte
 * of the section (lines before, other bullets, blank lines between). `bullet` is passed in already
 * formatted (see `formatSeatBullet`); this function does no formatting of its own.
 *
 * Not found: `bullet` is appended as the last bullet (after a trailing newline if the section
 * lacks one). A section with no `- ` line at all (the placeholder, or anything else) becomes just
 * `bullet` — there is nothing to append after.
 *
 * Pure, no I/O, no clock.
 */
export function replaceSeatBullet(seatsSection: string, name: string, bullet: string): string {
  const lines = seatsSection.split('\n');
  const spans = bulletSpans(lines);
  if (spans.length === 0) return bullet;

  const bullets = spans.map((s) => lines.slice(s.start, s.end));
  const idx = locateSeatBullet(bullets, name);
  if (idx !== -1) {
    const span = spans[idx];
    if (span) {
      const before = lines.slice(0, span.start);
      const after = lines.slice(span.end);
      return [...before, ...bullet.split('\n'), ...after].join('\n');
    }
  }

  const needsNewline = !seatsSection.endsWith('\n');
  return needsNewline ? `${seatsSection}\n${bullet}` : `${seatsSection}${bullet}`;
}

/**
 * RCB-58/RCB-88: a bullet's BODY, formatted exactly one way — trimmed, with internal newlines
 * turned into continuation lines (each `\n` becomes `\n  `, two spaces, so a ≤3-line bullet's
 * second/third lines stay inside it). `formatSeatBullet` and `rewriteSeatBulletBody` both call
 * this ONE function so the body rule cannot drift between the two.
 */
function formatSeatBulletBody(text: string): string {
  return text.trim().replace(/\n/g, '\n  ');
}

/**
 * RCB-58: format one SEATS bullet — `- **<name>: <UP|DOWN> <YYYY-MM-DD HH:MMZ>.** <text>`, `text`
 * trimmed with internal newlines turned into continuation lines (each `\n` becomes `\n  `, two
 * spaces, so a ≤3-line bullet's second/third lines stay inside it). `HH:MM` is UTC from `now`,
 * minutes exact — this is the restamp itself, not a redacted display form; a seat's own log block
 * carries the redacted stamp if it wants one. The label `**<name>: …**` is exactly what
 * `findSeatLine`'s label pass matches on the next call (see the round-trip test), so a bullet
 * written by this function is always found again by it.
 */
export function formatSeatBullet(
  name: string,
  status: 'UP' | 'DOWN',
  text: string,
  now: Date,
): string {
  const iso = toIso(now);
  const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  const body = formatSeatBulletBody(text);
  return `- **${name}: ${status} ${stamp}.** ${body}`;
}

/**
 * RCB-88: rewrite a seat's own bullet's BODY, keeping its first line's label, status and stamp
 * BYTE-FOR-BYTE — the raw `SEAT_BULLET_RE` captures, not reformatted or reparsed, so even a stamp
 * that fails to parse (`18:0xZ`) survives verbatim. `null` when the first line is not a seat
 * bullet at all (same shape check as `parseSeatStamp`) — there is nothing to keep. Pure, no I/O,
 * no clock: this function never restamps.
 */
export function rewriteSeatBulletBody(
  bullet: string,
  text: string,
): { bullet: string; status: 'UP' | 'DOWN'; stamp: string } | null {
  const firstLine = bullet.split('\n')[0] ?? '';
  const m = SEAT_BULLET_RE.exec(firstLine);
  if (!m) return null;
  const label = m[1] ?? '';
  const status = m[2] as 'UP' | 'DOWN';
  const date = m[3] ?? '';
  const time = m[4] ?? '';
  const body = formatSeatBulletBody(text);
  return {
    bullet: `- **${label}: ${status} ${date} ${time}Z.** ${body}`,
    status,
    stamp: `${date} ${time}Z`,
  };
}

/**
 * RCB-87: matches the first line of a bullet written by `formatSeatBullet` —
 * `- **<name>: <UP|DOWN> <YYYY-MM-DD> <HH:MM>Z.**` — the trailing `.` and closing `**` optional
 * (hand-written fpj bullets omit them), and the `<HH:MM>` half tolerated even when it is not all
 * digits (`18:0xZ`), since that shape has to be recognised as "a stamp that fails to parse", not
 * "not a seat bullet at all". No `$`/end anchor: everything after the stamp (the bullet's prose)
 * is irrelevant to the match.
 */
const SEAT_BULLET_RE = /^-\s+\*\*([^*:]+):\s+(UP|DOWN)\s+(\S+)\s+(\S+?)Z\.?\*{0,2}/;
const SEAT_STAMP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEAT_STAMP_TIME_RE = /^\d{2}:\d{2}$/;

/**
 * RCB-87: pure — parses a SEATS bullet's own status and stamp, first line only (continuation
 * lines are the bullet's prose, never the stamp). `null` when the first line is not a seat bullet
 * at all (`SEAT_BULLET_RE` does not match — e.g. a plain `- Owner tasks elsewhere: …` bullet).
 * `at` is `null` specifically when the bullet IS a seat bullet but its date or time half has a
 * non-digit or is missing — a parse failure on the stamp, not on the bullet shape.
 */
export function parseSeatStamp(bullet: string): { status: 'UP' | 'DOWN'; at: Date | null } | null {
  const firstLine = bullet.split('\n')[0] ?? '';
  const m = SEAT_BULLET_RE.exec(firstLine);
  if (!m) return null;
  const status = m[2] as 'UP' | 'DOWN';
  const date = m[3] ?? '';
  const time = m[4] ?? '';
  if (!SEAT_STAMP_DATE_RE.test(date) || !SEAT_STAMP_TIME_RE.test(time)) {
    return { status, at: null };
  }
  const at = new Date(`${date}T${time}:00.000Z`);
  return { status, at: Number.isNaN(at.getTime()) ? null : at };
}

/**
 * RCB-87: pure — non-null iff `bullet` (the seat's own standing SEATS bullet, or `null` when it
 * has none) parses as `UP` with a stamp, AND that stamp is within `windowMinutes` of `now`. A
 * future `at` (clock skew) counts as a conflict too — `now - at` is then negative, still `<=` the
 * window — same rule `presence.ts`'s `isActive` uses for a card's `updated`. `stamp` is rendered
 * `YYYY-MM-DD HH:MMZ` from the PARSED `at` (not the raw bullet text), so it is always well-formed
 * even though the caller only reaches this function when parsing already succeeded.
 */
export function seatUpConflict(
  bullet: string | null,
  now: Date,
  windowMinutes: number,
): { stamp: string; minutesAgo: number } | null {
  if (bullet === null) return null;
  const parsed = parseSeatStamp(bullet);
  if (parsed?.status !== 'UP' || parsed.at === null) return null;
  const diffMs = now.getTime() - parsed.at.getTime();
  if (diffMs > windowMinutes * 60_000) return null;
  const iso = toIso(parsed.at);
  return {
    stamp: `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`,
    minutesAgo: Math.round(diffMs / 60_000),
  };
}

/**
 * RCB-89: the two structured fields a stand-down bullet is asked to carry, key case-insensitive,
 * value trimmed. Shared by `parseSeatFields` (reading a stored bullet) and `checkDownFields`
 * (validating raw `--down` text before it becomes one) — the ONE pair of regexes either function
 * may use, so the two can never disagree about what counts as an `in-flight:`/`owes:` line.
 */
const IN_FLIGHT_LINE_RE = /^\s*in-flight:\s*(.*)$/im;
const OWES_LINE_RE = /^\s*owes:\s*(.*)$/im;

/**
 * RCB-89: `bullet`'s `in-flight:`/`owes:` lines — scanned across every line of the bullet,
 * including the FIRST line's tail (the prose right after the `.**` stamp close, on the same
 * physical line as the label/status/stamp) and every continuation line (with its 2-space
 * indent). `null` when the key never appears at all; `''` when it appears with nothing after the
 * colon — present but empty is not the same as missing. Pure, no I/O.
 */
export function parseSeatFields(bullet: string): { inFlight: string | null; owes: string | null } {
  const lines = bullet.split('\n');
  const firstLine = lines[0] ?? '';
  const m = SEAT_BULLET_RE.exec(firstLine);
  const tail = m ? firstLine.slice(m[0].length) : firstLine;
  const scanText = [tail, ...lines.slice(1)].join('\n');
  const inFlightMatch = IN_FLIGHT_LINE_RE.exec(scanText);
  const owesMatch = OWES_LINE_RE.exec(scanText);
  return {
    inFlight: inFlightMatch ? (inFlightMatch[1] ?? '').trim() : null,
    owes: owesMatch ? (owesMatch[1] ?? '').trim() : null,
  };
}

/**
 * RCB-89: guard for `seat --down` — `null` (ok) only when `text` (the raw `--down` argument, not
 * yet a formatted bullet) carries BOTH an `in-flight:` line and an `owes:` line (same regexes as
 * `parseSeatFields`); else the exact error a caller should surface verbatim. One function, no
 * argument that could weaken it — a caller cannot ask it to check only one of the two lines.
 */
export function checkDownFields(text: string): string | null {
  if (IN_FLIGHT_LINE_RE.test(text) && OWES_LINE_RE.test(text)) return null;
  return (
    'seat --down needs an "in-flight:" line (subagent ids, Monitor ids, worktree, lock holder — ' +
    'or none) and an "owes:" line'
  );
}

export interface SeatRow {
  name: string;
  status: 'UP' | 'DOWN';
  stamp: string;
  inFlight: string | null;
}

/**
 * RCB-89: `repoboard seat list` — one row per SEATS bullet whose first line `parseSeatStamp`
 * accepts (a non-seat bullet, e.g. `- Owner tasks elsewhere: …`, is skipped, never an error).
 * Splits bullets with `bulletSpans` (the one place that decides where a bullet starts and ends —
 * no second splitter here), reads the name with `bulletLabel` (its bold span, then up to that
 * span's own first `:`, trimmed — the label of a seat bullet is `<name>: <STATUS> <stamp>.`, so
 * the colon inside the label itself has to be cut too), and the raw `<date> <time>Z` text off
 * `SEAT_BULLET_RE`'s own captures (not the parsed `Date`) so a stamp that fails to parse
 * (`18:0xZ`) still survives into the row.
 */
export function listSeats(seatsSection: string): SeatRow[] {
  const lines = seatsSection.split('\n');
  const spans = bulletSpans(lines);
  const rows: SeatRow[] = [];
  for (const span of spans) {
    const bulletLines = lines.slice(span.start, span.end);
    const bulletText = bulletLines.join('\n');
    const parsed = parseSeatStamp(bulletText);
    if (!parsed) continue;
    const firstLine = bulletLines[0] ?? '';
    const m = SEAT_BULLET_RE.exec(firstLine);
    const label = bulletLabel(firstLine);
    const colonIdx = label.indexOf(':');
    const name = (colonIdx === -1 ? label : label.slice(0, colonIdx)).trim();
    const stamp = m ? `${m[3]} ${m[4]}Z` : '';
    const { inFlight } = parseSeatFields(bulletText);
    rows.push({ name, status: parsed.status, stamp, inFlight });
  }
  return rows;
}

/**
 * RCB-89: render `listSeats`' rows as a fixed-column table, `NAME  STATUS  STAMP  IN-FLIGHT`
 * header first, each column padded to its widest value (last column unpadded, trailing
 * whitespace trimmed — same convention as `formatTable` in `cli.ts`). `inFlight` prints as `-`
 * when `null`. No rows at all: one placeholder line, never a header with nothing under it.
 */
export function renderSeatList(rows: SeatRow[]): string {
  if (rows.length === 0) return '(no seat bullets in SEATS)\n';
  const header = ['NAME', 'STATUS', 'STAMP', 'IN-FLIGHT'];
  const data = rows.map((r) => [r.name, r.status, r.stamp, r.inFlight ?? '-']);
  const allRows = [header, ...data];
  const widths = header.map((_, i) => Math.max(...allRows.map((row) => (row[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return `${[line(header), ...data.map(line)].join('\n')}\n`;
}

/**
 * The cold-start bundle for one seat: its SEATS line, its own last log block, the coordinator's,
 * its next todo card, and the open decisions. A read only — nothing here writes or throws; a
 * cold seat on a fresh board (no STATE.md, no log history, no cards) is the normal case, and
 * every field is simply the placeholder value that produces.
 */
export function seatBundle(input: SeatBundleInput): SeatBundle {
  const seatsLine =
    input.seatsSection !== null ? findSeatLine(input.seatsSection, input.name) : null;

  const coordinatorBlock = isCoordinatorSeat(input.name) ? null : input.coordinatorBlock;

  const wantedAssignee = input.name.trim().toLowerCase();
  const todoCards = input.cards.filter((c) => c.status === 'todo');
  const assigned = todoCards.find((c) => (c.assignee ?? '').toLowerCase() === wantedAssignee);
  /**
   * RCB-57 (B1): among todo cards assigned to NO ONE (a card assigned to another seat is never
   * this seat's fallback), rank by priority — high, medium, low, unset, in that order — with a
   * stable sort so list order breaks every tie, including the all-unset case (which makes this
   * subsume the old "first todo in list order" rule exactly).
   */
  const unassignedTodo = todoCards.filter((c) => (c.assignee ?? '').trim() === '');
  const byPriority = [...unassignedTodo].sort((a, b) => priorityRank(a) - priorityRank(b));
  const anyPrioritised = unassignedTodo.some((c) => c.priority !== undefined);
  const picked = byPriority[0] ?? null;

  let nextCard: Card | null = null;
  let nextCardReason: NextCardReason = null;
  if (assigned !== undefined) {
    nextCard = assigned;
    nextCardReason = 'assigned';
  } else if (picked !== null) {
    nextCard = picked;
    nextCardReason = anyPrioritised ? 'priority' : 'first-todo';
  }

  const openDecisions = input.cards.filter((c) => needsDecision(c));

  const fields = seatsLine !== null ? parseSeatFields(seatsLine) : { inFlight: null, owes: null };

  return {
    name: input.name,
    seatsLine,
    ownBlock: input.ownBlock,
    coordinatorBlock,
    nextCard,
    nextCardReason,
    openDecisions,
    rig: input.rig ?? null,
    inFlight: fields.inFlight,
    owes: fields.owes,
  };
}

/**
 * Markdown, sections in the cold-start ORDER, each with a fixed `## ` heading so a reader can
 * `sed -n '/^## /,/^## /p'` it out. A missing part prints a one-line placeholder, never an empty
 * section. The COORDINATOR block section is omitted entirely when `b.name` IS the coordinator —
 * there is nothing to place there.
 */
export function renderSeatBundle(b: SeatBundle, now: Date): string {
  const isCoordinator = isCoordinatorSeat(b.name);
  const lines: string[] = [];

  lines.push(`# seat ${b.name} — ${toIso(now)}`, '');
  lines.push('## In flight / owes');
  lines.push(`in-flight: ${b.inFlight ?? '(none recorded)'}`);
  lines.push(`owes: ${b.owes ?? '(none recorded)'}`, '');

  lines.push('## SEATS line');
  lines.push(b.seatsLine ?? `(no SEATS line mentions ${b.name})`, '');

  lines.push('## Rig (.repoboard/local/RIG.md)');
  lines.push(b.rig ?? '(no .repoboard/local/RIG.md — run repoboard local init)', '');

  lines.push(`## Last block — ${b.name.toUpperCase()}`);
  lines.push(b.ownBlock ? formatLogBlock(b.ownBlock.block) : `(no log block for ${b.name})`, '');

  if (!isCoordinator) {
    lines.push('## Last block — COORDINATOR');
    lines.push(
      b.coordinatorBlock
        ? formatLogBlock(b.coordinatorBlock.block)
        : '(no log block for coordinator)',
      '',
    );
  }

  lines.push('## Next card');
  if (b.nextCard) {
    lines.push(`${b.nextCard.id}  ${b.nextCard.status}  ${b.nextCard.title}`);
    lines.push(
      b.nextCardReason === 'assigned'
        ? `(assigned to ${b.name})`
        : b.nextCardReason === 'priority'
          ? `(first ${b.nextCard.priority}-priority todo)`
          : '(first todo; nothing assigned, nothing prioritised)',
    );
  } else {
    lines.push('(no todo card)');
  }
  lines.push('');

  lines.push('## Open decisions');
  lines.push(
    b.openDecisions.length > 0 ? b.openDecisions.map(ownerQueueLine).join('\n') : '(none)',
  );

  return `${lines.join('\n')}\n`;
}
