/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/log/YYYY-MM-DD.md` — every seat appends its own block,
 * newest last; nothing here is ever rewritten (contrast `state.ts`, which is rewritten in place).
 * `log.ts` already exists for card `## Log` bullets — this is the SAME shape of idea (an
 * append-only text log) for the whole repo's daily record, one file per day.
 */

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
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

/**
 * `##### <SEAT-UPPERCASED> <ISO>: <title or first line>` + a blank line + the text verbatim.
 * No trailing blank line here — `appendLogBlock` owns all inter-block spacing, so a block's own
 * shape is stable regardless of where it lands in the file.
 */
export function formatLogBlock(input: LogBlockInput): string {
  const title =
    input.title !== undefined && input.title.trim().length > 0
      ? input.title.trim()
      : firstLine(input.text);
  return `##### ${input.seat.toUpperCase()} ${input.ts}: ${title}\n\n${input.text}`;
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
  ts: string;
  title: string;
  text: string;
}

const BLOCK_HEADING = /^##### (\S+) (\S+): (.*)$/gm;

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
    blocks.push({ seat: m[1] ?? '', ts: m[2] ?? '', title: m[3] ?? '', text });
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
 */
export function lastBlockFor(
  seat: string,
  days: readonly DatedLogBlocks[],
): { date: string; block: LogBlock } | null {
  const wanted = seat.trim().toUpperCase();
  if (wanted.length === 0) return null;
  const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const day of sorted) {
    for (let i = day.blocks.length - 1; i >= 0; i--) {
      const block = day.blocks[i];
      if (block && block.seat === wanted) return { date: day.date, block };
    }
  }
  return null;
}
