import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Card, defaultBoardConfig, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from '../src/http.js';
import { type CardStore, openStore } from '../src/store.js';
import {
  cardText,
  makeTempDir,
  makeTempRepoboard,
  makeTempRepoNoBoard,
  NOW,
  type TempRepo,
} from './helpers.js';

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
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  close(): void {
    this.ws.close();
  }
  /** First buffered or future message satisfying `pred`. */
  next<T = Msg>(pred: (m: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
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
        rej(new Error('timed out waiting for ws message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function connect(url: string): Promise<WsClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    // Wrap inside the open handler, synchronously, so no message can slip past.
    ws.once('open', () => res(new WsClient(ws)));
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
          { name: 'fpj', url: 'http://localhost:4243' },
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
        { name: 'fpj', url: 'http://localhost:9999' }, // collision: the flag wins
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
      { name: 'fpj', url: 'http://localhost:4243' },
      { name: 'stable', url: 'http://localhost:4244' },
    ]);
    expect(body.siblings).toEqual([
      { name: 'fpj', url: 'http://localhost:9999' },
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

    const ws = await connect(url);
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
        siblings: [{ name: 'fpj', url: 'http://localhost:4243' }],
      }),
    );
    const msg = await configMsg;
    expect(msg.siblings).toEqual([
      { name: 'fpj', url: 'http://localhost:4243' },
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
    const ws = await connect(r.url);
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
    const ws = await connect(r.url);
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

    const client = await connect(r.url);
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
    const ws = await connect(r.url);
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
    const posted = (await json(post)) as { date: string; text: string };
    expect(posted.date).toBe('2026-09-02');
    expect(posted.text).toContain('kickoff');

    const get = await fetch(`${r.url}/api/log`);
    expect(get.status).toBe(200);
    const body = (await json(get)) as { date: string; text: string; blocks: unknown[] };
    expect(body.date).toBe('2026-09-02');
    expect(body.blocks).toHaveLength(1);
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
    const findings = await r.store.check(false);
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
    const ws = await connect(r.url);
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
