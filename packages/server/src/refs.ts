/**
 * K7: resolve a card's `refs:` against the repo, live on every call — nothing here is cached,
 * because the file changes without the card changing (D6 spirit). Core does the parsing and the
 * span; this module owns the one path from a spec to a filesystem path (`resolveRepoPath`) and
 * the text-file rules it shares with the scanner.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type Card, parseRef, type ResolvedRef, refError, resolveRef } from '@repoboard/core';
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

/** CLI `card show --resolve`: each ref as a fenced block headed `path:start-end`. */
export function formatResolvedRefs(refs: readonly ResolvedRef[]): string {
  const out: string[] = [];
  for (const r of refs) {
    if (r.text === null) {
      out.push(`${r.spec} — unresolved: ${r.error ?? 'unknown error'}`, '');
      continue;
    }
    const range = r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
    const head = `${r.path}:${range}${r.truncated ? ' (truncated)' : ''}`;
    out.push(head, '```', r.text, '```', '');
  }
  return out.join('\n');
}
