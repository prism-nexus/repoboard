/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/log/YYYY-MM-DD.md` — every seat appends its own block,
 * newest last; nothing here is ever rewritten (contrast `state.ts`, which is rewritten in place).
 * `log.ts` already exists for card `## Log` bullets — this is the SAME shape of idea (an
 * append-only text log) for the whole repo's daily record, one file per day.
 */

import { resolveSince } from './decisions.js';

/** `# Log — YYYY-MM-DD`, line 1 of a freshly created daily log file. */
export function dailyLogHeader(date: string): string {
  return `# Log — ${date}`;
}

export interface LogBlockInput {
  /** Free string, e.g. `claude/p8-3`; stored UPPERCASED in the heading (locked decision 2). */
  seat: string;
  ts: string;
  /** Defaults to the first line of `text` when omitted or empty. */
  title?: string;
  text: string;
  /** RCB-160: `boardDisplayName(config, root)`, written as a `[repo] ` prefix right after
   *  `##### `. `undefined`/`null`/empty (the default) omits it — unprefixed history's own shape,
   *  unchanged. `string | null` (not just `string | undefined`) so a parsed `LogBlock` (whose own
   *  `repo` is `string | null`) can be re-emitted through this function with no conversion at the
   *  call site — that IS the round-trip `cli.ts`'s and `seat.ts`'s re-emitters rely on. */
  repo?: string | null;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

/**
 * `##### <SEAT-UPPERCASED> <ISO>: <title or first line>` + a blank line + the text verbatim —
 * this is the WRITER's shape, still exactly this and only this; RCB-54 widened only the READER
 * (`parseLogBlocks`/`BLOCK_HEADING`) to also accept shapes a hand-written log produces.
 * No trailing blank line here — `appendLogBlock` owns all inter-block spacing, so a block's own
 * shape is stable regardless of where it lands in the file.
 *
 * RCB-160: `input.repo` (trimmed, non-empty) is written as a `[repo] ` prefix right after
 * `##### `, before the seat — `undefined`/`null`/empty omits it, so a caller that never gathers a
 * repo name writes exactly today's heading.
 */
export function formatLogBlock(input: LogBlockInput): string {
  const title =
    input.title !== undefined && input.title.trim().length > 0
      ? input.title.trim()
      : firstLine(input.text);
  const repo = input.repo?.trim();
  const prefix = repo !== undefined && repo.length > 0 ? `[${repo}] ` : '';
  return `##### ${prefix}${input.seat.toUpperCase()} ${input.ts}: ${title}\n\n${input.text}`;
}

/**
 * Append one block to a log file's existing text. `text` is trimmed of trailing whitespace first
 * so repeated appends cannot accumulate blank lines; an empty `text` (a brand-new file, header
 * already written by the caller) gets the block with no leading separator. Append-only: there is
 * no rewrite here, matching locked decision 2 ("core exposes no rewrite").
 */
export function appendLogBlock(text: string, block: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const sep = trimmed.length === 0 ? '' : '\n\n';
  return `${trimmed}${sep}${block}\n`;
}

export interface LogBlock {
  /** As stored in the heading: UPPERCASED. */
  seat: string;
  /**
   * As stored in the heading, verbatim. The writer (`formatLogBlock`) always puts a parseable
   * ISO string here, but RCB-54 widened the reader to accept hand-written shapes too (e.g.
   * `2026-09-18 0x:xxZ`, or a trailing `(addendum)`), so a caller must not assume `new Date(ts)`
   * succeeds — `packages/web`'s `relTime` gets `Invalid Date` on those shapes (RCB-54, out of
   * scope, reported, not fixed here).
   */
  ts: string;
  title: string;
  text: string;
  /** RCB-160: the `[repo]` prefix parsed off right after `##### `, verbatim (not uppercased,
   *  unlike `seat`) — `null` when the heading carries none, unprefixed history's own default.
   *  Optional (not just nullable) so a `LogBlock` built by hand before this field existed (a
   *  fixture predating RCB-160) still satisfies the type; `parseLogBlocks` itself always sets it,
   *  never omits it. */
  repo?: string | null;
}

/**
 * RCB-54: the WRITER (`formatLogBlock`) still emits exactly `<SEAT> <ISO>: <title>`, but the
 * READER must also parse blocks a hand-written sibling log wrote directly (not through this
 * store) — measured shapes (`.repoboard/local/briefs/RCB-54-LOGDIR-BRIEF.md`) include a SPACE between date and
 * time, an `(addendum)` parenthetical after the time, an `x`-redacted hour, a `/` in the seat,
 * and a parenthetical in the seat. Contract: `seat` is everything after `##### ` up to the space
 * before the first `YYYY-MM-DD` token (lazy); `ts` runs from that date token, lazily, up to the
 * FIRST `: ` (colon-space) — so a title containing `: ` (our own ISO shape's "stand-up HH:MxZ: …")
 * does not get absorbed into `ts`; `title` is the rest of the line. `ts` is no longer guaranteed
 * to be a parseable ISO `Date` — a hand-written block's `ts` can be `2026-09-18 0x:xxZ`.
 *
 * RCB-160: an optional `[<repo>] ` — its OWN group (1), matched GREEDILY so it is preferred over
 * folding into the (lazy) seat group (2) whenever the heading does start with `[…] ` — right after
 * `##### `. Groups: (1) repo, (2) seat, (3) ts, (4) title. A heading with no bracket there (every
 * existing log) leaves group 1 `undefined`, unchanged from before this group was added.
 */
const BLOCK_HEADING = /^##### (?:\[([^\]]+)\] )?(.+?) (\d{4}-\d{2}-\d{2}.*?): (.*)$/gm;

/** Every `#####`-headed block in a daily log file, in file order (oldest first). */
export function parseLogBlocks(fileText: string): LogBlock[] {
  const matches = [...fileText.matchAll(BLOCK_HEADING)];
  const blocks: LogBlock[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const start = m.index + m[0].length;
    const next = matches[i + 1];
    const end = next?.index ?? fileText.length;
    const text = fileText.slice(start, end).replace(/^\n+/, '').replace(/\s+$/, '');
    blocks.push({ repo: m[1] ?? null, seat: m[2] ?? '', ts: m[3] ?? '', title: m[4] ?? '', text });
  }
  return blocks;
}

/** RCB-47: one day's parsed blocks, as `lastBlockFor` needs them (a subset of `LogFileInfo`). */
export interface DatedLogBlocks {
  date: string;
  blocks: readonly LogBlock[];
}

/**
 * RCB-47: the newest block written by `seat` (case-insensitive) across `days`, or `null` when
 * none exists. Days are sorted by `date` descending here — caller order is not trusted, since
 * `readdir` order is filesystem-defined — and within a day the LAST matching block (file order)
 * wins, matching the file's own newest-last invariant. A seat name that is empty after trim is
 * an unconfigured rule and stays inert: `null`, never a match.
 *
 * RCB-62: a single-word `wanted` (no whitespace, e.g. `builder`) matches a block's seat token on
 * its LEADING word only — the seat token's first whitespace-delimited word, case-insensitively —
 * so `builder` finds a hand-written heading like `BUILDER (fresh, f87be1)`. This is deliberately
 * a "leading word" rule, not a prefix rule: `coordinator` does NOT match `COORDINATOR/SEARCH`,
 * because `COORDINATOR/SEARCH` has no whitespace in it and so its whole token — not `COORDINATOR`
 * — is its "leading word" (a `/` is not a word boundary here). A prefix rule is a separate,
 * undecided behaviour and must not be introduced by accident. A multi-word `wanted` (e.g.
 * `repoboard builder`) keeps the ORIGINAL behaviour: it is compared whole against the whole seat
 * token, so it matches only an exact (case-insensitive) heading and not a bare `BUILDER`.
 */
export function lastBlockFor(
  seat: string,
  days: readonly DatedLogBlocks[],
): { date: string; block: LogBlock } | null {
  const wanted = seat.trim().toUpperCase();
  if (wanted.length === 0) return null;
  const wantedIsWhole = /\s/.test(wanted);
  const matches = (blockSeat: string): boolean => {
    if (wantedIsWhole) return blockSeat === wanted;
    const leading = blockSeat.split(/\s+/, 1)[0] ?? '';
    return leading === wanted;
  };
  const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const day of sorted) {
    for (let i = day.blocks.length - 1; i >= 0; i--) {
      const block = day.blocks[i];
      if (block && matches(block.seat)) return { date: day.date, block };
    }
  }
  return null;
}

/**
 * RCB-132: `filterLogBlocks`'s options — every field left `undefined` is "no restriction" (an
 * empty config yields everything, never silently nothing). `seat` matches `log show --seat`'s
 * own rule exactly (uppercased, exact match against the heading). `since` is a full ISO-8601
 * datetime, or `HH:MMZ` resolved against the caller's `day`. `tail` is the last N blocks of
 * whatever `seat`/`since` left — the caller (cli.ts's own flag parse, mcp.ts's zod schema)
 * validates the raw flag is a non-negative integer; this is a contract on the value, not a
 * second parse of it.
 */
export interface LogFilterOptions {
  seat?: string;
  since?: string;
  tail?: number;
}

export type LogFilterResult = { ok: true; blocks: LogBlock[] } | { ok: false; error: string };

/**
 * RCB-132: the ONE filter `log show --seat/--since/--tail` and MCP `get_log`'s matching args
 * share — CLI and MCP call this, never their own copy. Fixed order — seat, then since, then
 * tail — so `--since s --tail 3` means "the last 3 of the ones at or after `s`", never "the 3
 * most recent, then keep whichever of those are at or after `s`". A block whose `ts` fails to
 * parse as a `Date` (RCB-54: a hand-written log's `ts` is not guaranteed parseable) is dropped
 * by `--since` rather than kept on a guess — a missing answer stays out, never a plausible
 * inclusion. `tail` beyond what's left after `seat`/`since` is every remaining block, never an
 * error — a cold seat guessing a line count on the high side is the exact case `--tail` exists
 * to make safe.
 */
export function filterLogBlocks(
  blocks: readonly LogBlock[],
  day: string,
  opts: LogFilterOptions,
): LogFilterResult {
  let result: readonly LogBlock[] = blocks;
  if (opts.seat !== undefined) {
    const wanted = opts.seat.toUpperCase();
    result = result.filter((b) => b.seat === wanted);
  }
  if (opts.since !== undefined) {
    // `--since` is resolved by decisions.ts's `resolveSince` — the one HH:MMZ-or-ISO rule
    // `repoboard decisions --since` also uses; `HH:MMZ` means that UTC time on the log's `day`.
    const since = resolveSince(opts.since, new Date(`${day}T00:00:00Z`));
    if (!since.ok) return since;
    const sinceMs = Date.parse(since.iso);
    result = result.filter((b) => {
      const ms = Date.parse(b.ts);
      return !Number.isNaN(ms) && ms >= sinceMs;
    });
  }
  if (opts.tail !== undefined) {
    if (!Number.isInteger(opts.tail) || opts.tail < 0) {
      throw new Error(`filterLogBlocks: tail must be a non-negative integer (got ${opts.tail})`);
    }
    result = result.slice(Math.max(0, result.length - opts.tail));
  }
  return { ok: true, blocks: [...result] };
}
