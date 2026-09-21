/**
 * RCB-60: `.repoboard/local/RIG.md` §"Build first" — "A stale `dist/` silently runs old code; if in doubt,
 * rebuild." Every seat has been bitten by this. `repoboard seat <name>` is the cold-start command
 * every seat runs first, so it is the right moment for one warning line when THIS checkout's own
 * `dist/` (the tsup bundle `packages/server/dist/cli.js` actually runs) is older than its `src/`.
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Newest mtime (ms) of any regular file under `dir`, recursive, skipping `node_modules` at any
 *  depth. `-Infinity` for an empty or unreadable tree so it never wins a staleness comparison. */
async function newestFileMtimeMs(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  let newest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
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
      if (srcNewest > distNewest) stale.push(entry.name);
    }
    if (stale.length === 0) return null;
    return `dist is older than src — run pnpm build (${stale.join(', ')})`;
  } catch {
    return null;
  }
}
