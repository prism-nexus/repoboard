/**
 * P8.4: the I/O half of `repoboard cost` (locked decision 3 — "the server does the I/O, the core
 * does the arithmetic and the rule"). Every path this module touches goes through
 * `resolveRepoPath` (K7's own guard), so a CLAUDE.md that names an absolute path, a `..`, or a
 * symlink escaping the repo cannot make this module read outside `root` even though
 * `extractLinkedPaths` itself already rejects the syntax for the first two.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  type CostEntry,
  type CostReport,
  type CostWhy,
  extractLinkedPathsFlagged,
  summarizeCost,
} from '@repoboard/core';
import { resolveRepoPath } from './refs.js';

/** Locked decision 1(a): the root file plus its two variants, each listed separately. */
const CLAUDE_MD_VARIANTS = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const;
/** Locked decision 1(b). */
const AGENTS_MD_VARIANTS = ['AGENTS.md', 'docs/AGENTS.md'] as const;

async function fileEntry(root: string, rel: string, why: CostWhy): Promise<CostEntry | null> {
  const resolved = await resolveRepoPath(root, rel);
  if (!resolved.ok) return null;
  let bytes: number;
  try {
    const st = await stat(resolved.path);
    if (!st.isFile()) return null;
    bytes = st.size;
  } catch {
    return null;
  }
  return { file: rel, bytes, why };
}

/** `Object.keys(mcpServers)` of `.mcp.json` at `root` — names only (locked decision 1(d)). Any
 * read/parse failure (absent, malformed, not an object) yields no servers rather than a crash:
 * this tool is a read-only measurement, never a reason to fail loud about someone else's file. */
async function mcpServerNames(root: string): Promise<string[]> {
  const resolved = await resolveRepoPath(root, '.mcp.json');
  if (!resolved.ok) return [];
  try {
    const data: unknown = JSON.parse(await readFile(resolved.path, 'utf8'));
    const servers =
      data && typeof data === 'object' ? (data as { mcpServers?: unknown }).mcpServers : undefined;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      return Object.keys(servers);
    }
  } catch {
    // malformed .mcp.json — no servers, not a crash.
  }
  return [];
}

/**
 * Gather every file locked decision 1 names under `root`, hand them to core's `summarizeCost`.
 * Read-only: `stat` and `readFile` only, never a write — proved in
 * `packages/server/test/cost.test.ts` by an unchanged `git status` on freshpickedjobs before and
 * after a real call against it.
 */
export async function gatherCost(root: string, budget: number): Promise<CostReport> {
  const entries: CostEntry[] = [];
  const already = new Set<string>();
  let claudeMdBytes: number | null = null;

  for (const variant of CLAUDE_MD_VARIANTS) {
    const entry = await fileEntry(root, variant, 'root');
    if (!entry) continue;
    entries.push(entry);
    already.add(entry.file);
    if (variant === 'CLAUDE.md') claudeMdBytes = entry.bytes;
  }

  for (const variant of AGENTS_MD_VARIANTS) {
    const entry = await fileEntry(root, variant, 'agents');
    if (entry && !already.has(entry.file)) {
      entries.push(entry);
      already.add(entry.file);
    }
  }

  const claudeMdResolved = await resolveRepoPath(root, 'CLAUDE.md');
  if (claudeMdResolved.ok) {
    let text: string | null;
    try {
      text = await readFile(claudeMdResolved.path, 'utf8');
    } catch {
      text = null;
    }
    if (text !== null) {
      for (const { path: raw, frozen } of extractLinkedPathsFlagged(text)) {
        if (already.has(raw)) continue; // already counted as root/agents — never double-billed
        const why: CostWhy = frozen ? 'frozen' : 'linked from CLAUDE.md';
        const entry = await fileEntry(root, raw, why);
        if (entry) {
          entries.push(entry);
          already.add(entry.file);
        }
      }
    }
  }

  const mcpServers = await mcpServerNames(root);
  return summarizeCost(entries, { budget, claudeMdBytes, mcpServers });
}
