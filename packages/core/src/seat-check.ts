/**
 * RCB-200: `repoboard check`'s SEATS findings — the pure half. `check` looked at the log, the
 * cards and the leases but never at the SEATS section, so a bullet that said DOWN for a seat that
 * had logged four hours later, a second bullet for one seat, and a bullet whose UP outlived its
 * process were all invisible (a member board, 2026-09-29: search DOWN 20:16Z, logged 00:38Z). This file
 * turns the SEATS section, the recorded holders (`seatHolderInfos`) and the log blocks into
 * `Finding`s; the caller gathers them (core stays I/O-free, §0.5) and hands the result to
 * `checkFindings` as `CheckInput.seatFindings`. `state.ts` never imports this file — `seat.ts`
 * imports `state.ts`, so the reverse would cycle.
 */
import { describeLiveness, NO_PANE_TAG, type SeatHolderInfo, sameHolder } from './holder.js';
import {
  normalizeSeatName,
  type SeatBulletFact,
  seatNameKey,
  stampedSeatBullets,
  zonedLogMs,
} from './seat.js';
import { type Finding, FUTURE_STAMP_TOLERANCE_MS, type LogFileInfo } from './state.js';
import { toIso } from './time.js';

/**
 * RCB-184: what the caller measured about this board's HOME (`board.yml`'s `workspace:`), read
 * read-only — `null`/absent when the key is absent (every finding below is then silent, byte-
 * identical to before). `configured` is the key's text as written, what a finding names.
 * `ok: false` means the home could not be read (`error` says why); `ok: true` carries the home's
 * display `name` and whether its own `repos:` lists a root that resolves to THIS repo.
 */
export type SeatCheckHome =
  | { ok: true; configured: string; name: string; listsMember: boolean }
  | { ok: false; configured: string; error: string };

export interface SeatCheckInput {
  /** `StateDoc.sections.seats`; `null` when there is no STATE.md — then there is nothing to judge. */
  seatsSection: string | null;
  /** `boardDisplayName(config, root)` — the board these bullets and blocks are read as. */
  boardName: string;
  /** `seatHolderInfos(...)`, gathered by the caller. `null` when `seats.yml` could not be read:
   *  the holder checks then say NOTHING (a holder that cannot be read is not "no holder"). */
  holders: readonly SeatHolderInfo[] | null;
  logs: readonly LogFileInfo[];
  now: Date;
  /** RCB-184: this board's home, as read — `null`/absent = no `workspace:` key, inert. */
  home?: SeatCheckHome | null;
}

/** A board name as it is COMPARED — trimmed, case-insensitive (`normalizeSeatName`'s rule). */
function foldBoard(s: string): string {
  return s.trim().toLowerCase();
}

/** The board a bullet is about: its own `[repo]` prefix, else THIS board (an unprefixed bullet). */
function boardOf(f: SeatBulletFact, boardName: string): string {
  return foldBoard(f.board ?? boardName);
}

/** `[acme]`, else `[<this board>]` for an unprefixed bullet — how a finding names a bullet's board. */
function boardLabel(f: SeatBulletFact, boardName: string): string {
  if (f.board !== null) return `[${f.board}]`;
  return boardName.trim().length > 0 ? `[${boardName.trim()}]` : '(unprefixed)';
}

/** `a` · `a and b` · `a, b and c`. */
function joinList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Insertion-ordered grouping — the first item of each group is the earliest in `items`. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

/** `YYYY-MM-DD HH:MMZ` from a parsed stamp — the shape a bullet is written in. */
function stampText(at: Date): string {
  const iso = toIso(at);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/** The pane tag in a bullet's holder label (`1D3F` of `1D3F · rcb builder`), `null` when it has none. */
function bulletTag(f: SeatBulletFact): string | null {
  if (f.label === null) return null;
  const sep = f.label.indexOf(' · ');
  const tag = (sep === -1 ? f.label : f.label.slice(0, sep)).trim();
  return tag === '' ? null : tag;
}

/**
 * `seat-duplicate-bullet` (error): two or more stamped bullets for one seat on one board. The seat
 * verbs (`locateSeatBullet`) find only the FIRST, so `--up`/`--down`/`--update` rewrite bullet N and
 * leave the others reading whatever they last said. "One board" folds an unprefixed bullet into
 * THIS board, so `- **builder: …**` and `- **[repoboard] builder: …**` are duplicates.
 */
function duplicateBulletFindings(facts: readonly SeatBulletFact[], boardName: string): Finding[] {
  const findings: Finding[] = [];
  for (const group of groupBy(facts, (f) => JSON.stringify([f.key, boardOf(f, boardName)]))) {
    const first = group[0];
    if (first === undefined || group.length < 2) continue;
    findings.push({
      kind: 'seat-duplicate-bullet',
      level: 'error',
      message:
        `seat-duplicate-bullet: SEATS bullets ${joinList(group.map((f) => String(f.position)))} ` +
        `are ${group.length === 2 ? 'both' : 'all'} seat "${first.name.trim()}" — seat verbs ` +
        `rewrite only bullet ${first.position}; merge them`,
    });
  }
  return findings;
}

/**
 * `seat-name-ambiguous` (warning): one seat name stamped for two or more boards. The seat verbs
 * match the NAME alone (`[acme] ops` and `[repoboard] ops` are both `ops`), so a verb typed on one
 * board can land on the other's bullet. RCB-207: the message says WHICH — the first in section
 * order, the one `locateSeatBullet` takes (as `seat-duplicate-bullet` already does).
 */
function ambiguousNameFindings(facts: readonly SeatBulletFact[], boardName: string): Finding[] {
  const findings: Finding[] = [];
  for (const group of groupBy(facts, (f) => f.key)) {
    const first = group[0];
    if (first === undefined) continue;
    const boards = new Set(group.map((f) => boardOf(f, boardName)));
    if (boards.size < 2) continue;
    findings.push({
      kind: 'seat-name-ambiguous',
      level: 'warning',
      message:
        `seat-name-ambiguous: seat "${first.name.trim()}" is stamped on ${boards.size} boards — ` +
        `${group.map((f) => `${boardLabel(f, boardName)} bullet ${f.position}`).join(', ')} — ` +
        'a seat verb matches the name alone, whichever board a bullet is stamped for; give each ' +
        `board's seat its own name — a seat verb takes bullet ${first.position}`,
    });
  }
  return findings;
}

/**
 * Each seat's newest log block on THIS board (an unprefixed block, or one prefixed with
 * `boardName`), keyed by `seatNameKey`. A block counts only when its heading names a seat
 * (`normalizeSeatName`), its `ts` is a moment (`zonedLogMs`) and that moment is not further ahead
 * of `nowMs` than `FUTURE_STAMP_TOLERANCE_MS` — a hand-typed future stamp is `check`'s own
 * `future-stamp` finding, not evidence the seat is alive (RCB-90).
 */
function newestBlockBySeat(
  logs: readonly LogFileInfo[],
  boardName: string,
  nowMs: number,
): Map<string, { ms: number; ts: string }> {
  const newest = new Map<string, { ms: number; ts: string }>();
  for (const log of logs) {
    for (const b of log.blocks) {
      if (b.repo !== undefined && b.repo !== null && foldBoard(b.repo) !== foldBoard(boardName)) {
        continue;
      }
      const ms = zonedLogMs(b.ts);
      if (ms === null || ms - nowMs > FUTURE_STAMP_TOLERANCE_MS) continue;
      const seat = normalizeSeatName(b.seat, boardName);
      if (!seat.ok) continue;
      const key = seatNameKey(seat.name);
      const prior = newest.get(key);
      if (prior === undefined || ms > prior.ms) newest.set(key, { ms, ts: b.ts });
    }
  }
  return newest;
}

/**
 * `seat-log-while-down` (warning): a seat whose bullet says DOWN, and whose newest log block is
 * NEWER than that DOWN. A seat logs its last block and only then stands down, so a block after the
 * stamp means the bullet is stale, or a session is working without holding the seat. The stamp has
 * MINUTE resolution, so the block's moment is floored to its minute first: a block in the DOWN
 * minute is that last block, the next minute is not. A DOWN whose stamp does not parse says nothing.
 */
function logWhileDownFindings(mine: readonly SeatBulletFact[], input: SeatCheckInput): Finding[] {
  const findings: Finding[] = [];
  const newest = newestBlockBySeat(input.logs, input.boardName, input.now.getTime());
  for (const f of mine) {
    if (f.status !== 'DOWN' || f.at === null) continue;
    const block = newest.get(f.key);
    if (block === undefined || Math.floor(block.ms / 60_000) * 60_000 <= f.at.getTime()) continue;
    findings.push({
      kind: 'seat-log-while-down',
      level: 'warning',
      message:
        `seat-log-while-down: seat "${f.name.trim()}" is DOWN since ${stampText(f.at)} but its ` +
        `newest log block is ${block.ts} — it logged after it stood down: stale DOWN, or a ` +
        'session working without holding the seat',
    });
  }
  return findings;
}

/** The first of `holders` recorded for `key` (`seatNameKey`), else `undefined` — the ONE lookup. */
function holderOf(holders: readonly SeatHolderInfo[], key: string): SeatHolderInfo | undefined {
  return holders.find((h) => seatNameKey(h.seat) === key);
}

/**
 * `seat-up-dead-holder` (warning): a bullet says UP, and the process the lease records for that
 * seat is measured DEAD (`holderLiveness`: no such process, or a recycled pid). `unknown` and
 * `alive` say nothing — a holder that could not be measured is not a dead one.
 */
function deadHolderFindings(
  mine: readonly SeatBulletFact[],
  holders: readonly SeatHolderInfo[],
): Finding[] {
  const findings: Finding[] = [];
  for (const f of mine) {
    const h = f.status === 'UP' ? holderOf(holders, f.key) : undefined;
    if (h === undefined || h.liveness.state !== 'dead') continue;
    findings.push({
      kind: 'seat-up-dead-holder',
      level: 'warning',
      message:
        `seat-up-dead-holder: seat "${f.name.trim()}" is UP but its holder ` +
        `${h.tag ?? NO_PANE_TAG} is ${describeLiveness(h.liveness)} — the session is gone; ` +
        'stand the seat down or take it over',
    });
  }
  return findings;
}

/**
 * `pane-holds-two-seats` (error): two or more recorded seats held by ONE holder (`sameHolder`, so a
 * pane, or a host + pid + start time). A pane is one seat (`seat whoami` names only the first); the
 * rest are leases it never released. `holders` are grouped in file order, each joining the first
 * earlier group whose head is the same holder, and the group is named by its head's tag.
 */
function twoSeatsFindings(holders: readonly SeatHolderInfo[]): Finding[] {
  const groups: SeatHolderInfo[][] = [];
  for (const h of holders) {
    const group = groups.find((g) => g[0] !== undefined && sameHolder(g[0].holder, h.holder));
    if (group === undefined) groups.push([h]);
    else group.push(h);
  }
  const findings: Finding[] = [];
  for (const group of groups) {
    const head = group[0];
    if (head === undefined || group.length < 2) continue;
    findings.push({
      kind: 'pane-holds-two-seats',
      level: 'error',
      message: `pane-holds-two-seats: ${head.tag ?? NO_PANE_TAG} holds ${joinList(group.map((h) => h.seat))}`,
    });
  }
  return findings;
}

/** What a bullet says about its holder, for a drift message: `DOWN`, `UP, holder label 1D3F`, `UP, no holder label`. */
function bulletSays(f: SeatBulletFact, tag: string | null): string {
  if (f.status === 'DOWN') return 'DOWN';
  return tag !== null ? `UP, holder label ${tag}` : 'UP, no holder label';
}

/**
 * `seat-lease-bullet-drift` (warning): the bullet and the lease disagree about who holds a seat.
 * The bullet's tag is its holder label up to ` · ` (`1D3F` of `1D3F · rcb builder`); a tag is a
 * 4-character (or widened 6) PREFIX of the pane, so it agrees with the lease when the pane starts
 * with it, case-insensitively. Drift is:
 *
 * - UP with a lease: the lease has no pane but the bullet carries a tag; or it has one and the
 *   bullet carries none, or a tag the pane does not start with;
 * - UP with no lease but a tag on the bullet (it names a holder nothing records);
 * - DOWN with a lease (the stand-down should have released it);
 * - a lease for a seat that has no stamped bullet on this board at all.
 */
function leaseDriftFindings(
  mine: readonly SeatBulletFact[],
  holders: readonly SeatHolderInfo[],
): Finding[] {
  const findings: Finding[] = [];
  const drift = (seat: string, said: string): void => {
    findings.push({
      kind: 'seat-lease-bullet-drift',
      level: 'warning',
      message: `seat-lease-bullet-drift: seat "${seat}": ${said}`,
    });
  };
  for (const f of mine) {
    const h = holderOf(holders, f.key);
    const tag = bulletTag(f);
    const bullet = `bullet says ${bulletSays(f, tag)}`;
    if (h === undefined) {
      if (f.status === 'UP' && tag !== null)
        drift(f.name.trim(), `${bullet}; lease says no holder`);
      continue;
    }
    const lease = `lease says held by ${h.tag ?? NO_PANE_TAG}`;
    if (f.status === 'DOWN') {
      drift(f.name.trim(), `${bullet}; ${lease}`);
      continue;
    }
    const pane = h.holder.pane;
    const differs =
      pane === null
        ? tag !== null
        : tag === null || !pane.toLowerCase().startsWith(tag.toLowerCase());
    if (differs) drift(f.name.trim(), `${bullet}; ${lease}`);
  }
  const seen = new Set<string>();
  const haveBullet = new Set(mine.map((f) => f.key));
  for (const h of holders) {
    const key = seatNameKey(h.seat);
    if (seen.has(key)) continue;
    seen.add(key);
    if (haveBullet.has(key)) continue;
    drift(h.seat.trim(), `lease says held by ${h.tag ?? NO_PANE_TAG}; SEATS has no bullet for it`);
  }
  return findings;
}

/**
 * RCB-184: the three findings about a `workspace:` link, all warnings (hygiene, not a broken rig).
 *
 * - `seat-copy`: an own STAMPED bullet prefixed with the home's name — a copy of a seat the home's
 *   own STATE.md speaks for. The copy goes stale and `seat list` no longer shows it, so it is only
 *   noise; one per bullet, never raised when the home could not be read (its name is then unknown).
 * - `seat-home-unreadable`: the home's `.repoboard/`, STATE.md or board.yml could not be read; names
 *   the key's text and says why. The member's own rows still list — unreadable is never "no seats".
 * - `seat-home-not-member`: the home's `repos:` lists no root that resolves to this repo, so the
 *   home does not coordinate it — the link is one-sided.
 */
function homeFindings(
  facts: readonly SeatBulletFact[],
  home: SeatCheckHome | null | undefined,
): Finding[] {
  if (home === null || home === undefined) return [];
  if (!home.ok) {
    return [
      {
        kind: 'seat-home-unreadable',
        level: 'warning',
        message:
          `seat-home-unreadable: workspace: ${home.configured} cannot be read (${home.error}) — ` +
          'its seats are not listed here; fix the path, or drop workspace:',
      },
    ];
  }
  const findings: Finding[] = [];
  for (const f of facts) {
    if (f.board === null || foldBoard(f.board) !== foldBoard(home.name)) continue;
    findings.push({
      kind: 'seat-copy',
      level: 'warning',
      message:
        `seat-copy: SEATS bullet ${f.position} (${boardLabel(f, home.name)} ${f.name.trim()}) is a ` +
        `copy of home board ${home.name}'s seat — delete it; the home's bullet is read live`,
    });
  }
  if (!home.listsMember) {
    findings.push({
      kind: 'seat-home-not-member',
      level: 'warning',
      message:
        `seat-home-not-member: home board ${home.name} (workspace: ${home.configured}) lists no ` +
        'repos: root that resolves to this repo — add this repo to its board.yml, or drop workspace:',
    });
  }
  return findings;
}

/**
 * RCB-200: `check`'s SEATS findings, in the order the kinds are declared — duplicate bullet,
 * ambiguous name, log while DOWN, then (only when `holders` is non-null) UP with a dead holder, a
 * pane holding two seats, lease/bullet drift, then (only with `home`) the `workspace:` link's
 * findings. `null` `seatsSection` -> `[]`, or just the home's unreadable / not-member findings.
 * One finding per seat (or per group of bullets / holders), each message beginning `<kind>: `.
 *
 * Only STAMPED bullets are facts (`stampedSeatBullets`); a fact is THIS board's when its `[repo]`
 * prefix is absent or equals `boardName` (case-insensitive). The checks that ask what THIS board's
 * seat is doing (log-while-DOWN, dead holder, drift) use each seat name's FIRST such bullet — the
 * one a seat verb would find — so a duplicate is reported once, as itself, and not again as drift.
 * `holders: null` (`seats.yml` unreadable) leaves the holder checks silent, never guessing an
 * empty lease file; `[]` is a readable file with no leases.
 */
export function seatCheckFindings(input: SeatCheckInput): Finding[] {
  if (input.seatsSection === null) return homeFindings([], input.home);
  const { boardName, holders } = input;
  const facts = stampedSeatBullets(input.seatsSection).filter((f) => f.key !== '');
  const mine = groupBy(
    facts.filter((f) => f.board === null || foldBoard(f.board) === foldBoard(boardName)),
    (f) => f.key,
  ).flatMap((group) => group.slice(0, 1));
  const findings = [
    ...duplicateBulletFindings(facts, boardName),
    ...ambiguousNameFindings(facts, boardName),
    ...logWhileDownFindings(mine, input),
  ];
  if (holders !== null) {
    findings.push(
      ...deadHolderFindings(mine, holders),
      ...twoSeatsFindings(holders),
      ...leaseDriftFindings(mine, holders),
    );
  }
  // RCB-184: last, so a board with no `workspace:` key gets exactly the findings it got before.
  findings.push(...homeFindings(facts, input.home));
  return findings;
}
