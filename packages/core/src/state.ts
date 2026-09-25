/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/STATE.md` — one page, rewritten in place, never
 * appended (contrast `repolog.ts`). Fixed H2 sections in order: LIVE, LAST LANDINGS, OWNER QUEUE,
 * SEATS — this is the ON-DISK shape `parseState` requires, exactly these four headings, in this
 * order, never more. OWNER QUEUE is GENERATED on every read from cards that need a decision
 * (P8.1) — the file on disk keeps a one-line placeholder under that heading and never stores real
 * queue text, so a write here can never bake in a snapshot of decisions that goes stale the moment
 * another one is answered. RCB-131: `renderState`'s DISPLAY path (never `parseState`/the on-disk
 * writers) additionally generates a LEASES section right after OWNER QUEUE, same "never stored"
 * rule as OWNER QUEUE — see `renderTemplate`'s `leasesBody`. `checkFindings` (locked decision 4)
 * lives here too: it is the pure half of `repoboard check`, taking already-gathered facts (a
 * parsed STATE, parsed+stat'd logs, the cards, the board config, the leases doc, and `now`) and
 * returning findings — no filesystem access, so it is exactly as testable as everything else in
 * this package (§0.5).
 */
import { findColumn } from './board.js';
import type { CostReport } from './cost.js';
import { isOwnerTask, needsDecision } from './decisions.js';
import {
  formatLeaseMoment,
  holdsLiveLease,
  liveLeases,
  renderLeaseLines,
  staleLeases,
} from './leases.js';
import { blockedReason } from './phases.js';
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
/**
 * The DISPLAY path's "queue is empty" text (`renderOwnerQueue`) — the generated content never
 * touches disk. RCB-118: NOT what the file on disk keeps; see `OWNER_QUEUE_FILE_PLACEHOLDER`.
 */
export const OWNER_QUEUE_PLACEHOLDER = '_(generated from open decisions)_';
/**
 * RCB-118: what the ON-DISK file actually writes under OWNER QUEUE — distinct from
 * `OWNER_QUEUE_PLACEHOLDER` (the DISPLAY path's "queue is empty" text) so a raw-file reader can
 * never mistake "not stored here" for "empty". Parsing discards OWNER QUEUE content regardless of
 * which placeholder is on disk, so a file carrying the OLD placeholder still parses.
 */
export const OWNER_QUEUE_FILE_PLACEHOLDER =
  '_(not stored in this file — generated from open decisions: run `repoboard state`)_';

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

/**
 * `RCB-40 · <question> · [A B]` (locked decision 1) — the letters are omitted when there are none.
 * RCB-52: an owner task renders `RCB-9 · owner: buy the domain` instead — no letters bracket.
 */
export function ownerQueueLine(card: Card): string {
  const d = card.decision;
  if (isOwnerTask(card)) return `${card.id} · owner: ${d?.question ?? ''}`;
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

/**
 * RCB-131: `leasesBody` is the DISPLAY-only LEASES section body — `undefined` (never an empty
 * string) omits the whole `## LEASES` heading, which is exactly what every ON-DISK writer
 * (`renderStateFile`) passes by leaving the argument out. A caller that wants the section, even
 * with no live leases, passes `renderLeaseLines([], now)` (`'(no live leases)'`), never `undefined`.
 */
function renderTemplate(
  sections: StateSections,
  ownerQueueBody: string,
  opts: { now: Date; actor: string },
  leasesBody?: string,
): string {
  const leasesPart = leasesBody !== undefined ? ['', '## LEASES', '', leasesBody] : [];
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
    ...leasesPart,
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
 *
 * RCB-131: `leasesDoc`, when given, generates a LEASES section the same way OWNER QUEUE is
 * generated — live leases only (`liveLeases`), formatted by the ONE shared `renderLeaseLines`
 * (leases.ts) so `seat <name>`'s `## Leases` block and this section can never disagree on the
 * line format. Absent `leasesDoc` omits the section entirely rather than showing an empty one —
 * a caller that has not gathered leases (HTTP's `GET /api/state` is out of scope for this card)
 * gets exactly the old page back, byte for byte. Liveness (and the since/until moment text) is
 * judged against `leasesNow`, defaulting to `opts.now` — pass the REAL clock here, not the doc's
 * stamp: unlike LIVE/LAST LANDINGS/SEATS (frozen as last WRITTEN), LEASES is a fresh read, same
 * as OWNER QUEUE, so a lease that went stale after the last write must not still show as live.
 */
export function renderState(
  sections: StateSections,
  openDecisions: readonly Card[],
  opts: { now: Date; actor: string },
  leasesDoc?: LeasesDoc,
  leasesNow?: Date,
): string {
  const at = leasesNow ?? opts.now;
  const leasesBody =
    leasesDoc !== undefined ? renderLeaseLines(liveLeases(leasesDoc, at), at) : undefined;
  return renderTemplate(sections, renderOwnerQueue(openDecisions), opts, leasesBody);
}

/** The ON-DISK rendering: OWNER QUEUE is always the placeholder, never generated content. */
function renderStateFile(sections: StateSections, opts: { now: Date; actor: string }): string {
  return renderTemplate(sections, OWNER_QUEUE_FILE_PLACEHOLDER, opts);
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
    | 'live-lease'
    | 'needs-decision'
    | 'needs-ask'
    | 'gated-steps'
    | 'cost-over-budget'
    | 'local-unsynced'
    | 'local-no-remote'
    | 'future-stamp'
    | 'systems-invalid'
    | 'systems-stale'
    | 'untracked-cards'
    | 'seat-owner-queue-drift';
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
  /** P8.4: gathered (with I/O) by the caller — core stays I/O-free (§0.5). `null`/absent when the
   * caller could not gather it (e.g. a read error); `costFinding` then reports nothing rather
   * than guessing. */
  cost?: CostReport | null;
  /** RCB-83: `.repoboard/local/`'s git status, gathered (with I/O) by the caller. `null`/absent
   * when there is no local layer at all — an unconfigured local layer is inert, not dangerous, so
   * no finding fires for it. RCB-128: `remoteAck` (default `false` when omitted, for a caller
   * built before the ack existed) is the owner's opt-out ack (`local.yml`: `remote: none`) —
   * `!hasRemote && !remoteAck` is `local-no-remote`'s whole condition. */
  local?: {
    isRepo: boolean;
    hasRemote: boolean;
    dirty: boolean;
    ahead: number | null;
    remoteAck?: boolean;
  } | null;
  /** RCB-97: `.repoboard/systems.yml`'s parse errors and stale detected-row ids, gathered (with
   * I/O) by the caller — core stays I/O-free (§0.5). `null`/absent when the caller gathered
   * nothing (no systems.yml at all, or it gathered no stale check) — an unconfigured systems.yml
   * is inert, not dangerous, so no finding fires for it. */
  systems?: { errors: readonly string[]; stale: readonly string[] } | null;
  /** RCB-119: card files git does not track, gathered (with I/O, one `git ls-files`) by the
   * caller — core stays I/O-free (§0.5). `null`/absent when the caller could not gather it (not a
   * git repo, or the gather itself failed) — an ungathered signal is inert, not dangerous, so no
   * finding fires for it. `actor` is the creating actor's newest `create` event, or `null` when
   * none is known (e.g. the id was never created through this store). */
  untrackedCards?: readonly { id: string; actor: string | null }[] | null;
  /** RCB-130: every SEATS bullet's name + whole text — gathered (with I/O: reading STATE.md) by
   * the caller via core's own `seatBulletTexts` (`seat.ts`; `state.ts` never imports `seat.ts`
   * itself, so the two files can't cycle) and passed through unchanged. `null`/absent/`[]` is
   * inert — no bullets to scan means no finding, same "ungathered signal is inert" rule as
   * `systems`/`local`/`untrackedCards` above. */
  seatBullets?: readonly { name: string; text: string }[] | null;
}

/**
 * P8.4 (locked decision 4): error-grade, like `stale-lease` — a CLAUDE.md over budget is loaded
 * into every turn of every agent and nobody notices without this. `null` when there is no report
 * to judge, or when the report itself says CLAUDE.md is absent or within budget — an absent
 * CLAUDE.md can never be OVER (locked decision 2).
 */
export function costFinding(report: CostReport | null | undefined): Finding | null {
  if (!report?.over || report.claudeMdBytes === null) return null;
  return {
    kind: 'cost-over-budget',
    level: 'error',
    message: `cost-over-budget: CLAUDE.md ${report.claudeMdBytes} B > budget ${report.budget} B`,
  };
}

/**
 * RCB-97 (plan §3.3): error-grade for an invalid file — "a file that will not parse is worse than
 * none" (§3.2) — warning-grade for a stale detected row. `null`/absent `input.systems` is inert
 * (§3.1: unconfigured yields nothing, never a finding); each half fires independently of the
 * other, so a file with only stale rows (no parse errors) still reports them.
 */
export function systemsFindings(systems: CheckInput['systems']): Finding[] {
  if (!systems) return [];
  const findings: Finding[] = [];
  if (systems.errors.length > 0) {
    const k = systems.errors.length;
    const more = k > 1 ? ` (+${k - 1} more)` : '';
    findings.push({
      kind: 'systems-invalid',
      level: 'error',
      message: `systems-invalid: .repoboard/systems.yml: ${systems.errors[0]}${more}`,
    });
  }
  if (systems.stale.length > 0) {
    findings.push({
      kind: 'systems-stale',
      level: 'warning',
      message: `systems-stale: ${systems.stale.length} detected row(s) no longer yielded by their source: ${systems.stale.join(', ')}`,
    });
  }
  return findings;
}

/** A block stamped further ahead of `now` than this is a hand-typed or clock-skewed header, not a
 * real newer moment (RCB-90) — see `newestLogMoment`. */
export const FUTURE_STAMP_TOLERANCE_MS = 60_000;

/**
 * The later of a log file's own mtime and the newest parseable `#####` header time inside it —
 * except a header more than `FUTURE_STAMP_TOLERANCE_MS` ahead of `now` is ignored here. A
 * hand-typed block (the CLI stamps them; a human does not) can carry a clock-error timestamp
 * minutes or hours in the future; counting it as "newest" made every OTHER seat's STATE.md read
 * as permanently stale until the clock caught up, with nothing naming the cause (RCB-90, fpj
 * builder block stamped 03:30Z at ≈03:24Z). The file's own mtime still counts regardless — only
 * the parsed header time is discounted.
 */
function newestMomentOf(log: LogFileInfo, nowMs: number): number {
  let m = log.mtimeMs;
  for (const b of log.blocks) {
    const t = Date.parse(b.ts);
    if (Number.isNaN(t)) continue;
    if (t - nowMs > FUTURE_STAMP_TOLERANCE_MS) continue;
    if (t > m) m = t;
  }
  return m;
}

function newestLogMoment(logs: readonly LogFileInfo[], nowMs: number): number | null {
  let max: number | null = null;
  for (const log of logs) {
    const m = newestMomentOf(log, nowMs);
    if (max === null || m > max) max = m;
  }
  return max;
}

/**
 * RCB-130: ids named after a hand-typed `OWNER QUEUE =`/`OWNER QUEUE:` line inside a SEATS
 * bullet's text, to the end of that physical line — a card-id-shaped token (`phases.ts`'s own
 * `CARD_ID_SHAPE` rule, scanned rather than anchored), comma/space/anything else between them.
 * `null` when the text never mentions OWNER QUEUE at all, OR mentions it with no id-shaped token
 * after it (e.g. "OWNER QUEUE = none") — either way there is no LIST of card ids to compare, so
 * `seatOwnerQueueDriftFindings` has nothing to fire on.
 */
const OWNER_QUEUE_HAND_RE = /OWNER QUEUE\s*[=:]\s*(.*)$/m;
const CARD_ID_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;

function handTypedOwnerQueueIds(text: string): string[] | null {
  const m = OWNER_QUEUE_HAND_RE.exec(text);
  if (!m) return null;
  const ids = [...(m[1] ?? '').matchAll(CARD_ID_TOKEN_RE)].map((mm) => mm[0]);
  return ids.length > 0 ? ids : null;
}

/**
 * RCB-130 (owner: fpj STATE.md, 2026-09-25 01:56Z — a coordinator bullet's `owes:` line ended
 * `OWNER QUEUE = FPJ-86, FPJ-119`, 3.5 h stale, while the GENERATED queue — `renderOwnerQueue`,
 * from `needsDecision` cards — was right): warning-grade, like `active-without-lease` (hygiene,
 * not a broken rig; blocks only with `--strict`). One finding per bullet whose hand-typed id set
 * differs from `generatedIds` (order-insensitive — a same set in another order is not drift); a
 * bullet that never mentions OWNER QUEUE, or whose set already matches, contributes nothing.
 */
export function seatOwnerQueueDriftFindings(
  seatBullets: readonly { name: string; text: string }[],
  generatedIds: readonly string[],
): Finding[] {
  const generated = new Set(generatedIds);
  const findings: Finding[] = [];
  for (const { name, text } of seatBullets) {
    const handIds = handTypedOwnerQueueIds(text);
    if (handIds === null) continue;
    const hand = new Set(handIds);
    const sameSet = hand.size === generated.size && [...hand].every((id) => generated.has(id));
    if (sameSet) continue;
    findings.push({
      kind: 'seat-owner-queue-drift',
      level: 'warning',
      message:
        `seat-owner-queue-drift: ${name} bullet says OWNER QUEUE = ${handIds.join(', ')}; ` +
        `generated: ${generatedIds.length > 0 ? generatedIds.join(', ') : 'none'} — seats print ` +
        'open decisions; drop the hand line',
    });
  }
  return findings;
}

/**
 * `repoboard check`'s pure half. Findings, one per problem — never a blanket boolean, so every
 * surface prints exactly what a human or agent needs to act. `exitCodeForFindings` turns this
 * list into the shell-callable 0/1 contract.
 */
export function checkFindings(input: CheckInput): Finding[] {
  const findings: Finding[] = [];

  const nowMs = input.now.getTime();
  const newest = newestLogMoment(input.logs, nowMs);
  if (newest !== null) {
    const stampMs = input.state ? Date.parse(input.state.stamp) : Number.NaN;
    // The stamp is written at SECOND resolution (`toIso`), a file's mtime carries milliseconds:
    // a `--set-section` that lands in the same second as the log append it answers would
    // otherwise read as stale by a few hundred ms forever (fpj convergence, 2026-09-18).
    // Compare at the stamp's own resolution.
    const newestSec = Math.floor(newest / 1000) * 1000;
    if (input.state === null || Number.isNaN(stampMs) || stampMs < newestSec) {
      findings.push({
        kind: 'stale-state',
        level: 'error',
        message: 'stale-state: STATE.md stamp is older than the newest log entry',
      });
    }
  }

  // RCB-90: surface every block ignored above so the cause is visible — warning, not error, so a
  // hand-typed future stamp in ONE seat's log can never block another seat's `check` (that
  // blocking was the bug).
  for (const log of input.logs) {
    for (const b of log.blocks) {
      const t = Date.parse(b.ts);
      if (Number.isNaN(t)) continue;
      const aheadMs = t - nowMs;
      if (aheadMs <= FUTURE_STAMP_TOLERANCE_MS) continue;
      const aheadSec = Math.round(aheadMs / 1000);
      findings.push({
        kind: 'future-stamp',
        level: 'warning',
        message: `future-stamp: ${log.date} log block "${b.seat} ${b.ts}" is ${aheadSec} s ahead of the clock — hand-typed header? blocks come from \`repoboard log --as <seat>\``,
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

  // RCB-131 (owner 2026-09-24: two seats collided on a resource while one held a lease, visible
  // only to a seat that ran `lease list` by hand) — one INFO finding per LIVE lease, so a plain
  // `repoboard check` surfaces who holds what without a separate command. Info-grade, like
  // `needs-decision`: ordinary board state, never blocks, `exitCodeForFindings` untouched.
  for (const lease of liveLeases(input.leases, input.now)) {
    const since = formatLeaseMoment(lease.since, input.now);
    const until = lease.until !== undefined ? formatLeaseMoment(lease.until, input.now) : '—';
    findings.push({
      kind: 'live-lease',
      level: 'info',
      message: `live-lease: ${lease.resource} held by ${lease.holder} since ${since} (until ${until})`,
    });
  }

  // RCB-69 (owner 2026-09-19 20:1xZ): a card in a `decision: true` column with no OPEN ask —
  // never asked, or already decided and moved back (FPJ-28) — is the same finding either way: the
  // column has no open ask to show for it. Warning-grade, like `active-without-lease` (hygiene,
  // not a broken rig); cards outside a `decision: true` column never fire it.
  for (const card of input.cards) {
    const column = findColumn(input.config, card.status);
    if (!column?.decision) continue;
    if (needsDecision(card)) continue;
    findings.push({
      kind: 'needs-ask',
      level: 'warning',
      message:
        `needs-ask: ${card.id} is in "${column.id}" with no open ask (repoboard card ask ` +
        `${card.id} "<question>" [--option "A <text>"]... | --task)`,
    });
  }

  const openDecisionIds = input.cards.filter((c) => needsDecision(c)).map((c) => c.id);
  if (openDecisionIds.length > 0) {
    findings.push({
      kind: 'needs-decision',
      level: 'info',
      message: `needs-decision: ${openDecisionIds.length} card${openDecisionIds.length === 1 ? '' : 's'} waiting on the owner`,
    });
  }

  // RCB-130: a hand-typed OWNER QUEUE line inside a SEATS bullet, checked against the SAME
  // `needsDecision` set `openDecisionIds` above already computed — the generated queue is never
  // re-derived a second way.
  findings.push(...seatOwnerQueueDriftFindings(input.seatBullets ?? [], openDecisionIds));

  // RCB-68: info-grade like `needs-decision` — a blocked step is expected, ordinary board state,
  // not a rig problem; `check` never fails on it (`exitCodeForFindings` untouched).
  const gatedCount = input.cards.filter(
    (c) => blockedReason(c, input.cards, input.config) !== null,
  ).length;
  if (gatedCount > 0) {
    findings.push({
      kind: 'gated-steps',
      level: 'info',
      message:
        `gated-steps: ${gatedCount} card${gatedCount === 1 ? '' : 's'} blocked on a gate ` +
        '(repoboard card list shows BLOCKED)',
    });
  }

  // RCB-83: an absent/null `local` (no `.repoboard/local/`, or one that is not itself a git repo
  // yet) is inert, not a finding — an unconfigured local layer yields nothing, never a warning.
  if (input.local?.isRepo) {
    const { dirty, ahead, hasRemote, remoteAck } = input.local;
    if (dirty) {
      findings.push({
        kind: 'local-unsynced',
        level: 'warning',
        message: 'local: uncommitted changes in .repoboard/local/ — repoboard local sync',
      });
    } else if (ahead !== null && ahead > 0) {
      findings.push({
        kind: 'local-unsynced',
        level: 'warning',
        message: `local: ${ahead} ahead of origin — repoboard local sync`,
      });
    }
    // RCB-128: a remote makes the ack moot; without one, the ack (`local.yml`: `remote: none`)
    // silences the line on purpose — without it, a forgotten backup is still caught every run.
    if (!hasRemote && !remoteAck) {
      findings.push({
        kind: 'local-no-remote',
        level: 'info',
        message: 'local: no remote — repoboard local init --remote <url>',
      });
    }
  }

  const cf = costFinding(input.cost);
  if (cf) findings.push(cf);

  findings.push(...systemsFindings(input.systems));

  // RCB-119: an absent/null `untrackedCards` is inert (no git repo, or the caller could not
  // gather it) — like `local` and `systems`, an unconfigured/ungathered signal yields nothing,
  // never a warning. Warning-grade, like `future-stamp`: exit stays 0 without `--strict`.
  if (input.untrackedCards && input.untrackedCards.length > 0) {
    const n = input.untrackedCards.length;
    const shown = input.untrackedCards.slice(0, 10).map((c) => `${c.id} (${c.actor ?? '?'})`);
    const more = n > 10 ? `, …+${n - 10} more` : '';
    findings.push({
      kind: 'untracked-cards',
      level: 'warning',
      message: `untracked-cards: ${n} card file(s) not in git — ${shown.join(', ')}${more}`,
    });
  }

  return findings;
}

/**
 * `error` always blocks; `warning` blocks only with `--strict`; `info` never blocks
 * (locked decision 4: `needs-decision` is "informational, never fails").
 */
export function exitCodeForFindings(findings: readonly Finding[], strict: boolean): 0 | 1 {
  return findings.some((f) => f.level === 'error' || (strict && f.level === 'warning')) ? 1 : 0;
}

// ---- LAST LANDINGS trim (RCB-92) ---------------------------------------------------------

/** An entry starts at a line like `-38. **K101…`, `0. K117 voice…`, `1. Lane scripts…`. */
const LANDING_START = /^-?\d+\.\s/gm;

/**
 * Split a `## LAST LANDINGS` body into entries, file order (top = newest). Text before the
 * first start line (a preamble) stays attached to the FIRST entry; each entry is the verbatim
 * slice up to (not including) the next start line, trailing whitespace trimmed. A body with no
 * start line at all is one entry. `SECTION_PLACEHOLDER` (or anything that trims to empty) → `[]`.
 */
export function splitLandings(body: string): string[] {
  if (body === SECTION_PLACEHOLDER) return [];
  const starts = [...body.matchAll(LANDING_START)].map((m) => m.index);
  if (starts.length === 0) {
    const trimmed = body.replace(/\s+$/, '');
    return trimmed.length === 0 ? [] : [trimmed];
  }
  const entries: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = i === 0 ? 0 : (starts[i] ?? 0);
    const end = i + 1 < starts.length ? (starts[i + 1] ?? body.length) : body.length;
    entries.push(body.slice(start, end).replace(/\s+$/, ''));
  }
  return entries;
}

/**
 * `kept` = the first `keep` entries (file order) joined by a blank line; `archived` = the rest,
 * verbatim, in file order. `keep < 0` throws. `archived` is `[]` when there is nothing beyond
 * `keep`. Invariant: `[...splitLandings(kept), ...archived].join('\n\n')` reconstructs the
 * original body (trailing whitespace trimmed) — nothing lost, nothing reordered.
 */
export function trimLandings(body: string, keep: number): { kept: string; archived: string[] } {
  if (keep < 0) throw new Error(`trimLandings: keep must be >= 0 (got ${keep})`);
  const entries = splitLandings(body);
  const kept = entries.slice(0, keep).join('\n\n');
  const archived = entries.slice(keep);
  return { kept, archived };
}
