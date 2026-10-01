/**
 * RCB-196 slice B (of RCB-194): three hardening guarantees the seat verbs and the log lean on.
 *
 *  (2) SEATS is written by the seat verbs — `state --set-section SEATS`, MCP `set_state_section`
 *      and HTTP `PUT /api/state/section` are refused unless the request says `--force` / `force:
 *      true`, and a refusal writes NOTHING (STATE.md is byte-identical).
 *  (3) A seat verb or a log append run from a LINKED git worktree is refused, naming the main
 *      checkout — the worktree's `.repoboard/` is its own tracked copy, not the board's record.
 *  (4) The repo-log append reads the day's file INSIDE a cross-process file lock, and writes through
 *      a unique tmp name, so two writers at once each land their block.
 *
 * Every fixture lives under `os.tmpdir()`; nothing outside them is touched. Every `cli` call is
 * handed an explicit env, so the machine running the suite cannot leak its own identity in.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  defaultBoardConfig,
  parseLogBlocks,
  type SeatHolder,
  serializeBoard,
  toIso,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { startServer } from '../src/http.js';
import { createMcpServer } from '../src/mcp.js';
import { openStore } from '../src/store.js';
import { makeTempRepoboard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** No pane, no session, no `CLAUDE_PID`: the environment every pre-RCB-195 caller ran in. */
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

async function cli(cwd: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd, stdout, stderr, env: BARE_ENV, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

async function freshBoard(): Promise<string> {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  return repo.root;
}

/** Every file (and directory) under `dir` with its text — a change anywhere shows in `toEqual`. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = '';
        await walk(path);
      } else {
        out[relative(dir, path)] = await readFile(path, 'utf8');
      }
    }
  };
  await walk(dir);
  return out;
}

/** git's own "where am I" variables, dropped so a fixture repo is never the OUTER repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|PREFIX)$/.test(key),
  ),
);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { env: GIT_ENV },
  );
}

function textOf(res: CallToolResult): string {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

// ---- (2) SEATS is written by seat verbs ---------------------------------------------------------

describe('state --set-section SEATS is refused without --force (RCB-196 item 2)', () => {
  it('CLI: without --force exit 1 naming the seat verbs and STATE.md is byte-identical; with --force exit 0; LIVE needs no flag', async () => {
    const root = await freshBoard();
    const seeded = await cli(root, 'state', '--set-section', 'LIVE', 'Tree is dev.');
    expect(seeded.code, seeded.err).toBe(0);
    const statePath = join(root, '.repoboard', 'STATE.md');
    const before = await readFile(statePath, 'utf8');

    for (const spelling of ['SEATS', 'seats']) {
      const refused = await cli(root, 'state', '--set-section', spelling, 'ops watching.');
      expect(refused.code, spelling).toBe(1);
      expect(refused.err, spelling).toContain('SEATS is written by seat verbs');
      expect(refused.err, spelling).toMatch(/seat <name> --up\|--down\|--update/);
      expect(refused.out, spelling).toBe('');
      expect(await readFile(statePath, 'utf8'), spelling).toBe(before);
    }

    // The flag is only meaningful next to --set-section: alone it is a usage error, no write.
    const alone = await cli(root, 'state', '--force');
    expect(alone.code).toBe(1);
    expect(alone.err).toContain('--force is only valid with --set-section');
    expect(await readFile(statePath, 'utf8')).toBe(before);

    // LIVE never needed the flag, and still does not.
    const live = await cli(root, 'state', '--set-section', 'LIVE', 'Tree is still dev.');
    expect(live.code, live.err).toBe(0);
    expect(await readFile(statePath, 'utf8')).toContain('Tree is still dev.');

    const forced = await cli(root, 'state', '--set-section', 'SEATS', '--force', 'ops watching.');
    expect(forced.code, forced.err).toBe(0);
    expect(forced.out).toBe('updated STATE.md SEATS\n');
    expect(await readFile(statePath, 'utf8')).toContain('ops watching.');
  });

  it('MCP set_state_section: SEATS without force is an error and STATE.md is byte-identical; force:true writes; LIVE needs no flag', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: false, now: () => NOW });
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: 'set_state_section', arguments: args })) as CallToolResult;

    const seeded = await call({ section: 'LIVE', body: 'Tree is dev.' });
    expect(seeded.isError, textOf(seeded)).toBeFalsy();
    const statePath = join(root, '.repoboard', 'STATE.md');
    const before = await readFile(statePath, 'utf8');

    const refused = await call({ section: 'SEATS', body: 'ops watching.' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('SEATS is written by seat verbs');
    expect(await readFile(statePath, 'utf8')).toBe(before);

    // `force: false` is not a way round it either.
    const notForced = await call({ section: 'SEATS', body: 'ops watching.', force: false });
    expect(notForced.isError).toBe(true);
    expect(await readFile(statePath, 'utf8')).toBe(before);

    const live = await call({ section: 'LIVE', body: 'Tree is still dev.' });
    expect(live.isError, textOf(live)).toBeFalsy();

    const forced = await call({ section: 'SEATS', body: 'ops watching.', force: true });
    expect(forced.isError, textOf(forced)).toBeFalsy();
    expect(await readFile(statePath, 'utf8')).toContain('ops watching.');

    // The new parameter is in the schema, and the tool is still inside the 700 B pin.
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'set_state_section');
    expect(tool?.inputSchema.properties).toHaveProperty('force');
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThanOrEqual(700);
  });

  it('HTTP PUT /api/state/section: SEATS is honoured only when the body says force: true', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = `${server.url.replace(/\/$/, '')}/api/state/section`;
    const put = (body: Record<string, unknown>) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await put({ section: 'LIVE', body: 'Tree is dev.' })).status).toBe(200);
    const statePath = join(root, '.repoboard', 'STATE.md');
    const before = await readFile(statePath, 'utf8');

    const refused = await put({ section: 'SEATS', body: 'ops watching.' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'SEATS is written by seat verbs',
    );
    expect(await readFile(statePath, 'utf8')).toBe(before);

    // Truthy is not `true`: a string is a malformed request, not a way round the refusal.
    const stringly = await put({ section: 'SEATS', body: 'ops watching.', force: 'true' });
    expect(stringly.status).toBe(400);
    expect(((await stringly.json()) as { error: string }).error).toBe('force must be a boolean');
    expect(await readFile(statePath, 'utf8')).toBe(before);

    const forced = await put({ section: 'SEATS', body: 'ops watching.', force: true });
    expect(forced.status).toBe(200);
    expect(await readFile(statePath, 'utf8')).toContain('ops watching.');
  });
});

// ---- (2b) a forced SEATS rewrite is audited (RCB-207 h) ------------------------------------------

/** Today's (`NOW`'s) log blocks under `logDir`; `[]` when the day has no file yet. */
async function todaysBlocks(logDir: string) {
  const path = join(logDir, `${toIso(NOW).slice(0, 10)}.md`);
  return existsSync(path) ? parseLogBlocks(await readFile(path, 'utf8')) : [];
}

/** The ONE block a forced SEATS rewrite by `actor` audits — the wording is pinned on purpose. */
function forcedSeatsBlock(actor: string) {
  return {
    seat: actor.toUpperCase(),
    ts: '2026-09-02T22:41:10Z',
    title: 'state --set-section SEATS --force over any holder',
    text: `SEATS rewritten whole with force, bypassing seat holders; written by ${actor}`,
  };
}

describe('a forced SEATS rewrite appends ONE audit block (RCB-207 h)', () => {
  it('CLI: `state --set-section SEATS --force` audits once per write, by the actor; LIVE / LAST-LANDINGS (forced or not) and a refused SEATS audit nothing', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const statePath = join(root, '.repoboard', 'STATE.md');
    expect(await todaysBlocks(store.logDir)).toEqual([]);

    // The twin: every other section writes no audit, with or without --force.
    for (const args of [
      ['LIVE', 'Tree is dev.'],
      ['LIVE', '--force', 'Tree is still dev.'],
      ['LAST-LANDINGS', '--force', '1. A landing.'],
    ]) {
      const res = await cli(root, 'state', '--set-section', ...args);
      expect(res.code, `${args.join(' ')}: ${res.err}`).toBe(0);
      expect(await todaysBlocks(store.logDir), args.join(' ')).toEqual([]);
    }

    // A refused SEATS write (no --force) writes nothing, the log included.
    const refused = await cli(root, 'state', '--set-section', 'SEATS', 'ops watching.');
    expect(refused.code).toBe(1);
    expect(await todaysBlocks(store.logDir)).toEqual([]);

    // Forced: exactly one new block, and it says who and what.
    const first = await cli(root, 'state', '--set-section', 'SEATS', '--force', 'ops watching.');
    expect(first.code, first.err).toBe(0);
    expect(await readFile(statePath, 'utf8')).toContain('ops watching.');
    const afterFirst = await todaysBlocks(store.logDir);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject(forcedSeatsBlock('test-actor'));

    // A second forced write is one more block, not a cumulative one.
    const second = await cli(
      root,
      'state',
      '--set-section',
      'seats',
      '--force',
      'ops standing by.',
    );
    expect(second.code, second.err).toBe(0);
    const afterSecond = await todaysBlocks(store.logDir);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).toMatchObject(forcedSeatsBlock('test-actor'));
  });

  it('MCP set_state_section: force:true on SEATS audits once, by the actor passed (the default actor when none); force on LIVE audits nothing', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: 'set_state_section', arguments: args })) as CallToolResult;

    const live = await call({ section: 'LIVE', body: 'Tree is dev.', force: true });
    expect(live.isError, textOf(live)).toBeFalsy();
    const refused = await call({ section: 'SEATS', body: 'ops watching.' });
    expect(refused.isError).toBe(true);
    expect(await todaysBlocks(store.logDir)).toEqual([]);

    const byDefault = await call({ section: 'SEATS', body: 'ops watching.', force: true });
    expect(byDefault.isError, textOf(byDefault)).toBeFalsy();
    const named = await call({
      section: 'SEATS',
      body: 'ops standing by.',
      force: true,
      actor: 'coordinator',
    });
    expect(named.isError, textOf(named)).toBeFalsy();
    const blocks = await todaysBlocks(store.logDir);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject(forcedSeatsBlock('test/mcp'));
    expect(blocks[1]).toMatchObject(forcedSeatsBlock('coordinator'));
  });

  it('HTTP PUT /api/state/section: force:true on SEATS audits once (actor `web` unless the body names one); a refusal and force on LIVE audit nothing', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = `${server.url.replace(/\/$/, '')}/api/state/section`;
    const put = (body: Record<string, unknown>) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await put({ section: 'LIVE', body: 'Tree is dev.', force: true })).status).toBe(200);
    expect((await put({ section: 'SEATS', body: 'ops watching.' })).status).toBe(400);
    expect((await put({ section: 'SEATS', body: 'ops watching.', force: 'true' })).status).toBe(
      400,
    );
    expect(await todaysBlocks(store.logDir)).toEqual([]);

    expect((await put({ section: 'SEATS', body: 'ops watching.', force: true })).status).toBe(200);
    expect(
      (await put({ section: 'SEATS', body: 'ops standing by.', force: true, actor: 'ops' })).status,
    ).toBe(200);
    const blocks = await todaysBlocks(store.logDir);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject(forcedSeatsBlock('web'));
    expect(blocks[1]).toMatchObject(forcedSeatsBlock('ops'));
  });

  it('a forced SEATS write that cannot happen (an unparseable STATE.md) audits nothing and leaves STATE.md as it was', async () => {
    const root = await freshBoard();
    const store = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const statePath = join(root, '.repoboard', 'STATE.md');
    await writeFile(statePath, 'not a state file at all');

    const res = await store.setStateSection('seats', 'ops watching.', 'test-actor', {
      force: true,
    });
    expect(res.ok).toBe(false);
    expect(await readFile(statePath, 'utf8')).toBe('not a state file at all');
    expect(await todaysBlocks(store.logDir)).toEqual([]);
  });
});

// ---- (3) refuse seat/log writes from a linked worktree ------------------------------------------

interface LinkedFixture {
  /** realpath of the main checkout (the repository's top level). */
  main: string;
  /** The linked worktree's top level. */
  worktree: string;
  /** Where the board lives in the main checkout: `main`, or `main/<sub>`. */
  mainBoard: string;
  /** The same directory inside the linked worktree. */
  wtBoard: string;
}

/**
 * A git repo whose board (`<sub>/.repoboard/`, with `builder` seeded DOWN in a COMMITTED STATE.md)
 * is checked in, plus a linked worktree of it. The bullet has to be there: without the refusal,
 * `seat builder --update` from the worktree would SUCCEED, so an exit 1 can only be the refusal.
 */
async function linkedFixture(sub: string): Promise<LinkedFixture> {
  const main = await realpath(await mkdtemp(join(tmpdir(), 'repoboard-hard-')));
  const worktree = `${main}-wt`;
  dirs.push(main, worktree);
  await git(main, 'init', '-q', '-b', 'main');
  const mainBoard = sub === '' ? main : join(main, sub);
  await mkdir(join(mainBoard, '.repoboard', 'cards'), { recursive: true });
  await writeFile(
    join(mainBoard, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: 'hardboard' }),
  );
  const stoodDown = 'x\nin-flight: none\nowes: none';
  const seeded = await cli(mainBoard, 'seat', 'builder', '--down', stoodDown);
  expect(seeded.code, seeded.err).toBe(0);
  await git(main, 'add', '-A');
  await git(main, 'commit', '-q', '-m', 'board');
  await git(main, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  return { main, worktree, mainBoard, wtBoard: sub === '' ? worktree : join(worktree, sub) };
}

const SEAT_AND_LOG_VERBS: readonly (readonly string[])[] = [
  ['seat', 'builder', '--up', 'x'],
  ['seat', 'builder', '--update', 'x'],
  ['log', '--as', 'builder', 'x'],
];

describe('seat and log writes are refused from a linked git worktree (RCB-196 item 3)', () => {
  it('from the worktree: seat --up, seat --update and log each exit 1 naming the main checkout; nothing under either .repoboard/ changes', async () => {
    const f = await linkedFixture('');
    const wtRepoboard = join(f.wtBoard, '.repoboard');
    const mainRepoboard = join(f.mainBoard, '.repoboard');
    // Precondition: the worktree carries the committed bullet, so `--update` WOULD succeed there.
    expect(await readFile(join(wtRepoboard, 'STATE.md'), 'utf8')).toContain('builder: DOWN');
    const wtBefore = await snapshot(wtRepoboard);
    const mainBefore = await snapshot(mainRepoboard);

    for (const argv of SEAT_AND_LOG_VERBS) {
      const label = argv.join(' ');
      const res = await cli(f.wtBoard, ...argv);
      expect(res.code, `${label}: ${res.err}`).toBe(1);
      expect(res.out, label).toBe('');
      expect(res.err, label).toContain('linked git worktree');
      expect(res.err, label).toContain(f.worktree);
      // `f.worktree` extends `f.main`, so the phrase below is what proves the MAIN path is named.
      expect(res.err, label).toContain(`run it from the main checkout: ${f.mainBoard}`);
      expect(await snapshot(wtRepoboard), label).toEqual(wtBefore);
      expect(await snapshot(mainRepoboard), label).toEqual(mainBefore);
    }
  });

  it('from the main checkout: the same three commands exit 0', async () => {
    const f = await linkedFixture('');
    for (const argv of SEAT_AND_LOG_VERBS) {
      const res = await cli(f.mainBoard, ...argv);
      expect(res.code, `${argv.join(' ')}: ${res.err}`).toBe(0);
    }
    const state = await readFile(join(f.mainBoard, '.repoboard', 'STATE.md'), 'utf8');
    expect(state).toContain('builder: UP');
  });

  it('a board below the repository top level: the refusal names the matching directory in the main checkout', async () => {
    const f = await linkedFixture('pkg');
    expect(f.mainBoard).toBe(join(f.main, 'pkg'));
    const res = await cli(f.wtBoard, 'log', '--as', 'builder', 'x');
    expect(res.code, res.err).toBe(1);
    expect(res.err).toContain(`run it from the main checkout: ${join(f.main, 'pkg')}`);
    expect(existsSync(join(f.wtBoard, '.repoboard', 'log'))).toBe(false);
  });

  it('store level: setSeatBullet (with a holder and a local layer), updateSeatBullet, appendRepoLog and appendSeatLog all refuse; seats.yml is never created', async () => {
    const f = await linkedFixture('');
    const wtRepoboard = join(f.wtBoard, '.repoboard');
    // A local layer in the worktree, so `setSeatBullet` WOULD take its `seats.yml` path.
    await mkdir(join(wtRepoboard, 'local'));
    const before = await snapshot(wtRepoboard);
    const store = await openStore(f.wtBoard, { watch: false, now: () => NOW });
    const holder: SeatHolder = {
      pane: 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B',
      session: null,
      start: null,
      host: 'testhost',
      pid: process.pid,
    };

    const outcomes = [
      await store.setSeatBullet('builder', 'UP', 'x', holder),
      await store.updateSeatBullet('builder', 'x'),
      await store.appendRepoLog('builder', 'x', undefined),
      await store.appendSeatLog('builder', 'x', undefined),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error).toContain(`run it from the main checkout: ${f.mainBoard}`);
    }
    expect(existsSync(join(wtRepoboard, 'local', 'seats.yml'))).toBe(false);
    expect(await snapshot(wtRepoboard)).toEqual(before);
  });
});

// ---- (4) the repo-log append is locked ----------------------------------------------------------

describe('the repo-log append is read-modify-write under a file lock (RCB-196 item 4)', () => {
  it('two stores on one root, 20 rounds of concurrent appends: every block lands and no *.tmp is left', async () => {
    const root = await freshBoard();
    const a = await openStore(root, { watch: false, now: () => NOW });
    const b = await openStore(root, { watch: false, now: () => NOW });
    const date = toIso(NOW).slice(0, 10);
    const logPath = join(a.logDir, `${date}.md`);

    for (let round = 0; round < 20; round++) {
      const [ra, rb] = await Promise.all([
        a.appendRepoLog('a', `a round ${round}`, undefined),
        b.appendRepoLog('b', `b round ${round}`, undefined),
      ]);
      expect(ra.ok, `round ${round}: a`).toBe(true);
      expect(rb.ok, `round ${round}: b`).toBe(true);
      const text = await readFile(logPath, 'utf8');
      expect(parseLogBlocks(text), `round ${round}`).toHaveLength(2 * (round + 1));
      const leftovers = (await readdir(a.logDir)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers, `round ${round}`).toEqual([]);
    }

    // Not just the right COUNT: every writer's every block is there exactly once.
    const blocks = parseLogBlocks(await readFile(logPath, 'utf8'));
    for (let round = 0; round < 20; round++) {
      for (const who of ['a', 'b']) {
        const mine = blocks.filter((blk) => blk.text === `${who} round ${round}`);
        expect(mine, `${who} round ${round}`).toHaveLength(1);
      }
    }
  });
});
