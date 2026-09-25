/**
 * K12 T2/T3/T4 (integration): the repo watcher against a real chokidar instance over a real git
 * fixture. `startServer` awaits the watcher's `ready` before returning, so no manual wait is
 * needed here — by the time `startServer` resolves, the cap decision (T3) has already been made.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/http.js';
import { openRepoContext } from '../src/repo-context.js';
import { openStore } from '../src/store.js';
import { makeTempDir, sleep, waitUntil } from './helpers.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

/**
 * A temp git repo: one committed file, `.gitignore` naming `blobs/`, then `blobs/` created with
 * 500 small files across 20 subdirectories — the K12 fixture shape (a wholly-ignored tree the
 * pre-fix watcher walked and watched in full; freshpickedjobs' own gitignored trees were the same
 * shape, just three orders of magnitude bigger).
 */
async function makeIgnoredTreeFixture(): Promise<string> {
  const root = await makeTempDir('repoboard-watch-');
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), '# hi\n');
  await writeFile(join(root, '.gitignore'), 'blobs/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'one');
  for (let d = 0; d < 20; d++) {
    await mkdir(join(root, 'blobs', `d${d}`), { recursive: true });
    for (let f = 0; f < 25; f++) {
      await writeFile(join(root, 'blobs', `d${d}`, `f${f}.bin`), 'x');
    }
  }
  return root;
}

async function rigOn(root: string, extra: { watchCap?: number; warn?: (m: string) => void } = {}) {
  const store = await openStore(root, {
    watch: false,
    now: () => new Date('2026-09-17T00:00:00Z'),
  });
  cleanups.push(() => store.close());
  const server = await startServer({ store, port: 0, scan: true, ...extra });
  cleanups.push(() => server.close());
  return { store, server, url: server.url.replace(/\/$/, '') };
}

describe('K12 T2: the repo watcher honours .gitignore', () => {
  it('watches zero paths under a wholly-ignored directory (500 files, 20 subdirs)', async () => {
    const root = await makeIgnoredTreeFixture();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { server } = await rigOn(root);

    const watched = server.watchedPaths();
    const underBlobs = watched.filter((p) => p === 'blobs' || p.startsWith('blobs/'));
    expect(underBlobs).toEqual([]);
    // Sanity: the watcher is actually watching something real (not just empty because it's off).
    expect(watched).toContain('.');
    expect(watched).toContain('README.md');
  });
});

describe('K12 T3: a hard cap degrades to no-watch', () => {
  it('closes the watcher over cap, logs one warning, keeps serving, and stops rescanning', async () => {
    const root = await makeIgnoredTreeFixture();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const warnings: string[] = [];
    // Measured on this exact fixture (2026-09-17): the scanner sees 2 tracked files
    // (README.md, .gitignore) while `getWatched()` — root dir, the parent-directory entry
    // chokidar always adds, .git's own allowed HEAD/logs paths, and the two real files — counts
    // 11, once blobs/ is correctly excluded. `watchCap: 10` puts the real count (11) just over
    // the cap while the scanned count (2) is nowhere near it: this is what makes C2 (the control
    // that counts the scan instead of `getWatched()`) fail in the way it must.
    const { server, url } = await rigOn(root, {
      watchCap: 10,
      warn: (m) => warnings.push(m),
    });

    expect(server.watchedPaths()).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(
      /^repo watcher off: \d+ watched paths > cap 10 \(rescans now only on request\)$/,
    );

    const res = await fetch(`${url}/api/board`);
    expect(res.status).toBe(200);

    // RCB-125: `ready` now also fires one background rescan (K16 half 1), landing here whether
    // or not the cap then shuts the watcher off. Settle to that count before capturing
    // `scanCountBefore` — otherwise this rescan can land AFTER the capture (a race against the
    // fetch above, decided by process-spawn timing) and falsely fail the "no further scan"
    // assertion below.
    await waitUntil(() => server.scanCount() === 2, 4000);
    const scanCountBefore = server.scanCount();
    await writeFile(join(root, 'new-file.txt'), 'hello\n');
    await sleep(2500); // longer than the 2000ms default debounce
    expect(server.scanCount()).toBe(scanCountBefore);
  });
});

describe('K12 T4: an untracked-but-not-ignored new file still triggers a rescan', () => {
  it('a brand-new source file (not gitignored) is watched and rescans within the debounce', async () => {
    const root = await makeIgnoredTreeFixture();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { server } = await rigOn(root, {});

    const scanCountBefore = server.scanCount();
    // RCB-117: the first write right after `ready` can be dropped by fs.watch on macOS
    // (measured: 2/8 full-suite runs, watcher alive, a later write rescans); re-writing proves
    // the file is watched without depending on that first event. Each wait (3000ms) must outlast the
    // 2000ms debounce: a re-write resets that timer. Bound 3 x 3000ms.
    const cond = (): boolean =>
      server.scanCount() > scanCountBefore &&
      (server.repo()?.files.some((f) => f.path === 'fresh.txt') ?? false);
    for (let attempt = 0; attempt < 3 && !cond(); attempt++) {
      await writeFile(join(root, 'fresh.txt'), 'new\n');
      await waitUntil(cond, 3000).catch(() => {});
    }
    expect(server.scanCount()).toBeGreaterThan(scanCountBefore);
    expect(server.repo()?.files.map((f) => f.path)).toContain('fresh.txt');
  }, 12000);
});

describe('RCB-125 K16 half 1: one non-blocking rescan on watcher ready closes the initial-scan gap', () => {
  it('a file created between the initial scan and `ready` is missing right after ensureScanned() resolves, then appears once the background rescan lands — with no further scan needed', async () => {
    const root = await makeTempDir('repoboard-ready-gap-');
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'README.md'), '# hi\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'one');

    const store = await openStore(root, {
      watch: false,
      now: () => new Date('2026-09-17T00:00:00Z'),
    });
    cleanups.push(() => store.close());

    const ctx = await openRepoContext('primary', {
      store,
      fun: true,
      scan: true,
      watchRepo: true,
      rescanDebounceMs: 2000,
      watchCap: 20_000,
      warn: () => undefined,
      siblingsFlag: [],
      // RCB-125 test seam (repo-context.ts `afterInitialScan`): fires once the initial scan has
      // resolved but before the repo watcher is created — the exact gap K16 names.
      afterInitialScan: () => writeFile(join(root, 'gap.txt'), 'created in the gap\n'),
    });
    cleanups.push(() => ctx.close());

    await ctx.ensureScanned();

    // RCB-125 half 1: `ensureScanned()` resolves the moment `ready` fires, same as before this
    // change — it does NOT await the rescan `ready` also triggers. The gap file must therefore be
    // ABSENT here: were it already present, the rescan would have been awaited (the parked
    // patch's behaviour this brief rejected, since it puts a second full scan in front of every
    // first map load).
    expect(ctx.scanCount()).toBe(1);
    expect(ctx.repo()?.files.map((f) => f.path)).not.toContain('gap.txt');

    // The one rescan `ready` fires lands in the background; once it does, it must have picked up
    // the gap file.
    await waitUntil(() => ctx.scanCount() === 2, 4000);
    expect(ctx.repo()?.files.map((f) => f.path)).toContain('gap.txt');

    const scanCountAfterReady = ctx.scanCount();
    // Measured by the seat (8/8 isolated runs, 2026-09-25): after `ready`, macOS FSEvents
    // replays ONE `change` event for gap.txt — the write `afterInitialScan` made just before the
    // watcher started — scheduling one further debounced rescan. The bound below is therefore
    // +1, not +0: this still catches a real rescan loop (which would keep scanning past +1),
    // while tolerating the single replayed pre-watch event.
    await sleep(2500); // longer than the 2000ms debounce
    const settled = ctx.scanCount();
    expect(settled).toBeLessThanOrEqual(scanCountAfterReady + 1);
    await sleep(2500); // a second debounce window: quiet must stay quiet — no loop
    expect(ctx.scanCount()).toBe(settled);
  }, 12000);
});
