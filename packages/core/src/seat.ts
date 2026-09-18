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
}

/** Which rule picked `nextCard`, so the render (and a reader) can say so instead of guessing. */
export type NextCardReason = 'assigned' | 'first-todo' | null;

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
 * Split `seatsSection` into top-level bullets — a line starting with `- `, plus every following
 * line up to the next `- ` line as its continuation. Two-pass match, case-insensitive whole word
 * (`\b`), against `name`:
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
 * bullet's full text (continuation lines kept), trimmed. `null` when nothing matches in either
 * pass — including a placeholder section, which has no `- ` line to begin with.
 */
export function findSeatLine(seatsSection: string, name: string): string | null {
  const wanted = name.trim();
  if (wanted.length === 0) return null;
  const wordRe = new RegExp(`\\b${escapeRegExp(wanted)}\\b`, 'i');

  const bullets: string[][] = [];
  let current: string[] | null = null;
  for (const line of seatsSection.split('\n')) {
    if (/^- /.test(line)) {
      current = [line];
      bullets.push(current);
    } else if (current) {
      current.push(line);
    }
  }

  for (const bullet of bullets) {
    const firstLine = bullet[0] ?? '';
    if (wordRe.test(bulletLabel(firstLine))) return bullet.join('\n').trim();
  }

  for (const bullet of bullets) {
    const firstLine = bullet[0] ?? '';
    if (wordRe.test(firstLine)) return bullet.join('\n').trim();
  }
  return null;
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
  const firstTodo = todoCards[0] ?? null;
  let nextCard: Card | null = null;
  let nextCardReason: NextCardReason = null;
  if (assigned !== undefined) {
    nextCard = assigned;
    nextCardReason = 'assigned';
  } else if (firstTodo !== null) {
    nextCard = firstTodo;
    nextCardReason = 'first-todo';
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
        : '(first todo; nothing assigned)',
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
