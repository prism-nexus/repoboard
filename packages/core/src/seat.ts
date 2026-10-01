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
import {
  describeLiveness,
  type HolderLiveness,
  NO_PANE_TAG,
  type SeatHolderInfo,
} from './holder.js';
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
  /** RCB-199: every recorded `seat:<name>` holder with its tag and label (`seatHolderInfos`),
   *  gathered by the caller (core stays I/O-free). Absent/`[]` (a caller that read none, or every
   *  existing test) is inert: `SeatBundle.holder` is then `null`. */
  holders?: readonly SeatHolderInfo[];
  /** RCB-199: why the holders could not be read (`seats.yml` unreadable), else `null`/absent.
   *  Passed through to `SeatBundle.holderError` — never swallowed into an empty `holders`. */
  holderError?: string | null;
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
  /** RCB-199: the `input.holders` entry whose seat is `name` (trimmed, case-insensitive), else
   *  `null` — no lease recorded for it, or no holders gathered. Not rendered (`renderSeatBundle`
   *  is unchanged); a caller reads it. */
  holder: SeatHolderInfo | null;
  /** RCB-199: `input.holderError ?? null` — never re-derived. */
  holderError: string | null;
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
 * RCB-195: `span` (a bullet's leading bold span) without its ` · <holder label>` tail, when the
 * bullet carries one. The holder label (`1D3F · rcb builder`) names the board's SHORT NAME and the
 * seat's own name; it is decoration on the bullet, like the RCB-160 `[repo] ` prefix, and must
 * never be matched as the seat's name — a seat called `rcb` would otherwise own every bullet
 * whose label says `rcb builder`. `holder` is `parseSeatHolderLabel`'s answer for the same line,
 * `null` when there is none (the span is then returned untouched).
 */
function withoutHolderLabel(span: string, holder: string | null): string {
  if (holder === null) return span;
  const at = span.lastIndexOf(holder);
  return at === -1 ? span : span.slice(0, at).replace(/\s+·\s*$/, '');
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
  if (bold?.[1] !== undefined) return withoutHolderLabel(bold[1], parseSeatHolderLabel(firstLine));
  const colon = content.indexOf(':');
  return colon === -1 ? content : content.slice(0, colon);
}

/**
 * RCB-130: a top-level `- in-flight: …` or `- owes: …` line is never a real bullet on its own —
 * nobody writes a standalone bullet to say only that; it is what a hand-edit leaves behind when a
 * continuation line loses its 2-space indent and gets typed as its own `- ` item instead (a member
 * board's STATE.md, 2026-09-25 01:56Z: a coordinator bullet replace left exactly this behind, surviving as
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
 * RCB-196: a seat name as it is COMPARED — trimmed, whitespace runs collapsed to one space,
 * lowercased. The ONE normalizer `locateSeatBullet`'s exact pass runs on both sides, so how `name`
 * and a bullet's own name are folded can never differ. RCB-200: exported, so `seat-check.ts` groups
 * bullets and holders by the very key the seat verbs find them by.
 */
export function seatNameKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * RCB-196: a STAMPED bullet's seat name — `SEAT_BULLET_RE` group 2 (`raw`) through
 * `normalizeSeatName`, with the bullet's own `[repo]` prefix (group 1, `undefined` when it has
 * none) as the board name, so the spellings RCB-172 stopped writing (`[repoboard] repoboard
 * builder`) still resolve to the bare name. `raw` unchanged when it is not a normalizable name.
 */
function stampedSeatName(raw: string, repoPrefix: string | undefined): string {
  const n = normalizeSeatName(raw, repoPrefix ?? '');
  return n.ok ? n.name : raw;
}

/**
 * RCB-200: the seat name a bullet's first line CLAIMS — `locateSeatBullet`'s pass-1 rule, lifted
 * out so `stampedSeatBullets` (the `check` findings) and the seat verbs can never disagree about
 * whose bullet it is. A stamped bullet (`parseSeatStamp` non-null) names its seat with
 * `SEAT_BULLET_RE` group 2 through `stampedSeatName`; an unstamped one with `bulletLabel`.
 * Not case- or whitespace-folded: compare through `seatNameKey`.
 */
function bulletOwnName(firstLine: string): string {
  const stamp = parseSeatStamp(firstLine) !== null ? SEAT_BULLET_RE.exec(firstLine) : null;
  return stamp !== null ? stampedSeatName(stamp[2] ?? '', stamp[1]) : bulletLabel(firstLine);
}

/**
 * The seat's own bullet among `bullets` (each already split into its lines) — three passes, the
 * first hit wins. Returns the bullet's index in `bullets`, or -1 when nothing matches — including
 * an empty `bullets` array, which a placeholder section (no `- ` line) always produces. RCB-58:
 * this is the ONE private helper `findSeatLine` and `replaceSeatBullet` both call, so the two can
 * never disagree about which bullet is "mine".
 *
 * 1. EXACT, over every bullet (RCB-196): the bullet's own seat name equals `name` under
 *    `seatNameKey` (case, edge and inner whitespace folded — nothing else). A stamped bullet
 *    (`parseSeatStamp` non-null, `- **[repo] <name>: UP|DOWN <date> <time>Z · <holder>.**`) names its
 *    seat with `SEAT_BULLET_RE` group 2 — the `[repo] ` prefix (group 1) and the holder label
 *    (group 6) are decoration, never the name — run through `normalizeSeatName` with the
 *    bullet's OWN prefix as the board, so a legacy `- **[repoboard] repoboard builder: UP …**`
 *    (RCB-172) still owns `builder`, while `builder-2`, `web builder` and an unprefixed
 *    `**repoboard builder: UP**` do not. An unstamped one names it with `bulletLabel`.
 * 2. LEGACY label, UNSTAMPED bullets only: `name` as a whole word (`\b`, case-insensitive) inside
 *    `bulletLabel`, so a hand-written `- **repoboard builder (its own terminal)**…` is still found
 *    by `builder`.
 * 3. LEGACY first line, UNSTAMPED bullets only: `name` as a whole word anywhere in the first line.
 *
 * A stamped bullet is found by pass 1 or not at all. Before RCB-196 the `\b` test ran on every
 * bullet, so `builder` owned `- **[r] builder-2: UP …**` (`-` is a word boundary), a `web builder`
 * bullet and the `UP` of anyone's stamp, and `seat builder --down` could rewrite builder-2's line.
 *
 * History, shortened. RCB-48 (dogfood, 2026-09-18 21:07Z): `repoboard seat builder` returned the
 * COORDINATOR's bullet, whose prose said "the builder's RCB-47 card move" ahead of the real
 * builder bullet — a first-line match cannot tell "the builder bullet" from "a bullet about the
 * builder", so the label is read before the prose (passes 1-2 before 3). RCB-168: a seat with no
 * bullet of its own took over another seat's STAMPED bullet through its prose ("[repoboard] builder
 * told to stand down"), `--down` REPLACED it; a stamped bullet's label names the seat it belongs
 * to, so only unstamped (legacy) bullets are ever matched loosely.
 */
function locateSeatBullet(bullets: readonly (readonly string[])[], name: string): number {
  const typed = name.trim();
  const wanted = seatNameKey(name);
  if (wanted.length === 0) return -1;

  for (let i = 0; i < bullets.length; i++) {
    if (seatNameKey(bulletOwnName(bullets[i]?.[0] ?? '')) === wanted) return i;
  }

  const wordRe = new RegExp(`\\b${escapeRegExp(typed)}\\b`, 'i');
  for (let i = 0; i < bullets.length; i++) {
    const firstLine = bullets[i]?.[0] ?? '';
    if (parseSeatStamp(firstLine) !== null) continue;
    if (wordRe.test(bulletLabel(firstLine))) return i;
  }
  for (let i = 0; i < bullets.length; i++) {
    const firstLine = bullets[i]?.[0] ?? '';
    if (parseSeatStamp(firstLine) !== null) continue;
    if (wordRe.test(stripBulletRepoPrefix(firstLine))) return i;
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
 * RCB-172: the label a seat carries in its SEATS bullet — `[<repo>] <name>` when the board's name
 * (`boardDisplayName`, RCB-160) is known and non-empty, else the bare `<name>`. The ONE place that
 * writes it: `formatSeatBullet` builds the bullet's bold span with it, and `normalizeSeatName`
 * hands the same string back for the CLI's confirmations, so what a command prints is exactly what
 * the bullet says.
 */
export function seatLabel(name: string, repo?: string | null): string {
  return repo !== undefined && repo !== null && repo.trim().length > 0 ? `[${repo}] ${name}` : name;
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
 *
 * RCB-195: `holderLabel` (`holderLabel(tag, shortName, seat)` in `holder.ts`, e.g.
 * `1D3F · rcb builder`) is written after the stamp, still inside the bold span —
 * `- **[r] name: UP <stamp> · <label>.** text`. `undefined`/`null`/blank (the default) omits it,
 * so every existing caller keeps writing exactly today's bullet. The label goes through
 * `cleanHolderLabel`, so it can never break the bullet.
 */
export function formatSeatBullet(
  name: string,
  status: 'UP' | 'DOWN',
  text: string,
  now: Date,
  repo?: string,
  holderLabel?: string | null,
): string {
  const iso = toIso(now);
  const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  const body = formatSeatBulletBody(text);
  return `- **${seatLabel(name, repo)}: ${status} ${stamp}${holderLabelSegment(holderLabel)}.** ${body}`;
}

/**
 * RCB-195: a holder label as it may sit inside a bullet's bold span — `*` dropped (`**` would
 * close the span early), whitespace runs (a newline would end the bullet) collapsed to one space,
 * trimmed; `null` when nothing is left. `SEAT_BULLET_RE` reads the label back under the same
 * `[^*]` rule, so what this returns is exactly what `parseSeatHolderLabel` gives back.
 */
function cleanHolderLabel(label: string | null | undefined): string | null {
  if (label === undefined || label === null) return null;
  const clean = label.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 0 ? clean : null;
}

/** RCB-195: ` · <label>` (the segment between the stamp and `.**`), or `''` when there is no label. */
function holderLabelSegment(label: string | null | undefined): string {
  const clean = cleanHolderLabel(label);
  return clean === null ? '' : ` · ${clean}`;
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
 *
 * RCB-195: the bullet's ` · <holder label>` (if any) is kept byte-for-byte too — a body rewrite
 * says nothing about who holds the seat, so it never adds, changes or drops the label.
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
  const holder = m[6] !== undefined ? ` · ${m[6]}` : '';
  const body = formatSeatBulletBody(text);
  const nextRepo = repo !== undefined ? repo : existingRepo;
  const prefix = nextRepo !== undefined && nextRepo.trim().length > 0 ? `[${nextRepo}] ` : '';
  return {
    bullet: `- **${prefix}${label}: ${status} ${date} ${time}Z${holder}.** ${body}`,
    status,
    stamp: `${date} ${time}Z`,
  };
}

/**
 * RCB-87: matches the first line of a bullet written by `formatSeatBullet` —
 * `- **<name>: <UP|DOWN> <YYYY-MM-DD> <HH:MM>Z.**` — the trailing `.` and closing `**` optional
 * (hand-written bullets omit them), and the `<HH:MM>` half tolerated even when it is not all
 * digits (`18:0xZ`), since that shape has to be recognised as "a stamp that fails to parse", not
 * "not a seat bullet at all". No `$`/end anchor: everything after the stamp (the bullet's prose)
 * is irrelevant to the match.
 *
 * RCB-160: an optional `[<repo>] ` — its OWN capture group (1) — right after the opening `**`, so
 * a repo prefix is never absorbed into the label group (2).
 *
 * RCB-195: an optional ` · <holder label>` between the stamp and the closing `.**` — its own
 * group (6), the label without the separator. It is read only when `.**` follows it (lazily, so
 * the FIRST `.**` ends it): a hand-written bullet's `Z, cold-started …` never has one, and a
 * label the regex cannot place leaves the match exactly as it was before this group existed.
 * The label is INSIDE the match, so `m[0].length` still ends where it does for an unlabeled
 * bullet (`parseSeatFields` slices the prose tail off it). Groups: (1) repo, (2) label,
 * (3) status, (4) date, (5) time, (6) holder label.
 */
const SEAT_BULLET_RE =
  /^-\s+\*\*(?:\[([^\]]+)\]\s+)?([^*:]+):\s+(UP|DOWN)\s+(\S+)\s+(\S+?)Z(?:\s+·\s+([^*]+?)(?=\.\*\*))?\.?\*{0,2}/;
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
 * RCB-195: pure — the ` · <holder label>` a bullet carries after its stamp (`1D3F · rcb builder`),
 * first line only; `null` when the bullet has none (every bullet written before RCB-195) or is not
 * a seat bullet at all. The one reader of `SEAT_BULLET_RE`'s group 6.
 */
export function parseSeatHolderLabel(bullet: string): string | null {
  const firstLine = bullet.split('\n')[0] ?? '';
  return SEAT_BULLET_RE.exec(firstLine)?.[6] ?? null;
}

/**
 * RCB-169: a moment OTHER than the bullet's own UP stamp at which THIS seat was seen alive.
 * `--update` deliberately keeps the UP stamp (RCB-88), so a seat that has been UP for a day and
 * updated its bullet, or logged, five minutes ago looks stale by the stamp alone — and a second
 * session's `--up` then overwrote its bullet (a member board, 2026-09-29: ops' `in-flight:` line erased).
 * The CALLER gathers these (core stays I/O-free); `seatSightings` is the one builder.
 */
export interface SeatSighting {
  /** `log`: this seat's newest log block on this board. `STATE`: STATE.md's `Written <iso> by
   *  <actor>` stamp, when `<actor>` is this seat. */
  source: 'log' | 'STATE';
  at: Date;
  /** `STATE` only: the `<actor>` half of the stamp line, as written. */
  actor?: string;
}

/** Which moment `seatUpConflict` found freshest — the bullet's own stamp, or a `SeatSighting`. */
export type SeatLivenessSource = 'UP' | SeatSighting['source'];

export interface SeatUpConflict {
  /** The bullet's own UP stamp, `YYYY-MM-DD HH:MMZ` — `null` when it does not parse (a redacted
   *  hand-written stamp such as `18:0x`), in which case a sighting is the only evidence. */
  stamp: string | null;
  /** Minutes since `source`'s own moment (so "logged 10 min ago" is always true of the log). The
   *  refusal itself was decided by the newest moment of ANY source, at most `SAME_EVENT_MS` newer. */
  minutesAgo: number;
  /** Which source to NAME: the highest-precedence one (UP, then log, then STATE) among those
   *  within `SAME_EVENT_MS` of the newest moment. */
  source: SeatLivenessSource;
  /** `source === 'STATE'` only: who STATE.md says wrote it. */
  actor?: string;
}

/**
 * RCB-169: moments this close together are ONE event, so the refusal names the most informative
 * source instead of whichever was a few seconds later. The UP stamp has MINUTE resolution
 * (`formatSeatBullet`) while every `--up` also restamps STATE.md to the second, and a log by an UP
 * seat restamps STATE.md right after the block — without this, the commonest refusal (a second
 * `--up` five minutes after the first) would say "STATE written", never "UP".
 */
const SAME_EVENT_MS = 60_000;

/** Naming precedence when several sources are the same event: most informative first. */
const SOURCE_PRECEDENCE: readonly SeatLivenessSource[] = ['UP', 'log', 'STATE'];

/**
 * RCB-87: pure — non-null iff `bullet` (the seat's own standing SEATS bullet, or `null` when it
 * has none) parses as `UP` AND the seat was seen alive within `windowMinutes` of `now`. RCB-169:
 * "seen alive" is the NEWEST of the bullet's own UP stamp and every `sightings` moment (the seat's
 * newest log block, STATE.md's stamp when this seat wrote it), because `--update` keeps the UP
 * stamp on purpose. `sightings` is a REQUIRED argument — it can only ever add a refusal, and a
 * caller that has nothing to pass says so with `[]` rather than forgetting it. A DOWN or absent
 * bullet is never a conflict whatever the sightings say (a seat logs its last block and only then
 * stands down). A future moment (clock skew) counts as a conflict too — `now - at` is then
 * negative, still `<=` the window — same rule `presence.ts`'s `isActive` uses for a card's
 * `updated`. `stamp` is rendered `YYYY-MM-DD HH:MMZ` from the PARSED `at` (not the raw bullet
 * text), so it is always well-formed; `null` only when the bullet's stamp fails to parse.
 * The refusal is decided by the newest moment alone; `source` (see `SAME_EVENT_MS`) only names it.
 */
export function seatUpConflict(
  bullet: string | null,
  now: Date,
  windowMinutes: number,
  sightings: readonly SeatSighting[],
): SeatUpConflict | null {
  if (bullet === null) return null;
  const parsed = parseSeatStamp(bullet);
  if (parsed?.status !== 'UP') return null;
  const moments: { source: SeatLivenessSource; at: Date; actor?: string }[] = [];
  if (parsed.at !== null) moments.push({ source: 'UP', at: parsed.at });
  for (const s of sightings) moments.push({ source: s.source, at: s.at, actor: s.actor });
  if (moments.length === 0) return null;
  const newestMs = Math.max(...moments.map((m) => m.at.getTime()));
  const diffMs = now.getTime() - newestMs;
  if (diffMs > windowMinutes * 60_000) return null;
  // The newest moment is always among these (its own distance is 0), so `named` is never absent.
  const named = moments
    .filter((m) => newestMs - m.at.getTime() <= SAME_EVENT_MS)
    .sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source))[0];
  if (named === undefined) return null;
  let stamp: string | null = null;
  if (parsed.at !== null) {
    const iso = toIso(parsed.at);
    stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  }
  return {
    stamp,
    minutesAgo: Math.round((now.getTime() - named.at.getTime()) / 60_000),
    source: named.source,
    ...(named.source === 'STATE' && named.actor !== undefined ? { actor: named.actor } : {}),
  };
}

/**
 * RCB-169: the refusal's "which source was fresh" phrase, from the `SeatUpConflict` alone — the
 * one place that words it, so the CLI never re-derives it from `source`.
 * `UP 5 min ago (stamped 2026-09-21 22:32Z)` · `logged 5 min ago` · `STATE written 5 min ago by ops`.
 */
export function describeSeatUpConflict(c: SeatUpConflict): string {
  if (c.source === 'log') return `logged ${c.minutesAgo} min ago`;
  if (c.source === 'STATE') {
    return `STATE written ${c.minutesAgo} min ago by ${c.actor ?? '(unknown)'}`;
  }
  return c.stamp !== null
    ? `UP ${c.minutesAgo} min ago (stamped ${c.stamp})`
    : `UP ${c.minutesAgo} min ago`;
}

/**
 * RCB-172: `normalizeSeatName`'s first step — strip a leading `[<boardName>]` (case-insensitive)
 * from `raw`, trimmed. No board name (empty) strips nothing.
 */
function stripBoardBracket(raw: string, boardName: string): string {
  const s = raw.trim();
  const board = boardName.trim();
  if (board.length === 0) return s;
  const bracket = `[${board}]`;
  return s.slice(0, bracket.length).toLowerCase() === bracket.toLowerCase()
    ? s.slice(bracket.length).trim()
    : s;
}

const LOG_TS_WITH_ZONE_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;

/**
 * RCB-200: a log block's `ts` as epoch milliseconds — `null` unless it carries a date, a time AND
 * a zone (`LOG_TS_WITH_ZONE_RE`) and parses. A log `ts` is guaranteed nothing (RCB-54): a date-only
 * one would parse as midnight UTC and a zoneless one as the host's local time, each a
 * plausible-looking moment nobody wrote, so a missing answer stays `null`. The ONE reading of
 * "this `ts` is a moment": `seatSightings` (RCB-169) and `seatCheckFindings` (`seat-check.ts`) both
 * call it, so a seat is never "seen alive" by one rule and "logged while DOWN" by another.
 */
export function zonedLogMs(ts: string): number | null {
  if (!LOG_TS_WITH_ZONE_RE.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** RCB-172: `normalizeSeatName`'s outcome — `name` is the bare seat name, `label` what the bullet carries. */
export type SeatNameResult =
  | { ok: true; name: string; label: string }
  | { ok: false; error: string };

/**
 * RCB-172: one seat, one name. Agents type the prefix the bullet carries (13/28 RCB card titles,
 * 46/97 member-board titles repeat it), so `seat "repoboard builder" --up` made `[repoboard] repoboard
 * builder` and `seat "[repoboard] builder"` made `[repoboard] [repoboard] builder` — two bullets
 * for one seat. Every entry point that takes a seat name (CLI `seat`, `log --as`/`--last`/`show
 * --seat`, MCP `append_repo_log`/`get_log`/`get_seat`) calls THIS function, so the three spellings
 * can never reach the SEATS section or the log as three names.
 *
 * Order, each step once, all case-insensitive: strip a leading `[<boardName>]`; then a leading
 * `<boardName>` WORD (followed by whitespace and more text — a seat that IS called the board's
 * name stays as it is); a result still starting with `[` is an error — that prefix names another
 * board, and stripping it would file the seat under the wrong repo's name. `boardName` is
 * `boardDisplayName(config, root)`, the value RCB-160 writes as the bullet/log prefix — never a
 * second source. An empty `boardName` strips nothing (an unconfigured rule is inert), though a
 * leading `[` is still refused. `label` is `seatLabel(name, boardName)`.
 */
export function normalizeSeatName(raw: string, boardName: string): SeatNameResult {
  const typed = raw.trim();
  if (typed.length === 0) return { ok: false, error: 'seat name must not be empty' };
  const board = boardName.trim();
  let name = stripBoardBracket(typed, board);
  if (board.length > 0 && name.slice(0, board.length).toLowerCase() === board.toLowerCase()) {
    const rest = name.slice(board.length);
    if (/^\s/.test(rest) && rest.trim().length > 0) name = rest.trim();
  }
  if (name.length === 0) {
    return { ok: false, error: `seat name "${typed}" is empty once the board prefix is removed` };
  }
  if (name.startsWith('[')) {
    return {
      ok: false,
      error:
        `seat name "${typed}": that prefix names another board` +
        `${board.length > 0 ? ` (this board is "${board}")` : ''} — type the bare seat name`,
    };
  }
  return { ok: true, name, label: seatLabel(name, board) };
}

/**
 * RCB-169: every extra moment THIS seat was seen alive, for `seatUpConflict` — pure, the store/CLI
 * only gather the facts:
 *
 * - `lastLogTs`: the `ts` of this seat's newest log block on this board (`lastRepoLogBlock`).
 *   A `ts` that does not parse, or lacks a time or a zone (RCB-54: a hand-written block's
 *   `18:0xZ`, a date-only heading) contributes NOTHING — a missing answer stays out rather than
 *   becoming a guessed moment.
 * - `state`: STATE.md's `Written <iso> by <actor>` stamp, counted ONLY when `<actor>` is this
 *   seat — bare, `[<boardName>]`-prefixed or `<boardName>`-prefixed (`normalizeSeatName`'s rule),
 *   case-insensitive. Another seat's write of STATE.md
 *   says nothing about this one, and `null` (no STATE.md) contributes nothing.
 */
export function seatSightings(input: {
  seat: string;
  boardName: string;
  lastLogTs: string | null;
  state: { stamp: string; actor: string } | null;
}): SeatSighting[] {
  const out: SeatSighting[] = [];
  // Only a `ts` with a date, a time AND a zone counts (`zonedLogMs`, RCB-54).
  const logMs = input.lastLogTs !== null ? zonedLogMs(input.lastLogTs) : null;
  if (logMs !== null) out.push({ source: 'log', at: new Date(logMs) });
  if (input.state !== null) {
    // Both sides through `normalizeSeatName`: a STATE stamp written before RCB-172 may carry
    // `repoboard builder` or `[repoboard] builder` for the seat now called `builder`, and an actor
    // of another board's (`[acme] ops`) or one that is no seat name at all normalizes to an error.
    const wanted = normalizeSeatName(input.seat, input.boardName);
    const actor = normalizeSeatName(input.state.actor, input.boardName);
    const ms = Date.parse(input.state.stamp);
    if (
      wanted.ok &&
      actor.ok &&
      wanted.name.toLowerCase() === actor.name.toLowerCase() &&
      !Number.isNaN(ms)
    ) {
      out.push({ source: 'STATE', at: new Date(ms), actor: input.state.actor });
    }
  }
  return out;
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
 * RCB-130 (a member's STATE.md, 2026-09-25 01:56Z: a coordinator bullet carried TWO `in-flight:`/`owes:`
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
  return seatRowBullets(seatsSection).map((entry) => entry.row);
}

/**
 * RCB-199: `listSeats`' one pass, each row kept with the bullet text it was read from — so
 * `seatListRows` reads a row's label off THAT bullet, never off a second walk that has to skip the
 * same bullets in the same order to line up.
 */
function seatRowBullets(seatsSection: string): { row: SeatRow; bullet: string }[] {
  const lines = seatsSection.split('\n');
  const spans = bulletSpans(lines);
  const entries: { row: SeatRow; bullet: string }[] = [];
  for (const span of spans) {
    const bulletLines = lines.slice(span.start, span.end);
    const bulletText = bulletLines.join('\n');
    const parsed = parseSeatStamp(bulletText);
    if (!parsed) continue;
    const firstLine = bulletLines[0] ?? '';
    const m = SEAT_BULLET_RE.exec(firstLine);
    const stamp = m ? `${m[4]} ${m[5]}Z` : '';
    const { inFlight } = parseSeatFields(bulletText);
    entries.push({
      row: { name: bulletName(firstLine), status: parsed.status, stamp, inFlight },
      bullet: bulletText,
    });
  }
  return entries;
}

/**
 * RCB-199: a `SeatRow` plus who holds that seat. `label` is the bullet's own holder label
 * (`parseSeatHolderLabel`, what the bullet SAYS); `tag` and `live` come from the recorded lease
 * (`seats.yml`, what the file KNOWS). Each is `null` when there is no answer — a bullet with no
 * label, a seat with no lease, a holder with no pane — never a placeholder string.
 */
export type SeatListRow = SeatRow & {
  label: string | null;
  tag: string | null;
  live: HolderLiveness | null;
};

/**
 * RCB-199: `listSeats`' rows (same order, same skipping — `SeatRow` and `listSeats` are unchanged,
 * `workspace.ts` reads them) joined to `holders`. `label` is `parseSeatHolderLabel` of the row's
 * own bullet; `tag` and `live` are those of the holder whose `seat` equals the row's `name`
 * (case-insensitive), else `null`. `holders` defaults to `[]` — no lease information is inert: every
 * `tag` and `live` is `null`, the rows are otherwise exactly `listSeats`'.
 */
export function seatListRows(
  seatsSection: string,
  holders: readonly SeatHolderInfo[] = [],
): SeatListRow[] {
  return seatRowBullets(seatsSection).map(({ row, bullet }) => {
    const holder = holders.find((h) => h.seat.toLowerCase() === row.name.toLowerCase());
    return {
      ...row,
      label: parseSeatHolderLabel(bullet),
      tag: holder?.tag ?? null,
      live: holder?.liveness ?? null,
    };
  });
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
 * RCB-200: what one STAMPED SEATS bullet says, for `seatCheckFindings` (`seat-check.ts`). Every
 * field is what the first line carries, or `null` — never a guess.
 */
export interface SeatBulletFact {
  /** 1-based over ALL of `bulletSpans` (unstamped bullets count), so "bullet 3" is the third
   *  top-level `- ` bullet a reader counts in the section. */
  position: number;
  /** The bullet's own `[repo]` prefix, verbatim (`SEAT_BULLET_RE` group 1); `null` when it has none. */
  board: string | null;
  /** `bulletOwnName` — the seat name `locateSeatBullet` matches on, as written (not case-folded). */
  name: string;
  /** `seatNameKey(name)` — what the seat verbs compare; two facts with one key are one seat. */
  key: string;
  status: 'UP' | 'DOWN';
  /** `parseSeatStamp`'s `at`: `null` when the stamp's date or time does not parse. */
  at: Date | null;
  /** `parseSeatHolderLabel`: `1D3F · rcb builder`, `null` when the bullet carries none. */
  label: string | null;
}

/**
 * RCB-200: every bullet of `seatsSection` whose first line `parseSeatStamp` accepts, in section
 * order, as a `SeatBulletFact`. Splits with `bulletSpans` and names with `bulletOwnName` — the
 * split and the name `locateSeatBullet` uses, so a fact is exactly the bullet a seat verb would
 * find or miss. An unstamped bullet (`- Owner tasks elsewhere: …`) is skipped but still counts in
 * `position`. A placeholder section (no `- ` line) -> `[]`.
 */
export function stampedSeatBullets(seatsSection: string): SeatBulletFact[] {
  const lines = seatsSection.split('\n');
  const facts: SeatBulletFact[] = [];
  bulletSpans(lines).forEach((span, i) => {
    const firstLine = lines[span.start] ?? '';
    const parsed = parseSeatStamp(firstLine);
    if (parsed === null) return;
    const name = bulletOwnName(firstLine);
    facts.push({
      position: i + 1,
      board: SEAT_BULLET_RE.exec(firstLine)?.[1] ?? null,
      name,
      key: seatNameKey(name),
      status: parsed.status,
      at: parsed.at,
      label: parseSeatHolderLabel(firstLine),
    });
  });
  return facts;
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
 * RCB-89 / RCB-199: render the rows of `seatListRows` as a fixed-column table, `NAME  STATUS  STAMP
 * PANE  LABEL  LIVE  IN-FLIGHT` header first, each column padded to its widest value (last column
 * unpadded, trailing whitespace trimmed — same convention as `formatTable` in `cli.ts`). `PANE` is
 * the row's `tag`, `LIVE` is `describeLiveness(live)`; any `null` (and `inFlight`) prints as `-`. No
 * rows at all: one placeholder line, never a header with nothing under it.
 *
 * After the table, one line per row whose holder is DEAD (`live.state === 'dead'`) — a bullet that
 * still says UP for a process that is gone must not pass for a healthy row:
 * `! <name> <STATUS>: holder <tag ?? NO_PANE_TAG> is <describeLiveness>`.
 */
export function renderSeatList(rows: readonly SeatListRow[]): string {
  if (rows.length === 0) return '(no seat bullets in SEATS)\n';
  const header = ['NAME', 'STATUS', 'STAMP', 'PANE', 'LABEL', 'LIVE', 'IN-FLIGHT'];
  const data = rows.map((r) => [
    r.name,
    r.status,
    r.stamp,
    r.tag ?? '-',
    r.label ?? '-',
    r.live ? describeLiveness(r.live) : '-',
    r.inFlight ?? '-',
  ]);
  const allRows = [header, ...data];
  const widths = header.map((_, i) => Math.max(...allRows.map((row) => (row[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  const dead = rows.flatMap((r) =>
    r.live?.state === 'dead'
      ? [`! ${r.name} ${r.status}: holder ${r.tag ?? NO_PANE_TAG} is ${describeLiveness(r.live)}`]
      : [],
  );
  return `${[line(header), ...data.map(line), ...dead].join('\n')}\n`;
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
    holder: (input.holders ?? []).find((h) => h.seat.toLowerCase() === wantedAssignee) ?? null,
    holderError: input.holderError ?? null,
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
