/**
 * K7: resolve a card's `refs:` against the repo, live on every call — nothing here is cached,
 * because the file changes without the card changing (D6 spirit). Core does the parsing and the
 * span; this module owns the one path from a spec to a filesystem path (`resolveRepoPath`) and
 * the text-file rules it shares with the scanner.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  type Card,
  parseRef,
  type ResolvedRef,
  refError,
  resolveRef,
  splitLines,
} from '@repoboard/core';
import { textFileReason } from './scanner.js';

export type RepoPathResult = { ok: true; path: string } | { ok: false; error: string };

const DRIVE = /^[a-zA-Z]:[\\/]/;
/** A NUL in the first 8 KB is the scanner-independent binary sniff (`git diff` uses the same). */
const SNIFF_BYTES = 8000;

/**
 * The ONLY way a ref spec becomes a filesystem path (K7 brief). Rejects an absolute path, any
 * `..` segment, anything under `.git/`, and any realpath outside `root` (symlinks included).
 * Takes no option that could weaken it. Returns the real path of an existing file or directory;
 * whether it is a readable text file is `readRepoText`'s job.
 */
export async function resolveRepoPath(root: string, rel: string): Promise<RepoPathResult> {
  if (rel.length === 0) return { ok: false, error: 'empty path' };
  if (rel.includes('\0')) return { ok: false, error: 'path contains NUL' };
  if (isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\') || DRIVE.test(rel)) {
    return { ok: false, error: `absolute path not allowed: ${rel}` };
  }
  const segments = rel.split(/[\\/]/);
  if (segments.includes('..')) return { ok: false, error: `".." not allowed in path: ${rel}` };
  if (segments.includes('.git')) return { ok: false, error: `.git/ not allowed: ${rel}` };
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, error: 'repo root not found' };
  }
  let fileReal: string;
  try {
    fileReal = await realpath(join(rootReal, rel));
  } catch {
    return { ok: false, error: `not found: ${rel}` };
  }
  const inside = relative(rootReal, fileReal);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { ok: false, error: `path resolves outside the repo: ${rel}` };
  }
  if (inside.split(sep).includes('.git')) return { ok: false, error: `.git/ not allowed: ${rel}` };
  return { ok: true, path: fileReal };
}

export type RepoTextResult = { ok: true; text: string } | { ok: false; error: string };

/** Read a guarded path as text: regular file, scanner's binary/size rules, NUL sniff. */
export async function readRepoText(path: string, rel: string): Promise<RepoTextResult> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { ok: false, error: `not a file: ${rel}` };
    size = st.size;
  } catch {
    return { ok: false, error: `not found: ${rel}` };
  }
  const reason = textFileReason(rel, size);
  if (reason !== null) return { ok: false, error: `${reason}: ${rel}` };
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    return { ok: false, error: `cannot read ${rel}: ${(e as Error).message}` };
  }
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) {
    return { ok: false, error: `binary file (NUL byte): ${rel}` };
  }
  return { ok: true, text: buf.toString('utf8') };
}

/** One spec → one wire entry. Reads the file now; never a cached copy. */
export async function resolveRefSpec(root: string, spec: string): Promise<ResolvedRef> {
  const parsed = parseRef(spec);
  if (!parsed.ok) return refError(spec, null, parsed.error);
  const { ref } = parsed;
  const guarded = await resolveRepoPath(root, ref.path);
  if (!guarded.ok) return refError(spec, ref.path, guarded.error);
  const read = await readRepoText(guarded.path, ref.path);
  if (!read.ok) return refError(spec, ref.path, read.error);
  const res = resolveRef(ref, read.text);
  if (res.text === null) return refError(spec, ref.path, res.error);
  return {
    spec,
    path: ref.path,
    start: res.start,
    end: res.end,
    text: res.text,
    truncated: res.truncated,
    error: null,
  };
}

/** Every ref on the card, in order; a card without `refs:` yields `[]`. */
export function resolveCardRefs(root: string, card: Card): Promise<ResolvedRef[]> {
  return Promise.all((card.refs ?? []).map((spec) => resolveRefSpec(root, spec)));
}

/** RCB-106: one merged, printable span of a file, or an unresolved ref passed through as-is. */
export type MergedRef =
  | { path: string; start: number; end: number; text: string; truncated: boolean; specs: string[] }
  | { error: string; spec: string };

/**
 * RCB-106: card order, but overlapping or touching 1-based spans of the SAME file collapse into
 * one entry so a caller (the CLI's `--resolve`, and anything else printing refs) never repeats a
 * line. Only resolved refs with equal `path` and `next.start <= cur.end + 1` merge — a gap of >= 1
 * line, or a different file, never merges. Groups are found by sorting resolved refs by
 * (path, start); a group's own position in the output is its first member's original card index,
 * so an unmerged ref (or an unresolved one) keeps its card position and a merged group appears
 * where its earliest member did. Never re-reads a file: the merge is over text already resolved.
 */
export function mergeResolvedRefs(refs: readonly ResolvedRef[]): MergedRef[] {
  type Resolved = {
    idx: number;
    path: string;
    start: number;
    end: number;
    text: string;
    truncated: boolean;
    spec: string;
  };
  type Group = {
    position: number;
    path: string;
    start: number;
    end: number;
    text: string;
    truncated: boolean;
    /** `{ spec, idx }` so `specs` can come out in CARD order, not line order. */
    members: { spec: string; idx: number }[];
  };
  type Positioned = { position: number; entry: MergedRef };

  const resolvedEntries: Resolved[] = [];
  const positioned: Positioned[] = [];

  refs.forEach((r, idx) => {
    if (r.text === null || r.path === null || r.start === null || r.end === null) {
      positioned.push({
        position: idx,
        entry: { error: r.error ?? 'unknown error', spec: r.spec },
      });
      return;
    }
    resolvedEntries.push({
      idx,
      path: r.path,
      start: r.start,
      end: r.end,
      text: r.text,
      truncated: r.truncated,
      spec: r.spec,
    });
  });

  const sorted = [...resolvedEntries].sort((a, b) =>
    a.path === b.path ? a.start - b.start : a.path < b.path ? -1 : 1,
  );

  const groups: Group[] = [];
  for (const entry of sorted) {
    const cur = groups[groups.length - 1];
    if (cur !== undefined && cur.path === entry.path && entry.start <= cur.end + 1) {
      if (entry.end > cur.end) {
        const extra = splitLines(entry.text).slice(cur.end - entry.start + 1);
        if (extra.length > 0) cur.text = `${cur.text}\n${extra.join('\n')}`;
        cur.end = entry.end;
      }
      if (entry.truncated) cur.truncated = true;
      cur.members.push({ spec: entry.spec, idx: entry.idx });
      if (entry.idx < cur.position) cur.position = entry.idx;
    } else {
      groups.push({
        position: entry.idx,
        path: entry.path,
        start: entry.start,
        end: entry.end,
        text: entry.text,
        truncated: entry.truncated,
        members: [{ spec: entry.spec, idx: entry.idx }],
      });
    }
  }

  for (const g of groups) {
    positioned.push({
      position: g.position,
      entry: {
        path: g.path,
        start: g.start,
        end: g.end,
        text: g.text,
        truncated: g.truncated,
        specs: g.members.sort((a, b) => a.idx - b.idx).map((m) => m.spec),
      },
    });
  }

  return positioned.sort((a, b) => a.position - b.position).map((p) => p.entry);
}

/** CLI `card show --resolve`: each merged span as a fenced block headed `path:start-end`. */
export function formatResolvedRefs(refs: readonly ResolvedRef[]): string {
  const out: string[] = [];
  for (const m of mergeResolvedRefs(refs)) {
    if ('error' in m) {
      out.push(`${m.spec} — unresolved: ${m.error}`, '');
      continue;
    }
    const range = m.start === m.end ? `${m.start}` : `${m.start}-${m.end}`;
    const suffix = m.truncated ? ' (truncated)' : '';
    const head =
      m.specs.length > 1
        ? `${m.path}:${range}${suffix} — satisfies: ${m.specs.join(', ')}`
        : `${m.path}:${range}${suffix}`;
    out.push(head, '```', m.text, '```', '');
  }
  return out.join('\n');
}
