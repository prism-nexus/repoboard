import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardConfig, Card } from '@rcb/core';
import { parseCard } from '@rcb/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CardStore,
  type CreateOutcome,
  compareCardIds,
  type InvalidCard,
  openStore,
  type StoreEvent,
} from '../src/store.js';
import { cardText, makeTempRcb, NOW, type TempRepo, waitForEvent } from './helpers.js';

const opened: CardStore[] = [];
const repos: TempRepo[] = [];

async function open(repo: TempRepo, watch: boolean): Promise<CardStore> {
  const store = await openStore(repo.root, { watch, now: () => NOW });
  opened.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function repoWith(cards: Record<string, string>): Promise<TempRepo> {
  const repo = await makeTempRcb(cards);
  repos.push(repo);
  return repo;
}

describe('openStore: load', () => {
  it('reads board.yml and every card; falls back to defaults without board.yml', async () => {
    const repo = await repoWith({
      'RCB-1.md': cardText('RCB-1', 'todo'),
      'RCB-2.md': cardText('RCB-2', 'doing', { assignee: 'claude/x' }),
      'RCB-10.md': cardText('RCB-10', 'done'),
    });
    const store = await open(repo, false);
    expect(store.config.prefix).toBe('RCB');
    expect(store.config.columns.map((c) => c.id)).toEqual([
      'backlog',
      'todo',
      'doing',
      'review',
      'done',
    ]);
    expect(store.list().map((c) => c.id)).toEqual(['RCB-1', 'RCB-2', 'RCB-10']);
    expect(store.get('RCB-2')?.assignee).toBe('claude/x');
    expect(store.invalid).toEqual([]);

    await rm(join(repo.root, '.rcb', 'board.yml'));
    const bare = await open(repo, false);
    expect(bare.config.columns).toHaveLength(5);
  });

  it('reports an invalid card instead of throwing, and still loads the others', async () => {
    const repo = await repoWith({
      'RCB-1.md': cardText('RCB-1', 'todo'),
      'RCB-2.md': '---\nid: RCB-2\ntitle: no status here\n---\n',
    });
    const store = await open(repo, false);
    expect(store.list().map((c) => c.id)).toEqual(['RCB-1']);
    expect(store.invalid).toHaveLength(1);
    expect(store.invalid[0]?.path).toBe(join('.rcb', 'cards', 'RCB-2.md'));
    expect(store.invalid[0]?.error).toMatch(/missing required keys: status, created, updated/);
  });

  it('tolerates a missing cards directory', async () => {
    const repo = await repoWith({});
    await rm(repo.cardsDir, { recursive: true });
    const store = await open(repo, false);
    expect(store.list()).toEqual([]);
  });
});

/** Unwrap a create outcome (K4) or fail the test with its error. */
function created(res: CreateOutcome): Card {
  if (!res.ok) throw new Error(res.error);
  return res.card;
}

describe('create', () => {
  it('allocates the next id, writes the file via core, and appends a create event', async () => {
    const repo = await repoWith({
      'RCB-3.md': cardText('RCB-3', 'todo'),
      'RCB-7.md': cardText('RCB-7', 'done'),
    });
    const store = await open(repo, false);
    const card = created(await store.create({ title: 'New one', labels: ['a'] }, 'tester'));
    expect(card.id).toBe('RCB-8');
    expect(card.status).toBe('backlog');
    expect(card.created).toBe('2026-09-02T22:41:10Z');

    const text = await readFile(join(repo.cardsDir, 'RCB-8.md'), 'utf8');
    const parsed = parseCard(text);
    expect(parsed.ok && parsed.card.title).toBe('New one');
    expect(store.get('RCB-8')).toEqual(card);

    const log = await readFile(join(repo.root, '.rcb', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'tester',
      type: 'create',
      cardId: 'RCB-8',
      from: null,
      to: 'backlog',
    });
  });

  it('counts an invalid file toward id allocation so it is never overwritten', async () => {
    const repo = await repoWith({ 'RCB-4.md': 'garbage' });
    const store = await open(repo, false);
    const card = created(await store.create({ title: 'x' }, 'tester'));
    expect(card.id).toBe('RCB-5');
  });

  it('rejects an unknown status as ok:false (K4) without writing anything', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(await store.create({ title: 'x', status: 'nope' }, 't')).toEqual({
      ok: false,
      error: expect.stringMatching(/unknown column "nope"/),
    });
    expect(store.list()).toEqual([]);
  });
});

describe('move and update', () => {
  it('move writes the file, sets updated, appends a Log line and an event', async () => {
    const repo = await repoWith({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const store = await open(repo, false);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const res = await store.move('RCB-1', 'doing', 'claude/agent');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.status).toBe('doing');
    expect(res.card.updated).toBe('2026-09-02T22:41:10Z');
    expect(res.warnings).toEqual([]);

    const text = await readFile(join(repo.cardsDir, 'RCB-1.md'), 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('- 2026-09-02T22:41:10Z claude/agent — moved todo → doing');
    expect(await readFile(join(repo.cardsDir, 'RCB-1.md.tmp'), 'utf8').catch(() => 'gone')).toBe(
      'gone',
    );

    const log = await readFile(join(repo.root, '.rcb', 'events.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(events).toEqual([
      {
        ts: '2026-09-02T22:41:10Z',
        actor: 'claude/agent',
        type: 'move',
        cardId: 'RCB-1',
        from: 'todo',
        to: 'doing',
      },
    ]);
    expect(store.events('2026-09-02T22:41:09Z')).toHaveLength(1);
    expect(store.events('2026-09-02T22:41:10Z')).toHaveLength(0);
  });

  it('move returns ok:false for an unknown card or column, and a WIP warning', async () => {
    const repo = await repoWith({
      'RCB-1.md': cardText('RCB-1', 'doing'),
      'RCB-2.md': cardText('RCB-2', 'doing'),
      'RCB-3.md': cardText('RCB-3', 'doing'),
      'RCB-4.md': cardText('RCB-4', 'todo'),
    });
    const store = await open(repo, false);
    expect(await store.move('RCB-99', 'doing', 't')).toMatchObject({ ok: false, notFound: true });
    expect(await store.move('RCB-4', 'nowhere', 't')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown column/),
    });
    const res = await store.move('RCB-4', 'doing', 't');
    expect(res.ok && res.warnings[0]).toMatch(/WIP limit exceeded/);
  });

  it('update changes fields, clears with null, and appends an update event', async () => {
    const repo = await repoWith({ 'RCB-1.md': cardText('RCB-1', 'todo', { assignee: 'a' }) });
    const store = await open(repo, false);
    const res = await store.update('RCB-1', { title: 'Renamed', assignee: null }, 'ed');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.title).toBe('Renamed');
    expect(res.card.assignee).toBeUndefined();
    expect(res.event).toMatchObject({ type: 'update', from: 'todo', to: 'todo', actor: 'ed' });
    const text = await readFile(join(repo.cardsDir, 'RCB-1.md'), 'utf8');
    expect(text).not.toContain('assignee:');
    expect(text).toContain('updated title, assignee');
  });

  it('serialises concurrent creates so ids never collide', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const cards = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.create({ title: `c${i}` }, 't')),
    );
    expect(cards.map((c) => created(c).id)).toEqual(['RCB-1', 'RCB-2', 'RCB-3', 'RCB-4', 'RCB-5']);
  });
});

describe('watcher', () => {
  it('picks up an external sed-style edit and synthesises a file event', async () => {
    const repo = await repoWith({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const store = await open(repo, true);
    const path = join(repo.cardsDir, 'RCB-1.md');

    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    const eventSeen = waitForEvent<StoreEvent>(store, 'event');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    const card = await cardSeen;
    expect(card.id).toBe('RCB-1');
    expect(store.get('RCB-1')?.status).toBe('doing');
    expect(await eventSeen).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'file',
      type: 'move',
      cardId: 'RCB-1',
      from: 'todo',
      to: 'doing',
    });
    const log = await readFile(join(repo.root, '.rcb', 'events.jsonl'), 'utf8');
    expect(log).toContain('"actor":"file"');
  });

  it('sees a new file, a removed file, and a file that turns invalid', async () => {
    const repo = await repoWith({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const store = await open(repo, true);

    const added = waitForEvent<Card>(store, 'card', (c) => c.id === 'RCB-2');
    await writeFile(join(repo.cardsDir, 'RCB-2.md'), cardText('RCB-2', 'review'));
    expect((await added).status).toBe('review');
    expect(store.list()).toHaveLength(2);

    const invalid = waitForEvent<InvalidCard[]>(store, 'invalid', (list) => list.length === 1);
    const removed = waitForEvent<string>(store, 'card:removed', (id) => id === 'RCB-2');
    await writeFile(join(repo.cardsDir, 'RCB-2.md'), '---\nid: RCB-2\n---\n');
    expect((await invalid)[0]?.error).toMatch(/missing required/);
    expect(await removed).toBe('RCB-2');
    expect(store.list().map((c) => c.id)).toEqual(['RCB-1']);

    const gone = waitForEvent<string>(store, 'card:removed', (id) => id === 'RCB-1');
    await rm(join(repo.cardsDir, 'RCB-1.md'));
    expect(await gone).toBe('RCB-1');
    expect(store.list()).toEqual([]);
  });

  it('does not synthesise a file event for its own write', async () => {
    const repo = await repoWith({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const store = await open(repo, true);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));
    await store.move('RCB-1', 'doing', 'me');
    // Give the watcher time to echo the write back (awaitWriteFinish is 100 ms).
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe('me');
  });

  it('reloads config when board.yml changes', async () => {
    const repo = await repoWith({});
    const store = await open(repo, true);
    const changed = waitForEvent<BoardConfig>(store, 'config');
    await writeFile(
      join(repo.root, '.rcb', 'board.yml'),
      'prefix: ZZ\ncolumns:\n  - id: one\n  - id: two\n',
    );
    const cfg = await changed;
    expect(cfg.prefix).toBe('ZZ');
    expect(store.config.columns.map((c) => c.id)).toEqual(['one', 'two']);
  });

  it('emits events appended to events.jsonl by another process', async () => {
    const repo = await repoWith({});
    const store = await open(repo, true);
    const seen = waitForEvent<StoreEvent>(store, 'event');
    const line = {
      ts: '2026-09-02T23:00:00Z',
      actor: 'cli',
      type: 'move',
      cardId: 'RCB-1',
      from: 'a',
      to: 'b',
    };
    await writeFile(join(repo.root, '.rcb', 'events.jsonl'), `${JSON.stringify(line)}\n`);
    expect(await seen).toEqual(line);
    expect(store.events()).toEqual([line]);
  });
});

describe('compareCardIds', () => {
  it('orders numerically within a prefix', () => {
    expect(['RCB-10', 'RCB-2', 'ABC-1', 'RCB-1'].sort(compareCardIds)).toEqual([
      'ABC-1',
      'RCB-1',
      'RCB-2',
      'RCB-10',
    ]);
  });
});
