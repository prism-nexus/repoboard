import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Card } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from '../src/http.js';
import { type CardStore, openStore } from '../src/store.js';
import { cardText, makeTempDir, makeTempRepoboard, NOW, type TempRepo } from './helpers.js';

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
