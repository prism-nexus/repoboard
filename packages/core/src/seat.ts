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
  const body = text.trim().replace(/\n/g, '\n  ');
  return `- **${name}: ${status} ${stamp}.** ${body}`;
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

  return {
    name: input.name,
    seatsLine,
    ownBlock: input.ownBlock,
    coordinatorBlock,
    nextCard,
    nextCardReason,
    openDecisions,
    rig: input.rig ?? null,
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
