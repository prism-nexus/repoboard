import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardConfig, Card } from '@repoboard/core';
import { defaultBoardConfig, parseCard, serializeBoard } from '@repoboard/core';
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
    // releaseLease has nothing to release here (no lease was ever taken — taking one is itself
    // refused above), so this hits core's "no lease is held" refusal before the write guard ever
    // runs; the write guard's coverage for release/addWindow comes from the K10 structural tests
    // (both route only through the same guarded `writeLeases`, proven to open with the guard).
    expect(await store.releaseLease({ resource: 'r' }, 't')).toMatchObject({ ok: false });
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
    expect(text).toContain('_(generated from open decisions)_');

    const second = await store.setStateSection('seats', 'ops watching.', 'claude/ops');
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
    const first = await store.appendRepoLog('claude/p8-3', 'first entry', 'kickoff');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.date).toBe('2026-09-02');
    expect(first.text).toBe(
      '# Log — 2026-09-02\n\n##### CLAUDE/P8-3 2026-09-02T22:41:10Z: kickoff\n\nfirst entry\n',
    );
    const onDisk = await readFile(join(repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(onDisk).toBe(first.text);

    const second = await store.appendRepoLog('ops', 'second entry', undefined);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toContain('##### CLAUDE/P8-3');
    expect(second.text).toContain('##### OPS 2026-09-02T22:41:10Z: second entry');
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

    const clean = await store.check(false);
    expect(clean.findings).toEqual([]);
    expect(clean.exitCode).toBe(0);

    await store.setStateSection('live', 'first', 'claude/p8-3'); // stamp = NOW

    const logDir = join(repo.root, '.repoboard', 'log');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, '2026-09-02.md');
    await writeFile(logPath, '# Log — 2026-09-02\n\n##### OPS 2026-09-02T22:41:10Z: x\n\ny\n');
    const later = new Date(NOW.getTime() + 60_000);
    await utimes(logPath, later, later); // mtime strictly after the STATE stamp

    const stale = await store.check(false);
    expect(stale.findings.some((f) => f.kind === 'stale-state')).toBe(true);
    expect(stale.exitCode).toBe(1);

    clock = new Date(later.getTime() + 60_000); // now strictly after the log's mtime
    await store.setStateSection('live', 'second', 'claude/p8-3'); // restamp
    const fresh = await store.check(false);
    expect(fresh.findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('map-only: state()/log()/check() work as reads, writes refuse', async () => {
    const repo = await makeTempRepoNoBoard({});
    const store = await open(repo, false);
    expect(store.state()).toBeNull();
    expect(await store.log()).toBeNull();
    const check = await store.check(false);
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
});

// ---- P8.6 `logDir`: `check` reads an extra daily-log directory ------------------------------
// (fpj `docs/STATE-CONVERGENCE-BRIEF.md` locked decision 1 / control C2.)
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

    // fpj's own daily log lives outside .repoboard/, headed like fpj's real blocks — the `ts` is
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
    const withLogDir = await store.check(false);
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
    const withoutLogDir = await storeNoLogDir.check(false);
    expect(withoutLogDir.findings.some((f) => f.kind === 'stale-state')).toBe(false);
    expect(withoutLogDir.exitCode).toBe(0);
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

  it('every method returning a *Outcome goes through this.mutate', () => {
    const decls = [
      ...SRC.matchAll(/^ {2}(\w+)\([^)]*\): Promise<(\w+Outcome)> \{\n {4}return this\.(\w+)\(/gm),
    ];
    expect(decls.map((d) => d[1]).sort()).toEqual([
      'addWindow',
      'appendLog',
      'appendRepoLog',
      'archiveCards',
      'ask',
      'closeSynced',
      'create',
      'decide',
      'move',
      'releaseLease',
      'setStateSection',
      'takeLease',
      'update',
    ]);
    expect(decls.map((d) => d[3])).toEqual([
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
      'mutate',
    ]);
  });

  it('all five disk writers open with the guard, on their first line', () => {
    for (const decl of [
      'private async writeCard',
      'private async appendEvent',
      'private async writeLeases',
      'private async writeState',
      'private async writeLog',
    ]) {
      const [start, end] = methodRange(decl);
      const first = SRC.slice(start, end).split('\n')[1]?.trim();
      expect(first, `${decl} first statement`).toBe('this.refuseWriteWithoutBoard();');
    }
  });

  it('and nothing else in the store writes to disk', () => {
    const ranges = [
      methodRange('private async writeCard'),
      methodRange('private async appendEvent'),
      methodRange('private async writeLeases'),
      methodRange('private async writeState'),
      methodRange('private async writeLog'),
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
