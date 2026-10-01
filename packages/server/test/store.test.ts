import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  appendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BoardConfig, Card } from '@repoboard/core';
import {
  boardDisplayName,
  defaultBoardConfig,
  initialStateText,
  parseBoard,
  parseCard,
  parseLeases,
  parseState,
  serializeBoard,
} from '@repoboard/core';
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
import { createWatchDiag, getWatchDiag, setWatchDiag } from '../src/watch-diag.js';
import {
  cardText,
  makeTempRepoboard,
  makeTempRepoNoBoard,
  NOW,
  sleep,
  type TempRepo,
  waitForEvent,
} from './helpers.js';

const execFileAsync = promisify(execFile);

/** One `git` invocation for a fixture repo. Fixtures live under `os.tmpdir()` (never this repo). */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  await execFileAsync('git', args, { cwd, env });
}

const opened: CardStore[] = [];
const repos: TempRepo[] = [];

async function open(
  repo: TempRepo,
  watch: boolean,
  reconcileMs?: number,
  emptyGraceMs?: number,
): Promise<CardStore> {
  const store = await openStore(repo.root, {
    watch,
    now: () => NOW,
    ...(reconcileMs === undefined ? {} : { reconcileMs }),
    ...(emptyGraceMs === undefined ? {} : { emptyGraceMs }),
  });
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

/**
 * RCB-160: `repoWith`'s fixture writes `defaultBoardConfig()` (no `name:`), so every producer
 * (`setSeatBullet`, `appendRepoLog`, …) prefixes its output with `boardDisplayName`'s OWN fallback
 * — the temp dir's own random basename, never a fixed literal. Tests that pin a producer's exact
 * text compute it with this ONE call, so they can never drift from what the store itself uses.
 */
function repoName(repo: TempRepo): string {
  return boardDisplayName(null, repo.root);
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
      'decide',
      'todo',
      'doing',
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

describe('RCB-68: parent existence (checkParent, create and update)', () => {
  it('create refuses an unknown parent with the exact message; a known parent is accepted', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    expect(await store.create({ title: 'step', parent: 'RB-99' }, 't')).toEqual({
      ok: false,
      error: 'parent: unknown card "RB-99" (card list shows the ids)',
    });
    expect(store.list().map((c) => c.id)).toEqual(['RB-1']); // nothing written
    const card = created(await store.create({ title: 'step', parent: 'RB-1', phase: 'PH.1' }, 't'));
    expect(card.parent).toBe('RB-1');
    expect(card.phase).toBe('PH.1');
  });

  it('update refuses an unknown parent with the exact message; a known parent is accepted', async () => {
    const repo = await repoWith({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo'),
    });
    const store = await open(repo, false);
    expect(await store.update('RB-2', { parent: 'RB-404' }, 't')).toEqual({
      ok: false,
      error: 'parent: unknown card "RB-404" (card list shows the ids)',
    });
    expect(store.get('RB-2')?.parent).toBeUndefined(); // nothing written
    const res = await store.update('RB-2', { parent: 'RB-1' }, 't');
    expect(res.ok && res.card.parent).toBe('RB-1');
  });

  it('a reread from disk keeps parent/phase/gate', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    created(
      await store.create({ title: 'step', parent: 'RB-1', phase: 'PH.2', gate: 'RB-1' }, 't'),
    );
    const reopened = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(reopened);
    const step = reopened.list().find((c) => c.title === 'step');
    expect(step?.parent).toBe('RB-1');
    expect(step?.phase).toBe('PH.2');
    expect(step?.gate).toBe('RB-1');
  });
});

describe('RCB-67: size', () => {
  it('create + update + reread from disk keep size', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const card = created(await store.create({ title: 'sized', size: 'M' }, 't'));
    expect(card.size).toBe('M');

    const updated = await store.update(card.id, { size: 'XL' }, 't');
    expect(updated.ok && updated.card.size).toBe('XL');

    const reopened = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(reopened);
    expect(reopened.get(card.id)?.size).toBe('XL');
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

// ---- RCB-108: a plan parent doesn't count against WIP -----------------------------------------
describe('move: parents not counted for WIP (RCB-108)', () => {
  /** A repo with `doing`'s wip lowered to 2, so 2 plain cards already fill it. */
  async function repoWithDoingWip2(cards: Record<string, string>): Promise<TempRepo> {
    const repo = await repoWith(cards);
    const config: BoardConfig = {
      ...defaultBoardConfig(),
      columns: defaultBoardConfig().columns.map((c) => (c.id === 'doing' ? { ...c, wip: 2 } : c)),
    };
    await writeFile(join(repo.root, '.repoboard', 'board.yml'), serializeBoard(config));
    return repo;
  }

  it('2 plain cards fill doing (wip 2); moving a third plain in warns', async () => {
    const repo = await repoWithDoingWip2({
      'RB-1.md': cardText('RB-1', 'doing'),
      'RB-2.md': cardText('RB-2', 'doing'),
      'RB-3.md': cardText('RB-3', 'todo'),
    });
    const store = await open(repo, false);
    const res = await store.move('RB-3', 'doing', 't');
    expect(res.ok && res.warnings[0]).toMatch(/WIP limit exceeded/);
  });

  it('1 plain + 1 parent fill doing (wip 2); moving a plain in does not warn — the parent is excluded', async () => {
    const repo = await repoWithDoingWip2({
      'RB-1.md': cardText('RB-1', 'doing'), // plain
      'RB-2.md': cardText('RB-2', 'doing'), // a plan parent — RB-3 below names it
      'RB-3.md': cardText('RB-3', 'backlog').replace(
        'status: backlog\n',
        'status: backlog\nparent: RB-2\n',
      ),
      'RB-4.md': cardText('RB-4', 'todo'),
    });
    const store = await open(repo, false);
    const res = await store.move('RB-4', 'doing', 't');
    expect(res.ok && res.warnings).toEqual([]);
  });

  it('moving a plan parent itself into a full doing does not warn — it adds 0, so it cannot breach', async () => {
    const repo = await repoWithDoingWip2({
      'RB-1.md': cardText('RB-1', 'doing'),
      'RB-2.md': cardText('RB-2', 'doing'), // doing is already AT the wip 2 limit
      'RB-3.md': cardText('RB-3', 'todo'), // the parent being moved — RB-4 below names it
      'RB-4.md': cardText('RB-4', 'backlog').replace(
        'status: backlog\n',
        'status: backlog\nparent: RB-3\n',
      ),
    });
    const store = await open(repo, false);
    const res = await store.move('RB-3', 'doing', 't');
    expect(res.ok && res.warnings).toEqual([]);
  });
});

describe('ask and decide (P8.1)', () => {
  it('ask writes the file, moves into decide, appends both log lines, one events.jsonl row', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    const res = await store.ask(
      'RB-1',
      { question: 'Ship it?', options: [{ letter: 'A', text: 'yes' }] },
      'claude/agent',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.status).toBe('decide');
    expect(res.event).toMatchObject({ type: 'move', from: 'todo', to: 'decide' });
    const text = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('moved todo → decide');
    expect(text).toContain('asked: Ship it? [A]');
    expect(text).toContain('returnTo: todo');
    const log = await readFile(join(repo.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('decide writes the file, moves back to returnTo, and both surfaces read DECIDED', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'doing') });
    const store = await open(repo, false);
    const asked = await store.ask('RB-1', { question: 'Ship it?' }, 'claude/agent');
    if (!asked.ok) throw new Error(asked.error);
    const res = await store.decide('RB-1', { words: 'yes' }, 'human/matt');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.status).toBe('doing');
    expect(res.card.decision).toMatchObject({ words: 'yes', decidedBy: 'human/matt' });
    const text = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('decided — "yes"');
    expect(text).toContain('moved decide → doing');
  });

  it('unknown card, unknown letter, and nothing-open are ok:false with notFound honestly reported', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    expect(await store.ask('RB-99', { question: 'q' }, 't')).toMatchObject({
      ok: false,
      notFound: true,
    });
    expect(await store.decide('RB-1', { letter: 'A' }, 't')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no decision is open/),
    });
  });
});

describe('addNote (RCB-70)', () => {
  it('writes the ## Notes section, bumps updated, and emits a "note" event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    const res = await store.addNote('RB-1', 'ship it before RCB-68', 'owner');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.updated).toBe('2026-09-02T22:41:10Z');
    expect(res.event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'owner',
      type: 'note',
      cardId: 'RB-1',
      from: 'todo',
      to: 'todo',
    });
    const text = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(text).toContain('## Notes\n- 2026-09-02T22:41:10Z owner — ship it before RCB-68');
  });

  it('a "note" event line survives a store restart (EVENT_TYPES gates reread)', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const first = await open(repo, false);
    const res = await first.addNote('RB-1', 'keep this', 'owner');
    expect(res.ok).toBe(true);
    await first.close();

    const second = await open(repo, false);
    const events = second.events();
    expect(events.some((e) => e.type === 'note')).toBe(true);
  });
});

describe('leases and windows (P8.2)', () => {
  it('take writes leases.yml, one events.jsonl row, checkResource sees it', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(store.leases()).toEqual({ leases: [], windows: [] });
    const res = await store.takeLease({ resource: 'vitest-lock' }, 'claude/ops');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.leases).toEqual([
      { resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-02T22:41:10Z' },
    ]);
    const text = await readFile(join(repo.root, '.repoboard', 'leases.yml'), 'utf8');
    expect(text).toContain('resource: vitest-lock');
    expect(text).toContain('holder: claude/ops');
    const log = await readFile(join(repo.root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(log.trim())).toMatchObject({
      type: 'lease',
      cardId: null,
      resource: 'vitest-lock',
    });
    expect(store.checkResource('vitest-lock')).toEqual({
      clear: false,
      reasons: ['held by claude/ops until —'],
    });
    expect(store.checkResource('something-else')).toEqual({ clear: true });
  });

  it('a conflicting take is refused; release by the holder frees it', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const first = await store.takeLease({ resource: 'r' }, 'claude/ops');
    expect(first.ok).toBe(true);
    const conflict = await store.takeLease({ resource: 'r' }, 'claude/fix');
    expect(conflict).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is held by claude\/ops/),
    });
    const badRelease = await store.releaseLease({ resource: 'r' }, 'claude/fix');
    expect(badRelease).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is held by claude\/ops/),
    });
    const release = await store.releaseLease({ resource: 'r' }, 'claude/ops');
    expect(release.ok).toBe(true);
    if (!release.ok) return;
    expect(release.doc.leases).toEqual([]);
    expect(store.checkResource('r')).toEqual({ clear: true });
  });

  it('addWindow writes leases.yml and checkResource reflects it', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const res = await store.addWindow(
      {
        resource: 'vitest-lock',
        start: '2026-09-02T22:00:00Z',
        end: '2026-09-02T23:00:00Z',
        name: 'gate',
      },
      'claude/ops',
    );
    expect(res.ok).toBe(true);
    expect(store.checkResource('vitest-lock', NOW)).toEqual({
      clear: false,
      reasons: ['inside gate 2026-09-02T22:00:00Z–2026-09-02T23:00:00Z vitest-lock'],
    });
  });

  it('RCB-133: two stores on one root — B, loaded before A writes, still lands both leases', async () => {
    const repo = await repoWith({});
    // Two `CardStore`s on the SAME root, neither watching the other — the in-process stand-in
    // for "two CLI one-shots, or a CLI next to `serve`" the brief names: each loads its own
    // `leasesDoc` cache independently, and `mutate`/`enqueue` only ever serialize ONE store's
    // own writers against each other, never two different `CardStore` instances.
    const a = await open(repo, false);
    const b = await open(repo, false); // B's cache is loaded now — empty, before A writes "a"
    const resA = await a.takeLease({ resource: 'a' }, 'proc/a');
    expect(resA.ok).toBe(true);
    // B still computes from the cache it loaded before A's write — exactly the stale-copy race
    // RCB-133 describes. Only a lock around a FRESH re-read (not B's cache) can save "a" here.
    const resB = await b.takeLease({ resource: 'b' }, 'proc/b');
    expect(resB.ok).toBe(true);
    const onDisk = await readFile(join(repo.root, '.repoboard', 'leases.yml'), 'utf8');
    const parsed = parseLeases(onDisk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.leases.map((l) => l.resource).sort()).toEqual(['a', 'b']);
  });

  it('RCB-133: 20 rounds of concurrent STATE.md writes from two stores keep both, every round', async () => {
    const repo = await repoWith({});
    const a = await open(repo, false);
    const b = await open(repo, false);
    for (let round = 0; round < 20; round++) {
      const liveText = `round ${round} from A`;
      const seatText = `round ${round} from B`;
      const [resA, resB] = await Promise.all([
        a.setStateSection('live', liveText, 'proc/a'),
        // RCB-197: a seat per round — a second UP of one seat inside the window is now refused
        // by the store itself, and this test is about the two STATE.md writes, not the claim.
        b.setSeatBullet(`proc-b${round}`, 'UP', seatText),
      ]);
      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);
      const onDisk = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
      const parsed = parseState(onDisk);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.doc.sections.live).toBe(liveText);
      expect(parsed.doc.sections.seats).toContain(seatText);
    }
  });

  it('RCB-133: a malformed leases.yml refuses the write and leaves the bytes unchanged', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'leases.yml');
    const bad = 'leases: [\n';
    await writeFile(path, bad);
    const store = await open(repo, false);
    const res = await store.takeLease({ resource: 'r' }, 'proc/a');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not valid YAML/);
    const after = await readFile(path, 'utf8');
    expect(after).toBe(bad);
  });

  it('an external sed edit of leases.yml is re-read by the watcher', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'leases.yml');
    // The file must already EXIST before the watcher starts: chokidar's `add` event for a
    // brand-new file is measurably unreliable under concurrent watcher load in this sandbox
    // (reproduced independently of P8.2's own code — a plain `cards/*.md` create under 20
    // concurrent watchers times out the same way `card` events would; `change` on a pre-existing
    // file does not, at any concurrency tried). Every other "external edit" test here (K8, the
    // card watcher describe block) modifies a file the fixture already created, for the same
    // reason; this test now matches that pattern instead of being the one exception.
    await writeFile(path, 'leases: []\nwindows: []\n');
    const store = await open(repo, true);
    const leasesSeen = waitForEvent(store, 'leases', () => true);
    await writeFile(
      path,
      [
        'leases:',
        '  - resource: r',
        '    holder: cli/hand',
        '    since: 2026-09-02T22:00:00Z',
        '',
      ].join('\n'),
    );
    await leasesSeen;
    await sleep(20);
    expect(store.leases().leases).toEqual([
      { resource: 'r', holder: 'cli/hand', since: '2026-09-02T22:00:00Z' },
    ]);
  });

  it('map-only: reads (leases/checkResource) work, writes refuse', async () => {
    const repo = await makeTempRepoNoBoard({});
    const store = await open(repo, false);
    expect(store.leases()).toEqual({ leases: [], windows: [] });
    expect(store.checkResource('r')).toEqual({ clear: true });
    expect(await store.takeLease({ resource: 'r' }, 't')).toMatchObject({
      ok: false,
      readOnly: true,
      error: MAP_ONLY_ERROR,
    });
    // RCB-133: all three lease methods now share `mutateLeases`, which calls
    // `refuseWriteWithoutBoard()` itself, BEFORE ever taking the file lock or reading leases.yml
    // (map-only mode must never create `.repoboard/`, and a lock file is a write). So release
    // hits the SAME readOnly refusal take/addWindow do, not core's "no lease is held" — that
    // refusal never runs here because releaseLease's own core call is never reached.
    expect(await store.releaseLease({ resource: 'r' }, 't')).toMatchObject({
      ok: false,
      readOnly: true,
      error: MAP_ONLY_ERROR,
    });
    expect(
      await store.addWindow(
        { resource: 'r', start: '2026-09-02T22:00:00Z', end: '2026-09-02T23:00:00Z', name: 'g' },
        't',
      ),
    ).toMatchObject({ ok: false, readOnly: true });
  });
});

describe('state and log (P8.3)', () => {
  it('setStateSection scaffolds a fresh STATE.md when none exists, then restamps in place', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(store.state()).toBeNull();
    const res = await store.setStateSection('live', 'Tree is dev.', 'claude/p8-3');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.sections.live).toBe('Tree is dev.');
    expect(res.doc.stamp).toBe('2026-09-02T22:41:10Z');
    expect(res.doc.actor).toBe('claude/p8-3');
    expect(store.state()).toEqual(res.doc);
    const text = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    expect(text).toContain('Tree is dev.');
    // RCB-118: the ON-DISK file writes the FILE placeholder, not the DISPLAY one — a raw-file
    // reader must never mistake "not stored here" for "queue is empty".
    expect(text).toContain(
      '_(not stored in this file — generated from open decisions: run `repoboard state`)_',
    );

    const second = await store.setStateSection('seats', 'ops watching.', 'claude/ops', {
      force: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.doc.sections.live).toBe('Tree is dev.'); // untouched
    expect(second.doc.sections.seats).toBe('ops watching.');
  });

  it('an unknown/bad frontmatter-free STATE.md is refused with a named error', async () => {
    const repo = await repoWith({});
    await mkdir(join(repo.root, '.repoboard'), { recursive: true });
    await writeFile(join(repo.root, '.repoboard', 'STATE.md'), 'not a state file at all');
    const store = await open(repo, false);
    const res = await store.setStateSection('live', 'x', 'claude/p8-3');
    expect(res.ok).toBe(false);
  });

  it('appendRepoLog creates the header on the first call, appends after', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const repoTag = repoName(repo);
    const first = await store.appendRepoLog('claude/p8-3', 'first entry', 'kickoff');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.date).toBe('2026-09-02');
    expect(first.text).toBe(
      `# Log — 2026-09-02\n\n##### [${repoTag}] CLAUDE/P8-3 2026-09-02T22:41:10Z: kickoff\n\nfirst entry\n`,
    );
    const onDisk = await readFile(join(repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(onDisk).toBe(first.text);

    const second = await store.appendRepoLog('ops', 'second entry', undefined);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toContain(`##### [${repoTag}] CLAUDE/P8-3`);
    expect(second.text).toContain(`##### [${repoTag}] OPS 2026-09-02T22:41:10Z: second entry`);
    const log = await readFile(join(repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(log).toBe(second.text);
  });

  it('empty seat or text is refused', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(await store.appendRepoLog('  ', 'x', undefined)).toMatchObject({ ok: false });
    expect(await store.appendRepoLog('ops', '  ', undefined)).toMatchObject({ ok: false });
  });

  it('store.log() reads a specific date, defaults to today, null when absent', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(await store.log()).toBeNull();
    await store.appendRepoLog('ops', 'hello', undefined);
    const today = await store.log();
    expect(today?.date).toBe('2026-09-02');
    expect(today?.blocks).toHaveLength(1);
    expect(await store.log('2020-01-01')).toBeNull();
  });

  // RCB-62 (finding 2): `log()` merges `.repoboard/log/` with `board.yml`'s configured `logDir`,
  // same additional read-only source `loadAllLogInfo`/`lastRepoLogBlock` already read.
  describe('store.log(): merged with board.yml logDir (RCB-62)', () => {
    async function repoWithLogDir(): Promise<TempRepo> {
      const repo = await repoWith({});
      await writeFile(
        join(repo.root, '.repoboard', 'board.yml'),
        serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
      );
      return repo;
    }

    it('(e) a block only in the configured logDir is returned', async () => {
      const repo = await repoWithLogDir();
      const extraDir = join(repo.root, 'docs', 'log');
      await mkdir(extraDir, { recursive: true });
      await writeFile(
        join(extraDir, '2026-09-18.md'),
        '# Log — 2026-09-18\n\n##### OPS 2026-09-18 21:4xZ: hand-written\n\ntext\n',
      );
      const store = await open(repo, false);
      const log = await store.log('2026-09-18');
      expect(log?.date).toBe('2026-09-18');
      expect(log?.blocks).toHaveLength(1);
      expect(log?.blocks[0]?.seat).toBe('OPS');
      expect(log?.text).toContain('hand-written');
    });

    it('(f) both dirs present → both blocks, own dir first in `text`', async () => {
      const repo = await repoWithLogDir();
      const extraDir = join(repo.root, 'docs', 'log');
      await mkdir(extraDir, { recursive: true });
      await writeFile(
        join(extraDir, '2026-09-18.md'),
        '# Log — 2026-09-18\n\n##### OPS 2026-09-18 21:4xZ: hand-written\n\ntext\n',
      );
      const ownDir = join(repo.root, '.repoboard', 'log');
      await mkdir(ownDir, { recursive: true });
      await writeFile(
        join(ownDir, '2026-09-18.md'),
        '# Log — 2026-09-18\n\n##### BUILDER 2026-09-18T10:00:00Z: own entry\n\nfirst\n',
      );
      const store = await open(repo, false);
      const log = await store.log('2026-09-18');
      expect(log?.blocks).toHaveLength(2);
      expect(log?.blocks[0]?.seat).toBe('BUILDER'); // own dir first
      expect(log?.blocks[1]?.seat).toBe('OPS');
      const ownIdx = log?.text.indexOf('own entry') ?? -1;
      const extraIdx = log?.text.indexOf('hand-written') ?? -1;
      expect(ownIdx).toBeGreaterThanOrEqual(0);
      expect(extraIdx).toBeGreaterThan(ownIdx);
    });

    it('(g) no logDir configured → own dir text only, byte for byte as before', async () => {
      const repo = await repoWith({});
      const store = await open(repo, false);
      const res = await store.appendRepoLog('ops', 'hello', undefined);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const log = await store.log();
      expect(log?.text).toBe(res.text);
      expect(log?.blocks).toHaveLength(1);
    });

    it('(h) neither dir has the date → null', async () => {
      const repo = await repoWithLogDir();
      const store = await open(repo, false);
      expect(await store.log('2020-01-01')).toBeNull();
    });

    it('(i) RCB-71 A: appendRepoLog with logDir configured writes docs/log/<date>.md and NOT .repoboard/log/', async () => {
      const repo = await repoWithLogDir();
      const store = await open(repo, false);
      const res = await store.appendRepoLog('ops', 'hello', undefined);
      expect(res.ok).toBe(true);
      expect(existsSync(join(repo.root, 'docs', 'log', '2026-09-02.md'))).toBe(true);
      expect(existsSync(join(repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(false);
      const log = await store.log();
      expect(log?.blocks).toHaveLength(1); // no double read
    });

    it('(j) RCB-71 A: local layer + logDir → logDir wins', async () => {
      const repo = await repoWithLogDir();
      await mkdir(join(repo.root, '.repoboard', 'local'), { recursive: true });
      const store = await open(repo, false);
      const res = await store.appendRepoLog('ops', 'hello', undefined);
      expect(res.ok).toBe(true);
      expect(existsSync(join(repo.root, 'docs', 'log', '2026-09-02.md'))).toBe(true);
      expect(existsSync(join(repo.root, '.repoboard', 'local', 'log', '2026-09-02.md'))).toBe(
        false,
      );
    });
  });

  it('an external edit of STATE.md is re-read by the watcher', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'STATE.md');
    // Pre-existing file, then a `change` event — the same pattern P8.2's own §7 settled on for
    // leases.yml, because a brand-new file's chokidar `add` event is unreliable under concurrent
    // watcher load in this sandbox (not a P8.3 defect).
    await writeFile(
      path,
      '# STATE\n\n**Written 2026-09-02T00:00:00Z by hand.**\n\n## LIVE\n\nx\n\n## LAST LANDINGS\n\ny\n\n## OWNER QUEUE\n\n_(generated from open decisions)_\n\n## SEATS\n\nz\n',
    );
    const store = await open(repo, true);
    const seen = waitForEvent(store, 'state', () => true);
    await writeFile(
      path,
      '# STATE\n\n**Written 2026-09-02T12:00:00Z by hand.**\n\n## LIVE\n\nedited\n\n## LAST LANDINGS\n\ny\n\n## OWNER QUEUE\n\n_(generated from open decisions)_\n\n## SEATS\n\nz\n',
    );
    await seen;
    await sleep(20);
    expect(store.state()?.sections.live).toBe('edited');
  });

  it('an external edit of a log file is re-read by the watcher', async () => {
    const repo = await repoWith({});
    const logPath = join(repo.root, '.repoboard', 'log', '2026-09-02.md');
    await mkdir(join(repo.root, '.repoboard', 'log'), { recursive: true });
    await writeFile(logPath, '# Log — 2026-09-02\n\n');
    const store = await open(repo, true);
    const seen = waitForEvent<{ date: string; text: string }>(
      store,
      'log',
      (p) => p.date === '2026-09-02',
    );
    await writeFile(
      logPath,
      '# Log — 2026-09-02\n\n##### CLI/HAND 2026-09-02T18:00:00Z: hand edit\n\nfrom outside\n',
    );
    const payload = await seen;
    expect(payload.text).toContain('hand edit');
  });

  it('check aggregates findings from state, cards, leases; ok when clean', async () => {
    const repo = await repoWith({});
    // A mutable clock, not the fixed `NOW` the `open()` helper wires in: `stale-state` compares
    // the STATE stamp against a log file's real filesystem mtime (controlled below via `utimes`,
    // deterministic regardless of the actual wall-clock time this suite runs at), and the two
    // `setStateSection` calls below need to land on either side of it.
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    const clean = await store.check(false, []);
    expect(clean.findings).toEqual([]);
    expect(clean.exitCode).toBe(0);

    await store.setStateSection('live', 'first', 'claude/p8-3'); // stamp = NOW

    const logDir = join(repo.root, '.repoboard', 'log');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, '2026-09-02.md');
    // RCB-170: a headed log file is judged by its HEADERS alone (its mtime no longer counts), so
    // the block's own ts — not just the utimes below — must land strictly after the STATE stamp.
    const later = new Date(NOW.getTime() + 60_000);
    await writeFile(logPath, '# Log — 2026-09-02\n\n##### OPS 2026-09-02T22:42:10Z: x\n\ny\n');
    await utimes(logPath, later, later); // mtime strictly after the STATE stamp

    const stale = await store.check(false, []);
    expect(stale.findings.some((f) => f.kind === 'stale-state')).toBe(true);
    expect(stale.exitCode).toBe(1);

    clock = new Date(later.getTime() + 60_000); // now strictly after the log's mtime
    await store.setStateSection('live', 'second', 'claude/p8-3'); // restamp
    const fresh = await store.check(false, []);
    expect(fresh.findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('map-only: state()/log()/check() work as reads, writes refuse', async () => {
    const repo = await makeTempRepoNoBoard({});
    const store = await open(repo, false);
    expect(store.state()).toBeNull();
    expect(await store.log()).toBeNull();
    const check = await store.check(false, []);
    expect(check.exitCode).toBe(0);
    expect(await store.setStateSection('live', 'x', 't')).toMatchObject({
      ok: false,
      readOnly: true,
      error: MAP_ONLY_ERROR,
    });
    expect(await store.appendRepoLog('t', 'x', undefined)).toMatchObject({
      ok: false,
      readOnly: true,
      error: MAP_ONLY_ERROR,
    });
  });

  it('check: untracked-cards names only a fresh uncommitted card, with its creating actor (RCB-119)', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    await git(repo.root, 'init', '-q');
    await git(repo.root, 'add', '-A');
    await git(repo.root, 'commit', '-q', '-m', 'initial');

    const store = await open(repo, false);
    const created = await store.create({ title: 'new work' }, 'web');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const { findings } = await store.check(false, []);
    const finding = findings.find((f) => f.kind === 'untracked-cards');
    expect(finding).toEqual({
      kind: 'untracked-cards',
      level: 'warning',
      message: `untracked-cards: 1 card file(s) not in git — ${created.card.id} (web)`,
    });
  });

  it('check: a non-git dir gathers no untracked-cards finding — check() still works', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false);
    const { findings, exitCode } = await store.check(false, []);
    expect(findings.some((f) => f.kind === 'untracked-cards')).toBe(false);
    expect(exitCode).toBe(0);
  });
});

describe('setSeatBullet (RCB-58)', () => {
  const SEATS = [
    '- **coordinator**: routes work',
    '- **repoboard builder (its own terminal)**: on RCB-1',
    '- **ops**: watching things',
  ].join('\n');

  it("replaces ONLY the builder's own bullet, restamps as the seat, leaves LIVE/LAST LANDINGS untouched", async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const repoTag = repoName(repo);
    await store.setStateSection('live', 'Tree is dev.', 'claude/p8-3');
    await store.setStateSection('lastLandings', 'RCB-1 landed.', 'claude/p8-3');
    await store.setStateSection('seats', SEATS, 'coordinator', { force: true });
    const before = store.state();

    const res = await store.setSeatBullet('builder', 'UP', 'held: RCB-58');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // LIVE and LAST LANDINGS: byte-identical to before this write.
    expect(res.doc.sections.live).toBe(before?.sections.live);
    expect(res.doc.sections.lastLandings).toBe(before?.sections.lastLandings);
    expect(res.doc.sections.live).toBe('Tree is dev.');
    expect(res.doc.sections.lastLandings).toBe('RCB-1 landed.');

    // Stamp line: written by the seat name as typed.
    expect(res.doc.stamp).toBe('2026-09-02T22:41:10Z');
    expect(res.doc.actor).toBe('builder');

    // SEATS: the other two bullets untouched, byte for byte, plus the new one — automatically
    // carrying the board's own name (RCB-160) — in the builder's place.
    expect(res.doc.sections.seats).toBe(
      [
        '- **coordinator**: routes work',
        `- **[${repoTag}] builder: UP 2026-09-02 22:41Z.** held: RCB-58`,
        '- **ops**: watching things',
      ].join('\n'),
    );

    const onDisk = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    expect(onDisk).toContain('**Written 2026-09-02T22:41:10Z by builder.**');
    expect(onDisk).toContain('Tree is dev.');
    expect(onDisk).toContain('RCB-1 landed.');
    expect(onDisk).toContain(`- **[${repoTag}] builder: UP 2026-09-02 22:41Z.** held: RCB-58`);
    expect(onDisk).toContain('- **coordinator**: routes work');
    expect(onDisk).toContain('- **ops**: watching things');
  });

  it('a missing STATE.md is scaffolded first, then the bullet is appended (no bullet to replace yet)', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    const repoTag = repoName(repo);
    expect(store.state()).toBeNull();

    const res = await store.setSeatBullet('ops', 'DOWN', 'stood down for the night');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.sections.live).toBe('_(nothing recorded yet)_');
    expect(res.doc.sections.seats).toBe(
      `- **[${repoTag}] ops: DOWN 2026-09-02 22:41Z.** stood down for the night`,
    );
    expect(res.doc.actor).toBe('ops');

    const onDisk = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    expect(onDisk).toContain(
      `- **[${repoTag}] ops: DOWN 2026-09-02 22:41Z.** stood down for the night`,
    );
  });

  // RCB-58 Control B: skip the replace inside `store.setSeatBullet` (pass `parsed.doc.sections.seats`
  // unchanged to `setStateSectionCore` instead of the `replaceSeatBullet` result) — both tests above
  // must fail. See cli.test.ts for the CLI-facing half of this same control.
});

describe('updateSeatBullet (RCB-88)', () => {
  const SEATS = [
    '- **coordinator**: routes work',
    '- **repoboard builder (its own terminal)**: on RCB-1',
    '- **ops**: watching things',
  ].join('\n');

  it("(a) rewrites ONLY the builder bullet's body, keeps the standing stamp; STATE line 3 restamps as builder; every other bullet byte-identical", async () => {
    const repo = await repoWith({});
    const repoTag = repoName(repo);
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    await store.setStateSection('seats', SEATS, 'coordinator', { force: true });
    const up = await store.setSeatBullet('builder', 'UP', 'a');
    expect(up.ok).toBe(true);

    clock = new Date(NOW.getTime() + 5 * 60_000);
    const res = await store.updateSeatBullet('builder', 'b');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.status).toBe('UP');
    expect(res.stamp).toBe('2026-09-02 22:41Z');
    expect(res.doc.sections.seats).toBe(
      [
        '- **coordinator**: routes work',
        `- **[${repoTag}] builder: UP 2026-09-02 22:41Z.** b`,
        '- **ops**: watching things',
      ].join('\n'),
    );
    // STATE.md's own line-3 stamp restamps to the +5 clock, actor builder — every other write does.
    expect(res.doc.stamp).toBe('2026-09-02T22:46:10Z');
    expect(res.doc.actor).toBe('builder');

    const onDisk = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    expect(onDisk).toContain('**Written 2026-09-02T22:46:10Z by builder.**');
    expect(onDisk).toContain(`- **[${repoTag}] builder: UP 2026-09-02 22:41Z.** b`);
    expect(onDisk).toContain('- **coordinator**: routes work');
    expect(onDisk).toContain('- **ops**: watching things');
  });

  it('(b) no builder bullet: ok false, error matches /no standing bullet/, STATE.md unchanged', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    // SEATS has coordinator/builder/ops bullets but none for "qa" — findSeatLine finds nothing.
    await store.setStateSection('seats', SEATS, 'coordinator', { force: true });
    const before = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');

    const res = await store.updateSeatBullet('qa', 'b');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no standing bullet/);

    const after = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('(c) no STATE.md: ok false, and the file still does not exist', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(false);

    const res = await store.updateSeatBullet('builder', 'b');
    expect(res.ok).toBe(false);

    expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(false);
  });

  // RCB-88 control: in `store.updateSeatBullet`, swap the rewrite for
  // `formatSeatBullet(name, 'UP', text, now)` (so it restamps) — test (a) must fail on the stamp.
  // See cli.test.ts for the CLI-facing half of this same control.
});

describe('appendSeatLog (RCB-127): log --as <seat> restamps STATE.md when that seat is UP', () => {
  it('an UP seat: restamped true, and check has no stale-state once the log mtime is pinned to the same clock', async () => {
    const repo = await repoWith({});
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    await store.setSeatBullet('builder', 'UP', 'holding RCB-127'); // stamps STATE at NOW
    clock = new Date(NOW.getTime() + 5 * 60_000);

    const res = await store.appendSeatLog('builder', 'mid-session update', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(true);
    expect(store.state()?.stamp).toBe('2026-09-02T22:46:10Z');
    expect(store.state()?.actor).toBe('builder');

    // Pin the log file's mtime to the SAME clock reading the append+restamp just used — real
    // filesystem mtimes otherwise reflect wall-clock "now", not this mocked one (same technique
    // `check aggregates findings` above and cli.test.ts's `seat --up` test use).
    const logPath = join(repo.root, '.repoboard', 'log', '2026-09-02.md');
    await utimes(logPath, clock, clock);

    const result = await store.check(false, []);
    expect(result.findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('a DOWN seat: restamped false, and check is stale-state (the old stamp predates the log)', async () => {
    const repo = await repoWith({});
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    await store.setSeatBullet('ops', 'DOWN', 'stood down for the night'); // stamps STATE at NOW
    clock = new Date(NOW.getTime() + 5 * 60_000);

    const res = await store.appendSeatLog('ops', 'mid-session note', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(false);
    expect(store.state()?.stamp).toBe('2026-09-02T22:41:10Z'); // unchanged — still NOW

    const logPath = join(repo.root, '.repoboard', 'log', '2026-09-02.md');
    await utimes(logPath, clock, clock); // strictly after the (unmoved) STATE stamp

    const result = await store.check(false, []);
    expect(result.findings.some((f) => f.kind === 'stale-state')).toBe(true);
  });

  it('a seat with no SEATS bullet at all: restamped false, and check is stale-state', async () => {
    const repo = await repoWith({});
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    await store.setStateSection('live', 'x', 'coordinator'); // STATE.md exists, but no bullet for "ghost"
    clock = new Date(NOW.getTime() + 5 * 60_000);

    const res = await store.appendSeatLog('ghost', 'mid-session note', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(false);

    const logPath = join(repo.root, '.repoboard', 'log', '2026-09-02.md');
    await utimes(logPath, clock, clock);

    const result = await store.check(false, []);
    expect(result.findings.some((f) => f.kind === 'stale-state')).toBe(true);
  });

  it('no STATE.md at all: restamped false, the log append still succeeds, and no file is scaffolded', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false);
    expect(store.state()).toBeNull();

    const res = await store.appendSeatLog('ghost', 'mid-session note', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(false);
    expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(false);
  });

  it("every STATE.md byte outside line 3 (the stamp) is unchanged — including the builder's own SEATS bullet", async () => {
    const repo = await repoWith({});
    const repoTag = repoName(repo);
    let clock = NOW;
    const store = await openStore(repo.root, { watch: false, now: () => clock });
    opened.push(store);

    await store.setStateSection('live', 'Tree is dev.', 'coordinator');
    await store.setStateSection('lastLandings', 'RCB-1 landed.', 'coordinator');
    await store.setSeatBullet('builder', 'UP', 'holding RCB-127'); // stamps STATE at NOW
    const before = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');

    clock = new Date(NOW.getTime() + 5 * 60_000);
    const res = await store.appendSeatLog('builder', 'mid-session update', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restamped).toBe(true);

    const after = await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    for (let i = 0; i < beforeLines.length; i++) {
      if (i === 2) continue; // "**Written <ISO> by <actor>.**" — the one line that restamps
      expect(afterLines[i]).toBe(beforeLines[i]);
    }
    expect(afterLines[2]).not.toBe(beforeLines[2]);
    expect(after).toContain('**Written 2026-09-02T22:46:10Z by builder.**');
    expect(after).toContain(`- **[${repoTag}] builder: UP 2026-09-02 22:41Z.** holding RCB-127`); // builder's own bullet, byte-identical
  });

  // RCB-127 control: in `appendSeatLog`'s restamp step, drop the
  // `parseSeatStamp(line)?.status !== 'UP'` check (always restamp when a bullet is found) — the
  // DOWN-seat test above must fail (`restamped` flips to `true`, and its stale-state assertion
  // fails once the restamp fixes the stamp too). See cli.test.ts for the CLI-facing half.
});

describe('RCB-171: a checkout whose gitignored local layer is missing (git worktree / fresh clone)', () => {
  // The hazard: the root `.gitignore` says `.repoboard/local/` is private, but that directory is
  // absent here, so a write that CREATES STATE.md / the log directory would put private state into
  // TRACKED paths. Everywhere else the store scaffolds on first write, exactly as before.
  const IGNORES_LOCAL = 'node_modules\n.repoboard/local/\n';

  /** A bare board; `gitignore` (when not null) is written to the ROOT `.gitignore`. */
  async function checkout(gitignore: string | null): Promise<TempRepo> {
    const repo = await repoWith({});
    if (gitignore !== null) await writeFile(join(repo.root, '.gitignore'), gitignore);
    return repo;
  }
  const repoboardEntries = async (repo: TempRepo): Promise<string[]> =>
    (await readdir(join(repo.root, '.repoboard'))).sort();

  // PERTURBATION (seat runs it): make `refuseCreateWithoutPrivateLayer` return without throwing
  // (or `gitignoreExpectsLocalLayer` return false) — `ok` flips to true and STATE.md appears, so
  // this test fails. Direction feared: a worktree quietly grows a tracked STATE.md.
  it('setStateSection is REFUSED naming the missing .repoboard/local/, worktree/fresh clone and `repoboard local init`; nothing is created', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    const store = await open(repo, false);
    const res = await store.setStateSection('live', 'x', 'claude/p8-3');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.readOnly).toBeUndefined();
    expect(res.error).toContain('.repoboard/local/ is missing');
    expect(res.error).toContain('worktree or a fresh clone');
    expect(res.error).toContain('repoboard local init');
    expect(res.error).toContain('main checkout');
    expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(false);
    expect(await repoboardEntries(repo)).toEqual(['board.yml', 'cards']); // lock file released too
    expect(store.state()).toBeNull();
  });

  // PERTURBATION: as above, but in the `writeState` guard only (the `setSeatBullet` path shares it).
  it('setSeatBullet is REFUSED the same way; nothing is created', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    const store = await open(repo, false);
    const res = await store.setSeatBullet('ops', 'DOWN', 'stood down');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('.repoboard/local/ is missing');
    expect(await repoboardEntries(repo)).toEqual(['board.yml', 'cards']);
  });

  // PERTURBATION: remove the guard call in `writeLog` (keep the mkdir) — `ok` flips to true and
  // `.repoboard/log/` appears, so this test fails.
  it('appendRepoLog / appendSeatLog are REFUSED (the log directory would be created); nothing is created', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    const store = await open(repo, false);
    const res = await store.appendRepoLog('ops', 'hello', undefined);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('.repoboard/local/ is missing');
    expect(res.error).toContain('.repoboard/log/');
    const seatRes = await store.appendSeatLog('ops', 'hello', undefined);
    expect(seatRes.ok).toBe(false);
    expect(await repoboardEntries(repo)).toEqual(['board.yml', 'cards']);
  });

  // PERTURBATION (the OPPOSITE direction — over-refusing): delete the
  // `if (await isDirectory(localDir(this.root))) return;` line in `refuseCreateWithoutPrivateLayer`
  // — the same gitignore line then refuses even with the local layer present, and this test fails.
  it('the SAME repo with .repoboard/local/ present writes as usual — STATE into local/, the log into .repoboard/log/', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    await mkdir(join(repo.root, '.repoboard', 'local'), { recursive: true });
    const store = await open(repo, false);
    const res = await store.setStateSection('live', 'x', 'claude/p8-3');
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo.root, '.repoboard', 'local', 'STATE.md'))).toBe(true);
    expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(false);
    const logRes = await store.appendRepoLog('ops', 'hello', undefined);
    expect(logRes.ok).toBe(true);
    expect(existsSync(join(repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(true);
  });

  // PERTURBATION (the control that the rule is inert when unconfigured): drop the
  // `gitignoreExpectsLocalLayer()` condition so a missing local dir alone refuses (the blanket
  // guard) — every scaffold below fails. Also: widen LOCAL_LAYER_GITIGNORE_LINE to a substring
  // match — the near-miss `.gitignore` bodies (comment, negation, `.repoboard/localcache`) fail.
  it('no gitignore line for the local layer (no .gitignore, or only near-misses): scaffolds STATE.md and the log dir as before', async () => {
    const bodies: Array<string | null> = [
      null, // no .gitignore at all
      'node_modules\ndist\n',
      '# .repoboard/local/\n',
      '!.repoboard/local/\n',
      '.repoboard/localcache/\n',
      'docs/.repoboard/local/\n',
    ];
    for (const body of bodies) {
      const repo = await checkout(body);
      const store = await open(repo, false);
      const res = await store.setStateSection('live', 'x', 'claude/p8-3');
      expect(res.ok, `gitignore ${JSON.stringify(body)}`).toBe(true);
      expect(existsSync(join(repo.root, '.repoboard', 'STATE.md'))).toBe(true);
      const logRes = await store.appendRepoLog('ops', 'hello', undefined);
      expect(logRes.ok, `gitignore ${JSON.stringify(body)}`).toBe(true);
      expect(existsSync(join(repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(true);
    }
  });

  // PERTURBATION: narrow LOCAL_LAYER_GITIGNORE_LINE to the exact `.repoboard/local/` — the other
  // spellings stop refusing and this test fails.
  it('every spelling of the ignore line refuses: .repoboard/local, .repoboard/local/, /.repoboard/local/, /.repoboard/local, CRLF, padding', async () => {
    for (const body of [
      '.repoboard/local\n',
      '.repoboard/local/\n',
      '/.repoboard/local/\n',
      '/.repoboard/local\n',
      'node_modules\r\n.repoboard/local/\r\n',
      '  .repoboard/local/  \n',
    ]) {
      const repo = await checkout(body);
      const store = await open(repo, false);
      const res = await store.appendRepoLog('ops', 'hello', undefined);
      expect(res.ok, `gitignore ${JSON.stringify(body)}`).toBe(false);
      expect(existsSync(join(repo.root, '.repoboard', 'log'))).toBe(false);
    }
  });

  // PERTURBATION: hoist the guard above the `exists(this.statePath)` / `isDirectory(this.logDir)`
  // checks (refuse regardless of what is already there) — this test fails: a board that TRACKS its
  // STATE.md and log dir on purpose (acme) would be locked out of writing.
  it('an EXISTING top-level STATE.md and log directory are still written in a checkout with the ignore line and no local layer', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    await writeFile(
      join(repo.root, '.repoboard', 'STATE.md'),
      initialStateText({ now: NOW, actor: 'repoboard init' }),
    );
    await mkdir(join(repo.root, '.repoboard', 'log'), { recursive: true });
    const store = await open(repo, false);
    const res = await store.setStateSection('live', 'tracked on purpose', 'claude/p8-3');
    expect(res.ok).toBe(true);
    const seat = await store.setSeatBullet('builder', 'UP', 'holding RCB-171');
    expect(seat.ok).toBe(true);
    const logRes = await store.appendRepoLog('ops', 'hello', undefined);
    expect(logRes.ok).toBe(true);
    expect(existsSync(join(repo.root, '.repoboard', 'log', '2026-09-02.md'))).toBe(true);
    expect(await readFile(join(repo.root, '.repoboard', 'STATE.md'), 'utf8')).toContain(
      'tracked on purpose',
    );
  });

  // PERTURBATION: drop the `!this.cfg.logDir &&` half of the `writeLog` condition — the configured
  // `docs/log` is refused instead of created, and this test fails.
  it('a configured board.yml logDir is the owner’s named directory: created as before, whatever .gitignore says', async () => {
    const repo = await checkout(IGNORES_LOCAL);
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );
    const store = await open(repo, false);
    const res = await store.appendRepoLog('ops', 'hello', undefined);
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo.root, 'docs', 'log', '2026-09-02.md'))).toBe(true);
  });
});

// ---- RCB-34/P7.3: the column set is editable from the app (plan §11 O6) ---------------------
describe('setColumns (RCB-34/P7.3)', () => {
  const NEXT_COLUMNS = [
    { id: 'backlog', title: 'Backlog' },
    { id: 'doing', title: 'Doing', active: true, wip: 2 },
  ];

  async function boardWithExtras() {
    const repo = await repoWith({});
    const config: BoardConfig = {
      ...defaultBoardConfig(),
      name: 'MyBoard',
      logDir: 'docs/log',
      prefix: 'ZZ',
      extraKey: 1,
    };
    await writeFile(join(repo.root, '.repoboard', 'board.yml'), serializeBoard(config));
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    return { repo, store };
  }

  it('rewrites board.yml with the new columns and keeps every other key', async () => {
    const { repo, store } = await boardWithExtras();
    const res = await store.setColumns(NEXT_COLUMNS, 'claude/rcb-34');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.columns).toEqual(NEXT_COLUMNS);
    expect(store.config.columns).toEqual(NEXT_COLUMNS);

    const text = await readFile(join(repo.root, '.repoboard', 'board.yml'), 'utf8');
    const parsed = parseBoard(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.columns).toEqual(NEXT_COLUMNS);
    expect(parsed.config.name).toBe('MyBoard');
    expect(parsed.config.logDir).toBe('docs/log');
    expect(parsed.config.prefix).toBe('ZZ');
    expect(parsed.config.extraKey).toBe(1);
  });

  it('an empty list is refused with "at least one column"; the file is untouched', async () => {
    const { repo, store } = await boardWithExtras();
    const before = await readFile(join(repo.root, '.repoboard', 'board.yml'), 'utf8');
    const res = await store.setColumns([], 'claude/rcb-34');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('at least one column');
    const after = await readFile(join(repo.root, '.repoboard', 'board.yml'), 'utf8');
    expect(after).toBe(before);
  });

  it('a duplicate column id is refused; the file is untouched', async () => {
    const { repo, store } = await boardWithExtras();
    const before = await readFile(join(repo.root, '.repoboard', 'board.yml'), 'utf8');
    const res = await store.setColumns([{ id: 'x' }, { id: 'x' }], 'claude/rcb-34');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('duplicate column id "x"');
    const after = await readFile(join(repo.root, '.repoboard', 'board.yml'), 'utf8');
    expect(after).toBe(before);
  });

  it('map-only root: MapOnlyError / readOnly, and .repoboard/ stays absent', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    repos.push(repo);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    const res = await store.setColumns(NEXT_COLUMNS, 'claude/rcb-34');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.readOnly).toBe(true);
    expect(res.error).toBe(MAP_ONLY_ERROR);
    expect(await repo.hasRepoboard()).toBe(false);
  });

  it('cards in a removed column stay on disk untouched and still listed', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'doing') });
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    const before = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    // Drops 'doing' from the column set entirely.
    const res = await store.setColumns([{ id: 'backlog', title: 'Backlog' }], 'claude/rcb-34');
    expect(res.ok).toBe(true);
    const after = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(after).toBe(before);
    expect(store.get('RB-1')?.status).toBe('doing');
    expect(store.list().map((c) => c.id)).toEqual(['RB-1']);
  });

  it('emits exactly one "config" per write, even with the watcher on (measured)', async () => {
    const repo = await repoWith({});
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    opened.push(store);
    const seen: BoardConfig[] = [];
    store.on('config', (c) => seen.push(c));
    const res = await store.setColumns(NEXT_COLUMNS, 'claude/rcb-34');
    expect(res.ok).toBe(true);
    // Give the watcher time to notice the rename and NOT re-emit (awaitWriteFinish is 100ms;
    // same margin the "does not synthesise a file event for its own write" test above uses).
    await sleep(600);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.columns).toEqual(NEXT_COLUMNS);
  });

  // RCB-56: `setColumns` appends exactly one `columns` event through `appendEvent`.
  it('appends one "columns" event with from/to the previous/new column ids, comma-joined', async () => {
    const { store } = await boardWithExtras();
    const before = store.events().length;
    const res = await store.setColumns(NEXT_COLUMNS, 'claude/rcb-56');
    expect(res.ok).toBe(true);
    const events = store.events();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor: 'claude/rcb-56',
      type: 'columns',
      cardId: null,
      from: defaultBoardConfig()
        .columns.map((c) => c.id)
        .join(','),
      to: 'backlog,doing',
    });
  });

  it('a "columns" event line survives a store restart (RCB-38’s lesson: EVENT_TYPES gates reread)', async () => {
    const repo = await repoWith({});
    const first = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(first);
    const res = await first.setColumns(NEXT_COLUMNS, 'claude/rcb-56');
    expect(res.ok).toBe(true);
    await first.close();

    // A fresh store re-reads events.jsonl from disk (`load()` -> `loadEvents(true)`), which runs
    // every line through the `EVENT_TYPES` filter — the exact reread path RCB-38's comment warns
    // about (a type missing there is silently dropped, not merely delayed).
    const second = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(second);
    const events = second.events();
    expect(events.at(-1)).toMatchObject({
      type: 'columns',
      actor: 'claude/rcb-56',
      to: 'backlog,doing',
    });
  });
});

// ---- P8.6 `logDir`: `check` reads an extra daily-log directory ------------------------------
// (a member board's STATE-convergence brief, locked decision 1 / control C2.)
describe('check: board.yml logDir (P8.6, C2)', () => {
  it('a fresh entry in the configured logDir is seen as stale-state; removing logDir hides it', async () => {
    const repo = await repoWith({});
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );

    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    await store.setStateSection('live', 'first', 'claude/p8-6'); // STATE stamp = NOW

    // A member's own daily log lives outside .repoboard/, headed like its real blocks — the `ts` is
    // not ISO, so `newestMomentOf` falls back to the file's mtime, set strictly after the stamp.
    const extraLogDir = join(repo.root, 'docs', 'log');
    await mkdir(extraLogDir, { recursive: true });
    const extraLogPath = join(extraLogDir, '2026-09-18.md');
    await writeFile(
      extraLogPath,
      '# Log — 2026-09-18\n\n##### BUILDER 2026-09-18 09:2xZ: p8-6-logdir under way\n\ntext\n',
    );
    const later = new Date(NOW.getTime() + 60_000);
    await utimes(extraLogPath, later, later); // mtime strictly after the STATE stamp
    expect((await stat(extraLogPath)).mtimeMs).toBeGreaterThan(NOW.getTime());

    // Assertion 1: with logDir configured, the extra directory's newer entry is seen — stale-state fires.
    const withLogDir = await store.check(false, []);
    expect(withLogDir.findings.some((f) => f.kind === 'stale-state')).toBe(true);
    expect(withLogDir.exitCode).toBe(1);

    // Same repo, same files on disk, logDir removed from board.yml: a NEW store (config is read
    // once at open, like every other board.yml key) must not see docs/log/ at all.
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard(defaultBoardConfig()),
    );
    const storeNoLogDir = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(storeNoLogDir);

    // Assertion 2: with logDir unset, .repoboard/log/ is empty and docs/log/ is ignored — no
    // logs at all, so stale-state cannot fire. This is the proof the config is READ, not that
    // the directory merely exists.
    const withoutLogDir = await storeNoLogDir.check(false, []);
    expect(withoutLogDir.findings.some((f) => f.kind === 'stale-state')).toBe(false);
    expect(withoutLogDir.exitCode).toBe(0);
  });
});

// ---- RCB-54: `lastRepoLogBlock` (and therefore `log --last` / `seat`) must agree with `check`
// on what "the log" is — it now also reads the configured `logDir`, not just `.repoboard/log/`.
describe('lastRepoLogBlock: board.yml logDir (RCB-54)', () => {
  it('finds a block that exists only in the configured logDir; removing logDir makes it null', async () => {
    const repo = await repoWith({});
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );
    const extraLogDir = join(repo.root, 'docs', 'log');
    await mkdir(extraLogDir, { recursive: true });
    // The SPACE shape (a real member heading shape, RCB-54 cause 2) — proves the regex fix and the
    // logDir read are BOTH needed: the old regex alone would still find nothing here.
    await writeFile(
      join(extraLogDir, '2026-09-18.md'),
      '# Log — 2026-09-18\n\n##### OPS 2026-09-18 21:4xZ: hand-written by the sibling\n\ntext\n',
    );

    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    const found = await store.lastRepoLogBlock('ops');
    expect(found?.date).toBe('2026-09-18');
    expect(found?.block.seat).toBe('OPS');
    expect(found?.block.ts).toBe('2026-09-18 21:4xZ');
    expect(found?.block.title).toBe('hand-written by the sibling');

    // Same repo, same files on disk, logDir removed from board.yml (config read once at open,
    // like every other board.yml key): a NEW store must not see docs/log/ at all.
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard(defaultBoardConfig()),
    );
    const storeNoLogDir = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(storeNoLogDir);
    expect(await storeNoLogDir.lastRepoLogBlock('ops')).toBeNull();
  });

  it('same date in both dirs: the own-dir file wins because it is EARLIER in file-list order, not because it is newer', async () => {
    const repo = await repoWith({});
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );

    // Own dir: an OLDER-looking block (earlier ts), written first (file-list order: own before
    // extra — `loadAllLogInfo` returns `[...own, ...extra]`).
    const ownLogDir = join(repo.root, '.repoboard', 'log');
    await mkdir(ownLogDir, { recursive: true });
    await writeFile(
      join(ownLogDir, '2026-09-18.md'),
      '# Log — 2026-09-18\n\n##### OPS 2026-09-18T10:00:00Z: own dir, earlier ts\n\ntext\n',
    );

    // Extra dir (configured logDir): a NEWER-looking block, same date file.
    const extraLogDir = join(repo.root, 'docs', 'log');
    await mkdir(extraLogDir, { recursive: true });
    await writeFile(
      join(extraLogDir, '2026-09-18.md'),
      '# Log — 2026-09-18\n\n##### OPS 2026-09-18T23:00:00Z: extra dir, later ts\n\ntext\n',
    );

    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    opened.push(store);
    const found = await store.lastRepoLogBlock('ops');
    // If this were "newest wins" by ts, the extra-dir block (23:00Z) would win. It does not:
    // `lastBlockFor` takes the LAST match within the first `days` entry for a given date, and
    // for a tied date the own-dir entry comes first in `loadAllLogInfo`'s file-list order.
    expect(found?.block.title).toBe('own dir, earlier ts');
    expect(found?.block.ts).toBe('2026-09-18T10:00:00Z');
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

  // K11: pre-creates RB-2 in the fixture and starts with a `change`, not an `add` — a brand-new
  // file's chokidar `add` event is measurably unreliable under concurrent watcher load in this
  // sandbox (P8.2 §7, the same pattern as the leases.yml and STATE.md watcher tests above; not a
  // product defect). The `add` path itself still has a test: 'a second process running `card add`
  // emits one event, not two' (≈line 739) creates its card AFTER the watcher starts.
  it('sees a changed file, a file that turns invalid, and a removed file', async () => {
    const repo = await repoWith({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo'),
    });
    const store = await open(repo, true);

    const changed = waitForEvent<Card>(store, 'card', (c) => c.id === 'RB-2');
    await writeFile(join(repo.cardsDir, 'RB-2.md'), cardText('RB-2', 'review'));
    expect((await changed).status).toBe('review');
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

  // RCB-64: events.jsonl is pre-created (empty) BEFORE the watcher starts, so the append below
  // is a `change`, not an `add` — the same K11 fix as the card test below: a brand-new file's
  // chokidar `add` is unreliable under full-suite load (2 of 3 full runs missed it at the RCB-58
  // gate, 8/8 green alone). What the product does with an append is unchanged and still tested.
  it('emits events appended to events.jsonl by another process', async () => {
    const repo = await repoWith({});
    await writeFile(join(repo.root, '.repoboard', 'events.jsonl'), '');
    const store = await open(repo, true);
    expect(store.events()).toEqual([]);
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
    // RCB-157: listen BEFORE the trigger — an awaited write can resolve after the store emitted.
    const cardSeen = waitForEvent<Card>(watching, 'card', (c) => c.status === 'doing');
    const res = await cli.move('RB-1', 'doing', 'claude/cli');
    expect(res.ok).toBe(true);

    await cardSeen;
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
    const cardSeen = waitForEvent<Card>(watching, 'card', (c) => c.id === 'RB-1');
    expect(created(await cli.create({ title: 'From the CLI' }, 'claude/cli')).id).toBe('RB-1');

    await cardSeen;
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['claude/cli:create']);
  });

  // RCB-56: `setColumns` funnels through the same `appendEvent` as every other mutation — one
  // call, one line in events.jsonl, one "event" emission on a watching store, never two.
  it('a second process running `columns set` emits one event, not two', async () => {
    const repo = await repoWith({});
    const watching = await open(repo, true);
    const events: StoreEvent[] = [];
    watching.on('event', (e) => events.push(e));

    const cli = await open(repo, false);
    const configSeen = waitForEvent<BoardConfig>(watching, 'config', (c) => c.columns.length === 2);
    const res = await cli.setColumns(
      [
        { id: 'backlog', title: 'Backlog' },
        { id: 'doing', title: 'Doing', active: true, wip: 2 },
      ],
      'claude/cli',
    );
    expect(res.ok).toBe(true);

    await configSeen;
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['claude/cli:columns']);
  });

  it('a hand edit of status alone still yields exactly one file event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    expect(original).toContain('updated: 2026-09-02T22:00:00Z');
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await cardSeen;
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
    const cardSeen = waitForEvent<Card>(watching, 'card', (c) => c.status === 'doing');
    expect((await cli.move('RB-1', 'doing', 'claude/cli')).ok).toBe(true);
    await cardSeen;
    await settle();

    // The log now holds an event whose (cardId, ts) equals this card's (id, updated).
    const path = join(repo.cardsDir, 'RB-1.md');
    const afterMove = await readFile(path, 'utf8');
    expect(afterMove).toContain('updated: 2026-09-02T22:41:10Z');

    const events: StoreEvent[] = [];
    watching.on('event', (e) => events.push(e));
    const reviewSeen = waitForEvent<Card>(watching, 'card', (c) => c.status === 'review');
    await writeFile(path, afterMove.replace('status: doing', 'status: review'));

    await reviewSeen;
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
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    // RCB-115: `updated` moved and no claim ever follows, so this now clears the store's default
    // `claimGraceMs` (1000ms) before the synthetic event lands — `settle()`'s 700ms is no longer
    // enough. Wait for the event itself instead of a fixed sleep.
    const eventSeen = waitForEvent<StoreEvent>(store, 'event', (e) => e.type === 'move');
    await writeFile(
      path,
      original
        .replace('status: todo', 'status: doing')
        .replace('updated: 2026-09-02T22:00:00Z', 'updated: 2026-09-02T23:15:00Z'),
    );

    await cardSeen;
    await eventSeen;
    await settle();

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);
  });

  // RCB-115 (K8 double event under a slow writer): a writer's card-file write and its
  // events.jsonl claim are two separate writes. `claimGraceMs` gives the claim time to land
  // before the watcher synthesises its own `file` event — a scratch "slow writer" below does the
  // card-file half by hand and appends the matching claim itself, after a delay (or never).
  describe('claimGraceMs (RCB-115)', () => {
    /**
     * Hand-edits `id`'s status (bumping `updated` too, the real-writer shape), then — unless
     * `claimDelayMs` is `undefined` (no claim ever) — sleeps `claimDelayMs` and appends the
     * matching claim line to events.jsonl itself, exactly what a slow real writer would do.
     */
    async function slowWriterMove(
      repo: TempRepo,
      id: string,
      from: string,
      to: string,
      updated: string,
      claimDelayMs: number | undefined,
    ): Promise<void> {
      const path = join(repo.cardsDir, `${id}.md`);
      const original = await readFile(path, 'utf8');
      // A regex against whatever `updated:` currently holds, not a hardcoded default — this
      // helper is also used to chain a second hand edit onto a card a first edit already moved
      // (test (e)), where `updated` is no longer the fixture's original value.
      await writeFile(
        path,
        original
          .replace(`status: ${from}`, `status: ${to}`)
          .replace(/^updated: .+$/m, `updated: ${updated}`),
      );
      if (claimDelayMs === undefined) return;
      await sleep(claimDelayMs);
      const claim: StoreEvent = {
        ts: updated,
        actor: 'claude/cli',
        type: 'move',
        cardId: id,
        from,
        to,
      };
      await appendFile(join(repo.root, '.repoboard', 'events.jsonl'), `${JSON.stringify(claim)}\n`);
    }

    it('(a) default grace: a claim landing 400ms late is absorbed — one event, not two', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await open(repo, true); // default claimGraceMs (1000ms)
      const events: StoreEvent[] = [];
      store.on('event', (e) => events.push(e));

      const eventSeen = waitForEvent<StoreEvent>(store, 'event', (e) => e.actor === 'claude/cli');
      await slowWriterMove(repo, 'RB-1', 'todo', 'doing', '2026-09-02T22:50:00Z', 400);

      await eventSeen;
      // Past the default grace window (from roughly when the card change was delivered), so any
      // synthesis the grace timer would still do has already run.
      await sleep(900);

      expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['claude/cli:move']);
    });

    it('(a) claimGraceMs: 0 is the control — reproduces the old race, two events', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await openStore(repo.root, { watch: true, now: () => NOW, claimGraceMs: 0 });
      opened.push(store);
      const events: StoreEvent[] = [];
      store.on('event', (e) => events.push(e));

      await slowWriterMove(repo, 'RB-1', 'todo', 'doing', '2026-09-02T22:50:00Z', 400);
      // The `file` event fires DURING slowWriterMove's 400 ms wait, so a waitForEvent registered
      // after it would miss it; the collector above was attached before the edit.
      await settle();

      expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move', 'claude/cli:move']);
    });

    it('(b) claimGraceMs: 300, no claim ever arrives: exactly one file:move after the grace window', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await openStore(repo.root, { watch: true, now: () => NOW, claimGraceMs: 300 });
      opened.push(store);
      const events: StoreEvent[] = [];
      store.on('event', (e) => events.push(e));

      const eventSeen = waitForEvent<StoreEvent>(store, 'event', (e) => e.type === 'move');
      await slowWriterMove(repo, 'RB-1', 'todo', 'doing', '2026-09-02T22:50:00Z', undefined);

      const event = await eventSeen;
      expect(`${event.actor}:${event.type}`).toBe('file:move');
      // No second event ever follows for this card.
      await sleep(300);
      expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);
    });

    it('(c) claimGraceMs: 5000 does not slow a hand edit that leaves updated unchanged (§0.3)', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await openStore(repo.root, { watch: true, now: () => NOW, claimGraceMs: 5000 });
      opened.push(store);
      const path = join(repo.cardsDir, 'RB-1.md');
      const original = await readFile(path, 'utf8');
      // `updated` is untouched, so this must not wait for the 5000ms grace — it must arrive well
      // inside it, same as today's synchronous path.
      const eventSeen = waitForEvent<StoreEvent>(store, 'event', (e) => e.type === 'move', 1500);
      await writeFile(path, original.replace('status: todo', 'status: doing'));

      const event = await eventSeen;
      expect(`${event.actor}:${event.type}`).toBe('file:move');
    });

    it('(d) claimGraceMs: 1000, close() 300ms after the edit cancels a genuinely pending timer', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await openStore(repo.root, { watch: true, now: () => NOW, claimGraceMs: 1000 });
      opened.push(store);
      const events: StoreEvent[] = [];
      store.on('event', (e) => events.push(e));

      await slowWriterMove(repo, 'RB-1', 'todo', 'doing', '2026-09-02T22:50:00Z', undefined);
      // 300ms is well past chokidar's 100ms awaitWriteFinish, so the card `change` has already
      // been delivered and `schedulePendingClaim` has already registered a real timer — this
      // closes while a grace timer is genuinely outstanding, not merely before chokidar noticed
      // the write (RCB-115 seat review: the previous 50ms variant risked closing before the
      // watcher had scheduled anything at all, so it never actually exercised the cancel path).
      await sleep(300);
      await expect(store.close()).resolves.toBeUndefined();
      // Closed already — `afterEach`'s own close() on the same store must be a harmless no-op.

      await sleep(1500);
      expect(events).toEqual([]);
    });

    it('(e) two watch events for the same card inside the grace window both get reported', async () => {
      const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
      const store = await openStore(repo.root, { watch: true, now: () => NOW, claimGraceMs: 300 });
      opened.push(store);
      const events: StoreEvent[] = [];
      store.on('event', (e) => events.push(e));

      // RCB-115 seat review: a later watch event for the same card must NOT cancel an earlier
      // one's pending claim — each `updated` is its own mutation and, unclaimed, must be reported
      // on its own. No claim ever arrives for either edit.
      await slowWriterMove(repo, 'RB-1', 'todo', 'doing', '2026-09-02T22:50:00Z', undefined);
      // Past awaitWriteFinish (100ms), still inside RB-1's first grace window (300ms).
      await sleep(250);
      await slowWriterMove(repo, 'RB-1', 'doing', 'review', '2026-09-02T23:00:00Z', undefined);

      await sleep(1200);
      expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move', 'file:move']);
      expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(['todo->doing', 'doing->review']);
    });
  });
});

/**
 * RCB-157D: on macOS, chokidar sometimes delivers no fs event at all for a write under
 * `.repoboard/` (RCB-157B measured 65/1080 trials, 0/1080 on Linux) — the periodic reconcile
 * sweep (`OpenStoreOptions.reconcileMs`) is the store's own backstop, stating the tracked set on
 * a timer and routing anything `seen` says the watcher never reported through the SAME router
 * (`routeChange`) a real chokidar event uses. Listen BEFORE the trigger in every test (RCB-157).
 */
describe('RCB-157: reconcile — what the watcher lost', () => {
  // RCB-157E1: restore whatever was there (CI's REPOBOARD_WATCH_DIAG=1 recorder), never null it
  // out — same pattern as systems.test.ts's "RCB-157: MsgQueue dumps" describe.
  const envDiag = getWatchDiag();
  afterEach(() => setWatchDiag(envDiag));

  /** A minimal valid `systems.yml`: both environments, one `service`/`app` row per id. */
  const systemsYml = (ids: string[]): string =>
    [
      'environments:',
      '  dev: { note: null }',
      '  prod: { note: null }',
      'systems:',
      ...ids.flatMap((id) => [
        `  - id: ${id}`,
        `    name: ${id}`,
        '    kind: service',
        '    layer: app',
        '    env: [dev]',
        '    source: { hand: t, at: "2026-09-02T22:00:00Z" }',
      ]),
      '',
    ].join('\n');

  it('watch: false, reconcileMs: 100 — an external status edit routes as a move: one card, one file:move event', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 100);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    // A hand edit of `status:` alone (like the K8 tests above) — `updated` unchanged, so K8's
    // claim-grace never delays the synthesised event.
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await cardSeen;
    await sleep(400);

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);
    expect(store.get('RB-1')?.status).toBe('doing');
  });

  it('watch: false, reconcileMs: 100 — a new card file routes as an add: one card emit', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false, 100);

    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.id === 'RB-1');
    await writeFile(join(repo.cardsDir, 'RB-1.md'), cardText('RB-1', 'todo'));

    await cardSeen;
    await sleep(400);

    expect(store.get('RB-1')?.status).toBe('todo');
  });

  it('watch: false, reconcileMs: 100 — a deleted card file routes as an unlink: card:removed', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 100);
    expect(store.get('RB-1')).toBeDefined();

    const removed = waitForEvent<string>(store, 'card:removed', (id) => id === 'RB-1');
    await rm(join(repo.cardsDir, 'RB-1.md'));

    await removed;
    await sleep(400);

    expect(store.get('RB-1')).toBeUndefined();
  });

  it('watch: false, reconcileMs: 100 — a systems.yml edit routes: systems emit', async () => {
    const repo = await repoWith({});
    const store = await open(repo, false, 100);

    const changed = waitForEvent(store, 'systems', () => true);
    await writeFile(join(repo.root, '.repoboard', 'systems.yml'), systemsYml(['web']));

    await changed;
    await sleep(400);

    expect(store.systems().exists).toBe(true);
    expect(store.systems().doc?.systems.map((s) => s.id)).toEqual(['web']);
  });

  it('watch: false, reconcileMs: 50 — the sweep records a reconcile-on row and one sweep row that routed the edit', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'systems.yml');
    // Written BEFORE open: `fillSeenBaseline` sees it as already-known, not a "lost" add.
    await writeFile(path, systemsYml(['web']));

    const diag = createWatchDiag();
    setWatchDiag(diag);
    const store = await open(repo, false, 50);

    const changed = waitForEvent(store, 'systems', () => true);
    await writeFile(path, systemsYml(['web', 'api']));
    // 1s into the past: clears RECONCILE_SETTLE_MS (250ms) right away — the very next tick.
    const past = new Date(Date.now() - 1000);
    await utimes(path, past, past);

    await changed;
    await sleep(400);

    const rows = diag.rows(repo.root);
    expect(rows.some((r) => r[1] === 'reconcile-on' && r[2] === 50)).toBe(true);

    const sweepHit = rows.find((r) => {
      if (r[1] !== 'sweep') return false;
      const payload = r[2] as { routed: string[] };
      return payload.routed.includes('systems.yml:change');
    });
    expect(sweepHit).toBeDefined();
    const payload = sweepHit?.[2] as { tracked: number; routed: string[] };
    expect(payload.tracked).toBeGreaterThanOrEqual(5);
  });

  // A non-card path has no `refreshCard` hash to hide a second route of the same change, so an
  // emit count here shows a double that the card-based test above cannot.
  it('watch: true, reconcileMs: 100 — a systems.yml write is reported once, not by both watcher and sweep', async () => {
    const repo = await repoWith({});
    const store = await open(repo, true, 100);
    let emits = 0;
    store.on('systems', () => {
      emits += 1;
    });
    const path = join(repo.root, '.repoboard', 'systems.yml');

    const first = waitForEvent(store, 'systems', () => true);
    await writeFile(path, systemsYml(['web']));
    await first;
    await sleep(1000);
    expect(emits).toBe(1);

    const second = waitForEvent(store, 'systems', () => true);
    await writeFile(path, systemsYml(['web', 'api']));
    await second;
    await sleep(1000);
    expect(emits).toBe(2);
    expect(store.systems().doc?.systems.map((s) => s.id)).toEqual(['web', 'api']);
  });

  // RCB-157E: deterministic version of the test above — no REPOBOARD_WATCH_DIAG capture needed.
  // Written BEFORE open, like the 'sweep records a reconcile-on row' test above — `fillSeenBaseline`
  // sees systems.yml as already known, so the edit below routes as a 'change' with a real
  // `prevVia` to compare against (an 'add' has none, and the dedupe rule never applies to it).
  it('watch: true, reconcileMs: 50 — the sweep winning the race costs the watcher no second emit', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'systems.yml');
    await writeFile(path, systemsYml(['web']));
    const store = await open(repo, true, 50);
    let emits = 0;
    store.on('systems', () => {
      emits += 1;
    });

    await writeFile(path, systemsYml(['web', 'api']));
    // 1s into the past: the settle guard (250ms) passes on the sweep's very next tick (50ms
    // later) — well before chokidar's own awaitWriteFinish (100ms stability) can deliver a watch
    // event — deterministically making the sweep route this change first, `via: 'reconcile'`.
    // The watcher's own later report of the SAME edit must then be skipped as a cross-source
    // repeat, or `emits` would be 2.
    const past = new Date(Date.now() - 1000);
    await utimes(path, past, past);

    await sleep(1500);

    expect(emits).toBe(1);
    expect(store.systems().doc?.systems.map((s) => s.id)).toEqual(['web', 'api']);
  });

  // RCB-157E: the same-source rule (coordinator 2026-09-27, accepted) — a cross-source repeat is
  // skipped, but the SAME source reporting its own change again never is, even when two edits
  // share a `seen` key (a filesystem with 1s mtime resolution makes two same-size same-second
  // edits indistinguishable by key alone). reconcileMs: 0 keeps the sweep off entirely, so both
  // edits below can only ever be routed by the watcher — proving the skip rule's `prevVia !== via`
  // clause, not its `prevVia !== undefined` clause, is what lets B land.
  //
  // RCB-186: the watch route is DRIVEN, not awaited. RCB-157 measured the real macOS watcher
  // losing 65/1080 events after ready, and this test timed out once in 4 local runs waiting on
  // one. Each edit is instead announced by emitting chokidar's own `'all'` event on the store's
  // watcher — the exact `watcher.on('all', …)` handler → `routeChange(event, path, 'watch')` a
  // real event goes through, so `via` is `'watch'` — right after the file is fully written and its
  // mtime fixed. A real event arriving too (early, late, or twice) is just another `'watch'` route
  // for the same key, so it cannot change what is asserted; each wait is on the CONTENT of the
  // systems doc, so a late real event for A (which reads whatever is on disk) can never satisfy
  // the wait for B while B is unwritten.
  it('watch: true, reconcileMs: 0 — two same-size edits within one second on the watch path both land', async () => {
    const repo = await repoWith({});
    const path = join(repo.root, '.repoboard', 'systems.yml');
    const store = await open(repo, true, 0);
    // The one private reach of this test: `CardStore` does not expose its chokidar watcher.
    const watcher = (
      store as unknown as {
        watcher: { emit(name: 'all', event: 'add' | 'change', path: string): boolean } | null;
      }
    ).watcher;
    if (watcher === null) throw new Error('watch: true, but the store holds no watcher');

    type SystemsState = ReturnType<CardStore['systems']>;
    const idsOf = (s: SystemsState): string[] => s.doc?.systems.map((x) => x.id) ?? [];
    const landed = (id: string) => (s: SystemsState) => idsOf(s).join(',') === id;

    // Fixed past mtime, shared by both writes below, so both share one `seen` key by construction
    // — not by accident of a coarse filesystem clock.
    const t = new Date(Date.now() - 5000);

    const first = waitForEvent<SystemsState>(store, 'systems', landed('web'));
    await writeFile(path, systemsYml(['web'])); // A
    await utimes(path, t, t);
    watcher.emit('all', 'add', path);
    await first;
    expect(idsOf(store.systems())).toEqual(['web']);

    const second = waitForEvent<SystemsState>(store, 'systems', landed('api'));
    await writeFile(path, systemsYml(['api'])); // B — same length as A ('web'.length === 'api'.length)
    await utimes(path, t, t);
    watcher.emit('all', 'change', path);
    await second;

    expect(idsOf(store.systems())).toEqual(['api']);
  });

  it('watch: false, reconcileMs: 50 — settle guard: a file modified too recently is left for a later sweep', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50);
    const doingEmits: Card[] = [];
    store.on('card', (c) => {
      if (c.status === 'doing') doingEmits.push(c);
    });
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing', 2500);

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    const start = Date.now();
    await writeFile(path, original.replace('status: todo', 'status: doing'));
    // mtime 700ms in the future: `Date.now() - mtimeMs` stays below RECONCILE_SETTLE_MS (250)
    // until ~+950ms, so every sweep before then must leave this edit alone.
    const future = new Date(start + 700);
    await utimes(path, future, future);

    await sleep(400 - (Date.now() - start));
    expect(doingEmits).toHaveLength(0);

    await cardSeen;
    expect(store.get('RB-1')?.status).toBe('doing');
  });

  it('control: watch: false, reconcileMs: 0 — the same edit gives no card within 600ms', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 0);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));
    let sawCard = false;
    store.on('card', () => {
      sawCard = true;
    });

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await sleep(600);

    expect(sawCard).toBe(false);
    expect(events).toEqual([]);
    expect(store.get('RB-1')?.status).toBe('todo');
  });

  it('watch: true, reconcileMs: 100 — the watcher and reconcile do not both report the same edit', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, true, 100);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));
    const doingEmits: Card[] = [];
    store.on('card', (c) => {
      if (c.status === 'doing') doingEmits.push(c);
    });

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await cardSeen;
    // Longer than chokidar's awaitWriteFinish (100ms) plus the serial queue (K8's own `settle`),
    // plus another full reconcile tick (100ms) — long enough for the sweep to have had its own
    // chance at this same edit, were `seen` not shared with the watcher's own route.
    await sleep(700);
    await sleep(400);

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);
    expect(doingEmits).toHaveLength(1);
  });

  it("reconcileMs: 100 — the store's own move() is not double-reported by the sweep", async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 100);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    const res = await store.move('RB-1', 'doing', 'me');
    expect(res.ok).toBe(true);

    await sleep(400);

    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['me:move']);
  });

  it('close() stops the sweep: an edit after close gives nothing', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 100);
    await store.close(); // afterEach's own close() on the same store must be a harmless no-op.

    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));
    let sawCard = false;
    store.on('card', () => {
      sawCard = true;
    });

    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('status: todo', 'status: doing'));

    await sleep(400);

    expect(sawCard).toBe(false);
    expect(events).toEqual([]);
  });
});

/**
 * RCB-193: `refreshCard` emits `card`, THEN awaits `loadEvents()` and appends its `file:move` (or
 * arms K8's claim-grace timer) — so a store closed the instant the `card` emit is seen used to
 * resolve `close()` with that append still queued. Seat-measured before the fix (watch: false,
 * reconcileMs: 50): the move line was in events.jsonl at close 0/30, and 200 ms later 15/15; CI
 * 36637736105 hit it as `ENOTEMPTY rmdir .repoboard` in `afterEach`'s rm. Listen BEFORE the trigger
 * in every test (RCB-157), and close from inside the `card` emit's own continuation — that is the
 * exact moment the queued task is between its emit and its write.
 */
describe('RCB-193: close() waits for its own writes', () => {
  const eventsPath = (repo: TempRepo): string => join(repo.root, '.repoboard', 'events.jsonl');

  /** events.jsonl's text — `''` until the first append creates the file. */
  async function eventsText(repo: TempRepo): Promise<string> {
    try {
      return await readFile(eventsPath(repo), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  const summarize = (text: string): string[] =>
    text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as StoreEvent)
      .map((e) => `${e.actor}:${e.type}:${e.from}->${e.to}`);

  /**
   * A hand edit of RB-1 (`status: todo` -> `doing`, plus `updated:` when given), mtime 1 s in the
   * PAST so the sweep's settle guard (RECONCILE_SETTLE_MS, 250ms) passes on its very next tick.
   */
  async function handEdit(repo: TempRepo, updated?: string): Promise<void> {
    const path = join(repo.cardsDir, 'RB-1.md');
    const original = await readFile(path, 'utf8');
    const edited = original.replace('status: todo', 'status: doing');
    await writeFile(
      path,
      updated === undefined ? edited : edited.replace(/^updated: .+$/m, `updated: ${updated}`),
    );
    const past = new Date(Date.now() - 1000);
    await utimes(path, past, past);
  }

  // Control (seat, 2026-09-29): with the `do … while` drain deleted from `close()`, this test
  // failed on its first `expect` — events.jsonl at close summarised to `[]`, the append still
  // queued.
  it('(a) watch: false, reconcileMs: 50 — close() right after the card emit resolves with the file:move already in events.jsonl, and nothing lands after', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    // `updated:` untouched: a hand edit of `status:` alone, so K8's claim-grace never delays the
    // append — the task goes emit -> `loadEvents()` -> `appendEvent` with no timer in between.
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await handEdit(repo);

    await cardSeen;
    await store.close();

    const atClose = await eventsText(repo);
    expect(summarize(atClose)).toEqual(['file:move:todo->doing']);
    expect(events.map((e) => `${e.actor}:${e.type}`)).toEqual(['file:move']);

    await sleep(300);

    expect(await eventsText(repo)).toBe(atClose);
    expect(events).toHaveLength(1);
  });

  // Control (seat, 2026-09-29): with `if (this.closed) return;` deleted from
  // `schedulePendingClaim`, the task still running when `close()` cleared the timers armed a fresh
  // 300ms timer, and this test failed — one `file:move` emitted after close, where 0 was expected.
  it('(b) claimGraceMs: 300, updated moved — a task still deciding when close() runs arms no claim timer: nothing emitted or written after close', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    // `open()` has no claimGraceMs parameter: open the store directly, like the K8 tests above.
    const store = await openStore(repo.root, {
      watch: false,
      now: () => NOW,
      reconcileMs: 50,
      claimGraceMs: 300,
    });
    opened.push(store);
    const events: StoreEvent[] = [];
    store.on('event', (e) => events.push(e));

    // `updated:` moves too (the real-writer shape) and no claim line exists in events.jsonl, so
    // `refreshCard` takes `updatedMoved` and calls `schedulePendingClaim` instead of appending.
    const movedTo = '2026-09-02T22:50:00Z';
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await handEdit(repo, movedTo);

    const card = await cardSeen;
    // The precondition that puts this test on the claim path: `updated` really did move.
    expect(card.updated).toBe(movedTo);
    await store.close();

    const atClose = await eventsText(repo);
    const emittedAtClose = events.length;

    await sleep(600); // twice claimGraceMs: any timer armed at or after close has fired by now

    expect(events).toHaveLength(emittedAtClose);
    expect(await eventsText(repo)).toBe(atClose);
  });

  it('(c) close() twice resolves', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50);

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
    // Concurrent closes too: both drain the same queue, neither hangs or throws.
    await expect(Promise.all([store.close(), store.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
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

  it('move, update, appendLog, ask and decide cannot reach a write either', async () => {
    const { repo, store } = await boardless();
    // They stop earlier than the guard, at `unknown card`: a card can only be in memory if it was
    // read out of `.repoboard/cards/`, which cannot exist here. So `notFound`, not `readOnly` —
    // the refusal is honest either way, and neither reaches a writer.
    for (const res of [
      await store.move('RB-1', 'doing', 'test-actor'),
      await store.update('RB-1', { title: 'x' }, 'test-actor'),
      await store.appendLog('RB-1', 'x', 'test-actor'),
      await store.ask('RB-1', { question: 'q?' }, 'test-actor'),
      await store.decide('RB-1', { words: 'x' }, 'test-actor'),
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

  it('every method returning a *Outcome goes through this.mutate (directly, or via mutateLeases)', () => {
    const decls = [
      ...SRC.matchAll(/^ {2}(\w+)\([^)]*\): Promise<(\w+Outcome)> \{\n {4}return this\.(\w+)\(/gm),
    ];
    expect(decls.map((d) => d[1]).sort()).toEqual([
      'addNote',
      'addWindow',
      'appendArchiveText',
      'appendLog',
      'appendRepoLog',
      'appendSeatLog',
      'archiveCards',
      'ask',
      'closeSynced',
      'create',
      'decide',
      'move',
      'releaseLease',
      'setColumns',
      'setSeatBullet',
      'setStateSection',
      'takeLease',
      'update',
      'updateSeatBullet',
    ]);
    // File order (not the sorted list above): `takeLease`/`releaseLease`/`addWindow` are the
    // three that go through `mutateLeases` (RCB-133) — one level of indirection, not a bypass,
    // since `mutateLeases` itself is required (next test) to open with `this.mutate(`. Every
    // other Outcome method's first line is still `return this.mutate(` directly, unchanged.
    expect(decls.map((d) => d[3])).toEqual([
      'mutate', // create
      'mutate', // move
      'mutate', // update
      'mutate', // ask
      'mutate', // decide
      'mutateLeases', // takeLease
      'mutateLeases', // releaseLease
      'mutateLeases', // addWindow
      'mutate', // setStateSection
      'mutate', // setSeatBullet
      'mutate', // updateSeatBullet
      'mutate', // appendRepoLog
      'mutate', // appendSeatLog (RCB-127)
      'mutate', // appendArchiveText (RCB-132)
      'mutate', // appendLog
      'mutate', // addNote
      'mutate', // closeSynced
      'mutate', // archiveCards
      'mutate', // setColumns
    ]);
  });

  /**
   * RCB-133: the property the indirection above must not lose — `mutateLeases` is not a second,
   * unguarded funnel; it is `this.mutate(` plus a cross-process file lock wrapped around a fresh
   * re-read of leases.yml. If this ever changed to call `this.enqueue(` directly (skipping
   * `mutate`'s `MapOnlyError` → `{ok:false, readOnly:true}` conversion), `takeLease` et al would
   * throw instead of refusing cleanly in map-only mode — the "map-only: reads ... work, writes
   * refuse" behavioural test above (`leases and windows (P8.2)`) is the control for that.
   */
  it('mutateLeases itself opens with this.mutate', () => {
    const [start, end] = methodRange('private mutateLeases(');
    const body = SRC.slice(start, end);
    const firstStatement = body
      .slice(body.indexOf('): Promise<LeaseOutcome> {') + '): Promise<LeaseOutcome> {'.length)
      .split('\n')[1]
      ?.trim();
    expect(firstStatement).toBe('return this.mutate(async () => {');
  });

  it('all five disk writers open with the guard, on their first line', () => {
    for (const decl of [
      'private async writeCard',
      'private async appendEvent',
      'private async writeLeases',
      'private async writeState',
      'private async writeLog',
      'private async writeArchive',
    ]) {
      const [start, end] = methodRange(decl);
      const first = SRC.slice(start, end).split('\n')[1]?.trim();
      expect(first, `${decl} first statement`).toBe('this.refuseWriteWithoutBoard();');
    }
  });

  /**
   * RCB-34/P7.3: `setColumns` is not one of the five (structural check above), so it carries its
   * OWN `this.refuseWriteWithoutBoard()` — the behavioural control for this is
   * "map-only root → MapOnlyError / HTTP 409" below, which fails when this line is removed.
   */
  it('setColumns calls refuseWriteWithoutBoard itself', () => {
    const [start, end] = methodRange('setColumns(columns: Column[]');
    const lines = SRC.slice(start, end).split('\n');
    expect(lines.some((l) => l.trim() === 'this.refuseWriteWithoutBoard();')).toBe(true);
  });

  it('and nothing else in the store writes to disk', () => {
    const ranges = [
      methodRange('private async writeCard'),
      methodRange('private async appendEvent'),
      methodRange('private async writeLeases'),
      methodRange('private async writeState'),
      methodRange('private async writeLog'),
      methodRange('private async writeArchive'),
      // RCB-34/P7.3: `setColumns` is the sixth write site, guarded inline rather than through a
      // private `writeXxx` — see its doc comment in store.ts for why.
      methodRange('setColumns(columns: Column[]'),
    ];
    // RCB-207: `writeSeatsFile` (holder.ts) is the seats.yml writer — a disk writer like the rest,
    // and it was outside this audit (it is not `writeFile(`). Its one home is `runSeatWrite`.
    const seatsWriterRanges = [methodRange('private async runSeatWrite(')];
    const writes = [...SRC.matchAll(/await (writeFile|appendFile|rename|mkdir|writeSeatsFile)\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map((w) => w[1])).toContain('writeSeatsFile');
    for (const w of writes) {
      const i = w.index;
      const home = w[1] === 'writeSeatsFile' ? seatsWriterRanges : ranges;
      const inside = home.some(([a, b]) => i >= a && i < b);
      expect(inside, `${w[1]} at index ${i} is outside the two guarded writers`).toBe(true);
    }
  });

  /**
   * RCB-207: seats.yml holds holders; only the seat verbs write it, and only under its lock.
   * `writeSeatsFile` is called at exactly one site — `runSeatWrite`'s, gated on the plan carrying a
   * `leases` doc — and `runSeatWrite` is handed a seats.yml read (non-null `seats`) at exactly one
   * call, inside `setSeatBulletHeld`'s `withFileLock(this.seatsPath`; the other call passes `null`.
   */
  it('writeSeatsFile is called at exactly one site, in runSeatWrite, which gets a seats read only under withFileLock(this.seatsPath', () => {
    const sites = [...SRC.matchAll(/await writeSeatsFile\(/g)];
    expect(sites).toHaveLength(1);
    const site = sites[0]?.index ?? -1;
    const [runStart, runEnd] = methodRange('private async runSeatWrite(');
    expect(site >= runStart && site < runEnd, 'the call is outside runSeatWrite').toBe(true);
    const line = SRC.slice(SRC.lastIndexOf('\n', site) + 1, SRC.indexOf('\n', site)).trim();
    expect(line).toBe(
      'if (plan.leases !== null) await writeSeatsFile(this.seatsPath, serializeLeases(plan.leases));',
    );

    const calls = [...SRC.matchAll(/this\.runSeatWrite\(/g)];
    expect(calls).toHaveLength(2);
    expect(SRC).toContain('this.runSeatWrite(req, null)');
    const [heldStart, heldEnd] = methodRange('private async setSeatBulletHeld(');
    const held = SRC.slice(heldStart, heldEnd);
    const lockAt = held.indexOf('withFileLock(this.seatsPath');
    expect(lockAt, 'setSeatBulletHeld does not take seats.yml lock').toBeGreaterThan(-1);
    expect(held.indexOf('this.runSeatWrite(req, {')).toBeGreaterThan(lockAt);
  });
});

describe('RCB-164: a card caught mid-write is not a removed card', () => {
  // `watch: false, reconcileMs: 50` throughout — the sweep, not chokidar, so the empty read is
  // deterministic (like the RCB-157 reconcile describe above). `RECONCILE_SETTLE_MS` (250ms) is
  // store.ts's own guard, not reproduced here — these tests just wait long enough to clear it.

  it('a truncate-then-refill inside the grace produces a move, never a removal', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50); // default emptyGraceMs (1000)
    const events: StoreEvent[] = [];
    const removed: string[] = [];
    const invalid: InvalidCard[][] = [];
    store.on('event', (e) => events.push(e));
    store.on('card:removed', (id) => removed.push(id));
    store.on('invalid', (inv) => invalid.push(inv));

    const path = join(repo.cardsDir, 'RB-1.md');
    const cardSeen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    // `open(path, 'w')` is `O_TRUNC` then a separate `write` below — the same two-step a real
    // writer's `writeFile` does, just spread far enough apart (600ms) to land the empty read.
    const fh = await fsOpen(path, 'w');
    await sleep(600);
    await fh.write(cardText('RB-1', 'doing'));
    await fh.close();

    await cardSeen;
    // The default emptyGraceMs's own recheck timer starts once the sweep's 250ms settle guard
    // first sees the truncate (~250-300ms in) and fires ~1000ms later — wait comfortably past
    // that, not just past the refill, before asserting no removal ever happened.
    await sleep(800);

    expect(removed).toEqual([]);
    expect(invalid).toEqual([]);
    expect(store.get('RB-1')?.status).toBe('doing');
    expect(events.map((e) => `${e.actor}:${e.type}:${e.from}->${e.to}`)).toEqual([
      'file:move:todo->doing',
    ]);
  });

  it('a truncate that never refills becomes a real removal after the grace', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50, 300); // short emptyGraceMs: stays under 2s

    const path = join(repo.cardsDir, 'RB-1.md');
    const invalidSeen = waitForEvent<InvalidCard[]>(store, 'invalid', (list) => list.length === 1);
    const removedSeen = waitForEvent<string>(store, 'card:removed', (id) => id === 'RB-1');
    const fh = await fsOpen(path, 'w'); // O_TRUNC, never refilled

    expect(await removedSeen).toBe('RB-1');
    expect(await invalidSeen).toHaveLength(1);
    await fh.close();
    expect(store.get('RB-1')).toBeUndefined();
  });

  // Control (brief §3): the same sequence as test 1, but `emptyGraceMs: 0` — today's un-held
  // behaviour. Seeing `card:removed` here, where test 1 sees none, proves test 1's 600ms gap
  // really does land the empty read rather than the hold being vacuous.
  it('control: emptyGraceMs: 0 reproduces the bug the hold above fixes', async () => {
    const repo = await repoWith({ 'RB-1.md': cardText('RB-1', 'todo') });
    const store = await open(repo, false, 50, 0);
    const removed: string[] = [];
    store.on('card:removed', (id) => removed.push(id));

    const path = join(repo.cardsDir, 'RB-1.md');
    const removedSeen = waitForEvent<string>(store, 'card:removed', (id) => id === 'RB-1');
    const fh = await fsOpen(path, 'w');
    await sleep(600);
    await fh.write(cardText('RB-1', 'doing'));
    await fh.close();

    expect(await removedSeen).toBe('RB-1');
    expect(removed).toEqual(['RB-1']);
  });
});
