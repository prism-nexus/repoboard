/**
 * RCB-60: `.repoboard/local/RIG.md` §"Build first" — "A stale `dist/` silently runs old code; if in doubt,
 * rebuild." Every seat has been bitten by this. `repoboard seat <name>` is the cold-start command
 * every seat runs first, so it is the right moment for one warning line when THIS checkout's own
 * `dist/` (the tsup bundle `packages/server/dist/cli.js` actually runs) is older than its `src/`.
 *
 * RCB-145: mtime alone false-alarms on a `git checkout` that lands the exact bytes the current
 * `dist/` was built from but with a newer file mtime. `stampDist` (run by the root build) writes a
 * content digest of `src/` alongside `dist/`'s own newest mtime at build time; `distStaleness`
 * trusts that stamp — over the mtime rule — only when both still match exactly.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The stamp file `stampDist` writes into a package's `dist/`. Never counted as a `dist/` file by
 *  `newestFileMtimeMs`, so writing or having it can never itself flip a package stale/fresh. */
export const DIGEST_FILE = '.src-digest';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Newest mtime (ms) of any regular file under `dir`, recursive, skipping `node_modules` at any
 *  depth and skipping `DIGEST_FILE` wherever it appears. `-Infinity` for an empty or unreadable
 *  tree so it never wins a staleness comparison. */
async function newestFileMtimeMs(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  let newest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === DIGEST_FILE) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await newestFileMtimeMs(full);
      if (sub > newest) newest = sub;
    } else if (entry.isFile()) {
      try {
        const s = await stat(full);
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {
        // raced away between readdir and stat — ignore.
      }
    }
  }
  return newest;
}

/** Every regular file under `dir`, recursive, skipping `node_modules` at any depth, as posix
 *  relative paths from `dir`. Order is whatever `readdir` gives — callers that need a stable order
 *  sort the result themselves. */
async function listFilesRecursive(dir: string, base: string = dir): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, base)));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * sha256 over the sorted list of (posix relative path, NUL, file bytes, NUL) for every regular
 * file under `srcDir`, skipping `node_modules`. Two trees with identical file contents at
 * identical relative paths always hash the same, regardless of mtimes.
 */
export async function srcDigest(srcDir: string): Promise<string> {
  const paths = (await listFilesRecursive(srcDir)).sort();
  const hash = createHash('sha256');
  const nul = Buffer.alloc(1);
  for (const rel of paths) {
    const bytes = await readFile(join(srcDir, ...rel.split('/')));
    hash.update(rel, 'utf8');
    hash.update(nul);
    hash.update(bytes);
    hash.update(nul);
  }
  return hash.digest('hex');
}

/**
 * For every `packages/*` with both a `src/` and a `dist/`, write `dist/.src-digest` recording
 * `srcDigest(src)` and `dist`'s newest file mtime — measured before this write, so the stamp file
 * itself never inflates it. Returns the package names stamped. Throws on a real fs failure: this
 * runs during `pnpm build`, where a silent no-op stamp would be worse than a loud failure.
 */
export async function stampDist(repoRoot: string): Promise<string[]> {
  const packagesDir = join(repoRoot, 'packages');
  let pkgEntries: Dirent[];
  try {
    pkgEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamped: string[] = [];
  for (const entry of pkgEntries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(packagesDir, entry.name);
    const srcDir = join(pkgDir, 'src');
    const distDir = join(pkgDir, 'dist');
    const [hasSrc, hasDist] = await Promise.all([isDirectory(srcDir), isDirectory(distDir)]);
    if (!hasSrc || !hasDist) continue;
    const distNewestMs = await newestFileMtimeMs(distDir);
    const digest = await srcDigest(srcDir);
    await writeFile(join(distDir, DIGEST_FILE), JSON.stringify({ digest, distNewestMs }));
    stamped.push(entry.name);
  }
  return stamped;
}

/** Does `distDir`'s stamp prove the mtime-stale verdict is a false alarm? Any failure to parse or
 *  match — missing file, corrupt JSON, wrong shape, dist touched since the stamp, or a real src
 *  change — resolves `false` (trust the mtime rule), never throws. */
async function stampSaysFresh(
  distDir: string,
  srcDir: string,
  distNewestMs: number,
): Promise<boolean> {
  try {
    const raw = await readFile(join(distDir, DIGEST_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { digest?: unknown; distNewestMs?: unknown };
    if (typeof parsed.digest !== 'string' || typeof parsed.distNewestMs !== 'number') return false;
    if (parsed.distNewestMs !== distNewestMs) return false;
    return (await srcDigest(srcDir)) === parsed.digest;
  } catch {
    return false;
  }
}

/**
 * `repoRoot` is THIS CLI's own monorepo root (derived by the caller from `import.meta.url`, NOT
 * the board's `--root`). Never throws: any fs error anywhere below resolves to `null`, silent —
 * an npm install has no `packages/*\/src` at all, which is the same "nothing to warn about" case
 * as a fully fresh build.
 */
export async function distStaleness(repoRoot: string): Promise<string | null> {
  try {
    const packagesDir = join(repoRoot, 'packages');
    let pkgEntries: Dirent[];
    try {
      pkgEntries = await readdir(packagesDir, { withFileTypes: true });
    } catch {
      return null;
    }
    const stale: string[] = [];
    for (const entry of pkgEntries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(packagesDir, entry.name);
      const srcDir = join(pkgDir, 'src');
      const distDir = join(pkgDir, 'dist');
      const [hasSrc, hasDist] = await Promise.all([isDirectory(srcDir), isDirectory(distDir)]);
      if (!hasSrc || !hasDist) continue;
      const [srcNewest, distNewest] = await Promise.all([
        newestFileMtimeMs(srcDir),
        newestFileMtimeMs(distDir),
      ]);
      if (srcNewest > distNewest && !(await stampSaysFresh(distDir, srcDir, distNewest))) {
        stale.push(entry.name);
      }
    }
    if (stale.length === 0) return null;
    return `dist is older than src — run pnpm build (${stale.join(', ')})`;
  } catch {
    return null;
  }
}
