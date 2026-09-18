/**
 * RCB-43 slice 1: `startServer({store, roots})`, the lazy per-root registry, and `GET /api/repos`.
 * See `docs/RCB-43-MULTIROOT-BRIEF.md` §Slice 1 for the six scenarios below.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/http.js';
import { openStore } from '../src/store.js';
import { makeTempDir, makeTempRepoboard, makeTempRepoNoBoard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface ReposEntry {
  key: string;
  root: string;
  name: string;
  hasBoard: boolean;
  open: boolean;
  scanned: boolean;
}
interface ReposBody {
  primary: string;
  repos: ReposEntry[];
}

async function reposOf(server: RunningServer): Promise<ReposBody> {
  const res = await fetch(`${server.url}api/repos`);
  return (await res.json()) as ReposBody;
}

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

describe('RCB-43 slice 1: startServer({roots}) and GET /api/repos', () => {
  it('1. lists both roots; primary is a; b is unopened, unscanned, hasBoard correct without opening', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoboard({});
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false, roots: [a.root, b.root] });
    cleanups.push(() => server.close());

    const body = await reposOf(server);
    const aKey = basename(a.root).toLowerCase();
    const bKey = basename(b.root).toLowerCase();
    expect(body.primary).toBe(aKey);
    expect(body.repos.map((r) => r.key)).toEqual([aKey, bKey]);
    const bEntry = body.repos.find((r) => r.key === bKey);
    expect(bEntry).toMatchObject({ root: b.root, hasBoard: true, open: false, scanned: false });
    // b has a real board.yml on disk, so `hasBoard: true` above was computed WITHOUT opening it.
    expect(server.repos().length).toBe(1);
    expect(server.context(bKey)).toBeUndefined();
  });

  it('2. key collision: two roots both named "proj" get proj, proj-2 in --root order', async () => {
    const parentA = await makeTempDir();
    const parentB = await makeTempDir();
    cleanups.push(
      () => rm(parentA, { recursive: true, force: true }),
      () => rm(parentB, { recursive: true, force: true }),
    );
    const a = join(parentA, 'proj');
    const b = join(parentB, 'proj');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const store = await openStore(a, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false, roots: [a, b] });
    cleanups.push(() => server.close());

    const body = await reposOf(server);
    expect(body.repos.map((r) => r.key)).toEqual(['proj', 'proj-2']);
    expect(body.primary).toBe('proj');
  });

  it('3. roots[0] !== store.root throws at startServer, naming both paths', async () => {
    const a = await makeTempRepoboard({});
    const bDir = await makeTempDir();
    cleanups.push(a.cleanup, () => rm(bDir, { recursive: true, force: true }));
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    let threw: unknown;
    try {
      await startServer({ store, port: 0, scan: false, roots: [bDir, a.root] });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    const message = threw instanceof Error ? threw.message : String(threw);
    expect(message).toContain(bDir);
    expect(message).toContain(a.root);
  });

  it('4. map on demand: openRepo(b) leaves it unscanned; ensureScanned scans it; concurrent openRepo resolves to the same object', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoboard({});
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: true,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());

    const bKey = basename(b.root).toLowerCase();
    const [ctx1, ctx2] = await Promise.all([server.openRepo(bKey), server.openRepo(bKey)]);
    expect(ctx1).toBe(ctx2);
    expect(ctx1.scanCount()).toBe(0);
    expect(ctx1.watchedPaths()).toEqual([]);

    await ctx1.ensureScanned();
    expect(ctx1.scanCount()).toBe(1);
  });

  it('5. read-only: opening and scanning a no-board root writes nothing into it', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoNoBoard({ 'a.ts': 'export const a = 1;\n' });
    cleanups.push(a.cleanup, b.cleanup);
    await git(b.root, 'init', '-q');
    await git(b.root, 'add', '-A');
    await git(b.root, 'commit', '-q', '-m', 'fixture');
    expect(await git(b.root, 'status', '--porcelain')).toBe('');

    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: true,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());

    const bKey = basename(b.root).toLowerCase();
    const ctx = await server.openRepo(bKey);
    await ctx.ensureScanned();

    expect(await b.hasRepoboard()).toBe(false);
    expect(await git(b.root, 'status', '--porcelain')).toBe('');
  });

  it('6. single-root regression: no `roots` lists exactly one repo, the primary', async () => {
    const a = await makeTempRepoboard({});
    cleanups.push(a.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());

    const body = await reposOf(server);
    expect(body.repos.length).toBe(1);
    expect(body.primary).toBe(body.repos[0]?.key);
    expect(body.repos[0]).toMatchObject({ root: a.root, open: true });
  });
});
