/**
 * RCB-43 slice 1: `startServer({store, roots})`, the lazy per-root registry, and `GET /api/repos`.
 * See `docs/RCB-43-MULTIROOT-BRIEF.md` §Slice 1 for the six scenarios below.
 *
 * RCB-43 slice 2: `/api/repos/<key>/…` (one prefix strip, one registry lookup, then the SAME
 * `handleApi`) and the per-root WS (`/api/repos/<key>/ws`). See §Slice 2 for the seven scenarios
 * below `describe('RCB-43 slice 2: ...')`.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { type Card, defaultBoardConfig, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from '../src/http.js';
import { openStore } from '../src/store.js';
import {
  cardText,
  makeTempDir,
  makeTempRepoboard,
  makeTempRepoNoBoard,
  NOW,
  waitUntil,
} from './helpers.js';

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

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A minimal WS client for slice 2's per-root WS tests: buffers messages, `next(pred)` resolves
 * from the buffer or waits. `http.test.ts`'s own `WsClient` is not exported; this is the same
 * shape, kept local and small on purpose. */
type Msg = Record<string, unknown>;
class ScopedWsClient {
  private readonly queue: Msg[] = [];
  private readonly waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i === -1) {
        this.queue.push(m);
        return;
      }
      const [w] = this.waiters.splice(i, 1);
      w?.resolve(m);
    });
  }
  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }
  close(): void {
    this.ws.close();
  }
  next<T = Msg>(pred: (m: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
    const i = this.queue.findIndex((m) => pred(m as T));
    if (i !== -1) return Promise.resolve(this.queue.splice(i, 1)[0] as T);
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        const j = this.waiters.indexOf(waiter);
        if (j !== -1) this.waiters.splice(j, 1);
        rej(new Error('timed out waiting for ws message'));
      }, timeoutMs);
      const waiter = {
        pred: (m: Msg) => pred(m as T),
        resolve: (m: Msg) => {
          clearTimeout(timer);
          res(m as T);
        },
      };
      this.waiters.push(waiter);
    });
  }
}

function connectPath(url: string, path: string): Promise<ScopedWsClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${path}`);
    ws.once('open', () => res(new ScopedWsClient(ws)));
    ws.once('error', rej);
  });
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
    // RCB-125: `ensureScanned()` now resolves the moment the watcher's `ready` fires, WITHOUT
    // waiting for the rescan `ready` also triggers (K16 half 1) — so the count right here can be
    // 1 (rescan still in flight) or 2 (already landed), depending on how fast the background scan
    // ran relative to this line. Waiting for the settled count, rather than asserting immediately,
    // is what makes this deterministic instead of a race two different ways could pass.
    await waitUntil(() => ctx1.scanCount() === 2, 4000);
    expect(ctx1.scanCount()).toBe(2);
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

describe('RCB-43 slice 2: /api/repos/<key>/… and the per-root WS', () => {
  it("1. scoped board read: /api/repos/<b>/board returns b's cards, not a's; /api/board still a's", async () => {
    const a = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    const b = await makeTempRepoboard({ 'RB-2.md': cardText('RB-2', 'todo') });
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());
    const bKey = basename(b.root).toLowerCase();

    const bBoard = await jsonOf<{ cards: Card[] }>(
      await fetch(`${server.url}api/repos/${bKey}/board`),
    );
    expect(bBoard.cards.map((c) => c.id)).toEqual(['RB-2']);

    const aBoard = await jsonOf<{ cards: Card[] }>(await fetch(`${server.url}api/board`));
    expect(aBoard.cards.map((c) => c.id)).toEqual(['RB-1']);
  });

  it("2. scoped write: POST /api/repos/<b>/cards creates a card in b's cards/ and events.jsonl, not a's", async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoboard({});
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());
    const bKey = basename(b.root).toLowerCase();

    const res = await fetch(`${server.url}api/repos/${bKey}/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'in b' }),
    });
    expect(res.status).toBe(201);
    const created = (await jsonOf<Card>(res)).id;

    const bBoard = await jsonOf<{ cards: Card[] }>(
      await fetch(`${server.url}api/repos/${bKey}/board`),
    );
    expect(bBoard.cards.map((c) => c.id)).toEqual([created]);
    const aBoard = await jsonOf<{ cards: Card[] }>(await fetch(`${server.url}api/board`));
    expect(aBoard.cards).toEqual([]);

    const bEvents = await readFile(join(b.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(bEvents).toContain(`"cardId":"${created}"`);
    let aEvents = '';
    try {
      aEvents = await readFile(join(a.root, '.repoboard', 'events.jsonl'), 'utf8');
    } catch {
      aEvents = '';
    }
    expect(aEvents).not.toContain(created);
  });

  it('3. unknown key is 404 naming every known key; GET /api/repos/<b> (no rest) answers without opening', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoboard({});
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());
    const aKey = basename(a.root).toLowerCase();
    const bKey = basename(b.root).toLowerCase();

    const missing = await fetch(`${server.url}api/repos/nope/board`);
    expect(missing.status).toBe(404);
    const message = (await jsonOf<{ error: string }>(missing)).error;
    expect(message).toContain(aKey);
    expect(message).toContain(bKey);

    const entry = await fetch(`${server.url}api/repos/${bKey}`);
    expect(entry.status).toBe(200);
    expect(await jsonOf<{ key: string; open: boolean; scanned: boolean }>(entry)).toMatchObject({
      key: bKey,
      open: false,
      scanned: false,
    });
    expect(server.context(bKey)).toBeUndefined();
  });

  it('4. map on demand over HTTP: /board leaves b unscanned; /repo scans it and returns files', async () => {
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

    await fetch(`${server.url}api/repos/${bKey}/board`);
    expect(server.context(bKey)?.scanCount()).toBe(0);

    const repoRes = await fetch(`${server.url}api/repos/${bKey}/repo`);
    expect(repoRes.status).toBe(200);
    const body = await jsonOf<{ files: unknown[] }>(repoRes);
    expect(Array.isArray(body.files)).toBe(true);
    // RCB-125: the `/repo` route awaits `ensureScanned()`, which now resolves on `ready` without
    // waiting for the rescan `ready` also fires (K16 half 1) — so the count right after the HTTP
    // round trip can already be 2, not 1, depending on timing. Wait for the settled count instead
    // of asserting the count this instant.
    await waitUntil(() => server.context(bKey)?.scanCount() === 2, 4000);
    expect(server.context(bKey)?.scanCount()).toBe(2);
  });

  it("5. per-root WS: connects to b's snapshot, card:move moves b's card only; a's /ws client gets nothing", async () => {
    const a = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    const b = await makeTempRepoboard({ 'RB-2.md': cardText('RB-2', 'todo') });
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());
    const bKey = basename(b.root).toLowerCase();
    const url = server.url.replace(/\/$/, '');

    const aClient = await connectPath(url, '/ws');
    cleanups.push(async () => aClient.close());
    const bClient = await connectPath(url, `/api/repos/${bKey}/ws`);
    cleanups.push(async () => bClient.close());

    const bSnap = await bClient.next<{ type: string; board: { cards: Card[] } }>(
      (m) => m.type === 'snapshot',
    );
    expect(bSnap.board.cards.map((c) => c.id)).toEqual(['RB-2']);
    await aClient.next((m) => m.type === 'snapshot');

    const bMoved = bClient.next<{ type: string; card: Card }>(
      (m) => m.type === 'card' && (m.card as Card).status === 'doing',
    );
    bClient.send({ type: 'card:move', id: 'RB-2', status: 'doing', actor: 'ui' });
    expect((await bMoved).card.status).toBe('doing');
    expect(await readFile(join(b.cardsDir, 'RB-2.md'), 'utf8')).toContain('status: doing');
    expect(await readFile(join(a.cardsDir, 'RB-1.md'), 'utf8')).toContain('status: todo');

    await expect(aClient.next(() => true, 300)).rejects.toThrow(/timed out/);
  });

  it('6. reserved key: a root literally named "repos" gets key "repos-2"; GET /api/repos still lists', async () => {
    const parentA = await makeTempDir();
    const parentB = await makeTempDir();
    cleanups.push(
      () => rm(parentA, { recursive: true, force: true }),
      () => rm(parentB, { recursive: true, force: true }),
    );
    const a = join(parentA, 'primary');
    const b = join(parentB, 'repos');
    await mkdir(join(a, '.repoboard', 'cards'), { recursive: true });
    await mkdir(join(b, '.repoboard', 'cards'), { recursive: true });
    await writeFile(join(a, '.repoboard', 'board.yml'), serializeBoard(defaultBoardConfig()));
    await writeFile(join(b, '.repoboard', 'board.yml'), serializeBoard(defaultBoardConfig()));
    const store = await openStore(a, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a, b],
      now: () => NOW,
    });
    cleanups.push(() => server.close());

    const body = await reposOf(server);
    expect(body.repos.map((r) => r.key)).toEqual(['primary', 'repos-2']);
    expect(body.primary).toBe('primary');
  });

  it('7. boardless b: POST /api/repos/<b>/cards is 409; b/.repoboard stays absent (O7 through the scoped path)', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoNoBoard({ 'a.ts': 'export const a = 1;\n' });
    cleanups.push(a.cleanup, b.cleanup);
    const store = await openStore(a.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      roots: [a.root, b.root],
      now: () => NOW,
    });
    cleanups.push(() => server.close());
    const bKey = basename(b.root).toLowerCase();

    const res = await fetch(`${server.url}api/repos/${bKey}/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hole' }),
    });
    expect(res.status).toBe(409);
    expect(await b.hasRepoboard()).toBe(false);
  });
});
