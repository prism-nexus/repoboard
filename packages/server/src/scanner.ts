/**
 * P2.4 Repo scanner → RepoSnapshot (BUILD-PLAN §4).
 * Three git spawns total (ls-files, log, rev-parse), never one per file.
 * P4.4: JS/TS import edges from a regex scan (no bundler), capped at EDGE_CAP.
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RepoSnapshot } from '@rcb/core';
import { toIso } from '@rcb/core';

const execFileAsync = promisify(execFile);

export type RepoFile = RepoSnapshot['files'][number];

/** §4 plus `truncated` (additive): true when the file list hit the cap. */
export interface ScanResult extends RepoSnapshot {
  truncated: boolean;
}

export interface ScanOptions {
  now?: () => Date;
  /** Max files considered; §4 says 20,000. */
  cap?: number;
  /** Files bigger than this are not line-counted. */
  maxLineCountBytes?: number;
}

export const FILE_CAP = 20_000;
/** §5 P4.4: the import graph stops growing here. */
export const EDGE_CAP = 5_000;
const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;
/** Files whose imports are scanned (P4.4). */
const IMPORT_SCAN_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
/** Resolution candidates for a relative specifier, tried after the literal path. */
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx'];
const RESOLVE_INDEX = RESOLVE_EXT.map((e) => `/index${e}`);
const WALK_SKIP = new Set(['node_modules', '.git', 'dist']);
const CONCURRENCY = 32;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  xml: 'xml',
  svg: 'svg',
  txt: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  pdf: 'binary',
  zip: 'binary',
  gz: 'binary',
  tgz: 'binary',
  wasm: 'binary',
};

const BINARY_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'tar',
  'bz2',
  '7z',
  'jar',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'wav',
  'ogg',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'wasm',
  'class',
  'pyc',
]);

const LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
]);

const LANG_BY_BASENAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
};

export function langOf(path: string): string {
  const base = basename(path).toLowerCase();
  if (LOCK_FILES.has(base)) return 'lock';
  const byName = LANG_BY_BASENAME[base];
  if (byName) return byName;
  const ext = extname(base).slice(1);
  return (ext && LANG_BY_EXT[ext]) || 'other';
}

function shouldCountLines(path: string, bytes: number, maxBytes: number): boolean {
  if (bytes > maxBytes) return false;
  const base = basename(path).toLowerCase();
  if (LOCK_FILES.has(base)) return false;
  return !BINARY_EXT.has(extname(base).slice(1));
}

function countNewlines(path: string): Promise<number> {
  return new Promise((res, rej) => {
    let n = 0;
    createReadStream(path)
      .on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        let i = -1;
        // biome-ignore lint/suspicious/noAssignInExpressions: tight scan loop
        while ((i = buf.indexOf(0x0a, i + 1)) !== -1) n++;
      })
      .on('end', () => res(n))
      .on('error', rej);
  });
}

/**
 * P4.4 import scan. Matches, in one pass over the source text:
 *   import … from '…'   import '…'   export … from '…'   import('…')   require('…')
 * Bare package specifiers are dropped; only `./` and `../` come back. Comments are not
 * stripped, so a commented-out import counts — accepted for a regex scan with no parser.
 */
const IMPORT_RE =
  /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]|\b(?:import|require)\(\s*['"]([^'"\n]+)['"]\s*\)/g;

export function findImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec && (spec.startsWith('./') || spec.startsWith('../'))) out.push(spec);
  }
  return out;
}

/**
 * Resolve a relative specifier from `fromPath` (repo-relative, posix) to a repo path in `known`.
 * Order: the literal path; a `.js/.jsx` specifier rewritten to `.ts/.tsx` (TS ESM convention);
 * then `.ts .tsx .js .jsx`; then `/index.*`. Null when nothing matches (e.g. a `.vue` file).
 */
export function resolveImport(
  fromPath: string,
  spec: string,
  known: ReadonlySet<string>,
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  if (base.startsWith('../')) return null; // escapes the repo
  if (known.has(base)) return base;
  const ext = posix.extname(base);
  if (ext === '.js' || ext === '.jsx') {
    const stem = base.slice(0, -ext.length);
    for (const e of ext === '.js' ? ['.ts', '.tsx'] : ['.tsx', '.ts']) {
      if (known.has(stem + e)) return stem + e;
    }
  }
  for (const e of RESOLVE_EXT) if (known.has(base + e)) return base + e;
  for (const e of RESOLVE_INDEX) if (known.has(base + e)) return base + e;
  return null;
}

function scansImports(path: string, bytes: number, maxBytes: number): boolean {
  return bytes <= maxBytes && IMPORT_SCAN_EXT.has(extname(path).slice(1).toLowerCase());
}

function countNewlinesIn(buf: Buffer): number {
  let n = 0;
  let i = -1;
  // biome-ignore lint/suspicious/noAssignInExpressions: tight scan loop
  while ((i = buf.indexOf(0x0a, i + 1)) !== -1) n++;
  return n;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await stat(join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Tracked plus untracked files, minus whatever .gitignore excludes (§4: respect .gitignore). */
async function gitFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.split('\0').filter((p) => p.length > 0);
}

/** Walk when not in git: skips node_modules/.git/dist and symlinks, stops at `cap`. */
async function walkFiles(root: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < cap) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!WALK_SKIP.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

interface Activity {
  commits30d: number;
  commits90d: number;
  lastCommitAt: string | null;
}

/**
 * One `git log` over the last 90 days. Output shape per commit:
 *   <sha>\0<committer-iso>\n\n<path>\n<path>\n\n
 * Any line containing NUL starts a new commit; blank lines are skipped; the rest are paths.
 */
export function parseGitLog(out: string, now: Date): Map<string, Activity> {
  const cutoff30 = now.getTime() - 30 * 86_400_000;
  const perFile = new Map<string, Activity>();
  let commitTime: number | null = null;
  let commitIso: string | null = null;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      commitIso = line.slice(nul + 1).trim();
      const t = Date.parse(commitIso);
      commitTime = Number.isNaN(t) ? null : t;
      continue;
    }
    if (commitTime === null || commitIso === null) continue;
    const entry = perFile.get(line) ?? { commits30d: 0, commits90d: 0, lastCommitAt: null };
    entry.commits90d++;
    if (commitTime >= cutoff30) entry.commits30d++;
    // git log is newest-first; the first time we see a path is its latest commit.
    if (entry.lastCommitAt === null) entry.lastCommitAt = commitIso;
    perFile.set(line, entry);
  }
  return perFile;
}

async function gitActivity(root: string, now: Date): Promise<Map<string, Activity>> {
  try {
    const out = await git(root, [
      '-c',
      'core.quotePath=false',
      'log',
      '--since=90.days',
      '--name-only',
      '--format=%H%x00%cI',
    ]);
    return parseGitLog(out, now);
  } catch {
    return new Map(); // no commits yet, or git missing: activity is simply unknown
  }
}

async function gitHead(root: string): Promise<RepoSnapshot['head']> {
  try {
    // rev-parse applies flags to the arguments after them: sha first, then the short ref.
    const out = await git(root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
    const [sha, branch] = out.trim().split('\n');
    if (!branch || !sha) return null;
    return { branch, sha };
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function scanRepo(rootIn: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const root = resolve(rootIn);
  const now = opts.now?.() ?? new Date();
  const cap = opts.cap ?? FILE_CAP;
  const maxLineBytes = opts.maxLineCountBytes ?? MAX_LINE_COUNT_BYTES;
  const inGit = await isGitRepo(root);

  const [listed, activity, head] = await Promise.all([
    inGit ? gitFiles(root) : walkFiles(root, cap + 1),
    inGit ? gitActivity(root, now) : Promise.resolve(new Map<string, Activity>()),
    inGit ? gitHead(root) : Promise.resolve(null),
  ]);
  const truncated = listed.length > cap;
  const paths = truncated ? listed.slice(0, cap) : listed;

  type Scanned = { file: RepoFile; specs: string[] };
  const files = await mapLimit(paths, CONCURRENCY, async (path): Promise<Scanned | null> => {
    const full = join(root, path);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(full);
    } catch {
      return null; // listed by git but deleted in the working tree
    }
    if (!st.isFile()) return null;
    const bytes = st.size;
    // K3: a file that is not line-counted (binary, lock file, > maxLineBytes) reports null.
    let lines: number | null = null;
    let specs: string[] = [];
    if (scansImports(path, bytes, maxLineBytes)) {
      // JS/TS: one read serves both the newline count and the import scan.
      try {
        const buf = await readFile(full);
        lines = countNewlinesIn(buf);
        specs = findImportSpecifiers(buf.toString('utf8'));
      } catch {
        lines = null;
      }
    } else if (shouldCountLines(path, bytes, maxLineBytes)) {
      try {
        lines = await countNewlines(full);
      } catch {
        lines = null;
      }
    }
    const act = activity.get(path);
    return {
      file: {
        path,
        bytes,
        lines,
        lang: langOf(path),
        commits30d: act?.commits30d ?? 0,
        commits90d: act?.commits90d ?? 0,
        lastCommitAt: act?.lastCommitAt ?? null,
      },
      specs,
    };
  });

  const languages: Record<string, number> = {};
  const kept: RepoFile[] = [];
  const known = new Set<string>();
  for (const s of files) {
    if (!s) continue;
    kept.push(s.file);
    known.add(s.file.path);
    languages[s.file.lang] = (languages[s.file.lang] ?? 0) + s.file.bytes;
  }

  // P4.4: resolve specifiers against the file set, dedupe, cap. Self-imports are dropped.
  const edges: RepoSnapshot['edges'] = [];
  const seen = new Set<string>();
  outer: for (const s of files) {
    if (!s || s.specs.length === 0) continue;
    for (const spec of s.specs) {
      const to = resolveImport(s.file.path, spec, known);
      if (to === null || to === s.file.path) continue;
      const key = `${s.file.path}\0${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: s.file.path, to });
      if (edges.length >= EDGE_CAP) break outer;
    }
  }

  return {
    root,
    scannedAt: toIso(now),
    files: kept,
    edges,
    languages,
    head,
    truncated,
  };
}
