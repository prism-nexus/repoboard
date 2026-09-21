/**
 * P8.4 (plan §5 P8.4, §11 O9): `repoboard cost` — bytes (and ≈tokens) of what a COLD agent
 * loads before it does anything: `CLAUDE.md` and its variants, `AGENTS.md` and its variants,
 * every repo-relative path `CLAUDE.md` names in backticks that exists as a file, and the NAMES
 * of MCP servers configured in `.mcp.json`. Motivating measurement: freshpickedjobs' own
 * `CLAUDE.md` reached 32,620 B — loaded into every turn of every subagent — before anyone
 * measured it (.repoboard/local/briefs/P8.4-COST-BRIEF.md).
 *
 * Split of labor (locked decision 3): this module is the pure arithmetic and the extraction
 * RULE — no filesystem access, so it is exactly as testable as everything else in @repoboard/core
 * (§0.5). `packages/server/src/cost.ts` does the `stat`/`readFile` and hands entries here.
 */

/** The three categories `repoboard cost`'s table names in its WHY column (locked decision 2). */
export type CostWhy = 'root' | 'agents' | 'linked from CLAUDE.md';

export interface CostEntry {
  /** Repo-relative path (or, for a variant that is conventionally root-only, its bare name). */
  file: string;
  bytes: number;
  why: CostWhy;
}

/** `bytes / 4`, rounded — an ESTIMATE, always labelled as one (locked decision 1). */
export function approxTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export const DEFAULT_CLAUDE_MD_BUDGET_BYTES = 8192;

/** The fixed note locked decision 1(d) demands next to MCP server names. */
export const MCP_SCHEMA_NOTE =
  "schema bytes are per-harness; repoboard's own is measured in AGENTS.md";

export interface CostReport {
  entries: CostEntry[];
  totalBytes: number;
  /** `approxTokens(totalBytes)`. */
  totalTokensApprox: number;
  /** The root `CLAUDE.md`'s own bytes, or `null` when it is absent — never a guess. */
  claudeMdBytes: number | null;
  budget: number;
  /** `claudeMdBytes !== null && claudeMdBytes > budget`. An absent CLAUDE.md can never be OVER. */
  over: boolean;
  /** Names only (locked decision 1(d)) — never bytes; a harness's own schema cost is its own. */
  mcpServers: string[];
  mcpNote: string;
}

export interface SummarizeCostOptions {
  budget: number;
  claudeMdBytes: number | null;
  mcpServers: readonly string[];
}

/** The pure arithmetic and the OVER rule (locked decision 2): `>`, never `<=` (C1's own control). */
export function summarizeCost(
  entries: readonly CostEntry[],
  opts: SummarizeCostOptions,
): CostReport {
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const over = opts.claudeMdBytes !== null && opts.claudeMdBytes > opts.budget;
  return {
    entries: [...entries],
    totalBytes,
    totalTokensApprox: approxTokens(totalBytes),
    claudeMdBytes: opts.claudeMdBytes,
    budget: opts.budget,
    over,
    mcpServers: [...opts.mcpServers],
    mcpNote: MCP_SCHEMA_NOTE,
  };
}

// ---- extractLinkedPaths (locked decision 1(c)) -------------------------------------------

/** Every character a repo-relative path in this codebase is written with, and nothing else. */
const PATH_CHARS = /^[A-Za-z0-9_.\-/]+$/;
/** `name.ext` at the end, 1–6 alnum characters — enough to admit `.md`/`.ts`/`.yml`/`.jsonl`. */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,6}$/;

/**
 * Is `s` (the exact text between one pair of backticks) a candidate repo-relative path? Pure
 * syntax — no filesystem access, so no opinion on whether the path exists (that is the server's
 * job: locked decision 3, and the "ignores … non-existent" test is split across the two
 * accordingly). Rejects:
 * - anything with a character outside `[A-Za-z0-9_.-/]` (rules out spaces, quotes, `<>:*`,
 *   `~`, parens — code snippets and prose fragments, not paths);
 * - an absolute path (`/...`);
 * - a path with any segment made of ONLY dots — `..` (the brief's own example) and, measured
 *   against freshpickedjobs' real CLAUDE.md, the prose ellipsis `...` used to abbreviate a path
 *   outside the repo (`.../other-app-pipeline` in the sample fixture) — both are "escape the
 *   repo" shaped, so both are rejected by the same rule rather than special-casing `..` alone
 *   (§7 correction).
 * A bare word with no slash and no extension (`main`, `any`, `README` without `.md`) is not
 * treated as a path — it is far more often a branch name, a tool name, or a type name than a
 * file, and admitting it would flood the linked-paths list with false positives.
 */
function looksLikePath(s: string): boolean {
  if (s.length === 0) return false;
  if (!PATH_CHARS.test(s)) return false;
  if (s.startsWith('/')) return false;
  if (s.split('/').some((seg) => /^\.+$/.test(seg))) return false;
  return s.includes('/') || HAS_EXTENSION.test(s);
}

/** One pair of backticks, content on one line only (a fenced code block is not inline code). */
const BACKTICK_SPAN = /`([^`\n]*)`/g;

/**
 * Every repo-relative path named in backticks in `claudeMdText`, first-order only (no recursion
 * into a linked file's own text, no globs — a `*` is not in `PATH_CHARS` so it is rejected by
 * construction), deduplicated, in order of first appearance. `..` and absolute paths are
 * ignored (locked decision 1(c)); a path that does not exist on disk is NOT filtered here — that
 * is `packages/server/src/cost.ts`'s job, so this function needs no filesystem.
 */
export function extractLinkedPaths(claudeMdText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of claudeMdText.matchAll(BACKTICK_SPAN)) {
    const raw = m[1] ?? '';
    if (!looksLikePath(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// ---- formatCostTable (locked decision 2) --------------------------------------------------

function padCells(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}

/**
 * `FILE  BYTES  ≈TOK  WHY`, then `total <bytes> ≈<tok>`, then the CLAUDE.md/budget verdict line,
 * then (only when at least one MCP server is configured) the fixed MCP note, then a footer
 * labelling ≈TOK as an estimate (locked decision 1: "labelled an estimate").
 */
export function formatCostTable(report: CostReport): string {
  const header = ['FILE', 'BYTES', '≈TOK', 'WHY'];
  const rows = report.entries.map((e) => [
    e.file,
    String(e.bytes),
    `≈${approxTokens(e.bytes)}`,
    e.why,
  ]);
  const lines = padCells([header, ...rows]);
  const out = [...lines];
  out.push(`total  ${report.totalBytes}  ≈${report.totalTokensApprox}`);
  out.push(
    report.claudeMdBytes === null
      ? 'CLAUDE.md — absent'
      : `CLAUDE.md ${report.claudeMdBytes} of budget ${report.budget}  ${report.over ? 'OVER' : 'OK'}`,
  );
  if (report.mcpServers.length > 0) {
    out.push(`mcp servers: ${report.mcpServers.join(', ')} (${report.mcpNote})`);
  }
  out.push('≈tok is an estimate: bytes / 4.');
  return out.join('\n');
}
