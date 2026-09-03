/**
 * P2.4 Repo scanner → RepoSnapshot (BUILD-PLAN §4).
 * Three git spawns total (ls-files, log, rev-parse), never one per file.
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
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
const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;
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

  const files = await mapLimit(paths, CONCURRENCY, async (path): Promise<RepoFile | null> => {
    const full = join(root, path);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(full);
    } catch {
      return null; // listed by git but deleted in the working tree
    }
    if (!st.isFile()) return null;
    const bytes = st.size;
    let lines = 0;
    if (shouldCountLines(path, bytes, maxLineBytes)) {
      try {
        lines = await countNewlines(full);
      } catch {
        lines = 0;
      }
    }
    const act = activity.get(path);
    return {
      path,
      bytes,
      lines,
      lang: langOf(path),
      commits30d: act?.commits30d ?? 0,
      commits90d: act?.commits90d ?? 0,
      lastCommitAt: act?.lastCommitAt ?? null,
    };
  });

  const languages: Record<string, number> = {};
  const kept: RepoFile[] = [];
  for (const f of files) {
    if (!f) continue;
    kept.push(f);
    languages[f.lang] = (languages[f.lang] ?? 0) + f.bytes;
  }

  return {
    root,
    scannedAt: toIso(now),
    files: kept,
    edges: [],
    languages,
    head,
    truncated,
  };
}
