/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/STATE.md` — one page, rewritten in place, never
 * appended (contrast `repolog.ts`). Fixed H2 sections in order: LIVE, LAST LANDINGS, OWNER QUEUE,
 * SEATS. OWNER QUEUE is GENERATED on every read from cards that need a decision (P8.1) — the file
 * on disk keeps a one-line placeholder under that heading and never stores real queue text, so a
 * write here can never bake in a snapshot of decisions that goes stale the moment another one is
 * answered. `checkFindings` (locked decision 4) lives here too: it is the pure half of
 * `repoboard check`, taking already-gathered facts (a parsed STATE, parsed+stat'd logs, the
 * cards, the board config, the leases doc, and `now`) and returning findings — no filesystem
 * access, so it is exactly as testable as everything else in this package (§0.5).
 */
import { findColumn } from './board.js';
import { needsDecision } from './decisions.js';
import { holdsLiveLease, staleLeases } from './leases.js';
import { isActive } from './presence.js';
import type { LogBlock } from './repolog.js';
import { toIso } from './time.js';
import type { BoardConfig, Card, LeasesDoc } from './types.js';

export interface StateSections {
  live: string;
  lastLandings: string;
  seats: string;
}

export interface StateDoc {
  /** ISO-8601, from the stamp line. Who/when the page was last REWRITTEN, not read. */
  stamp: string;
  actor: string;
  sections: StateSections;
}

export type StateParseResult = { ok: true; doc: StateDoc } | { ok: false; error: string };

/** A freshly scaffolded STATE.md's section bodies (`init --practices`, locked decision 3). */
export const SECTION_PLACEHOLDER = '_(nothing recorded yet)_';
/** What the FILE keeps under OWNER QUEUE — the generated content never touches disk. */
export const OWNER_QUEUE_PLACEHOLDER = '_(generated from open decisions)_';

const STAMP_LINE = /^\*\*Written (\S+) by (.+)\.\*\*\s*$/m;
const HEADINGS = ['## LIVE', '## LAST LANDINGS', '## OWNER QUEUE', '## SEATS'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse `.repoboard/STATE.md`. Never throws. Requires the stamp line and all four headings in
 * order; OWNER QUEUE's own on-disk content is read but discarded — it is never part of
 * `StateSections` because a caller must never mistake it for something to preserve or edit.
 */
export function parseState(text: string): StateParseResult {
  const stampMatch = STAMP_LINE.exec(text);
  if (!stampMatch) {
    return {
      ok: false,
      error: 'STATE.md is missing the stamp line "**Written <ISO> by <actor>.**"',
    };
  }
  const positions: number[] = [];
  for (const heading of HEADINGS) {
    const re = new RegExp(`^${escapeRegExp(heading)}[ \\t]*$`, 'm');
    const m = re.exec(text);
    if (!m || m.index === undefined) {
      return { ok: false, error: `STATE.md is missing the "${heading}" section` };
    }
    positions.push(m.index);
  }
  for (let i = 1; i < positions.length; i++) {
    const cur = positions[i];
    const prev = positions[i - 1];
    if (cur === undefined || prev === undefined || cur <= prev) {
      return {
        ok: false,
        error:
          'STATE.md sections are out of order (expected LIVE, LAST LANDINGS, OWNER QUEUE, SEATS)',
      };
    }
  }
  const sectionText = (i: number): string => {
    const headingStart = positions[i] ?? 0;
    const nl = text.indexOf('\n', headingStart);
    const contentStart = nl === -1 ? text.length : nl + 1;
    const end = positions[i + 1] ?? text.length;
    return text.slice(contentStart, end).trim();
  };
  const doc: StateDoc = {
    stamp: stampMatch[1] ?? '',
    actor: stampMatch[2] ?? '',
    sections: {
      live: sectionText(0),
      lastLandings: sectionText(1),
      // index 2 is OWNER QUEUE — its content is intentionally not read into StateSections.
      seats: sectionText(3),
    },
  };
  return { ok: true, doc };
}

/** `RCB-40 · <question> · [A B]` (locked decision 1) — the letters are omitted when there are none. */
export function ownerQueueLine(card: Card): string {
  const d = card.decision;
  const letters =
    d && d.options.length > 0 ? ` · [${d.options.map((o) => o.letter).join(' ')}]` : '';
  return `${card.id} · ${d?.question ?? ''}${letters}`;
}

/** The OWNER QUEUE section's DISPLAY content: one line per card that needs a decision. */
export function renderOwnerQueue(cards: readonly Card[]): string {
  const open = cards.filter((c) => needsDecision(c));
  if (open.length === 0) return OWNER_QUEUE_PLACEHOLDER;
  return open.map(ownerQueueLine).join('\n');
}

function renderTemplate(
  sections: StateSections,
  ownerQueueBody: string,
  opts: { now: Date; actor: string },
): string {
  return `${[
    '# STATE',
    '',
    `**Written ${toIso(opts.now)} by ${opts.actor}.**`,
    '',
    '## LIVE',
    '',
    sections.live,
    '',
    '## LAST LANDINGS',
    '',
    sections.lastLandings,
    '',
    '## OWNER QUEUE',
    '',
    ownerQueueBody,
    '',
    '## SEATS',
    '',
    sections.seats,
  ].join('\n')}\n`;
}

/**
 * The DISPLAY rendering — `repoboard state`, `GET /api/state`: OWNER QUEUE is generated fresh
 * from `openDecisions` every time. Pass the doc's own recorded `stamp`/`actor` as `now`/`actor`
 * to show the page as last WRITTEN (a read must never look like a rewrite); pass the real clock
 * only when this call IS the rewrite (see `setStateSection` below, and the store's `init`).
 */
export function renderState(
  sections: StateSections,
  openDecisions: readonly Card[],
  opts: { now: Date; actor: string },
): string {
  return renderTemplate(sections, renderOwnerQueue(openDecisions), opts);
}

/** The ON-DISK rendering: OWNER QUEUE is always the placeholder, never generated content. */
function renderStateFile(sections: StateSections, opts: { now: Date; actor: string }): string {
  return renderTemplate(sections, OWNER_QUEUE_PLACEHOLDER, opts);
}

/** A freshly scaffolded STATE.md (`init --practices`, locked decision 3): every section a placeholder. */
export function initialStateText(opts: { now: Date; actor: string }): string {
  const sections: StateSections = {
    live: SECTION_PLACEHOLDER,
    lastLandings: SECTION_PLACEHOLDER,
    seats: SECTION_PLACEHOLDER,
  };
  return renderStateFile(sections, opts);
}

export type StateSectionName = 'live' | 'lastLandings' | 'seats';

export type SetStateSectionResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Replace one section's body and restamp line 3 — the only write. OWNER QUEUE and every other
 * section's rendered bytes are untouched (round-trip through the same canonical `renderStateFile`
 * both took, so an unchanged section serializes identically before and after).
 */
export function setStateSection(
  text: string,
  section: StateSectionName,
  body: string,
  opts: { now: Date; actor: string },
): SetStateSectionResult {
  const parsed = parseState(text);
  if (!parsed.ok) return parsed;
  const sections: StateSections = { ...parsed.doc.sections, [section]: body.trim() };
  return { ok: true, text: renderStateFile(sections, opts) };
}

// ---- check (locked decision 4) -----------------------------------------------------------

export type FindingLevel = 'error' | 'warning' | 'info';

export interface Finding {
  kind:
    | 'stale-state'
    | 'active-without-lease'
    | 'stale-lease'
    | 'needs-decision'
    | 'cost-over-budget';
  level: FindingLevel;
  message: string;
}

/** One daily log file's facts, already read and stat'd by the caller (core stays I/O-free). */
export interface LogFileInfo {
  date: string;
  /** `fs.stat(...).mtimeMs` of the file. */
  mtimeMs: number;
  blocks: readonly LogBlock[];
}

export interface CheckInput {
  state: StateDoc | null;
  logs: readonly LogFileInfo[];
  cards: readonly Card[];
  config: BoardConfig;
  leases: LeasesDoc;
  now: Date;
}

/** P8.4 fills this in; for now `check` never emits a `cost-over-budget` finding. */
// P8.4
export function costFinding(): Finding | null {
  return null;
}

/** The later of a log file's own mtime and the newest parseable `#####` header time inside it. */
function newestMomentOf(log: LogFileInfo): number {
  let m = log.mtimeMs;
  for (const b of log.blocks) {
    const t = Date.parse(b.ts);
    if (!Number.isNaN(t) && t > m) m = t;
  }
  return m;
}

function newestLogMoment(logs: readonly LogFileInfo[]): number | null {
  let max: number | null = null;
  for (const log of logs) {
    const m = newestMomentOf(log);
    if (max === null || m > max) max = m;
  }
  return max;
}

/**
 * `repoboard check`'s pure half. Findings, one per problem — never a blanket boolean, so every
 * surface prints exactly what a human or agent needs to act. `exitCodeForFindings` turns this
 * list into the shell-callable 0/1 contract.
 */
export function checkFindings(input: CheckInput): Finding[] {
  const findings: Finding[] = [];

  const newest = newestLogMoment(input.logs);
  if (newest !== null) {
    const stampMs = input.state ? Date.parse(input.state.stamp) : Number.NaN;
    if (input.state === null || Number.isNaN(stampMs) || stampMs < newest) {
      findings.push({
        kind: 'stale-state',
        level: 'error',
        message: 'stale-state: STATE.md stamp is older than the newest log entry',
      });
    }
  }

  for (const card of input.cards) {
    if (!card.assignee) continue;
    const column = findColumn(input.config, card.status);
    if (!column?.active) continue;
    if (!isActive(card, input.config, input.now)) continue;
    if (!holdsLiveLease(input.leases, card.assignee, input.now)) {
      findings.push({
        kind: 'active-without-lease',
        level: 'warning',
        message: `active-without-lease: ${card.id} (${card.assignee}) holds no live lease`,
      });
    }
  }

  for (const lease of staleLeases(input.leases, input.now)) {
    findings.push({
      kind: 'stale-lease',
      level: 'error',
      message: `stale-lease: ${lease.resource} held by ${lease.holder} until ${lease.until ?? '—'}`,
    });
  }

  const needsCount = input.cards.filter((c) => needsDecision(c)).length;
  if (needsCount > 0) {
    findings.push({
      kind: 'needs-decision',
      level: 'info',
      message: `needs-decision: ${needsCount} card${needsCount === 1 ? '' : 's'} waiting on the owner`,
    });
  }

  const cf = costFinding();
  if (cf) findings.push(cf);

  return findings;
}

/**
 * `error` always blocks; `warning` blocks only with `--strict`; `info` never blocks
 * (locked decision 4: `needs-decision` is "informational, never fails").
 */
export function exitCodeForFindings(findings: readonly Finding[], strict: boolean): 0 | 1 {
  return findings.some((f) => f.level === 'error' || (strict && f.level === 'warning')) ? 1 : 0;
}
