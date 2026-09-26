/**
 * RCB-48: `repoboard seat <name>` — the cold-start bundle, packaging RCB-47's rule (STATE.md →
 * your own seat's last block → the coordinator's → `card list --status todo` → open decisions)
 * as one read instead of the three-file ritual. Pure, I/O-free (§0.5): the store gathers
 * `SeatBundleInput`, this file turns it into a `SeatBundle` and renders it.
 */
import { defaultBoardConfig, findColumn } from './board.js';
import {
  type AnsweredDecisionRow,
  answeredDecisions,
  formatAnsweredChoice,
  needsDecision,
} from './decisions.js';
import { liveLeases, renderLeaseLines } from './leases.js';
import { blockedReason, type GateMemberFacts, gateState, stepsOf } from './phases.js';
import { formatLogBlock, type LogBlock } from './repolog.js';
import { ownerQueueLine } from './state.js';
import type { SystemsSummary } from './systems-surface.js';
import { toIso } from './time.js';
import type { BoardConfig, Card, Lease, LeasesDoc } from './types.js';

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
  /** RCB-103: board config for `findColumn`/`blockedReason` against — `defaultBoardConfig()` when
   *  absent, so every existing caller/test (no phases in play) keeps working unchanged. */
  config?: BoardConfig;
  /** RCB-97: `systemsSummary(...)`, gathered by the caller — `null`/absent when there is no
   *  systems.yml to summarise (§3.1: unconfigured is inert — the line is simply omitted). */
  systems?: SystemsSummary | null;
  /** RCB-131: `store.leases()` — `.repoboard/leases.yml`'s whole doc. `null`/absent (no file, or a
   *  caller that gathered nothing) is inert: `seatBundle` then reports no live leases, never
   *  throws — same "unconfigured is inert" rule as `systems`. */
  leases?: LeasesDoc | null;
  /** RCB-154: a WORKSPACE's opened member boards — a card's `gate:` (this store's own, or a
   *  step's) can then resolve against them, the SAME facts `card list`/`show`/`move` already pass
   *  to `blockedReason`. Absent/`[]` (a plain board, or a caller that gathered none) is inert:
   *  every `blockedReason`/`gateState` call below defaults to `[]` on its own too, so this whole
   *  card's wiring is a no-op for any caller that never touches it. */
  members?: readonly GateMemberFacts[];
  /** RCB-160: `boardDisplayName(config, root)`, gathered by the caller (core stays I/O-free) —
   *  written as a `[repo] ` prefix on the bundle's own header. `null`/absent (a caller that
   *  gathers none, or every existing test) is inert: the header prints exactly as it does today. */
  repo?: string | null;
}

/** Which rule picked `nextCard`, so the render (and a reader) can say so instead of guessing. */
export type NextCardReason = 'parent-step' | 'assigned' | 'priority' | 'first-todo' | null;

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
  /** RCB-103: set only when `nextCardReason === 'parent-step'` — the parent card whose step
   *  `nextCard` is, and `gateState(nextCard, ...).by` when that step's gate is `clear`, `null`
   *  when the step has no gate (a blocked step is never picked, so `gateState` here is never
   *  `blocked`). */
  nextCardStep: { parentId: string; gateBy: string | null } | null;
  /** `needsDecision(c)`, list order — reused from `decisions.ts`, never re-derived. */
  openDecisions: Card[];
  /** RCB-129: `answeredDecisions(cards).filter(r => !r.acknowledged)` — the owner answered on
   *  another surface (typically the web) and nothing here changed otherwise; a seat's cold-start
   *  read is the first place that would notice. Never re-derived by `renderSeatBundle`. */
  answeredNotAck: AnsweredDecisionRow[];
  /**
   * RCB-118: non-null exactly when `nextCard` is null — a cold seat's "there is no todo card for
   * you" broken into WHY, so it can tell an empty board from one whose work is gated, owner-held,
   * or someone else's. `awaitingOwner` reuses `openDecisions.length` — never re-derived.
   */
  nextCardEmpty: { todoForOthers: number; gated: number; awaitingOwner: number } | null;
  /** RCB-83: `.repoboard/local/RIG.md`'s text, `null` when there is none. */
  rig: string | null;
  /** RCB-89: `parseSeatFields(seatsLine)` when `seatsLine` is non-null, else `null`. */
  inFlight: string | null;
  /** RCB-89: `parseSeatFields(seatsLine)` when `seatsLine` is non-null, else `null`. */
  owes: string | null;
  /** RCB-97: `input.systems ?? null` — `repoboard seat`'s one Systems line, a pointer not the
   *  table (§3.3: O3, standing cost). */
  systems: SystemsSummary | null;
  /** RCB-131: `liveLeases(input.leases, input.now)` — live leases only (`isStale` false); a stale
   *  lease is never shown here, `check`'s `stale-lease` finding already owns that. */
  leases: Lease[];
  /** RCB-140: true when the SEATS section is absent or has no bullets at all, stamped or not
   *  (`bulletSpans`, not `listSeats`, which drops unstamped ones). A board with no seats recorded yet has never
   *  had a second agent on it, so the cold-start bundle drops the sections that are pure noise on
   *  a solo board instead of printing five placeholders in a row. */
  solo: boolean;
  /** RCB-160: `input.repo ?? null` — never re-derived. `null` prints the header exactly as before. */
  repo: string | null;
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
 * RCB-160: a `[repo] ` prefix written by `formatSeatBullet`/`rewriteSeatBulletBody` right after
 * `- ` or `- **`, when the board's name is known. Stripped before any label/name match, so a repo
 * prefix can never be mistaken for the seat's own name — `seat repoboard` must not match a bullet
 * merely PREFIXED `[repoboard]`.
 */
const BULLET_REPO_PREFIX_RE = /^(- (?:\*\*)?)\[[^\]]+\]\s+/;

function stripBulletRepoPrefix(firstLine: string): string {
  return firstLine.replace(BULLET_REPO_PREFIX_RE, '$1');
}

/**
 * A bullet's LABEL: the leading `**…**` span of its first line when present (a bullet is almost
 * always written `- **<seat name…>**: …`), else the first line up to the first `:` (so a plain
 * `- ops: watching` still has a label). This is what a human means by "the ops bullet" — the
 * seat's own name at the HEAD of its own bullet — as opposed to any bullet whose prose merely
 * mentions another seat's name in passing. RCB-160: `stripBulletRepoPrefix` runs FIRST, so a
 * `[repo] ` prefix (see above) is never part of the label this returns.
 */
function bulletLabel(firstLine: string): string {
  const content = stripBulletRepoPrefix(firstLine).replace(/^- /, '');
  const bold = LEADING_BOLD.exec(content);
  if (bold?.[1] !== undefined) return bold[1];
  const colon = content.indexOf(':');
  return colon === -1 ? content : content.slice(0, colon);
}

/**
 * RCB-130: a top-level `- in-flight: …` or `- owes: …` line is never a real bullet on its own —
 * nobody writes a standalone bullet to say only that; it is what a hand-edit leaves behind when a
 * continuation line loses its 2-space indent and gets typed as its own `- ` item instead (fpj
 * STATE.md, 2026-09-25 01:56Z: a coordinator bullet replace left exactly this behind, surviving as
 * an orphan `bulletSpans` neither `locateSeatBullet` pass claims — see `bulletSpans`' own comment).
 * `bulletLabel`'s field names, not a separately hand-written pair, so this can never drift from
 * what `parseSeatFields` recognizes as a field line.
 */
const STRAY_FIELD_BULLET_RE = /^-\s+(?:in-flight|owes):/i;

/**
 * Line-index spans (end exclusive) of `lines`' top-level bullets — a line starting with `- `, plus
 * every following line up to the next `- ` line as its continuation. Lines before the first bullet
 * (if any) belong to no span, same as the old inline splitter this replaces. Shared by
 * `findSeatLine` and `replaceSeatBullet` (RCB-58) so both split a SEATS section identically —
 * `bulletSpans` is the one place that decides where a bullet starts and ends.
 *
 * RCB-130: a line matching `STRAY_FIELD_BULLET_RE` does NOT start a new span when one is already
 * open — it is folded into the bullet in progress as an ordinary continuation line instead, so a
 * mis-indented `in-flight:`/`owes:` line can never survive a `replaceSeatBullet` as an orphan
 * bullet nobody's label matches. Only when NO span is open yet (the stray line is the very first
 * thing in the section) does it still start one of its own — there is nothing to fold it into.
 */
function bulletSpans(lines: readonly string[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/^- /.test(line)) continue;
    if (STRAY_FIELD_BULLET_RE.test(line) && start !== -1) continue;
    if (start !== -1) spans.push({ start, end: i });
    start = i;
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
    if (wordRe.test(stripBulletRepoPrefix(bullets[i]?.[0] ?? ''))) return i;
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
 *
 * RCB-160: `repo` (the board's `boardDisplayName`) is written as a `[repo] ` prefix right before
 * `name`, INSIDE the bold span — `undefined`/empty (the default) omits it, so every existing
 * caller keeps writing exactly today's bullet.
 */
export function formatSeatBullet(
  name: string,
  status: 'UP' | 'DOWN',
  text: string,
  now: Date,
  repo?: string,
): string {
  const iso = toIso(now);
  const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  const body = formatSeatBulletBody(text);
  const prefix = repo !== undefined && repo.trim().length > 0 ? `[${repo}] ` : '';
  return `- **${prefix}${name}: ${status} ${stamp}.** ${body}`;
}

/**
 * RCB-88: rewrite a seat's own bullet's BODY, keeping its first line's label, status and stamp
 * BYTE-FOR-BYTE — the raw `SEAT_BULLET_RE` captures, not reformatted or reparsed, so even a stamp
 * that fails to parse (`18:0xZ`) survives verbatim. `null` when the first line is not a seat
 * bullet at all (same shape check as `parseSeatStamp`) — there is nothing to keep. Pure, no I/O,
 * no clock: this function never restamps.
 *
 * RCB-160: `repo` writes that `[repo] ` prefix — given, it REPLACES whatever prefix (if any) the
 * bullet already carried; omitted (`undefined`), the bullet's own existing prefix (if any) is kept
 * byte-for-byte, same as the label/status/stamp.
 */
export function rewriteSeatBulletBody(
  bullet: string,
  text: string,
  repo?: string,
): { bullet: string; status: 'UP' | 'DOWN'; stamp: string } | null {
  const firstLine = bullet.split('\n')[0] ?? '';
  const m = SEAT_BULLET_RE.exec(firstLine);
  if (!m) return null;
  const existingRepo = m[1];
  const label = m[2] ?? '';
  const status = m[3] as 'UP' | 'DOWN';
  const date = m[4] ?? '';
  const time = m[5] ?? '';
  const body = formatSeatBulletBody(text);
  const nextRepo = repo !== undefined ? repo : existingRepo;
  const prefix = nextRepo !== undefined && nextRepo.trim().length > 0 ? `[${nextRepo}] ` : '';
  return {
    bullet: `- **${prefix}${label}: ${status} ${date} ${time}Z.** ${body}`,
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
 *
 * RCB-160: an optional `[<repo>] ` — its OWN capture group (1) — right after the opening `**`, so
 * a repo prefix is never absorbed into the label group (2). Groups: (1) repo, (2) label, (3)
 * status, (4) date, (5) time.
 */
const SEAT_BULLET_RE =
  /^-\s+\*\*(?:\[([^\]]+)\]\s+)?([^*:]+):\s+(UP|DOWN)\s+(\S+)\s+(\S+?)Z\.?\*{0,2}/;
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
  const status = m[3] as 'UP' | 'DOWN';
  const date = m[4] ?? '';
  const time = m[5] ?? '';
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
 * RCB-130: counts every line matching `re` — derived from `re`'s own source with a `g` flag added
 * (never a second, separately hand-written pattern), so a counting pass can never disagree with
 * `IN_FLIGHT_LINE_RE`/`OWES_LINE_RE`'s own single-match use in `parseSeatFields`.
 */
function countLineMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...text.matchAll(global)].length;
}

/**
 * RCB-130 (fpj STATE.md, 2026-09-25 01:56Z: a coordinator bullet carried TWO `in-flight:`/`owes:`
 * pairs, the second ending a now-stale hand-typed `OWNER QUEUE = …`): `null` (ok) only when `text`
 * carries AT MOST ONE `in-flight:` line and AT MOST ONE `owes:` line — else names which count(s)
 * are over. Reproduced with a plain `--down` text that already holds two of each: nothing before
 * this guarded against that shape, so both landed verbatim in the formatted bullet. The ONE guard
 * `checkDownFields` (which additionally requires both lines present) and `seat --update`'s text
 * (`store.ts`'s `updateSeatBullet`, which has no presence requirement of its own) both call — a
 * caller cannot ask it to allow a second line of either kind.
 */
export function checkFieldCounts(text: string): string | null {
  const inFlightCount = countLineMatches(text, IN_FLIGHT_LINE_RE);
  const owesCount = countLineMatches(text, OWES_LINE_RE);
  const over: string[] = [];
  if (inFlightCount > 1) over.push(`${inFlightCount} "in-flight:" lines`);
  if (owesCount > 1) over.push(`${owesCount} "owes:" lines`);
  if (over.length === 0) return null;
  return `seat: text has ${over.join(' and ')} — one of each, at most`;
}

/**
 * RCB-89: guard for `seat --down` — `null` (ok) only when `text` (the raw `--down` argument, not
 * yet a formatted bullet) carries BOTH an `in-flight:` line and an `owes:` line (same regexes as
 * `parseSeatFields`), AND neither more than once (RCB-130's `checkFieldCounts`, checked first);
 * else the exact error a caller should surface verbatim. One function, no argument that could
 * weaken it — a caller cannot ask it to check only one of the two lines.
 */
export function checkDownFields(text: string): string | null {
  const countErr = checkFieldCounts(text);
  if (countErr) return countErr;
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
/**
 * A bullet's NAME half of its label — `bulletLabel`'s bold span, or up to that span's own first
 * `:` when there is none, trimmed. `listSeats` and `seatBulletTexts` (RCB-130) both call this ONE
 * function so the name a row/entry carries can never drift between the two.
 */
function bulletName(firstLine: string): string {
  const label = bulletLabel(firstLine);
  const colonIdx = label.indexOf(':');
  return (colonIdx === -1 ? label : label.slice(0, colonIdx)).trim();
}

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
    const stamp = m ? `${m[4]} ${m[5]}Z` : '';
    const { inFlight } = parseSeatFields(bulletText);
    rows.push({ name: bulletName(firstLine), status: parsed.status, stamp, inFlight });
  }
  return rows;
}

export interface SeatBulletText {
  /** `bulletName`'s derivation — same rule `listSeats`'s `name` uses. */
  name: string;
  /** The bullet's whole text, continuation lines included (joined by `\n`, not trimmed). */
  text: string;
}

/**
 * RCB-130: every top-level SEATS bullet, in section order — unlike `listSeats`, this does NOT
 * require the bullet's first line to parse as a stamped `UP|DOWN` bullet (`parseSeatStamp`), so a
 * hand-typed or malformed bullet still gets an entry. Used by `state.ts`'s `checkFindings` (via
 * the caller that gathers `CheckInput.seatBullets` — core stays split from `state.ts` so the two
 * never import each other) to scan every bullet's text for a hand-typed `OWNER QUEUE` line.
 */
export function seatBulletTexts(seatsSection: string): SeatBulletText[] {
  const lines = seatsSection.split('\n');
  return bulletSpans(lines).map((span) => {
    const bulletLines = lines.slice(span.start, span.end);
    return { name: bulletName(bulletLines[0] ?? ''), text: bulletLines.join('\n') };
  });
}

/**
 * RCB-160 slice 2: every top-level SEATS bullet (`bulletSpans`, the same split `seatBulletTexts`
 * uses), whole text with continuation lines kept, its FIRST line re-prefixed `[<key>] ` — an
 * existing `[x] ` prefix (`BULLET_REPO_PREFIX_RE`, written by `formatSeatBullet`/
 * `rewriteSeatBulletBody` from the board's own `boardDisplayName`) is REPLACED, never left
 * alongside a second one; an unprefixed bullet gets `[<key>] ` inserted right after `- ` or
 * `- **`. Used by the WORKSPACE view (`workspaceSeatLines`, `workspace.ts`) so a member's SEATS
 * bullets show under the `repos[].key` the workspace's OWN OWNER QUEUE/LEASES lines already print
 * — a member may call its own board something else entirely (`workspace-key-name-mismatch`
 * warns about exactly that mismatch) — never under whatever the member calls itself. A placeholder
 * section (no `- ` line) -> `[]`.
 */
export function keySeatBullets(seatsSection: string, key: string): string[] {
  const lines = seatsSection.split('\n');
  const prefix = `[${key}] `;
  return bulletSpans(lines).map((span) => {
    const bulletLines = lines.slice(span.start, span.end);
    const firstLine = bulletLines[0] ?? '';
    const reprefixed = BULLET_REPO_PREFIX_RE.test(firstLine)
      ? firstLine.replace(BULLET_REPO_PREFIX_RE, `$1${prefix}`)
      : firstLine.replace(/^(- (?:\*\*)?)/, `$1${prefix}`);
    return [reprefixed, ...bulletLines.slice(1)].join('\n');
  });
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

  const config = input.config ?? defaultBoardConfig();
  const members = input.members ?? [];
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

  /**
   * RCB-103: evaluated FIRST, ahead of `assigned` — a seat that owns a PARENT (a non-done card of
   * its own that HAS steps, RCB-68) should be pointed at that plan's next clear step, not a
   * random todo card elsewhere. A "parent" here is any non-done card of mine with `stepsOf(...)`
   * non-empty; a plain card contributes nothing (`stepsOf` returns `[]`), so a board with no
   * phases in play behaves byte-for-byte as before. Cards are walked in LIST order (never
   * re-sorted — `stepsOf` already gives its own steps in phase order) and the first (parent,
   * step) pair found wins; a parent whose every step is done/blocked/not-mine is skipped, not
   * stopped on, so a later qualifying parent still gets a chance.
   */
  let parentStep: Card | null = null;
  let nextCardStep: { parentId: string; gateBy: string | null } | null = null;
  for (const c of input.cards) {
    if ((c.assignee ?? '').trim().toLowerCase() !== wantedAssignee) continue;
    if (findColumn(config, c.status)?.done === true) continue;
    const step = stepsOf(c.id, input.cards).find((s) => {
      if (findColumn(config, s.status)?.done === true) return false;
      if (blockedReason(s, input.cards, config, members) !== null) return false;
      const stepAssignee = (s.assignee ?? '').trim().toLowerCase();
      return stepAssignee === '' || stepAssignee === wantedAssignee;
    });
    if (step !== undefined) {
      parentStep = step;
      const state = gateState(step, input.cards, config, members);
      nextCardStep = { parentId: c.id, gateBy: state.kind === 'clear' ? state.by : null };
      break;
    }
  }

  let nextCard: Card | null = null;
  let nextCardReason: NextCardReason = null;
  if (parentStep !== null) {
    nextCard = parentStep;
    nextCardReason = 'parent-step';
  } else if (assigned !== undefined) {
    nextCard = assigned;
    nextCardReason = 'assigned';
  } else if (picked !== null) {
    nextCard = picked;
    nextCardReason = anyPrioritised ? 'priority' : 'first-todo';
  }

  const openDecisions = input.cards.filter((c) => needsDecision(c));
  const answeredNotAck = answeredDecisions(input.cards).filter((r) => !r.acknowledged);

  /**
   * RCB-118: WHY `nextCard` is null, computed only in that case (never for a seat that has a next
   * card — the empty-board question does not apply to it). `todoForOthers` mirrors `assigned`'s
   * own matching (case-insensitive, trimmed) but the opposite way: assignee set AND not this seat.
   * `gated` walks every non-done card, not just todo — a card in ANY non-done column can be gated.
   */
  const nextCardEmpty =
    nextCard !== null
      ? null
      : {
          todoForOthers: todoCards.filter((c) => {
            const a = (c.assignee ?? '').trim().toLowerCase();
            return a !== '' && a !== wantedAssignee;
          }).length,
          gated: input.cards.filter(
            (c) =>
              findColumn(config, c.status)?.done !== true &&
              blockedReason(c, input.cards, config, members) !== null,
          ).length,
          awaitingOwner: openDecisions.length,
        };

  const fields = seatsLine !== null ? parseSeatFields(seatsLine) : { inFlight: null, owes: null };

  return {
    name: input.name,
    seatsLine,
    ownBlock: input.ownBlock,
    coordinatorBlock,
    nextCard,
    nextCardReason,
    nextCardStep: nextCardReason === 'parent-step' ? nextCardStep : null,
    openDecisions,
    answeredNotAck,
    nextCardEmpty,
    rig: input.rig ?? null,
    inFlight: fields.inFlight,
    owes: fields.owes,
    systems: input.systems ?? null,
    leases: liveLeases(input.leases ?? { leases: [], windows: [] }, input.now),
    // Any bullet counts, stamped or not — `listSeats` keeps only stamped ones.
    solo: bulletSpans((input.seatsSection ?? '').split('\n')).length === 0,
    repo: input.repo ?? null,
  };
}

/** RCB-129: one line of the seat bundle's "Answered, not acknowledged" block — same shape as
 * `ownerQueueLine` (state.ts), plus who decided it, what they chose, and when. */
function answeredDecisionLine(row: AnsweredDecisionRow): string {
  return (
    `${row.id} · ${row.question} → ${formatAnsweredChoice(row)} ` +
    `(decided ${row.decidedAt} by ${row.decidedBy ?? '(unknown)'})`
  );
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

  // RCB-160: `b.repo` null (no board name gathered, or every existing caller/test) prints exactly
  // today's header.
  const repoPrefix = b.repo !== null && b.repo.trim().length > 0 ? `[${b.repo}] ` : '';
  lines.push(`# seat ${repoPrefix}${b.name} — ${toIso(now)}`, '');

  if (b.solo) {
    lines.push(
      'solo board — seats, the log and leases apply once more than one agent runs (repoboard init --practices)',
      '',
    );
  }

  const inFlightOwesIsPlaceholder = b.inFlight === null && b.owes === null;
  if (!b.solo || !inFlightOwesIsPlaceholder) {
    lines.push('## In flight / owes');
    lines.push(`in-flight: ${b.inFlight ?? '(none recorded)'}`);
    lines.push(`owes: ${b.owes ?? '(none recorded)'}`);
    if (b.systems !== null) lines.push(b.systems.line);
    lines.push('');
  } else if (b.systems !== null) {
    lines.push(b.systems.line, '');
  }

  if (!b.solo || b.seatsLine !== null) {
    lines.push('## SEATS line');
    lines.push(b.seatsLine ?? `(no SEATS line mentions ${b.name})`, '');
  }

  // RCB-131: right after the SEATS line block — a seat colliding with another over a resource
  // sees it here, cold, instead of only after running `lease list` by hand.
  if (!b.solo || b.leases.length > 0) {
    lines.push('## Leases');
    lines.push(renderLeaseLines(b.leases, now, { as: b.name }), '');
  }

  if (!b.solo || b.rig !== null) {
    lines.push('## Rig (.repoboard/local/RIG.md)');
    lines.push(b.rig ?? '(no .repoboard/local/RIG.md — run repoboard local init)', '');
  }

  if (!b.solo || b.ownBlock !== null) {
    lines.push(`## Last block — ${b.name.toUpperCase()}`);
    lines.push(b.ownBlock ? formatLogBlock(b.ownBlock.block) : `(no log block for ${b.name})`, '');
  }

  if (!isCoordinator && (!b.solo || b.coordinatorBlock !== null)) {
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
      b.nextCardReason === 'parent-step' && b.nextCardStep
        ? `(next unblocked step of ${b.nextCardStep.parentId} — ${
            b.nextCardStep.gateBy !== null ? `gate ${b.nextCardStep.gateBy}` : 'no gate'
          })`
        : b.nextCardReason === 'assigned'
          ? `(assigned to ${b.name})`
          : b.nextCardReason === 'priority'
            ? `(first ${b.nextCard.priority}-priority todo)`
            : '(first todo; nothing assigned, nothing prioritised)',
    );
  } else if (b.nextCardEmpty) {
    const { todoForOthers, gated, awaitingOwner } = b.nextCardEmpty;
    lines.push(
      `(no todo card for ${b.name} — ${todoForOthers} todo assigned to other seats · ${gated} gated · ${awaitingOwner} waiting on the owner)`,
    );
  } else {
    lines.push('(no todo card)');
  }
  lines.push('');

  lines.push('## Open decisions');
  lines.push(
    b.openDecisions.length > 0 ? b.openDecisions.map(ownerQueueLine).join('\n') : '(none)',
  );
  lines.push('');

  lines.push('## Answered, not acknowledged');
  lines.push(
    b.answeredNotAck.length > 0 ? b.answeredNotAck.map(answeredDecisionLine).join('\n') : '(none)',
  );

  return `${lines.join('\n')}\n`;
}
