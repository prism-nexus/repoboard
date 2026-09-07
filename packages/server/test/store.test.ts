import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardConfig, Card } from '@repoboard/core';
import { parseCard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CardStore,
  type CreateOutcome,
  compareCardIds,
  type InvalidCard,
  MAP_ONLY_ERROR,
  MapOnlyError,
  openStore,
  type StoreEvent,
} from '../src/store.js';
import {
  cardText,
  makeTempRepoboard,
  makeTempRepoNoBoard,
  NOW,
  sleep,
  type TempRepo,
  waitForEvent,
} from './helpers.js';

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
  const repo = await makeTempRepoboard(cards);
  repos.push(repo);
  return repo;
}

describe('openStore: load', () => {
  it('reads board.yml and every card; falls back to defaults without board.yml', async () => {
    const repo = await repoWith({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'doing', { assignee: 'claude/x' }),
      'RB-10.md': cardText('RB-10', 'done'),
    });
    const store = await open(repo, false);
    expect(store.config.prefix).toBe('RB');
    expect(store.config.columns.map((c) => c.id)).toEqual([
      'backlog',
      'todo',
      'doing',
      'review',
      'done',
    ]);
    expect(store.list().map((c) => c.id)).toEqual(['RB-1', 'RB-2', 'RB-10']);
    expect(store.get('RB-2')?.assignee).toBe('claude/x');
    expect(store.invalid).toEqual([]);

    await rm(join(repo.root, '.repoboard', 'board.yml'));
    const bare = await open(repo, false);
    expect(bare.config.columns).toHaveLength(5);
  });

  it('reports an invalid card instead of throwing, and still loads the others', async () => {
    const repo = await repoWith({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': '---\nid: RB-2\ntitle: no status here\n---\n',
    });
    const store = await open(repo, false);
    expect(store.list().map((c) => c.id)).toEqual(['RB-1']);
    expect(store.invalid).toHaveLength(1);
    expect(store.invalid[0]?.path).toBe(join('.repoboard', 'cards', 'RB-2.md'));
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
      'RB-3.md': cardText('RB-3', 'todo'),
      'RB-7.md': cardText('RB-7', 'done'),
    });
    const store = await open(repo, false);
    const card = created(await store.create({ title: 'New one', labels: ['a'] }, 'tester'));
    expect(card.id).toBe('RB-8');
    expect(card.status).toBe('backlog');
    expect(card.created).toBe('2026-09-02T22:41:10Z');

    const text = await readFile(join(repo.cardsDir, 'RB-8.md'), 'utf8');
    const parsed = parseCard(text);
    expect(parsed.ok && parsed.card.title).toBe('New one');
    expect(store.get('RB-8')).toEqual(card);

    const log = await readFile(join(repo.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'tester',
      type: 'create',
      cardId: 'RB-8',
      from: null,
      to: 'backlog',
    });
  });

  it('counts an invalid file toward id allocation so it is never overwritten', async () => {
    const repo = await repoWith({ 'RB-4.md': 'garbage' });
    const store = await open(repo, false);
    const card = created(await store.create({ title: 'x' }, 'tester'));
    expect(card.id).toBe('RB-5');
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
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const res = await store.move('RB-1', 'doing', 'claude/agent');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.status).toBe('doing');
    expect(res.card.updated).toBe('2026-09-02T22:41:10Z');
    expect(res.warnings).toEqual([]);

    const text = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('- 2026-09-02T22:41:10Z claude/agent — moved todo → doing');
    expect(await readFile(join(repo.cardsDir, 'RB-1.md.tmp'), 'utf8').catch(() => 'gone')).toBe(
      'gone',
    );

    const log = await readFile(join(repo.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(events).toEqual([
      {
        ts: '2026-09-02T22:41:10Z',
        actor: 'claude/agent',
        type: 'move',
        cardId: 'RB-1',
        from: 'todo',
        to: 'doing',
      },
    ]);
    expect(store.events('2026-09-02T22:41:09Z')).toHaveLength(1);
    expect(store.events('2026-09-02T22:41:10Z')).toHaveLength(0);
  });

  it('move returns ok:false for an unknown card or column, and a WIP warning', async () => {
    const repo = await repoWith({
      'RB-1.md': cardText('RB-1', 'doing'),
      'RB-2.md': cardText('RB-2', 'doing'),
      'RB-3.md': cardText('RB-3', 'doing'),
      'RB-4.md': cardText('RB-4', 'todo'),
    });
    const store = await open(repo, false);
    expect(await store.move('RB-99', 'doing', 't')).toMatchObject({ ok: false, notFound: true });
    expect(await store.move('RB-4', 'nowhere', 't')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown column/),
    });
    const res = await store.move('RB-4', 'doing', 't');
    expect(res.ok && res.warnings[0]).toMatch(/WIP limit exceeded/);
  });

  it('update changes fields, clears with null, and appends an update event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo', { assignee: 'a' }) });
    const store = await open(repo, false);
    const res = await store.update('RB-1', { title: 'Renamed', assignee: null }, 'ed');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.title).toBe('Renamed');
    expect(res.card.assignee).toBeUndefined();
    expect(res.event).toMatchObject({ type: 'update', from: 'todo', to: 'todo', actor: 'ed' });
    const text = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).not.toContain('assignee:');
    expect(text).toContain('updated title, assignee');
  });

  it('serialises concurrent creates so ids never collide', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const cards = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.create({ title: `c${i}` }, 't')),
    );
    expect(cards.map((c) => created(c).id)).toEqual(['RB-1', 'RB-2', 'RB-3', 'RB-4', 'RB-5']);
  });
});

describe('watcher', () => {
  it('picks up an external sed-style edit and synthesises a file event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);
    const path = join(repo.cardsDir, 'RB-1.md');

    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    const eventSeen = waitForEvent<StoreEvent>(store, 'event');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    const card = await cardSeen;
    expect(card.id).toBe('RB-1');
    expect(store.get('RB-1')?.status).toBe('doing');
    expect(await eventSeen).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'file',
      type: 'move',
      cardId: 'RB-1',
      from: 'todo',
      to: 'doing',
    });
    const log = await readFile(join(repo.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(log).toContain('"actor":"file"');
  });

  it('sees a new file, a removed file, and a file that turns invalid', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);

    const added = waitForEvent<Card>(store, 'card', (c) => c.id === 'RB-2');
    await writeFile(join(repo.cardsDir, 'RB-2.md'), cardText('RB-2', 'review'));
    expect((await added).status).toBe('review');
    expect(store.list()).toHaveLength(2);

    const invalid = waitForEvent<InvalidCard[]>(store, 'invalid', (list) => list.length === 1);
    const removed = waitForEvent<string>(store, 'card:removed', (id) => id === 'RB-2');
    await writeFile(join(repo.cardsDir, 'RB-2.md'), '---\nid: RB-2\n---\n');
    expect((await invalid)[0]?.error).toMatch(/missing required/);
    expect(await removed).toBe('RB-2');
    expect(store.list().map((c) => c.id)).toEqual(['RB-1']);

    const gone = waitForEvent<string>(store, 'card:removed', (id) => id === 'RB-1');
    await rm(join(repo.cardsDir, 'RB-1.md'));
    expect(await gone).toBe('RB-1');
    expect(store.list()).toEqual([]);
  });

  it('does not synthesise a file event for its own write', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));
    await store.move('RB-1', 'doing', 'me');
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
      join(repo.root, '.repoboard', 'board.yml'),
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
      cardId: 'RB-1',
      from: 'a',
      to: 'b',
    };
    await writeFile(join(repo.root, '.repoboard', 'events.jsonl'), `${JSON.stringify(line)}\n`);
    expect(await seen).toEqual(line);
    expect(store.events()).toEqual([line]);
  });
});

describe('compareCardIds', () => {
  it('orders numerically within a prefix', () => {
    expect(['RB-10', 'RB-2', 'ABC-1', 'RB-1'].sort(compareCardIds)).toEqual([
      'ABC-1',
      'RB-1',
      'RB-2',
      'RB-10',
    ]);
  });
});

/**
 * K8 (RCB-28): one external mutation must produce exactly one ticker entry.
 * Each test counts every `event` emission on the *watching* store across one mutation.
 */
describe('K8: one external mutation, one ticker entry', () => {
  /** Longer than chokidar's awaitWriteFinish (100 ms) plus the serial queue. */
  const settle = (): Promise<void> => sleep(700);

  it('a second process running `card move` emits one event, not two', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const watching = await open(repo, true);
    const events: StoreEvent[] = [];
    watching.on('event', (e) => events.push(e));

    // A second process (the CLI): its own store, no watcher, writing the same files.
    const cli = await open(repo, false);
    const res = await cli.move('RB-1', 'doing', 'claude/cli');
    expect(res.ok).toBe(true);

    await waitForEvent<Card>(watching, 'card', (c) => c.status === 'doing');
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['claude/cli:move']);
    expect(watching.get('RB-1')?.status).toBe('doing');
  });

  it('a second process running `card add` emits one event, not two', async () => {
    const repo = await repoWith({});
    const watching = await open(repo, true);
    const events: StoreEvent[] = [];
    watching.on('event', (e) => events.push(e));

    const cli = await open(repo, false);
    expect(created(await cli.create({ title: 'From the CLI' }, 'claude/cli')).id).toBe('RB-1');

    await waitForEvent<Card>(watching, 'card', (c) => c.id === 'RB-1');
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['claude/cli:create']);
  });

  it('a hand edit of status alone still yields exactly one file event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    expect(original).toContain('updated: 2026-09-02T22:00:00Z');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await settle();

    expect(events).toEqual([
      {
        ts: '2026-09-02T22:41:10Z',
        actor: 'file',
        type: 'move',
        cardId: 'RB-1',
        from: 'todo',
        to: 'doing',
      },
    ]);
  });

  it('a hand edit of status alone still speaks after a CLI move left a claim in the log', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const watching = await open(repo, true);
    const cli = await open(repo, false);
    expect((await cli.move('RB-1', 'doing', 'claude/cli')).ok).toBe(true);
    await waitForEvent<Card>(watching, 'card', (c) => c.status === 'doing');
    await settle();

    // The log now holds an event whose (cardId, ts) equals this card's (id, updated).
    const path = join(repo.cardsDir, 'RB-1.md');
    const afterMove = await readFile(path, 'utf8');
    expect(afterMove).toContain('updated: 2026-09-02T22:41:10Z');

    const events: StoreEvent[] = [];
    watching.on('event', (e) => events.push(e));
    await writeFile(path, afterMove.replace('status: doing', 'status: review'));

    await waitForEvent<Card>(watching, 'card', (c) => c.status === 'review');
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}:${e.from}->${e.to}`)).toEqual([
      'file:move:doing->review',
    ]);
  });

  it('an in-process mutation keeps, not loses, an event another process appended first', async () => {
    // Guards the byte-offset accounting in appendEvent. `eventsBytes` is a read offset into
    // events.jsonl; adding our own line's length to a stale offset drops the other process's
    // line and makes the next read start mid-line. watch:false so nothing but the mutation
    // itself can re-read the log.
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const foreign: StoreEvent = {
      ts: '2026-09-02T22:30:00Z',
      actor: 'claude/cli',
      type: 'update',
      cardId: 'RB-9',
      from: 'todo',
      to: 'todo',
    };
    await writeFile(join(repo.root, '.repoboard', 'events.jsonl'), `${JSON.stringify(foreign)}\n`);

    expect((await store.move('RB-1', 'doing', 'me')).ok).toBe(true);

    expect(events).toEqual([
      foreign,
      {
        ts: '2026-09-02T22:41:10Z',
        actor: 'me',
        type: 'move',
        cardId: 'RB-1',
        from: 'todo',
        to: 'doing',
      },
    ]);
    expect(store.events()).toEqual(events);
    // The offset now matches the file, so a re-read adds nothing.
    const before = store.events().length;
    expect((await store.appendLog('RB-1', 'note', 'me')).ok).toBe(true);
    expect(store.events()).toHaveLength(before + 1);
  });

  it('a hand edit that bumps updated but appends no event still yields one file event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    await writeFile(
      path,
      original
        .replace('status: todo', 'status: doing')
        .replace('updated: 2026-09-02T22:00:00Z', 'updated: 2026-09-02T23:15:00Z'),
    );

    await waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);
  });
});

// ---- K10: a root with no `.repoboard/` refuses every mutation ---------------------------------

describe('map-only roots refuse every mutation (K10)', () => {
  async function boardless() {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    repos.push(repo);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    expect(store.hasBoard).toBe(false);
    return { repo, store };
  }

  it('create is refused as readOnly and materialises nothing', async () => {
    const { repo, store } = await boardless();
    const res = await store.create({ title: 'hole' }, 'test-actor');
    // On-disk FIRST, and on the directory's existence rather than `git status` — git does not
    // track empty directories, so a `git status` assertion here would pass while `.repoboard/`
    // sat in a stranger's repo (HANDOFF §7, the sixth vacuous-control species).
    expect(await repo.hasRepoboard()).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.events()).toEqual([]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('create should have been refused');
    expect(res.readOnly).toBe(true);
    expect(res.error).toBe(MAP_ONLY_ERROR);
  });

  it('move, update and appendLog cannot reach a write either', async () => {
    const { repo, store } = await boardless();
    // They stop earlier than the guard, at `unknown card`: a card can only be in memory if it was
    // read out of `.repoboard/cards/`, which cannot exist here. So `notFound`, not `readOnly` —
    // the refusal is honest either way, and neither reaches a writer.
    for (const res of [
      await store.move('RB-1', 'doing', 'test-actor'),
      await store.update('RB-1', { title: 'x' }, 'test-actor'),
      await store.appendLog('RB-1', 'x', 'test-actor'),
    ]) {
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('should have been refused');
      expect(res.notFound).toBe(true);
    }
    expect(await repo.hasRepoboard()).toBe(false);
  });

  /**
   * The property the guard is placed for: a *fifth* mutating method, added later by someone who
   * never read this file, cannot write even if it skips `mutate` entirely — because the only two
   * functions in the store that put bytes on disk refuse first.
   */
  it('a caller that bypasses the mutate funnel still cannot write', async () => {
    const { repo, store } = await boardless();
    const internals = store as unknown as {
      writeCard(card: Card): Promise<void>;
      appendEvent(event: StoreEvent): Promise<void>;
    };
    const card: Card = {
      id: 'RB-1',
      title: 'bypass',
      status: 'todo',
      created: '2026-09-07T00:00:00Z',
      updated: '2026-09-07T00:00:00Z',
      body: '',
    };
    await expect(internals.writeCard(card)).rejects.toThrow(MapOnlyError);
    await expect(
      internals.appendEvent({
        ts: '2026-09-07T00:00:00Z',
        actor: 'bypass',
        type: 'create',
        cardId: 'RB-1',
        from: null,
        to: 'todo',
      }),
    ).rejects.toThrow(MapOnlyError);
    expect(await repo.hasRepoboard()).toBe(false);
  });

  it('a repo that has a board is completely unaffected', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    expect(store.hasBoard).toBe(true);
    const created = await store.create({ title: 'fine' }, 'test-actor');
    expect(created.ok).toBe(true);
    const moved = await store.move('RB-1', 'doing', 'test-actor');
    expect(moved.ok).toBe(true);
    const logged = await store.appendLog('RB-1', 'still works', 'test-actor');
    expect(logged.ok).toBe(true);
  });
});

// ---- K10 structurally: the guard cannot be forgotten by a later method ------------------------
//
// Same idea as core's purity.test.ts: some guarantees are about the SHAPE of the source, and a
// behavioural test can only ever cover the methods that exist today.

describe('K10 structure of store.ts', () => {
  const SRC = readFileSync(fileURLToPath(new URL('../src/store.ts', import.meta.url)), 'utf8');

  /** `[start, end)` of a method body, from its declaration to the matching two-space `}`. */
  function methodRange(decl: string): [number, number] {
    const start = SRC.indexOf(decl);
    expect(start, `${decl} not found`).toBeGreaterThan(-1);
    const end = SRC.indexOf('\n  }', start);
    expect(end, `end of ${decl} not found`).toBeGreaterThan(start);
    return [start, end];
  }

  it('every method returning a *Outcome goes through this.mutate', () => {
    const decls = [
      ...SRC.matchAll(/^ {2}(\w+)\([^)]*\): Promise<(\w+Outcome)> \{\n {4}return this\.(\w+)\(/gm),
    ];
    expect(decls.map((d) => d[1]).sort()).toEqual(['appendLog', 'create', 'move', 'update']);
    expect(decls.map((d) => d[3])).toEqual(['mutate', 'mutate', 'mutate', 'mutate']);
  });

  it('both disk writers open with the guard, on their first line', () => {
    for (const decl of ['private async writeCard', 'private async appendEvent']) {
      const [start, end] = methodRange(decl);
      const first = SRC.slice(start, end).split('\n')[1]?.trim();
      expect(first, `${decl} first statement`).toBe('this.refuseWriteWithoutBoard();');
    }
  });

  it('and nothing else in the store writes to disk', () => {
    const ranges = [
      methodRange('private async writeCard'),
      methodRange('private async appendEvent'),
    ];
    const writes = [...SRC.matchAll(/await (writeFile|appendFile|rename|mkdir)\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      const i = w.index;
      const inside = ranges.some(([a, b]) => i >= a && i < b);
      expect(inside, `${w[1]} at index ${i} is outside the two guarded writers`).toBe(true);
    }
  });
});
