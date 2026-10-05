import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  appendLogBlock,
  type Card,
  dailyLogHeader,
  defaultBoardConfig,
  formatLogBlock,
  initialStateText,
  serializeBoard,
  serializeLeases,
  setStateSection,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from '../src/http.js';
import { githubWebBase } from '../src/repo-context.js';
import { type CardStore, openStore } from '../src/store.js';
import {
  cardText,
  dumpWatchDiag,
  makeTempDir,
  makeTempRepoboard,
  makeTempRepoNoBoard,
  NOW,
  type TempRepo,
} from './helpers.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Rig {
  repo: TempRepo;
  store: CardStore;
  server: RunningServer;
  url: string;
}

async function rig(
  cards: Record<string, string>,
  opts: { scan?: boolean; webDir?: string; fun?: boolean } = {},
): Promise<Rig> {
  const repo = await makeTempRepoboard(cards);
  cleanups.push(repo.cleanup);
  const store = await openStore(repo.root, { watch: true, now: () => NOW });
  cleanups.push(() => store.close());
  const server = await startServer({ store, port: 0, scan: opts.scan ?? false, ...opts });
  cleanups.push(() => server.close());
  return { repo, store, server, url: server.url.replace(/\/$/, '') };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

type Msg = Record<string, unknown>;
interface Waiter {
  pred: (m: Msg) => boolean;
  resolve: (m: Msg) => void;
}

/**
 * A ws client that buffers every message from the moment the socket opens.
 * The server sends `snapshot` immediately on connect, so its bytes can arrive in the same
 * chunk as the upgrade response; `ws` unshifts that head and delivers it on nextTick, BEFORE
 * an `await`ed `open` continuation runs. A listener attached after `await connect()` would
 * miss it — which is exactly the flake this replaces.
 */
class WsClient {
  private readonly queue: Msg[] = [];
  private readonly waiters: Waiter[] = [];
  constructor(
    readonly ws: WebSocket,
    private readonly diagRoots: readonly string[] = [],
  ) {
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
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  close(): void {
    this.ws.close();
  }
  /** First buffered or future message satisfying `pred`. */
  /** `expectingNone`: this wait is a negative assertion (a timeout is the PASS), so skip the RB157
   * dump — a real miss's DIAG block must not be buried among expected ones. */
  next<T = Msg>(
    pred: (m: T) => boolean = () => true,
    timeoutMs = 4000,
    expectingNone = false,
  ): Promise<T> {
    const i = this.queue.findIndex((m) => pred(m as T));
    if (i !== -1) {
      const [m] = this.queue.splice(i, 1);
      return Promise.resolve(m as T);
    }
    return new Promise<T>((res, rej) => {
      const waiter: Waiter = {
        pred: (m) => pred(m as T),
        resolve: (m) => {
          clearTimeout(timer);
          res(m as T);
        },
      };
      const timer = setTimeout(() => {
        const j = this.waiters.indexOf(waiter);
        if (j !== -1) this.waiters.splice(j, 1);
        if (!expectingNone) dumpWatchDiag(this.diagRoots);
        rej(new Error('timed out waiting for ws message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function connect(url: string, diagRoots: readonly string[] = []): Promise<WsClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    // Wrap inside the open handler, synchronously, so no message can slip past.
    ws.once('open', () => res(new WsClient(ws, diagRoots)));
    ws.once('error', rej);
  });
}

function nextMessage<T = Msg>(
  client: WsClient,
  pred: (m: T) => boolean = () => true,
  timeoutMs = 4000,
): Promise<T> {
  return client.next(pred, timeoutMs);
}

describe('HTTP routes', () => {
  it('binds 127.0.0.1 and GET /api/board returns config, cards and invalid', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo'), 'RB-2.md': 'nope' });
    expect(r.server.host).toBe('127.0.0.1');
    const body = (await json(await fetch(`${r.url}/api/board`))) as {
      config: { prefix: string; fun: boolean };
      cards: Card[];
      invalid: { path: string }[];
    };
    expect(body.config.prefix).toBe('RB');
    expect(body.config.fun).toBe(true);
    expect(body.cards.map((c) => c.id)).toEqual(['RB-1']);
    expect(body.invalid[0]?.path).toBe(join('.repoboard', 'cards', 'RB-2.md'));
  });

  it('--no-fun surfaces as config.fun=false', async () => {
    const r = await rig({}, { fun: false });
    const body = (await json(await fetch(`${r.url}/api/board`))) as { config: { fun: boolean } };
    expect(body.config.fun).toBe(false);
  });

  it('RCB-41: GET /api/board carries config.name when board.yml sets one, and omits it otherwise', async () => {
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), name: 'Fresh Picked Jobs' }),
    );
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    const body = (await json(await fetch(`${url}/api/board`))) as { config: { name?: string } };
    expect(body.config.name).toBe('Fresh Picked Jobs');

    // No name at all: a plain default board — omitted, not null or empty.
    const noNameRepo = await makeTempRepoboard({});
    cleanups.push(noNameRepo.cleanup);
    const noNameStore = await openStore(noNameRepo.root, { watch: false, now: () => NOW });
    cleanups.push(() => noNameStore.close());
    const noNameServer = await startServer({ store: noNameStore, port: 0, scan: false });
    cleanups.push(() => noNameServer.close());
    const noNameUrl = noNameServer.url.replace(/\/$/, '');
    const noNameBody = (await json(await fetch(`${noNameUrl}/api/board`))) as {
      config: { name?: string };
    };
    expect('name' in noNameBody.config).toBe(false);
  });

  it('RCB-42: GET /api/board carries the merged siblings list next to config, not inside it', async () => {
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        siblings: [
          { name: 'globex', url: 'http://localhost:4243' },
          { name: 'stable', url: 'http://localhost:4244' },
        ],
      }),
    );
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      siblingsFlag: [
        { name: 'globex', url: 'http://localhost:9999' }, // collision: the flag wins
        { name: 'newcomer', url: 'http://localhost:5001' },
      ],
    });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    const body = (await json(await fetch(`${url}/api/board`))) as {
      config: { siblings?: { name: string; url: string }[] };
      siblings: { name: string; url: string }[];
    };
    // `config.siblings` is the file's own (unmerged) list — config stays honest about the file,
    // the same as `store.config` verbatim. The MERGED list is the top-level `siblings` key.
    expect(body.config.siblings).toEqual([
      { name: 'globex', url: 'http://localhost:4243' },
      { name: 'stable', url: 'http://localhost:4244' },
    ]);
    expect(body.siblings).toEqual([
      { name: 'globex', url: 'http://localhost:9999' },
      { name: 'stable', url: 'http://localhost:4244' },
      { name: 'newcomer', url: 'http://localhost:5001' },
    ]);
  });

  it('RCB-42: no board.yml siblings and no --sibling flags is an empty list, not absent', async () => {
    const r = await rig({});
    const body = (await json(await fetch(`${r.url}/api/board`))) as { siblings: unknown };
    expect(body.siblings).toEqual([]);
  });

  it('RCB-42: a live board.yml edit’s config broadcast carries the updated merged siblings', async () => {
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({
      store,
      port: 0,
      scan: false,
      siblingsFlag: [{ name: 'flagOnly', url: 'http://localhost:6000' }],
    });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    const ws = await connect(url, [repo.root]);
    cleanups.push(async () => ws.close());
    await nextMessage(ws, (m) => m.type === 'snapshot');

    const configMsg = nextMessage<{ type: string; siblings: { name: string; url: string }[] }>(
      ws,
      (m) => m.type === 'config',
    );
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        siblings: [{ name: 'globex', url: 'http://localhost:4243' }],
      }),
    );
    const msg = await configMsg;
    expect(msg.siblings).toEqual([
      { name: 'globex', url: 'http://localhost:4243' },
      { name: 'flagOnly', url: 'http://localhost:6000' },
    ]);
  });

  it('POST /api/cards creates via core; bad input is 400', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Made by http', status: 'doing', labels: ['x'], actor: 'me' }),
    });
    expect(res.status).toBe(201);
    const card = (await json(res)) as Card;
    expect(card.id).toBe('RB-2');
    expect(card.status).toBe('doing');
    expect(await readFile(join(r.repo.cardsDir, 'RB-2.md'), 'utf8')).toContain('Made by http');

    const bad = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'x', status: 'nowhere' }),
    });
    expect(bad.status).toBe(400);
    expect(((await json(bad)) as { error: string }).error).toMatch(/unknown column/);

    const noTitle = await fetch(`${r.url}/api/cards`, { method: 'POST', body: '{}' });
    expect(noTitle.status).toBe(400);
    const notJson = await fetch(`${r.url}/api/cards`, { method: 'POST', body: '{nope' });
    expect(notJson.status).toBe(400);
  });

  it('PATCH /api/cards/:id moves (status) and updates (other fields)', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'doing', assignee: 'claude/x', actor: 'tester' }),
    });
    expect(res.status).toBe(200);
    const card = (await json(res)) as Card;
    expect(card.status).toBe('doing');
    expect(card.assignee).toBe('claude/x');
    const text = await readFile(join(r.repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('tester — moved todo → doing');
    expect(text).toContain('tester — updated assignee');

    const events = (await json(await fetch(`${r.url}/api/events`))) as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(['move', 'update']);
    const none = (await json(await fetch(`${r.url}/api/events?since=2030-01-01T00:00:00Z`))) as [];
    expect(none).toEqual([]);

    expect((await fetch(`${r.url}/api/cards/RB-9`, { method: 'PATCH', body: '{}' })).status).toBe(
      404,
    );
    const badCol = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'nope' }),
    });
    expect(badCol.status).toBe(400);
    const unknownField = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ id: 'RB-5' }),
    });
    expect(unknownField.status).toBe(400);
    expect(((await json(unknownField)) as { error: string }).error).toMatch(/unknown field "id"/);
  });

  it('RCB-68: PATCH each of parent/phase/gate, null clears, non-string is 400; POST create with them', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo'),
    });
    const set = await fetch(`${r.url}/api/cards/RB-2`, {
      method: 'PATCH',
      body: JSON.stringify({ parent: 'RB-1', phase: 'PH.1', gate: 'RB-1' }),
    });
    expect(set.status).toBe(200);
    const card = (await json(set)) as Card;
    expect(card.parent).toBe('RB-1');
    expect(card.phase).toBe('PH.1');
    expect(card.gate).toBe('RB-1');

    const cleared = await fetch(`${r.url}/api/cards/RB-2`, {
      method: 'PATCH',
      body: JSON.stringify({ parent: null, phase: null, gate: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedCard = (await json(cleared)) as Card;
    expect(clearedCard.parent).toBeUndefined();
    expect(clearedCard.phase).toBeUndefined();
    expect(clearedCard.gate).toBeUndefined();

    const badParent = await fetch(`${r.url}/api/cards/RB-2`, {
      method: 'PATCH',
      body: JSON.stringify({ parent: 42 }),
    });
    expect(badParent.status).toBe(400);
    expect(((await json(badParent)) as { error: string }).error).toMatch(/parent must be a string/);

    const unknownParent = await fetch(`${r.url}/api/cards/RB-2`, {
      method: 'PATCH',
      body: JSON.stringify({ parent: 'RB-404' }),
    });
    expect(unknownParent.status).toBe(400);
    expect(((await json(unknownParent)) as { error: string }).error).toBe(
      'parent: unknown card "RB-404" (card list shows the ids)',
    );

    const created = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'step', parent: 'RB-1', phase: 'PH.2', gate: 'sentence gate' }),
    });
    expect(created.status).toBe(201);
    const createdCard = (await json(created)) as Card;
    expect(createdCard.parent).toBe('RB-1');
    expect(createdCard.phase).toBe('PH.2');
    expect(createdCard.gate).toBe('sentence gate');
  });

  it('RCB-67: POST /api/cards accepts size, rejects a bad one with the body verbatim', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'sized', size: 'L' }),
    });
    expect(res.status).toBe(201);
    const card = (await json(res)) as Card;
    expect(card.size).toBe('L');

    const bad = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'x', size: 'huge' }),
    });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: 'size must be S|M|L|XL' });
  });

  it('RCB-67: PATCH /api/cards/:id sets size, null clears it, a bad one is 400 with the body verbatim', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const set = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ size: 'M' }),
    });
    expect(set.status).toBe(200);
    expect(((await json(set)) as Card).size).toBe('M');

    const cleared = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ size: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await json(cleared)) as Card).size).toBeUndefined();

    const bad = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({ size: 'huge' }),
    });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: 'size must be S|M|L|XL' });
  });

  it('GET /api/repo returns a snapshot when scanning is on, 404 when off', async () => {
    const off = await rig({});
    expect((await fetch(`${off.url}/api/repo`)).status).toBe(404);

    const on = await rig({ 'RB-1.md': cardText('RB-1', 'todo') }, { scan: true });
    const snap = (await json(await fetch(`${on.url}/api/repo`))) as {
      files: { path: string }[];
      edges: [];
      head: null;
      truncated: boolean;
    };
    expect(snap.files.map((f) => f.path)).toContain('.repoboard/cards/RB-1.md');
    expect(snap.edges).toEqual([]);
    expect(snap.head).toBeNull();
    expect(snap.truncated).toBe(false);
  });

  it('unknown API routes are 404 JSON', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/nothing`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('PATCH /api/board (RCB-34/P7.3)', () => {
  const NEXT_COLUMNS = [
    { id: 'backlog', title: 'Backlog' },
    { id: 'doing', title: 'Doing', active: true },
  ];

  it('200 with the same body GET /api/board returns, and exactly one ws config broadcast', async () => {
    const r = await rig({});
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());
    await nextMessage(ws, (m) => m.type === 'snapshot');

    const patch = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columns: NEXT_COLUMNS, actor: 'claude/rcb-34' }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await json(patch)) as { config: { columns: unknown } };
    expect(patchBody.config.columns).toEqual(NEXT_COLUMNS);
    const getBody = await json(await fetch(`${r.url}/api/board`));
    expect(patchBody).toEqual(getBody);

    const configMsg = await nextMessage<{ type: string; config: { columns: unknown } }>(
      ws,
      (m) => m.type === 'config',
    );
    expect(configMsg.config.columns).toEqual(NEXT_COLUMNS);
    // Measured: one write must not produce two broadcasts (store.test.ts also counts the
    // store-level `config` emit directly). No second `config` message should arrive.
    await expect(ws.next<Msg>((m) => m.type === 'config', 500, true)).rejects.toThrow(/timed out/);

    // RCB-56: `setColumns` appends one `columns` event, so PATCH /api/board gets it for free.
    const events = (await json(await fetch(`${r.url}/api/events`))) as {
      type: string;
      actor: string;
      to: string;
    }[];
    expect(events.at(-1)).toMatchObject({
      type: 'columns',
      actor: 'claude/rcb-34',
      to: 'backlog,doing',
    });
  });

  it('400 on an empty column list, an unknown body key, or a missing columns field', async () => {
    const r = await rig({});
    const empty = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columns: [] }),
    });
    expect(empty.status).toBe(400);
    expect(((await json(empty)) as { error: string }).error).toContain('at least one column');

    const unknownField = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columns: NEXT_COLUMNS, nope: 1 }),
    });
    expect(unknownField.status).toBe(400);
    expect(((await json(unknownField)) as { error: string }).error).toMatch(/unknown field "nope"/);

    const missing = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'me' }),
    });
    expect(missing.status).toBe(400);

    // Refused writes leave board.yml untouched — GET still shows the original columns.
    const getBody = (await json(await fetch(`${r.url}/api/board`))) as {
      config: { columns: { id: string }[] };
    };
    expect(getBody.config.columns.map((c) => c.id)).toEqual([
      'backlog',
      'decide',
      'todo',
      'doing',
      'done',
    ]);
  });

  it('a duplicate column id is 400 with the schema message', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columns: [{ id: 'x' }, { id: 'x' }] }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)) as { error: string }).error).toContain('duplicate column id "x"');
  });
});

describe('static files', () => {
  it('serves "web not built" when no bundle exists', async () => {
    const empty = await makeTempDir('repoboard-noweb-');
    const r = await rig({}, { webDir: join(empty, 'missing') });
    // The rig's webDir override does not exist and the dev fallback (packages/web/dist)
    // may or may not exist on this machine, so accept either outcome but require HTML.
    const res = await fetch(`${r.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    if (!r.server.webDir) expect(await res.text()).toContain('web not built');
  });

  it('serves a built web dir with content types and SPA fallback', async () => {
    const web = await makeTempDir('repoboard-web-');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><title>t</title>');
    await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)');
    const r = await rig({}, { webDir: web });
    expect(r.server.webDir).toBe(web);

    const index = await fetch(`${r.url}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await index.text()).toContain('<title>t</title>');

    const js = await fetch(`${r.url}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    const spa = await fetch(`${r.url}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<title>t</title>');

    expect((await fetch(`${r.url}/assets/missing.png`)).status).toBe(404);
    expect((await fetch(`${r.url}/..%2F..%2Fetc%2Fpasswd`)).status).not.toBe(200);
  });
});

describe('WebSocket', () => {
  it('sends a snapshot on connect and a card message after a direct file write', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());

    const snap = await nextMessage<{ type: string; board: { cards: Card[] }; repo: null }>(ws);
    expect(snap.type).toBe('snapshot');
    expect(snap.board.cards.map((c) => c.id)).toEqual(['RB-1']);
    expect(snap.repo).toBeNull();

    const cardMsg = nextMessage<{ type: string; card: Card }>(ws, (m) => m.type === 'card');
    const eventMsg = nextMessage<{ type: string; event: { actor: string } }>(
      ws,
      (m) => m.type === 'event',
    );
    const path = join(r.repo.cardsDir, 'RB-1.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('status: todo', 'status: review'));

    expect((await cardMsg).card.status).toBe('review');
    expect((await eventMsg).event.actor).toBe('file');
  });

  it('card:move and card:update write through the store; bad messages get an error', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());
    await nextMessage(ws, (m) => m.type === 'snapshot');

    const moved = nextMessage<{ type: string; card: Card }>(
      ws,
      (m) => m.type === 'card' && (m.card as Card).status === 'doing',
    );
    ws.send(JSON.stringify({ type: 'card:move', id: 'RB-1', status: 'doing', actor: 'ui' }));
    expect((await moved).card.status).toBe('doing');
    expect(await readFile(join(r.repo.cardsDir, 'RB-1.md'), 'utf8')).toContain('ui — moved');

    const updated = nextMessage<{ type: string; card: Card }>(
      ws,
      (m) => m.type === 'card' && (m.card as Card).title === 'Renamed',
    );
    ws.send(JSON.stringify({ type: 'card:update', id: 'RB-1', patch: { title: 'Renamed' } }));
    expect((await updated).card.title).toBe('Renamed');

    const err = nextMessage<{ type: string; message: string }>(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'card:move', id: 'RB-1', status: 'nope' }));
    expect((await err).message).toMatch(/unknown column/);

    const err2 = nextMessage<{ type: string; message: string }>(ws, (m) => m.type === 'error');
    ws.send('not json');
    expect((await err2).message).toMatch(/not valid JSON/);
  });

  it('rejects upgrades on other paths', async () => {
    const r = await rig({});
    await expect(
      new Promise((res, rej) => {
        const ws = new WebSocket(`${r.url.replace('http', 'ws')}/elsewhere`);
        ws.once('open', res);
        ws.once('error', rej);
      }),
    ).rejects.toThrow();
  });
});

describe('GET /api/cards/:id/refs (K7)', () => {
  const PLAN = '# Plan\n\n## §5 Phases\n- **P6.1** README.\n\n## §6 Layout\nx\n';
  const REFS_CARD = [
    '---',
    'id: RB-9',
    'title: Refs',
    'status: todo',
    'refs:',
    '  - docs/plan.md#§5 Phases',
    '  - ../../etc/hosts',
    '  - docs/../docs/plan.md',
    '  - .git/config',
    '  - docs/plan.md#Nope',
    'created: 2026-09-02T22:00:00Z',
    'updated: 2026-09-02T22:00:00Z',
    '---',
    'Points, does not paste.',
    '',
  ].join('\n');

  async function refsRig() {
    const r = await rig({ 'RB-9.md': REFS_CARD, 'RB-1.md': cardText('RB-1', 'todo') });
    await mkdir(join(r.repo.root, 'docs'));
    await mkdir(join(r.repo.root, '.git'));
    await writeFile(join(r.repo.root, 'docs', 'plan.md'), PLAN);
    await writeFile(join(r.repo.root, '.git', 'config'), '[core]\n\tsecret = yes\n');
    return r;
  }

  it('resolves the good ref and returns text null with the reason for every rejected path', async () => {
    const r = await refsRig();
    const res = await fetch(`${r.url}/api/cards/RB-9/refs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const refs = (await json(res)) as {
      spec: string;
      path: string | null;
      start: number | null;
      end: number | null;
      text: string | null;
      truncated: boolean;
      error: string | null;
    }[];
    expect(refs.map((x) => x.spec)).toEqual([
      'docs/plan.md#§5 Phases',
      '../../etc/hosts',
      'docs/../docs/plan.md',
      '.git/config',
      'docs/plan.md#Nope',
    ]);
    expect(refs[0]).toEqual({
      spec: 'docs/plan.md#§5 Phases',
      path: 'docs/plan.md',
      start: 3,
      end: 5,
      text: '## §5 Phases\n- **P6.1** README.\n',
      truncated: false,
      error: null,
    });
    // The path guard: `..` anywhere (even when the realpath would stay inside), and .git/.
    expect(refs[1]).toMatchObject({
      text: null,
      error: '".." not allowed in path: ../../etc/hosts',
    });
    expect(refs[2]).toMatchObject({
      text: null,
      error: '".." not allowed in path: docs/../docs/plan.md',
    });
    expect(refs[3]).toMatchObject({ text: null, error: '.git/ not allowed: .git/config' });
    expect(JSON.stringify(refs)).not.toContain('secret = yes');
    expect(JSON.stringify(refs)).not.toContain('localhost');
    expect(refs[4]).toMatchObject({
      text: null,
      error: 'heading "Nope" not found in docs/plan.md',
    });
  });

  it('reads the file on every request: an appended line shows up without touching the card', async () => {
    const r = await refsRig();
    const before = (await json(await fetch(`${r.url}/api/cards/RB-9/refs`))) as { text: string }[];
    expect(before[0]?.text).not.toContain('appended');
    await writeFile(
      join(r.repo.root, 'docs', 'plan.md'),
      PLAN.replace('README.\n', 'README.\n- appended\n'),
    );
    const after = (await json(await fetch(`${r.url}/api/cards/RB-9/refs`))) as {
      text: string;
      end: number;
    }[];
    expect(after[0]?.text).toContain('- appended');
    expect(after[0]?.end).toBe(6);
  });

  it('a card without refs is [], an unknown card is 404, and PATCH can set refs', async () => {
    const r = await refsRig();
    expect(await json(await fetch(`${r.url}/api/cards/RB-1/refs`))).toEqual([]);
    expect((await fetch(`${r.url}/api/cards/RB-77/refs`)).status).toBe(404);
    const patched = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refs: ['docs/plan.md:L1'] }),
    });
    expect(patched.status).toBe(200);
    expect(((await json(patched)) as Card).refs).toEqual(['docs/plan.md:L1']);
    const resolved = (await json(await fetch(`${r.url}/api/cards/RB-1/refs`))) as {
      text: string;
    }[];
    expect(resolved.map((x) => x.text)).toEqual(['# Plan']);
    const bad = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refs: 'docs/plan.md' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/systems/:id/refs (RCB-98)', () => {
  const SYSTEMS_YML = `environments:
  dev:  { note: "local dev" }
  prod: { note: "cloud" }
systems:
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    runtime: { dev: "node server", prod: "Cloudflare Workers" }
    owner: null
    pointers: ["docs/plan.md#§5 Phases"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections: []
`;
  const PLAN = '# Plan\n\n## §5 Phases\n- **P6.1** README.\n\n## §6 Layout\nx\n';

  /**
   * Unlike `rig()`, `systems.yml` must exist BEFORE the store opens/watches — a brand-new file's
   * chokidar `add` is flaky under concurrent test load (same note as `systems.test.ts`'s HTTP
   * describe), where a pre-existing file's later `change` is not.
   */
  async function systemsRefsRig(withSystemsYml = true) {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, 'docs'));
    await writeFile(join(repo.root, 'docs', 'plan.md'), PLAN);
    if (withSystemsYml) {
      await writeFile(join(repo.root, '.repoboard', 'systems.yml'), SYSTEMS_YML);
    }
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, store, server, url: server.url.replace(/\/$/, '') };
  }

  it("resolves a known system's pointers, live, the same as `systems show`", async () => {
    const r = await systemsRefsRig();
    const res = await fetch(`${r.url}/api/systems/api/refs`);
    expect(res.status).toBe(200);
    const refs = (await json(res)) as { spec: string; text: string | null }[];
    expect(refs).toEqual([
      {
        spec: 'docs/plan.md#§5 Phases',
        path: 'docs/plan.md',
        start: 3,
        end: 5,
        text: '## §5 Phases\n- **P6.1** README.\n',
        truncated: false,
        error: null,
      },
    ]);
  });

  it('404s with {error} for an unknown id, and for a repo with no systems.yml at all', async () => {
    const r = await systemsRefsRig();
    const unknown = await fetch(`${r.url}/api/systems/nope/refs`);
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: expect.stringContaining('nope') });

    const noFile = await systemsRefsRig(false);
    const res = await fetch(`${noFile.url}/api/systems/api/refs`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: expect.any(String) });
  });
});

describe('GET /api/systems/connections/:from/:to/refs (RCB-173)', () => {
  const SYSTEMS_YML = `environments:
  dev:  { note: "local dev" }
  prod: { note: "cloud" }
systems:
  - id: web
    name: web
    kind: client
    layer: client
    env: [dev, prod]
    pointers: ["src/a.ts"]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
connections:
  - from: web
    to: api
    id: rest
    label: REST calls
    env: [dev, prod]
    pointers: ["src/a.ts"]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
  - from: web
    to: api
    id: ws
    label: live socket
    env: [dev, prod]
    pointers: ["src/b.ts"]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
  - from: api
    to: web
    label: callback
    env: [dev]
    pointers: ["src/a.ts:L1", "src/missing.ts"]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
  - from: api
    to: api
    env: [dev]
    source: { hand: "owner", at: "2026-09-29T00:00:00Z" }
`;

  /** Same rig shape as the system-refs describe above: `systems.yml` written before the store
   * opens/watches (a brand-new file's chokidar `add` is flaky under concurrent test load). */
  async function connectionRefsRig(withSystemsYml = true) {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, 'src'));
    await writeFile(join(repo.root, 'src', 'a.ts'), 'export const A_MARKER = 1;\n');
    await writeFile(join(repo.root, 'src', 'b.ts'), 'export const B_MARKER = 2;\n');
    if (withSystemsYml) {
      await writeFile(join(repo.root, '.repoboard', 'systems.yml'), SYSTEMS_YML);
    }
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, store, server, url: server.url.replace(/\/$/, '') };
  }

  type Ref = { spec: string; text: string | null; error: string | null };

  it("resolves a connection pointer to its live lines, with the system route's own resolver", async () => {
    const r = await connectionRefsRig();
    const res = await fetch(`${r.url}/api/systems/connections/web/api/refs?id=rest`);
    expect(res.status).toBe(200);
    const refs = (await json(res)) as Ref[];
    // CONTROL: a route that returned the raw pointer strings (or never read the file) fails on
    // `text`; one that ignored `?id=` returns the FIRST row's pointer for `ws` too (next test).
    expect(refs).toEqual([
      {
        spec: 'src/a.ts',
        path: 'src/a.ts',
        start: 1,
        end: 1,
        text: 'export const A_MARKER = 1;',
        truncated: false,
        error: null,
      },
    ]);
  });

  it("`?id=` picks the row of a shared pair: ws resolves b.ts, not the first row's a.ts", async () => {
    const r = await connectionRefsRig();
    const ws = (await json(
      await fetch(`${r.url}/api/systems/connections/web/api/refs?id=ws`),
    )) as Ref[];
    expect(ws.map((x) => x.spec)).toEqual(['src/b.ts']);
    expect(ws[0]?.text).toContain('B_MARKER');
    expect(JSON.stringify(ws)).not.toContain('A_MARKER');
  });

  it('a shared pair with no `?id=` is a 400 naming the row count, never a silent pick', async () => {
    const r = await connectionRefsRig();
    const res = await fetch(`${r.url}/api/systems/connections/web/api/refs`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: 'connection "web→api" has 2 rows — pass ?id=<id>',
    });
  });

  it('a single-row pair needs no `?id=`; a pointer that cannot resolve is an entry with `error`, not a failed request', async () => {
    const r = await connectionRefsRig();
    const res = await fetch(`${r.url}/api/systems/connections/api/web/refs`);
    expect(res.status).toBe(200);
    const refs = (await json(res)) as Ref[];
    expect(refs.map((x) => x.spec)).toEqual(['src/a.ts:L1', 'src/missing.ts']);
    expect(refs[0]).toMatchObject({ text: 'export const A_MARKER = 1;', error: null });
    expect(refs[1]).toMatchObject({ text: null, error: 'not found: src/missing.ts' });
  });

  it('a connection with no pointers is a well-formed [] (200)', async () => {
    const r = await connectionRefsRig();
    const res = await fetch(`${r.url}/api/systems/connections/api/api/refs`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
  });

  it('404s with {error} naming the connection: unknown pair, unknown id, and no systems.yml at all', async () => {
    const r = await connectionRefsRig();
    const pair = await fetch(`${r.url}/api/systems/connections/web/nowhere/refs`);
    expect(pair.status).toBe(404);
    expect(await json(pair)).toMatchObject({ error: 'unknown connection "web→nowhere"' });

    const id = await fetch(`${r.url}/api/systems/connections/web/api/refs?id=nope`);
    expect(id.status).toBe(404);
    expect(await json(id)).toMatchObject({ error: 'unknown connection "web→api" id "nope"' });

    const noFile = await connectionRefsRig(false);
    const res = await fetch(`${noFile.url}/api/systems/connections/web/api/refs`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: expect.any(String) });
  });

  it('does not shadow the system route: /api/systems/:id/refs still resolves that system', async () => {
    const r = await connectionRefsRig();
    const res = await fetch(`${r.url}/api/systems/web/refs`);
    expect(res.status).toBe(200);
    const refs = (await json(res)) as Ref[];
    expect(refs.map((x) => x.spec)).toEqual(['src/a.ts']);
  });
});

describe('GET /api/systems/:id/tests (RCB-110)', () => {
  const SYSTEMS_YML = `environments:
  dev:  { note: "local dev" }
  prod: { note: "cloud" }
systems:
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    runtime: { dev: "node server", prod: "Cloudflare Workers" }
    owner: null
    pointers: ["src/api/index.ts"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections: []
`;

  /**
   * Same rig pattern as `systemsRefsRig` above: `systems.yml` written BEFORE the store
   * opens/watches (a brand-new file's chokidar `add` is flaky under concurrent test load). The
   * only test file in the repo is `test/api.test.ts`, importing whatever `testImport` names —
   * the `api` pointer for the 200 case, an unrelated sibling for the CONTROL case.
   */
  async function systemsTestsRig(testImport: string) {
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, 'src', 'api'), { recursive: true });
    await writeFile(join(repo.root, 'src', 'api', 'index.ts'), 'export const API_MARKER = true;\n');
    await writeFile(join(repo.root, 'src', 'other.ts'), 'export const OTHER = true;\n');
    await mkdir(join(repo.root, 'test'), { recursive: true });
    await writeFile(join(repo.root, 'test', 'api.test.ts'), `import '${testImport}';\n`);
    await mkdir(join(repo.root, '.repoboard'), { recursive: true });
    await writeFile(join(repo.root, '.repoboard', 'systems.yml'), SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, store, url: server.url.replace(/\/$/, '') };
  }

  it('200 with the count and the covering test file for the api pointer', async () => {
    const r = await systemsTestsRig('../src/api/index.js');
    const res = await fetch(`${r.url}/api/systems/api/tests`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      files: number | null;
      line: string;
      pointers: Array<{ pointer: string; tests: string[] | null; reason: string | null }>;
    };
    expect(body.files).toBe(1);
    expect(body.line).toBe('tests: 1 file');
    expect(body.pointers).toEqual([
      { pointer: 'src/api/index.ts', tests: ['test/api.test.ts'], reason: null },
    ]);
  });

  it('404s with {error} for an unknown system id', async () => {
    const r = await systemsTestsRig('../src/api/index.js');
    const res = await fetch(`${r.url}/api/systems/nope/tests`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: expect.stringContaining('nope') });
  });

  it(
    'CONTROL: a test that imports a sibling and never names the pointer — ' +
      'files: 0, "tests: none found" (a filename-similarity matcher would fail this)',
    async () => {
      const r = await systemsTestsRig('../src/other.js');
      const res = await fetch(`${r.url}/api/systems/api/tests`);
      expect(res.status).toBe(200);
      const body = (await json(res)) as { files: number | null; line: string };
      expect(body.files).toBe(0);
      expect(body.line).toBe('tests: none found');
    },
  );
});

describe('GET /api/dashboard (RCB-112 A)', () => {
  interface DashboardBody {
    now: string;
    health: {
      checks: Record<'tests' | 'typecheck' | 'lint' | 'build', unknown>;
      ledger: string | null;
      errors: string[];
      source: string;
    };
    commits: { branch: string | null; head: unknown; originMain: unknown; source: string };
    coverage: Array<{ id: string; line: string }> | null;
    coverageSource: string;
  }

  it('200, always present: no .git under a temp dir, no systems.yml — every band null/empty', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/dashboard`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as DashboardBody;
    expect(typeof body.now).toBe('string');
    expect(body.health.checks).toEqual({ tests: null, typecheck: null, lint: null, build: null });
    expect(body.health.ledger).toBeNull();
    expect(body.health.errors).toEqual([]);
    expect(body.commits.branch).toBeNull();
    expect(body.commits.head).toBeNull();
    expect(body.coverage).toBeNull();
  });

  it('coverage mirrors GET /api/systems: a system with a covering test file reports it', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, 'src'), { recursive: true });
    await writeFile(join(repo.root, 'src', 'a.ts'), 'export const A = 1;\n');
    await mkdir(join(repo.root, 'test'), { recursive: true });
    await writeFile(join(repo.root, 'test', 'a.test.ts'), "import '../src/a.ts';\n");
    await writeFile(
      join(repo.root, '.repoboard', 'systems.yml'),
      `environments:
  dev:  { note: "local dev" }
  prod: { note: "cloud" }
systems:
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev]
    runtime: {}
    owner: null
    pointers: ["src/a.ts"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections: []
`,
    );
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());

    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/dashboard`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as DashboardBody;
    expect(body.coverage).toEqual([
      { id: 'api', line: 'tests: 1 file · lines: n/a (no coverage report)' },
    ]);
  });
});

// ---- P7.2: hasBoard on the wire (plan §3) ----------------------------------------------------

describe('hasBoard (P7.2)', () => {
  /** A rig whose root has whatever `.repoboard/` the caller made — or none at all. */
  async function boardlessRig(init: (root: string) => Promise<unknown> = async () => {}) {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    cleanups.push(repo.cleanup);
    await init(repo.root);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, store, url: server.url.replace(/\/$/, '') };
  }

  it('is false on GET /api/board and in the ws snapshot when there is no .repoboard/', async () => {
    const r = await boardlessRig();
    expect(r.store.hasBoard).toBe(false);
    const body = (await json(await fetch(`${r.url}/api/board`))) as {
      hasBoard: boolean;
      cards: Card[];
    };
    expect(body.hasBoard).toBe(false);
    expect(body.cards).toEqual([]);

    const client = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => client.close());
    const snap = await nextMessage<{ type: string; board: { hasBoard: boolean } }>(
      client,
      (m) => m.type === 'snapshot',
    );
    expect(snap.board.hasBoard).toBe(false);
    expect(await r.repo.hasRepoboard()).toBe(false);
  });

  it('is true for an empty but initialised .repoboard/, which still has zero cards', async () => {
    const r = await boardlessRig((root) => mkdir(join(root, '.repoboard'), { recursive: true }));
    expect(r.store.hasBoard).toBe(true);
    const body = (await json(await fetch(`${r.url}/api/board`))) as {
      hasBoard: boolean;
      cards: Card[];
    };
    expect(body.hasBoard).toBe(true);
    expect(body.cards).toEqual([]);
  });

  it('is true for a normal board', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const body = (await json(await fetch(`${r.url}/api/board`))) as { hasBoard: boolean };
    expect(body.hasBoard).toBe(true);
  });
});

// ---- K10: HTTP refuses mutations against a boardless root with 409 ----------------------------

describe('POST /api/cards/:id/ask and /decide (P8.1)', () => {
  it('ask opens a decision and moves the card into the default board’s decide column', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({
        question: 'Ship it?',
        options: [
          { letter: 'A', text: 'yes' },
          { letter: 'B', text: 'no' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const card = (await json(res)) as Card;
    expect(card.status).toBe('decide');
    expect(card.decision).toMatchObject({ question: 'Ship it?', returnTo: 'todo', chosen: null });
    const text = await readFile(join(r.repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('web — moved todo → decide');
    expect(text).toContain('asked: Ship it? [A|B]');
  });

  it('an empty question and an unknown field are 400', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const empty = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: '' }),
    });
    expect(empty.status).toBe(400);
    const unknown = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'q', bogus: 1 }),
    });
    expect(unknown.status).toBe(400);
    expect(((await json(unknown)) as { error: string }).error).toMatch(/unknown field "bogus"/);
  });

  it('asking again while OPEN is 409; decide moves the card back and is 200', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'doing') });
    await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'First?' }),
    });
    const conflict = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'Second?' }),
    });
    expect(conflict.status).toBe(409);

    const decided = await fetch(`${r.url}/api/cards/RB-1/decide`, {
      method: 'POST',
      body: JSON.stringify({ words: 'go ahead' }),
    });
    expect(decided.status).toBe(200);
    const card = (await json(decided)) as Card;
    expect(card.status).toBe('doing');
    expect(card.decision).toMatchObject({ chosen: null, words: 'go ahead', decidedBy: 'web' });
  });

  it('decide is 409 when nothing is open, and 400 for an unknown letter', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const nothingOpen = await fetch(`${r.url}/api/cards/RB-1/decide`, {
      method: 'POST',
      body: JSON.stringify({ letter: 'A' }),
    });
    expect(nothingOpen.status).toBe(409);

    await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'q?', options: [{ letter: 'A', text: 'x' }] }),
    });
    const badLetter = await fetch(`${r.url}/api/cards/RB-1/decide`, {
      method: 'POST',
      body: JSON.stringify({ letter: 'Z' }),
    });
    expect(badLetter.status).toBe(400);
  });

  it('PATCH refuses a `decision` field with 400, naming /ask and /decide', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      body: JSON.stringify({
        decision: { question: 'sneaking in', options: [], chosen: 'A' },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)) as { error: string }).error).toMatch(/use \/ask and \/decide/);
    const text = await readFile(join(r.repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).not.toContain('decision:');
  });
});

describe('POST /api/cards/:id/notes (RCB-70)', () => {
  it('200 with the card, ## Notes section in body', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1/notes`, {
      method: 'POST',
      body: JSON.stringify({ text: 'ship it after the restart', actor: 'owner' }),
    });
    expect(res.status).toBe(200);
    const card = (await json(res)) as Card;
    expect(card.body).toContain('## Notes');
    expect(card.body).toContain('owner — ship it after the restart');
    const text = await readFile(join(r.repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('## Notes');
  });

  it('empty text is 400', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1/notes`, {
      method: 'POST',
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)) as { error: string }).error).toMatch(/text is required/);
  });

  it('unknown card is 404', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-99/notes`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/cards/:id/ask with kind: task (RCB-52 owner tasks)', () => {
  it('kind: "task" is 200 and the ownerQueue payload item carries kind: "task"', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    await r.store.setStateSection('live', 'x', 'claude/test'); // scaffolds STATE.md
    const res = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'set up npm', kind: 'task' }),
    });
    expect(res.status).toBe(200);
    const card = (await json(res)) as Card;
    expect(card.decision).toMatchObject({ kind: 'task', options: [] });
    const state = (await json(await fetch(`${r.url}/api/state`))) as {
      ownerQueue: { id: string; kind?: string }[];
    };
    expect(state.ownerQueue).toEqual([
      { id: 'RB-1', question: 'set up npm', options: [], kind: 'task' },
    ]);
  });

  it('kind: "nope" is 400 naming the field', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'q', kind: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)) as { error: string }).error).toMatch(/kind must be "task"/);
  });

  it("a plain question's ownerQueue item has no kind key at all", async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    await r.store.setStateSection('live', 'x', 'claude/test'); // scaffolds STATE.md
    await fetch(`${r.url}/api/cards/RB-1/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'q' }),
    });
    const state = (await json(await fetch(`${r.url}/api/state`))) as {
      ownerQueue: Record<string, unknown>[];
    };
    expect(state.ownerQueue).toHaveLength(1);
    expect('kind' in (state.ownerQueue[0] as object)).toBe(false);
  });
});

describe('map-only mode refuses mutations over HTTP (K10)', () => {
  async function boardlessRig() {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, store, url: server.url.replace(/\/$/, '') };
  }

  it('POST /api/cards is 409 and writes nothing into the target', async () => {
    const r = await boardlessRig();
    const res = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hole' }),
    });
    // K10's exact reproduction, now closed. On-disk first, asserted on the directory itself.
    expect(await r.repo.hasRepoboard()).toBe(false);
    expect(res.status).toBe(409);
    expect(((await json(res)) as { error: string }).error).toContain('map-only');
    expect(((await json(await fetch(`${r.url}/api/board`))) as { cards: Card[] }).cards).toEqual(
      [],
    );
  });

  it('PATCH /api/board is 409 on a map-only root and writes nothing into the target', async () => {
    const r = await boardlessRig();
    const res = await fetch(`${r.url}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columns: [{ id: 'backlog' }] }),
    });
    expect(res.status).toBe(409);
    expect(((await json(res)) as { error: string }).error).toContain('map-only');
    expect(await r.repo.hasRepoboard()).toBe(false);
  });

  it('PATCH of a card that cannot exist is still 404, not 409', async () => {
    const r = await boardlessRig();
    const res = await fetch(`${r.url}/api/cards/RB-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'doing' }),
    });
    expect(res.status).toBe(404);
    expect(await r.repo.hasRepoboard()).toBe(false);
  });

  it('a repo with a board still creates on 201 and still rejects bad input with 400', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const good = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fine' }),
    });
    expect(good.status).toBe(201);
    const bad = await fetch(`${r.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('leases/windows over HTTP (P8.2)', () => {
  it('GET /api/leases returns leases, windows, stale, now; empty when there is nothing yet', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/leases`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      leases: unknown[];
      windows: unknown[];
      stale: string[];
      now: string;
    };
    expect(body).toEqual({ leases: [], windows: [], stale: [], now: expect.any(String) });
  });

  it('POST /api/leases/take then /release round-trip; GET reflects both', async () => {
    const r = await rig({});
    const taken = await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'vitest-lock', actor: 'claude/ops' }),
    });
    expect(taken.status).toBe(200);
    const afterTake = (await json(taken)) as {
      leases: Array<{ resource: string; holder: string }>;
    };
    expect(afterTake.leases).toEqual([
      {
        resource: 'vitest-lock',
        holder: 'claude/ops',
        since: NOW.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    ]);

    const released = await fetch(`${r.url}/api/leases/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'vitest-lock', actor: 'claude/ops' }),
    });
    expect(released.status).toBe(200);
    const afterRelease = (await json(released)) as { leases: unknown[] };
    expect(afterRelease.leases).toEqual([]);
  });

  it('a conflicting take is 409; an unknown-field / empty-resource request is 400', async () => {
    const r = await rig({});
    await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r', actor: 'claude/ops' }),
    });
    const conflict = await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r', actor: 'claude/fix' }),
    });
    expect(conflict.status).toBe(409);
    expect(((await json(conflict)) as { error: string }).error).toMatch(/is held by claude\/ops/);

    const badField = await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r2', nonsense: true }),
    });
    expect(badField.status).toBe(400);

    const emptyResource = await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: '' }),
    });
    expect(emptyResource.status).toBe(400);
  });

  it('release by a non-holder is 409; releasing a never-taken resource is 409', async () => {
    const r = await rig({});
    await fetch(`${r.url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r', actor: 'claude/ops' }),
    });
    const wrongHolder = await fetch(`${r.url}/api/leases/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r', actor: 'claude/fix' }),
    });
    expect(wrongHolder.status).toBe(409);
    const never = await fetch(`${r.url}/api/leases/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'never' }),
    });
    expect(never.status).toBe(409);
  });

  it('POST /api/leases/windows adds one; end<=start is 400', async () => {
    const r = await rig({});
    const added = await fetch(`${r.url}/api/leases/windows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: 'vitest-lock',
        start: '2026-09-02T22:00:00Z',
        end: '2026-09-02T23:00:00Z',
        name: 'cold4 gate',
      }),
    });
    expect(added.status).toBe(200);
    const body = (await json(added)) as { windows: unknown[] };
    expect(body.windows).toEqual([
      {
        resource: 'vitest-lock',
        start: '2026-09-02T22:00:00Z',
        end: '2026-09-02T23:00:00Z',
        name: 'cold4 gate',
      },
    ]);
    const bad = await fetch(`${r.url}/api/leases/windows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: 'r',
        start: '2026-09-02T23:00:00Z',
        end: '2026-09-02T22:00:00Z',
        name: 'backwards',
      }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /api/leases/check/:resource: 200 clear, 200 not-clear (inside a window), --at query works', async () => {
    const r = await rig({});
    await fetch(`${r.url}/api/leases/windows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: 'vitest-lock',
        start: '2026-09-02T22:00:00Z',
        end: '2026-09-02T23:00:00Z',
        name: 'cold4 gate',
      }),
    });
    const clear = await fetch(`${r.url}/api/leases/check/vitest-lock?at=2026-09-02T21:00:00Z`);
    expect(clear.status).toBe(200);
    expect(await json(clear)).toEqual({ clear: true });
    const blocked = await fetch(`${r.url}/api/leases/check/vitest-lock?at=2026-09-02T22:30:00Z`);
    expect(blocked.status).toBe(200);
    expect(await json(blocked)).toEqual({
      clear: false,
      reasons: ['inside cold4 gate 2026-09-02T22:00:00Z–2026-09-02T23:00:00Z vitest-lock'],
    });
    const badAt = await fetch(`${r.url}/api/leases/check/vitest-lock?at=nonsense`);
    expect(badAt.status).toBe(400);
  });

  it('map-only: GET /api/leases and check work, POST take/release/windows are 409', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    expect((await fetch(`${url}/api/leases`)).status).toBe(200);
    expect((await fetch(`${url}/api/leases/check/r`)).status).toBe(200);

    const take = await fetch(`${url}/api/leases/take`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'r' }),
    });
    expect(take.status).toBe(409);
    expect(((await json(take)) as { error: string }).error).toContain('map-only');
    expect(await repo.hasRepoboard()).toBe(false);

    const addWin = await fetch(`${url}/api/leases/windows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: 'r',
        start: '2026-09-02T22:00:00Z',
        end: '2026-09-02T23:00:00Z',
        name: 'g',
      }),
    });
    expect(addWin.status).toBe(409);
    expect(await repo.hasRepoboard()).toBe(false);
  });

  it('WS snapshot carries leases; a take through the store broadcasts a leases message', async () => {
    const r = await rig({});
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());
    const snap = await nextMessage<{ type: string; leases: { leases: unknown[] } }>(ws);
    expect(snap.type).toBe('snapshot');
    expect(snap.leases).toEqual({ leases: [], windows: [], stale: [], now: expect.any(String) });

    const leasesMsg = nextMessage<{
      type: string;
      leases: { leases: Array<{ resource: string }> };
    }>(ws, (m) => m.type === 'leases');
    await r.store.takeLease({ resource: 'vitest-lock' }, 'claude/ops');
    const msg = await leasesMsg;
    expect(msg.leases.leases.map((l) => l.resource)).toEqual(['vitest-lock']);
  });
});

describe('state/log/check over HTTP (P8.3)', () => {
  it('GET /api/state before any STATE.md exists: nulls, 200, not a crash', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/state`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      stamp: null,
      actor: null,
      sections: null,
      ownerQueue: [],
      text: null,
    });
  });

  it('PUT /api/state/section scaffolds then restamps; GET reflects it with generated OWNER QUEUE', async () => {
    const r = await rig({});
    const put = await fetch(`${r.url}/api/state/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'LIVE', body: 'Tree is dev.', actor: 'claude/p8-3' }),
    });
    expect(put.status).toBe(200);
    const putBody = (await json(put)) as { sections: { live: string }; text: string };
    expect(putBody.sections.live).toBe('Tree is dev.');
    expect(putBody.text).toContain('_(generated from open decisions)_');

    const get = await fetch(`${r.url}/api/state`);
    const body = (await json(get)) as { sections: { live: string } };
    expect(body.sections.live).toBe('Tree is dev.');
  });

  it('PUT /api/state/section: 400 on a bad section name, an empty body, or an unknown field', async () => {
    const r = await rig({});
    const badSection = await fetch(`${r.url}/api/state/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'NOPE', body: 'x' }),
    });
    expect(badSection.status).toBe(400);

    const emptyBody = await fetch(`${r.url}/api/state/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'LIVE', body: '' }),
    });
    expect(emptyBody.status).toBe(400);

    const unknownField = await fetch(`${r.url}/api/state/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'LIVE', body: 'x', nope: 1 }),
    });
    expect(unknownField.status).toBe(400);
  });

  it('GET /api/log defaults to today, 404 for a date with no file, ?date= reads another day', async () => {
    const r = await rig({});
    const missing = await fetch(`${r.url}/api/log?date=2020-01-01`);
    expect(missing.status).toBe(404);

    const post = await fetch(`${r.url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: 'claude/p8-3', title: 'kickoff', text: 'first entry' }),
    });
    expect(post.status).toBe(200);
    const posted = (await json(post)) as { date: string; text: string; restamped: boolean };
    expect(posted.date).toBe('2026-09-02');
    // RCB-127: no SEATS bullet for this seat, so no restamp.
    expect(posted.restamped).toBe(false);
    expect(posted.text).toContain('kickoff');

    const get = await fetch(`${r.url}/api/log`);
    expect(get.status).toBe(200);
    const body = (await json(get)) as { date: string; text: string; blocks: unknown[] };
    expect(body.date).toBe('2026-09-02');
    expect(body.blocks).toHaveLength(1);
  });

  // RCB-62 (finding 2, test i): the LOG panel's `GET /api/log` must see the configured `logDir`
  // too, same as `check`/`seat` already do — `board.yml` is read once at `openStore`, so `logDir`
  // has to be on disk BEFORE the store opens (unlike `rig()`, which opens immediately).
  it('(i) GET /api/log?date=… returns the merged text on a board with logDir', async () => {
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );
    const extraDir = join(repo.root, 'docs', 'log');
    await mkdir(extraDir, { recursive: true });
    await writeFile(
      join(extraDir, '2026-09-02.md'),
      '# Log — 2026-09-02\n\n##### OPS 2026-09-02 21:4xZ: hand-written by the sibling\n\ntext\n',
    );
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    // RCB-71 A (owner 2026-09-21): with `logDir` set the append WRITES there too, so both blocks
    // sit in docs/log/2026-09-02.md in append order and `.repoboard/log/` is never created.
    await store.appendRepoLog('claude/p8-3', 'own entry', 'kickoff'); // same date (NOW)

    const get = await fetch(`${url}/api/log?date=2026-09-02`);
    expect(get.status).toBe(200);
    const merged = (await json(get)) as { date: string; text: string; blocks: unknown[] };
    expect(merged.date).toBe('2026-09-02');
    expect(merged.blocks).toHaveLength(2);
    expect(merged.text).toContain('kickoff');
    expect(merged.text).toContain('hand-written by the sibling');
    expect(merged.text.indexOf('hand-written by the sibling')).toBeLessThan(
      merged.text.indexOf('kickoff'),
    ); // the hand-written block came first; the append followed it in the same file
    expect(existsSync(join(repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(false);
  });

  it('POST /api/log: 400 on empty seat/text or an unknown field', async () => {
    const r = await rig({});
    const emptySeat = await fetch(`${r.url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: '  ', text: 'x' }),
    });
    expect(emptySeat.status).toBe(400);
    const unknownField = await fetch(`${r.url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: 'ops', text: 'x', nope: 1 }),
    });
    expect(unknownField.status).toBe(400);
  });

  // RCB-188: the seat door lives in the store's `appendSeatLog` (not in its callers), so the web's
  // POST /api/log folds `[<board>] builder` / `<board> builder` to the seat `builder` exactly as
  // the CLI's `log --as` and MCP's `append_repo_log` do. The fixture's board.yml has no `name:`,
  // so this board's display name is its folder name.
  // CONTROL (RCB-188): drop the `this.seatName(typedSeat)` call (and use `typedSeat` as `seat`) in
  // `store.appendSeatLog` — the prefixed-seat header assertions below fail (`] [` in the log, seat
  // `[<BOARD>] BUILDER`), and the `[other] builder` test below gets 200 instead of 400.
  it('POST /api/log: [<this board>] builder and <this board> builder write the bare seat, same as builder', async () => {
    const r = await rig({});
    const board = basename(r.repo.root);
    const seats = ['builder', `[${board}] builder`, `${board} builder`];
    for (const [i, seat] of seats.entries()) {
      const res = await fetch(`${r.url}/api/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seat, title: `t${i}`, text: `body ${i}` }),
      });
      expect(res.status, `seat ${JSON.stringify(seat)}`).toBe(200);
      const posted = (await json(res)) as { block: { seat: string; repo: string | null } };
      expect(posted.block.seat, `seat ${JSON.stringify(seat)}`).toBe('BUILDER');
      expect(posted.block.repo).toBe(board);
    }
    const logText = await readFile(join(r.repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    const headings = logText.split('\n').filter((l) => l.startsWith('##### '));
    expect(headings).toHaveLength(seats.length);
    for (const [i, heading] of headings.entries()) {
      // `##### [<board>] BUILDER <ts>: t<i>` — one bracketed board name, the bare seat, no second name.
      expect(heading.startsWith(`##### [${board}] BUILDER `), heading).toBe(true);
      expect(heading.endsWith(`: t${i}`), heading).toBe(true);
    }
    expect(logText).not.toContain('] [');
  });

  it('POST /api/log: a seat prefixed with ANOTHER board is 400 and nothing is written', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: '[other] builder', text: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(((await json(res)) as { error: string }).error).toContain('another board');
    expect(existsSync(join(r.repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(false);
    expect(existsSync(join(r.repo.root, '.repoboard', 'STATE.md'))).toBe(false);
  });

  it('GET /api/check: 200 with empty findings on a clean fixture, and with a stale lease', async () => {
    const r = await rig({});
    const clean = await fetch(`${r.url}/api/check`);
    expect(clean.status).toBe(200);
    expect(await json(clean)).toEqual({ findings: [], exitCode: 0 });

    await r.store.takeLease({ resource: 'r', until: '2020-01-01T00:00:00Z' }, 'claude/ops');
    const stale = await fetch(`${r.url}/api/check`);
    const body = (await json(stale)) as { findings: Array<{ kind: string }>; exitCode: number };
    expect(body.findings.some((f) => f.kind === 'stale-lease')).toBe(true);
    expect(body.exitCode).toBe(1);
  });

  it('GET /api/check?strict=1 turns a warning-grade finding into exitCode 1', async () => {
    // cardText's fixed `updated: 2026-09-02T22:00:00Z` is 41 minutes before NOW — outside the
    // default 30-minute active window — so this card is written with `updated` at NOW itself, to
    // land inside it (avoids depending on the watcher re-reading a later on-disk edit in time).
    const r = await rig({
      'RB-1.md': [
        '---',
        'id: RB-1',
        'title: "active card"',
        'status: doing',
        'assignee: claude/p8-3',
        'created: 2026-09-02T22:00:00Z',
        'updated: 2026-09-02T22:41:10Z',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    });
    const findings = await r.store.check(false, []);
    expect(findings.findings.some((f) => f.kind === 'active-without-lease')).toBe(true);

    const plain = await fetch(`${r.url}/api/check`);
    const plainBody = (await json(plain)) as { exitCode: number };
    expect(plainBody.exitCode).toBe(0);
    const strict = await fetch(`${r.url}/api/check?strict=1`);
    const strictBody = (await json(strict)) as { exitCode: number };
    expect(strictBody.exitCode).toBe(1);
  });

  it('map-only: GET /api/state, /api/log, /api/check work; PUT/POST writes are 409', async () => {
    const repo = await makeTempRepoNoBoard({});
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    expect((await fetch(`${url}/api/state`)).status).toBe(200);
    expect((await fetch(`${url}/api/log`)).status).toBe(404); // no board, no log — same as "no file"
    expect((await fetch(`${url}/api/check`)).status).toBe(200);

    const put = await fetch(`${url}/api/state/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'LIVE', body: 'x' }),
    });
    expect(put.status).toBe(409);
    expect(await repo.hasRepoboard()).toBe(false);

    const post = await fetch(`${url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: 'ops', text: 'x' }),
    });
    expect(post.status).toBe(409);
    expect(await repo.hasRepoboard()).toBe(false);
  });

  it("WS snapshot carries state and today's log; a rewrite through the store broadcasts state", async () => {
    const r = await rig({});
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());
    const snap = await nextMessage<{
      type: string;
      state: { stamp: null; text: null };
      log: { date: string; text: string };
    }>(ws);
    expect(snap.type).toBe('snapshot');
    expect(snap.state).toEqual({
      stamp: null,
      actor: null,
      sections: null,
      ownerQueue: [],
      text: null,
    });
    expect(snap.log.date).toBe('2026-09-02');

    const stateMsg = nextMessage<{ type: string; state: { text: string } }>(
      ws,
      (m) => m.type === 'state',
    );
    await r.store.setStateSection('live', 'Tree is dev.', 'claude/p8-3');
    const msg = await stateMsg;
    expect(msg.state.text).toContain('Tree is dev.');
  });
});

describe('cost over HTTP (P8.4)', () => {
  it('GET /api/cost: 200, absent CLAUDE.md, never over', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/cost`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { claudeMdBytes: null; over: boolean };
    expect(body.claudeMdBytes).toBeNull();
    expect(body.over).toBe(false);
  });

  it('GET /api/cost?budget= overrides board.yml, and 200 either side of OVER (a pure read, never 4xx)', async () => {
    const r = await rig({});
    await writeFile(join(r.repo.root, 'CLAUDE.md'), 'x'.repeat(100));
    const atBudget = await fetch(`${r.url}/api/cost?budget=100`);
    expect(atBudget.status).toBe(200);
    expect(((await json(atBudget)) as { over: boolean }).over).toBe(false);
    const overBudget = await fetch(`${r.url}/api/cost?budget=99`);
    expect(overBudget.status).toBe(200);
    const overBody = (await json(overBudget)) as { over: boolean; claudeMdBytes: number };
    expect(overBody.over).toBe(true);
    expect(overBody.claudeMdBytes).toBe(100);
  });

  it('GET /api/cost?budget=0 is a 400 (not a positive integer)', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/cost?budget=0`);
    expect(res.status).toBe(400);
  });

  it('map-only: GET /api/cost still works (a pure read of the filesystem, not the board)', async () => {
    const repo = await makeTempRepoNoBoard({ 'CLAUDE.md': 'x'.repeat(50) });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/cost`);
    expect(res.status).toBe(200);
    expect(((await json(res)) as { claudeMdBytes: number }).claudeMdBytes).toBe(50);
  });
});

describe('POST /api/systems/plan (RCB-111)', () => {
  const MINIMAL_SYSTEMS_YML = `environments:
  dev: { note: null }
  prod: { note: null }
systems: []
connections: []
`;

  it('201s a dry-run detect turned into a parent + three PH.1..PH.3 steps; writes no systems.yml', async () => {
    const r = await rig({});
    const res = await fetch(`${r.url}/api/systems/plan`, {
      method: 'POST',
      body: JSON.stringify({ actor: 'web' }),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)) as { parent: Card; steps: Card[] };
    expect(body.parent.title).toMatch(/^Systems map for /);
    expect(body.steps).toHaveLength(3);
    expect(r.store.list()).toHaveLength(4);
    const phases = body.steps.map((s) => s.phase);
    expect(phases).toEqual(['PH.1', 'PH.2', 'PH.3']);
    for (const step of body.steps) expect(step.parent).toBe(body.parent.id);
    const ph1 = body.steps[0] as Card;
    expect(ph1.body).toMatch(/\d+ systems \/ \d+ connections \/ \d+ unclassified/);
    // The dry run must never write — a `--apply` creeping in would leave this true.
    expect(existsSync(join(r.repo.root, '.repoboard', 'systems.yml'))).toBe(false);
  });

  it('409s with 0 cards created when the served root has no .repoboard/ (map-only)', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/systems/plan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(store.list()).toHaveLength(0);
  });

  it('409s with 0 cards created when .repoboard/systems.yml already exists', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await writeFile(join(repo.root, '.repoboard', 'systems.yml'), MINIMAL_SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/systems/plan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    // Only the seeded RB-1, none of the four plan cards.
    expect(store.list()).toHaveLength(1);
  });
});

// ---- RCB-178: Flow drawers — "how to get there" ------------------------------------------------

/** One git call inside a fixture directory this test made — never the repo under test. */
async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const { stdout } = await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
  });
  return stdout.trim();
}

describe('githubWebBase (RCB-178)', () => {
  const BASE = 'https://github.com/acme/widgets';

  it('reads the scp, https and ssh:// forms, with and without .git, to one https base', () => {
    for (const remote of [
      'git@github.com:acme/widgets.git',
      'git@github.com:acme/widgets',
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets/',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@ssh.github.com:443/acme/widgets.git',
      'HTTPS://GitHub.com/acme/widgets.git',
    ]) {
      expect(githubWebBase(remote), remote).toBe(BASE);
    }
  });

  it('never lets embedded credentials into the answer', () => {
    const web = githubWebBase('https://x-access-token:s3cret@github.com/acme/widgets.git');
    expect(web).toBe(BASE);
    expect(web).not.toContain('s3cret');
  });

  it('is null for a non-GitHub host, a path that is not <owner>/<repo>, and text that is no URL', () => {
    for (const remote of [
      'git@gitlab.com:acme/widgets.git',
      'https://gitlab.com/acme/widgets.git',
      'https://github.example.com/acme/widgets',
      'https://notgithub.com/acme/widgets',
      'git@github.com.evil.example:acme/widgets.git',
      'https://github.com/acme',
      'https://github.com/acme/widgets/tree/main',
      'https://github.com//widgets',
      'file:///srv/git/widgets.git',
      '/srv/git/widgets.git',
      '',
    ]) {
      expect(githubWebBase(remote), remote).toBeNull();
    }
  });
});

describe('GET /api/git (RCB-178)', () => {
  /** A board root whose fixture `setup` (git init, remotes, commits) runs BEFORE the store opens. */
  async function gitRig(setup: (root: string) => Promise<void> = async () => {}) {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await setup(repo.root);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, url: server.url.replace(/\/$/, '') };
  }

  async function initWithOrigin(root: string, origin: string | null): Promise<void> {
    await runGit(root, 'init', '-q');
    if (origin !== null) await runGit(root, 'remote', 'add', 'origin', origin);
    await runGit(root, 'commit', '-q', '--allow-empty', '-m', 'one');
  }

  it('a directory that is not a git repo answers 200 with its root and null web and head', async () => {
    const r = await gitRig();
    const res = await fetch(`${r.url}/api/git`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toEqual({ root: r.repo.root, web: null, head: null });
  });

  it('a repo with origin and one commit: web is the GitHub base, head is the commit sha', async () => {
    const r = await gitRig((root) => initWithOrigin(root, 'git@github.com:acme/widgets.git'));
    const sha = await runGit(r.repo.root, 'rev-parse', 'HEAD');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await json(await fetch(`${r.url}/api/git`))).toEqual({
      root: r.repo.root,
      web: 'https://github.com/acme/widgets',
      head: sha,
    });
  });

  it('is read live: a new commit and a re-pointed origin show up on the next request', async () => {
    const r = await gitRig((root) => initWithOrigin(root, 'https://github.com/acme/widgets.git'));
    const first = (await json(await fetch(`${r.url}/api/git`))) as { web: string; head: string };
    expect(first.web).toBe('https://github.com/acme/widgets');

    await runGit(r.repo.root, 'commit', '-q', '--allow-empty', '-m', 'two');
    await runGit(r.repo.root, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git');
    const sha = await runGit(r.repo.root, 'rev-parse', 'HEAD');
    expect(sha).not.toBe(first.head);
    expect(await json(await fetch(`${r.url}/api/git`))).toEqual({
      root: r.repo.root,
      web: null,
      head: sha,
    });
  });

  it('no remote: web null, head set. No commit yet: head null, web set. Neither throws', async () => {
    const noRemote = await gitRig((root) => initWithOrigin(root, null));
    const sha = await runGit(noRemote.repo.root, 'rev-parse', 'HEAD');
    expect(await json(await fetch(`${noRemote.url}/api/git`))).toEqual({
      root: noRemote.repo.root,
      web: null,
      head: sha,
    });

    const noCommit = await gitRig(async (root) => {
      await runGit(root, 'init', '-q');
      await runGit(root, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    });
    expect(await json(await fetch(`${noCommit.url}/api/git`))).toEqual({
      root: noCommit.repo.root,
      web: 'https://github.com/acme/widgets',
      head: null,
    });
  });

  it('a root that is a subdirectory of the git repo has no web: a blob URL would lack its prefix', async () => {
    const top = await makeTempRepoNoBoard({ 'sub/a.ts': 'export const a = 1;\n' });
    cleanups.push(top.cleanup);
    await initWithOrigin(top.root, 'git@github.com:acme/widgets.git');
    const sub = join(top.root, 'sub');
    const store = await openStore(sub, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const body = (await json(await fetch(`${server.url.replace(/\/$/, '')}/api/git`))) as {
      root: string;
      web: string | null;
      head: string | null;
    };
    expect(body.root).toBe(sub);
    expect(body.web).toBeNull();
    // ...whereas the same remote at the top of the repo is a link (the three tests above).
  });

  it('is per root: /api/repos/<key>/git answers for that root, not the primary', async () => {
    const a = await makeTempRepoboard({});
    const b = await makeTempRepoboard({});
    cleanups.push(a.cleanup, b.cleanup);
    await initWithOrigin(a.root, 'git@github.com:acme/alpha.git');
    await initWithOrigin(b.root, 'git@github.com:acme/beta.git');
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
    const url = server.url.replace(/\/$/, '');
    const bKey = basename(b.root).toLowerCase();
    expect(await json(await fetch(`${url}/api/git`))).toMatchObject({
      root: a.root,
      web: 'https://github.com/acme/alpha',
    });
    expect(await json(await fetch(`${url}/api/repos/${bKey}/git`))).toMatchObject({
      root: b.root,
      web: 'https://github.com/acme/beta',
      head: await runGit(b.root, 'rev-parse', 'HEAD'),
    });
  });
});

describe('GET /api/systems/:id/docs (RCB-178)', () => {
  const SYSTEMS_YML = `environments:
  dev:  { note: "local dev" }
  prod: { note: "cloud" }
systems:
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    runtime: { dev: "node server", prod: "Cloudflare Workers" }
    owner: null
    pointers: ["docs/plan.md#§6 Layout"]
    docs: ["docs/plan.md#§5 Phases", "docs/missing.md", "../../etc/hosts"]
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections: []
`;
  const PLAN = '# Plan\n\n## §5 Phases\n- **P6.1** README.\n\n## §6 Layout\nx\n';

  /** `systems.yml` written BEFORE the store opens, same reason as `systemsRefsRig` above. */
  async function docsRig(withSystemsYml = true) {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, 'docs'));
    await writeFile(join(repo.root, 'docs', 'plan.md'), PLAN);
    if (withSystemsYml) {
      await writeFile(join(repo.root, '.repoboard', 'systems.yml'), SYSTEMS_YML);
    }
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    return { repo, url: server.url.replace(/\/$/, '') };
  }

  it("resolves the system's docs[] (not its pointers), one entry each, in order", async () => {
    const r = await docsRig();
    const res = await fetch(`${r.url}/api/systems/api/docs`);
    expect(res.status).toBe(200);
    const docs = (await json(res)) as { spec: string; text: string | null; error: string | null }[];
    expect(docs.map((d) => d.spec)).toEqual([
      'docs/plan.md#§5 Phases',
      'docs/missing.md',
      '../../etc/hosts',
    ]);
    expect(docs[0]).toEqual({
      spec: 'docs/plan.md#§5 Phases',
      path: 'docs/plan.md',
      start: 3,
      end: 5,
      text: '## §5 Phases\n- **P6.1** README.\n',
      truncated: false,
      error: null,
    });
  });

  it('an entry that does not resolve carries its error and no text; nothing is guessed', async () => {
    const r = await docsRig();
    const docs = (await json(await fetch(`${r.url}/api/systems/api/docs`))) as {
      path: string | null;
      start: number | null;
      text: string | null;
      error: string | null;
    }[];
    expect(docs[1]).toMatchObject({
      path: 'docs/missing.md',
      start: null,
      text: null,
      error: 'not found: docs/missing.md',
    });
    expect(docs[2]).toMatchObject({
      text: null,
      error: '".." not allowed in path: ../../etc/hosts',
    });
  });

  it('404s with {error} for an unknown id, and for a repo with no systems.yml at all', async () => {
    const r = await docsRig();
    const unknown = await fetch(`${r.url}/api/systems/nope/docs`);
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: expect.stringContaining('nope') });

    const noFile = await docsRig(false);
    const res = await fetch(`${noFile.url}/api/systems/api/docs`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: expect.any(String) });
  });
});

// ---- RCB-217: seat rows, landings and the newest log day on the wire -------------------------------
//
// The WS snapshot gains `seats` (core's `seatRowPayloads`: STATE.md's SEATS bullets joined to the
// holders recorded in `.repoboard/local/seats.yml`), `landings` (the last 14 days of HEAD's commits
// whose subject starts with a card id, grouped by card) and a `log` that is today's day when it has
// an entry, else the newest earlier day within 14 days that has one. `{type:"seats"}` follows every
// STATE.md change and a poll that catches what no file event reports; `{type:"landings"}` follows a
// new HEAD. The poll interval is a test seam (`livenessPollMs`).
//
// CONTROLS (run by the seat, not part of the suite) — each perturbation is applied, read back,
// typechecked, and must turn the named test red:
//  - `packages/server/src/repo-context.ts`: drop `seats` from the snapshot object: (1), (2), (4) fail.
//  - drop `landings` from the snapshot object: (5) and (6) fail.
//  - `snapshotLogPayload` back to `store.log()`: (7) fails (today's empty payload, not yesterday's).
//  - `sendSeats`: delete `if (onlyIfChanged && json === lastSeatsJson) return;`: (4) fails on its
//    "no further seats message" assertion (the poll re-sends every 50 ms).
//  - `onState`: delete `void sendSeats(false);`: (3) fails (no `seats` message after the write).
//  - delete the `lastSeatsJson = null; lastLandingsKey = null;` reset in the connection handler:
//    (4) times out waiting for its first poll message (STATE.md's own broadcast already recorded it).
//  - `sendLandings`: compare nothing (delete `if (key === lastLandingsKey) return;`): (6) fails on
//    its "no further landings message" assertion.
//  - `packages/server/src/store.ts`, `newestLog`: loop `back <= maxDaysBack` -> `back < maxDaysBack`:
//    (7)'s boundary assertion fails (the day exactly 14 back is no longer found).
//  - `packages/core/src/landings.ts` as in `landings.test.ts`: (5) fails with the `cards: …` commit.
describe('seats, landings and the newest log day on the wire (RCB-217)', () => {
  const POLL_MS = 50;
  const PANE = 'A7B2A3F2-1B2D-4E5F';
  const LEASES = serializeLeases({
    leases: [{ resource: 'seat:builder', holder: `pane=${PANE}`, since: '2026-09-02T22:40:00Z' }],
    windows: [],
  });
  const BUILDER_TEXT = 'building\nin-flight: none\nowes: nothing';
  /** What `seatRowPayloads` makes of the bullet `setSeatBullet` writes at the fixed `NOW`. */
  const BUILDER_ROW = {
    name: 'builder',
    home: null,
    status: 'UP',
    at: '2026-09-02T22:41:00Z',
    tag: null,
    label: null,
    live: null,
    inFlight: 'none',
    owes: 'nothing',
  };

  interface WireRig {
    repo: TempRepo;
    store: CardStore;
    url: string;
    seatsFile: string;
  }

  /** A board with a local layer (so `seats.yml` is read), the server polling every `POLL_MS`. */
  async function wireRig(
    setup: (root: string) => Promise<void> = async () => {},
    cards: Record<string, string> = {},
  ): Promise<WireRig> {
    const repo = await makeTempRepoboard(cards);
    cleanups.push(repo.cleanup);
    await mkdir(join(repo.root, '.repoboard', 'local'), { recursive: true });
    await setup(repo.root);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false, livenessPollMs: POLL_MS });
    cleanups.push(() => server.close());
    return {
      repo,
      store,
      url: server.url.replace(/\/$/, ''),
      seatsFile: join(repo.root, '.repoboard', 'local', 'seats.yml'),
    };
  }

  async function open(r: WireRig): Promise<WsClient> {
    const ws = await connect(r.url, [r.repo.root]);
    cleanups.push(async () => ws.close());
    return ws;
  }

  type Snap = {
    type: string;
    seats: Record<string, unknown>[];
    landings: {
      rows: { cardId: string; commits: Record<string, unknown>[] }[];
      web: string | null;
    };
    log: { date: string; text: string; blocks: unknown[] };
  };
  const isSnapshot = (m: Msg) => m.type === 'snapshot';

  /**
   * Consume the `type` messages that are buffered or about to arrive — a poll or two, or a
   * duplicate raced in by the same change — and return once 150 ms pass in silence. Bounded: an
   * endless stream (a poll that re-sends every tick) leaves messages behind for the NEXT assertion.
   */
  async function drain(ws: WsClient, type: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      try {
        await ws.next((m) => m.type === type, 150, true);
      } catch {
        return;
      }
    }
  }

  it('(1) the snapshot carries seat rows: the SEATS bullet joined to the holder in seats.yml', async () => {
    const r = await wireRig(async (root) => {
      await writeFile(join(root, '.repoboard', 'local', 'seats.yml'), LEASES);
    });
    expect((await r.store.setSeatBullet('builder', 'UP', BUILDER_TEXT)).ok).toBe(true);

    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.seats).toEqual([{ ...BUILDER_ROW, tag: 'A7B2', live: 'unknown' }]);
  });

  it('(2) a seats.yml that cannot be read gives rows with null holder fields, never an error', async () => {
    // Two ways to be unreadable: invalid YAML, and a directory where the file should be (EISDIR).
    for (const unreadable of ['yaml', 'directory'] as const) {
      const r = await wireRig(async (root) => {
        const path = join(root, '.repoboard', 'local', 'seats.yml');
        if (unreadable === 'yaml') await writeFile(path, 'leases: {{{ not yaml [');
        else await mkdir(path);
      });
      expect((await r.store.setSeatBullet('builder', 'UP', BUILDER_TEXT)).ok).toBe(true);

      const snap = await nextMessage<Snap>(await open(r), isSnapshot);
      expect(snap.type, unreadable).toBe('snapshot');
      expect(snap.seats, unreadable).toEqual([BUILDER_ROW]);
    }
  });

  it('(3) a seat write while connected broadcasts the rows, and a `seat` event, with no reload', async () => {
    const r = await wireRig();
    const ws = await open(r);
    const snap = await nextMessage<Snap>(ws, isSnapshot);
    expect(snap.seats).toEqual([]);

    const seen = nextMessage<{ type: string; seats: Record<string, unknown>[] }>(
      ws,
      (m) => m.type === 'seats' && (m.seats as unknown[]).length === 1,
    );
    const event = nextMessage<{ type: string; event: Record<string, unknown> }>(
      ws,
      (m) => m.type === 'event' && (m.event as { type?: string }).type === 'seat',
    );
    expect((await r.store.setSeatBullet('builder', 'UP', BUILDER_TEXT)).ok).toBe(true);
    expect((await seen).seats).toEqual([BUILDER_ROW]);
    expect((await event).event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'builder',
      type: 'seat',
      cardId: null,
      from: null,
      to: 'UP',
    });
  });

  it('(4) the poll re-sends seat rows only when they differ from the last it sent — a holder change with no file event', async () => {
    const r = await wireRig();
    expect((await r.store.setSeatBullet('builder', 'UP', BUILDER_TEXT)).ok).toBe(true);
    const ws = await open(r);
    const snap = await nextMessage<Snap>(ws, isSnapshot);
    expect(snap.seats).toEqual([BUILDER_ROW]);

    // A connection makes the next poll send once (so a client is stale for one poll at most): the
    // same rows as the snapshot.
    const first = await nextMessage<{ type: string; seats: unknown }>(
      ws,
      (m) => m.type === 'seats',
    );
    expect(first.seats).toEqual(snap.seats);

    // seats.yml is not watched: this is a change nothing but the poll can see.
    await writeFile(r.seatsFile, LEASES);
    const changed = await nextMessage<{ type: string; seats: Record<string, unknown>[] }>(
      ws,
      (m) => m.type === 'seats' && (m.seats as { tag?: string }[])[0]?.tag === 'A7B2',
    );
    expect(changed.seats).toEqual([{ ...BUILDER_ROW, tag: 'A7B2', live: 'unknown' }]);

    // ...and then nothing, however many polls pass (8 at 50 ms) while the rows stay as they are.
    await drain(ws, 'seats');
    await expect(ws.next((m) => m.type === 'seats', 400, true)).rejects.toThrow('timed out');
  });

  // ---- RCB-184 slice 2: a member's `seats` carry its home board's rows --------------------------
  //
  // CONTROLS (run by the seat, not part of the suite), applied to `repo-context.ts` `seatsPayload`:
  //  - return `seatRowPayloads(own, held.holders)` unconditionally: (H1) and (H4) fail (no home row),
  //    (H2)/(H3) still pass.
  //  - drop the `.catch(() => null)` on `readHome()` AND make `readHome` throw: (H3) fails (a throw).
  //  - cache the first `readHome()` result for the process: (H4) times out (the edit never arrives).
  //  - swap the spread order (home rows first): (H1) fails on its name order.
  const HOME_SEATS = (owes: string) =>
    [
      '- **[acme] coordinator: UP 2026-10-05 11:00Z · A7B2 · acme coordinator.** coordinating',
      '  in-flight: none',
      `  owes: ${owes}`,
      '- **ops: DOWN 2026-10-05 10:00Z.** done',
    ].join('\n');
  const MEMBER_SEATS = [
    '- **[demo] builder: UP 2026-09-02 22:00Z.** building',
    '  in-flight: none',
    '  owes: nothing',
    '- **[acme] coordinator: DOWN 2026-10-04 09:00Z.** stale copy',
  ].join('\n');

  async function writeSeats(root: string, seats: string): Promise<void> {
    const opts = { now: NOW, actor: 'test-actor' };
    const made = setStateSection(initialStateText(opts), 'seats', seats, opts);
    if (!made.ok) throw new Error(made.error);
    await writeFile(join(root, '.repoboard', 'STATE.md'), made.text, 'utf8');
  }

  /** The home `acme` (its own board.yml name and a SEATS section), then a member rig pointing at it. */
  async function homeRig(
    homeOwes: string,
    workspace: 'home' | 'missing' | null,
  ): Promise<WireRig & { home: string }> {
    const home = await makeTempRepoboard();
    cleanups.push(home.cleanup);
    await writeFile(
      join(home.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), name: 'acme' }),
    );
    await writeSeats(home.root, HOME_SEATS(homeOwes));
    const r = await wireRig(async (root) => {
      const base = { ...defaultBoardConfig(), name: 'demo' };
      const cfg =
        workspace === null
          ? base
          : { ...base, workspace: workspace === 'home' ? home.root : join(home.root, 'not-there') };
      await writeFile(join(root, '.repoboard', 'board.yml'), serializeBoard(cfg));
      await writeSeats(root, MEMBER_SEATS);
    });
    return { ...r, home: home.root };
  }

  it("(H1) with `workspace:` set, the snapshot seats are this board's own rows then the home's, the copy hidden", async () => {
    const r = await homeRig('RCB-9', 'home');
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.seats.map((x) => [x.name, x.home])).toEqual([
      ['builder', null],
      ['[acme] coordinator', 'acme'],
      ['[acme] ops', 'acme'],
    ]);
    expect(snap.seats[1]).toMatchObject({
      status: 'UP',
      tag: null,
      owes: 'RCB-9',
      inFlight: 'none',
    });
  });

  it('(H2) `workspace:` absent: the same rows as today, each with home: null', async () => {
    const r = await homeRig('RCB-9', null);
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.seats.map((x) => [x.name, x.home])).toEqual([
      ['builder', null],
      ['coordinator', null],
    ]);
  });

  it("(H3) a home that cannot be read gives this board's own rows only, and no error", async () => {
    const r = await homeRig('RCB-9', 'missing');
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.type).toBe('snapshot');
    expect(snap.seats.map((x) => [x.name, x.home])).toEqual([
      ['builder', null],
      ['coordinator', null],
    ]);
  });

  it('(H4) a home STATE.md edit reaches a connected client on the next poll', async () => {
    const r = await homeRig('RCB-9', 'home');
    const ws = await open(r);
    const snap = await nextMessage<Snap>(ws, isSnapshot);
    expect(snap.seats[1]?.owes).toBe('RCB-9');
    // The home is not watched by this board's store: only the poll can see this change.
    await writeSeats(r.home, HOME_SEATS('RCB-10'));
    const changed = await nextMessage<{ type: string; seats: Record<string, unknown>[] }>(
      ws,
      (m) =>
        m.type === 'seats' &&
        (m.seats as { home?: string | null; owes?: string | null }[]).some(
          (x) => x.home === 'acme' && x.owes === 'RCB-10',
        ),
    );
    expect(changed.seats.map((x) => x.name)).toEqual([
      'builder',
      '[acme] coordinator',
      '[acme] ops',
    ]);
  });

  /** A git repo at the board root, origin on GitHub, one commit per subject (oldest first). */
  async function gitWire(subjects: string[]) {
    return wireRig(
      async (root) => {
        await runGit(root, 'init', '-q');
        await runGit(root, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
        for (const subject of subjects) {
          await runGit(root, 'commit', '-q', '--allow-empty', '-m', subject);
        }
      },
      { 'RB-1.md': cardText('RB-1', 'todo') },
    );
  }

  it('(5) the snapshot carries landings from git: commits whose subject starts with a card id, grouped, with the GitHub base', async () => {
    const r = await gitWire(['RB-1: first slice', 'cards: RB-9 filed', 'RB-2: second slice']);
    const [sha2, , sha1] = (await runGit(r.repo.root, 'log', '--format=%h')).split('\n');

    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.landings).toEqual({
      rows: [
        {
          cardId: 'RB-2',
          commits: [
            { sha: sha2, at: expect.any(String), author: 't', subject: 'RB-2: second slice' },
          ],
        },
        {
          cardId: 'RB-1',
          commits: [
            { sha: sha1, at: expect.any(String), author: 't', subject: 'RB-1: first slice' },
          ],
        },
      ],
      web: 'https://github.com/acme/widgets',
      source: expect.stringContaining('git log'),
    });
  });

  it('(5b) no git: landings is {rows: [], web: null, source} — a payload, not a crash', async () => {
    const r = await wireRig();
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.landings).toEqual({
      rows: [],
      web: null,
      source: expect.stringContaining('git log'),
    });
  });

  it('(6) a new commit re-sends landings, and an unchanged HEAD does not', async () => {
    const r = await gitWire(['RB-1: first slice']);
    const ws = await open(r);
    await nextMessage<Snap>(ws, isSnapshot);
    type Landings = { type: string; landings: { rows: { cardId: string }[] } };
    const firstRows = (m: Landings) => m.landings.rows.map((row) => row.cardId);

    // The poll after a connection sends once, for the HEAD the snapshot was read at.
    const first = await nextMessage<Landings>(ws, (m) => m.type === 'landings');
    expect(firstRows(first)).toEqual(['RB-1']);

    await runGit(r.repo.root, 'commit', '-q', '--allow-empty', '-m', 'RB-3: third slice');
    const next = await nextMessage<Landings>(ws, (m) => m.type === 'landings');
    expect(firstRows(next)).toEqual(['RB-3', 'RB-1']);

    // A commit that lands between a poll's two git reads can be sent twice; once drained, silence.
    await drain(ws, 'landings');
    await expect(ws.next((m) => m.type === 'landings', 400, true)).rejects.toThrow('timed out');
  });

  /** `.repoboard/log/<day>.md`: the header, plus one block when `withBlock`. */
  async function writeLogDay(root: string, day: string, withBlock: boolean): Promise<void> {
    const dir = join(root, '.repoboard', 'log');
    await mkdir(dir, { recursive: true });
    const header = `${dailyLogHeader(day)}\n`;
    const block = formatLogBlock({
      seat: 'builder',
      ts: `${day}T10:00:00Z`,
      title: `work on ${day}`,
      text: 'the body',
    });
    await writeFile(join(dir, `${day}.md`), withBlock ? appendLogBlock(header, block) : header);
  }

  it("(7) the snapshot's log is today's when it has an entry, else the newest earlier day with one within 14 days", async () => {
    // The fixed clock is 2026-09-02. Today has a header and no block; the 1st has one; so does the
    // 14th day back (08-19), but 08-18 (15 back) is out of reach.
    const r = await wireRig(async (root) => {
      await writeLogDay(root, '2026-09-02', false);
      await writeLogDay(root, '2026-08-19', true);
      await writeLogDay(root, '2026-08-18', true);
    });
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.log.date).toBe('2026-08-19');
    expect(snap.log.blocks).toHaveLength(1);
    expect(snap.log.text).toContain('work on 2026-08-19');

    // the newest earlier day wins over an older one; today's own block wins over both
    await writeLogDay(r.repo.root, '2026-09-01', true);
    expect((await r.store.newestLog(14))?.date).toBe('2026-09-01');
    await writeLogDay(r.repo.root, '2026-09-02', true);
    expect((await r.store.newestLog(14))?.date).toBe('2026-09-02');

    // GET /api/log is unchanged: it answers for the day it is asked about, today by default.
    const today = (await json(await fetch(`${r.url}/api/log`))) as { date: string };
    expect(today.date).toBe('2026-09-02');
    expect((await fetch(`${r.url}/api/log?date=2026-08-30`)).status).toBe(404);
  });

  it('(7b) no day with an entry within 14 days: today’s empty payload, as before', async () => {
    const r = await wireRig(async (root) => {
      await writeLogDay(root, '2026-08-18', true); // 15 days back: out of reach
    });
    const snap = await nextMessage<Snap>(await open(r), isSnapshot);
    expect(snap.log).toEqual({ date: '2026-09-02', text: '', blocks: [] });
    expect(await r.store.newestLog(14)).toBeNull();
  });
});
