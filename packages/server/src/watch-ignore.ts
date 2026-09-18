/**
 * K12: the repo watcher's ignore rule, shared with the scanner's own idea of "the repo" so the
 * two do not disagree. The scanner's file list is `git ls-files --cached --others
 * --exclude-standard` (gitignore-aware, `scanner.ts` `gitFiles`). Before this module existed, the
 * chokidar watcher in `http.ts` skipped only `.git` (mostly), `.repoboard`, and path segments
 * named `node_modules`/`dist` — it did NOT honour `.gitignore`. On a root where the gitignored
 * tree is large (build output, data dumps, a pile of worktrees), the watcher walked and watched
 * all of it anyway: two different definitions of "the repo", and the watcher's was the wrong one.
 *
 * Measured cause (coordinator, 2026-09-17 ~23:5xZ, `serve --root
 * /Users/hometown/Projects/Repos/freshpickedjobs --port 4243`): at 27s the log said `warning:
 * watcher: EMFILE: too many open files, scandir …/.repoboard/log` (the store's own watcher
 * starved too); RSS 1.46 GB at 27s → 1.61 GB at 36s, 47% CPU, `/api/board` never answered. The
 * gitignored tree on that root was `packages/db/backups` (19 GB of pg dumps), `apps/web/.wrangler`
 * (1.5 GB of many small files) and `.claude/worktrees` (17,027 directories): 6.36M files outside
 * node_modules/.git.
 */
import { execFile } from 'node:child_process';
import { relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export interface GitIgnoredSet {
  /** Posix, repo-relative, no leading/trailing slash — an ENTIRELY ignored directory (git's
   *  `--directory` collapses a wholly-ignored tree to one `dir/` entry, no matter how deep). */
  dirs: Set<string>;
  /** Posix, repo-relative — an individually-ignored file whose containing directory is not
   *  itself wholly ignored. */
  files: Set<string>;
}

export const EMPTY_IGNORED: GitIgnoredSet = { dirs: new Set(), files: new Set() };

/**
 * Parse `git ls-files -z --others --ignored --exclude-standard --directory` output (NUL-joined,
 * a trailing NUL after the last entry). A line ending in `/` is a wholly-ignored directory
 * (git's `--directory` behaviour); anything else is an individually-ignored file.
 */
export function parseGitIgnoredOutput(out: string): GitIgnoredSet {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const raw of out.split('\0')) {
    if (raw.length === 0) continue;
    if (raw.endsWith('/')) dirs.add(raw.slice(0, -1));
    else files.add(raw);
  }
  return { dirs, files };
}

/**
 * One git spawn; the caller runs it once per watcher start and reuses the result. Empty (never
 * thrown) when `root` is not a git work tree, or `git` itself fails — the watcher then falls back
 * to the pre-existing segment-only rule, unchanged from before K12.
 */
export async function gitIgnoredPaths(root: string): Promise<GitIgnoredSet> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: root, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
    );
    return parseGitIgnoredOutput(stdout);
  } catch {
    return EMPTY_IGNORED;
  }
}

/**
 * True when repo-relative posix `rel` is itself an ignored directory, is under one at any depth,
 * or is an individually-ignored file. Linear in the number of ignored directories, which is the
 * number of top-level `.gitignore` rules that match something on disk, not the number of files
 * under them — fine for the sizes this watches for.
 */
export function isGitIgnoredPath(rel: string, ignored: GitIgnoredSet): boolean {
  if (ignored.files.has(rel)) return true;
  for (const dir of ignored.dirs) {
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** Always ignored, `.gitignore` or not — pre-existing rule, unchanged by K12. */
const GIT_ALLOWED = new Set(['.git', '.git/HEAD', '.git/logs', '.git/logs/HEAD']);

/**
 * The chokidar `ignored` predicate for the repo watcher (`http.ts`). Combines the pre-K12 rule
 * (`.git` except HEAD/logs, `.repoboard` — the store owns watching that itself, `node_modules` /
 * `dist` at any path segment) with the git-ignore rule above (empty `ignored` on a non-git root
 * behaves exactly as before K12). An untracked-but-not-ignored path is NOT ignored here — a
 * brand-new source file must still be watched and trigger a rescan.
 */
export function buildRepoWatchIgnore(
  root: string,
  ignored: GitIgnoredSet,
): (path: string) => boolean {
  return (p: string): boolean => {
    const rel = relative(root, p).split(sep).join('/');
    if (rel === '' || rel.startsWith('..')) return false;
    const parts = rel.split('/');
    if (parts[0] === '.git') return !GIT_ALLOWED.has(rel);
    if (parts[0] === '.repoboard') return true; // the store watches that
    if (parts.some((seg) => seg === 'node_modules' || seg === 'dist')) return true;
    return isGitIgnoredPath(rel, ignored);
  };
}
