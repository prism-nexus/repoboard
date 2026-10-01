/**
 * RCB-198 (slice B of RCB-194): a seat is WRITTEN by the pane that holds it. `seat --down`,
 * `seat --update` and `log --as <seat>` check the recorded holder (`.repoboard/local/seats.yml`)
 * inside seats.yml's lock, in ONE store function (`checkSeatWrite` -> core's `decideSeatWrite`):
 * a pane that is not the holder is refused with both labels and NOTHING written, unless `--force`,
 * which writes and appends one audit block first. `--down` drops the seat's lease, `--update` keeps
 * it. A seat with no lease (a legacy bullet) and a board with no local layer are writable by anyone,
 * as before. MCP `append_repo_log` writes as the server's own holder; HTTP `POST /api/log` has no
 * pane and writes as `web` — a non-holder, so it needs `force: true`.
 *
 * Two panes are two live processes: pane A is this process (`process.pid`), pane C's pid is its
 * parent (`process.ppid`) — one pid is one holder (`sameHolder`), so the panes must not share one.
 * Every `cli` call is handed an explicit `env` (the machine running the suite may itself be an
 * iTerm pane), and every board lives under `os.tmpdir()`.
 *
 * CONTROL (run by the seat, not part of the suite): put cc5dccd's `cli.ts` + `store.ts` back — a
 * `--down` (and `--update`, and `log --as`) from pane C then succeeds, so (c) fails for each verb
 * (exit 0, STATE.md rewritten), and (d)'s audit block is never written.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  defaultBoardConfig,
  parseHolder,
  parseLeases,
  type SeatHolder,
  serializeBoard,
  serializeLeases,
} from '@repoboard/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { withFileLock } from '../src/file-lock.js';
import { holderFromEnv } from '../src/holder.js';
import { startServer } from '../src/http.js';
import { localDir } from '../src/local.js';
import { createMcpServer } from '../src/mcp.js';
import { openStore } from '../src/store.js';
import { makeTempRepoboard, NOW } from './helpers.js';

// Each test runs several CLI writes, each of which syncs the local git repo: past the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

/** Pane A holds `builder`; pane C is another pane (nothing shared with A, so both tags stay 4 long). */
const PANE_A = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
const PANE_C = '0460D7A9-3E1F-4B2C-9D8E-5A6B7C8D9E0F';
const SESSION_A = 'session-a-7f3a9c2e-privacy-marker';
const SESSION_C = 'session-c-51d0e8b4-privacy-marker';
/** The two live pids: this process and its parent. */
const PID_A = process.pid;
const PID_C = process.ppid;

/** What an iTerm pane running Claude Code exports: the pane, the Claude session, the Claude pid. */
function paneEnv(pane: string, pid: number, session: string): Record<string, string> {
  return {
    REPOBOARD_ACTOR: 'test-actor',
    ITERM_SESSION_ID: `w0t0p0:${pane}`,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PID: String(pid),
  };
}

const ENV_A = paneEnv(PANE_A, PID_A, SESSION_A);
const ENV_C = paneEnv(PANE_C, PID_C, SESSION_C);
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

/** The refusal pane C gets for pane A's `builder` (UP at the fixed `NOW`). */
const REFUSAL_C =
  'builder is held by A7B2 · acme builder (UP 2026-09-02 22:41Z); you are 0460 · acme' +
  ' — use --force to write it anyway (audited in the log)';
/** The same, for a caller with no pane at all — serve's HTTP door, or a store call with no holder. */
const REFUSAL_WEB =
  'builder is held by A7B2 · acme builder (UP 2026-09-02 22:41Z); you are web' +
  ' — use --force to write it anyway (audited in the log)';

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

/** `env` is ALWAYS explicit — see the header. */
async function cli(root: string, env: Record<string, string>, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd: root, stdout, stderr, env, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

/** A board named `seatboard` with short name `acme`, with or without a local layer (`local init`). */
async function makeBoard(withLocal: boolean): Promise<string> {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  await writeFile(
    join(repo.root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: 'seatboard', shortName: 'acme' }),
  );
  if (withLocal) {
    const init = await cli(repo.root, BARE_ENV, 'local', 'init');
    expect(init.code).toBe(0);
  }
  return repo.root;
}

/** A local-layer board on which pane A holds `builder`. */
async function heldByA(): Promise<string> {
  const root = await makeBoard(true);
  const up = await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-198');
  expect(up.code, up.err).toBe(0);
  return root;
}

const seatsFile = (root: string) => join(localDir(root), 'seats.yml');
const localState = (root: string) => join(localDir(root), 'STATE.md');

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The `seat:` leases in `seats.yml`, parsed the way the store parses them. */
async function readLeases(root: string) {
  const parsed = parseLeases((await readOrNull(seatsFile(root))) ?? '');
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc.leases;
}

/** The first line of `seat`'s bullet in the local STATE.md. */
async function bulletOf(root: string, seat: string): Promise<string> {
  const text = await readFile(localState(root), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('- **') && l.includes(` ${seat}: `));
  if (line === undefined) throw new Error(`no bullet for ${seat} in:\n${text}`);
  return line;
}

interface LoggedBlock {
  seat: string;
  title: string;
  text: string;
}

/** Every log block written today (the fixed `NOW`), oldest first. */
async function loggedBlocks(root: string): Promise<LoggedBlock[]> {
  const shown = await cli(root, BARE_ENV, 'log', 'show', '--json');
  expect(shown.code).toBe(0);
  return (JSON.parse(shown.out) as { blocks: LoggedBlock[] }).blocks;
}

/** The three files a refusal must leave byte-for-byte alone: STATE.md, seats.yml and today's log. */
async function bytes(root: string) {
  return {
    state: await readOrNull(localState(root)),
    seats: await readOrNull(seatsFile(root)),
    log: (await cli(root, BARE_ENV, 'log', 'show')).out,
  };
}

/** Nothing in the log or a bullet may name a pane, a session, a pid or a host (the log is git-tracked). */
function expectNoIdentity(text: string): void {
  for (const secret of [PANE_A, PANE_C, SESSION_A, SESSION_C, 'pid=', 'host=']) {
    expect(text).not.toContain(secret);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DOWN_TEXT = 'stood down\nin-flight: none\nowes: none';

interface Verb {
  kind: 'down' | 'update' | 'log';
  label: string;
  argv: string[];
  /** The audit block's title when `--force` writes over another holder. */
  auditTitle: string;
}

const VERBS: readonly Verb[] = [
  {
    kind: 'down',
    label: 'seat --down',
    argv: ['seat', 'builder', '--down', DOWN_TEXT],
    auditTitle: 'seat --down --force over another holder',
  },
  {
    kind: 'update',
    label: 'seat --update',
    argv: ['seat', 'builder', '--update', 'still holding'],
    auditTitle: 'seat --update --force over another holder',
  },
  {
    kind: 'log',
    label: 'log --as builder',
    argv: ['log', '--as', 'builder', 'a log block'],
    auditTitle: 'log --as builder --force over another holder',
  },
];

/** Assert that `verb`'s own write is on disk (and, for `--down`, that the lease is gone). */
async function expectLanded(root: string, verb: Verb): Promise<void> {
  if (verb.kind === 'down') {
    expect(await bulletOf(root, 'builder')).toMatch(
      /builder: DOWN 2026-09-02 22:41Z\.\*\* stood down$/,
    );
  } else if (verb.kind === 'update') {
    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: UP 2026-09-02 22:41Z · A7B2 · acme builder.** still holding',
    );
  } else {
    const blocks = await loggedBlocks(root);
    expect(blocks.some((b) => b.seat === 'BUILDER' && b.text === 'a log block')).toBe(true);
  }
}

for (const verb of VERBS) {
  describe(`${verb.label} is the holder's (RCB-198)`, () => {
    it('(a) the holder: exit 0, the write lands, no audit block; --down drops the lease, --update leaves seats.yml byte-identical', async () => {
      const root = await heldByA();
      const seatsBefore = await readOrNull(seatsFile(root));
      expect(seatsBefore).not.toBeNull();

      const res = await cli(root, ENV_A, ...verb.argv);
      expect(res.code, res.err).toBe(0);
      await expectLanded(root, verb);
      expect((await loggedBlocks(root)).filter((b) => b.title.includes('--force'))).toEqual([]);
      if (verb.kind === 'down') {
        expect(await readLeases(root)).toEqual([]);
      } else {
        expect(await readOrNull(seatsFile(root))).toBe(seatsBefore);
      }
    });

    it('(b) the SAME pane in a new session with a new pid (a restarted Claude) is the same holder: exit 0, no --force, no audit', async () => {
      const root = await heldByA();
      const res = await cli(root, paneEnv(PANE_A, PID_C, 'session-two'), ...verb.argv);
      expect(res.code, res.err).toBe(0);
      await expectLanded(root, verb);
      expect((await loggedBlocks(root)).filter((b) => b.title.includes('--force'))).toEqual([]);
    });

    it('(c) ANOTHER pane: exit 1 naming both labels on stderr; STATE.md, seats.yml and the log are byte-identical', async () => {
      const root = await heldByA();
      const before = await bytes(root);

      const res = await cli(root, ENV_C, ...verb.argv);
      expect(res.code).toBe(1);
      expect(res.err).toBe(`${REFUSAL_C}\n`);
      expect(res.out).toBe('');
      expect(await bytes(root)).toEqual(before);
      // the holder is still the holder
      const holder = parseHolder((await readLeases(root))[0]?.holder ?? '');
      expect(holder.pane).toBe(PANE_A);
    });

    it('(d) ANOTHER pane with --force: exit 0, exactly one audit block naming labels only; --down drops the lease, --update keeps pane A’s', async () => {
      const root = await heldByA();
      const seatsBefore = await readOrNull(seatsFile(root));

      const res = await cli(root, ENV_C, ...verb.argv, '--force');
      expect(res.code, res.err).toBe(0);
      await expectLanded(root, verb);

      const blocks = await loggedBlocks(root);
      const audits = blocks.filter((b) => b.title === verb.auditTitle);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        seat: 'BUILDER',
        text: 'builder is held by A7B2 · acme builder (UP 2026-09-02 22:41Z); written by 0460 · acme',
      });
      expect(blocks.filter((b) => b.title.includes('over another holder'))).toHaveLength(1);
      // the audit is written FIRST: for `log`, it precedes the block that was asked for
      if (verb.kind === 'log') {
        expect(blocks.map((b) => b.title === verb.auditTitle)).toEqual([true, false]);
        expect(blocks[1]?.text).toBe('a log block');
      }
      // the log is git-tracked: labels only, never a pane, session, pid or host
      expectNoIdentity(JSON.stringify(blocks));
      expectNoIdentity(await readFile(localState(root), 'utf8'));

      if (verb.kind === 'down') {
        expect(await readLeases(root)).toEqual([]);
      } else {
        expect(await readOrNull(seatsFile(root))).toBe(seatsBefore);
        expect(parseHolder((await readLeases(root))[0]?.holder ?? '').pane).toBe(PANE_A);
      }
    });

    it('(e) a seat with no lease (a legacy UP bullet) is writable by anyone until it is next claimed: pane C exits 0, no audit — with --force too', async () => {
      for (const force of [false, true]) {
        const root = await heldByA();
        await writeFile(seatsFile(root), serializeLeases({ leases: [], windows: [] }), 'utf8');

        const res = await cli(root, ENV_C, ...verb.argv, ...(force ? ['--force'] : []));
        expect(res.code, `force=${force}: ${res.err}`).toBe(0);
        await expectLanded(root, verb);
        // nothing was overridden, so nothing is audited
        expect(
          (await loggedBlocks(root)).filter((b) => b.title.includes('over another holder')),
        ).toEqual([]);
      }
    });

    it('(e2) a board with no local layer records no holder: exit 0 from any pane, no seats.yml made', async () => {
      const root = await makeBoard(false);
      expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-198')).code).toBe(0);
      expect(existsSync(localDir(root))).toBe(false);

      const res = await cli(root, ENV_C, ...verb.argv);
      expect(res.code, res.err).toBe(0);
      expect(existsSync(localDir(root))).toBe(false);
      expect(
        (await loggedBlocks(root)).filter((b) => b.title.includes('over another holder')),
      ).toEqual([]);
    });

    it('(f) a seats.yml that does not parse: exit 1 naming the file, and STATE.md, seats.yml and the log are byte-identical', async () => {
      const root = await heldByA();
      await writeFile(seatsFile(root), 'leases: [\n  - this is not: yaml\n', 'utf8');
      const before = await bytes(root);

      // even the holder is refused: a lease that cannot be read is never treated as absent
      const res = await cli(root, ENV_A, ...verb.argv);
      expect(res.code).toBe(1);
      expect(res.err).toContain('seats.yml');
      expect(res.err).toContain('nothing was written');
      expect(await bytes(root)).toEqual(before);
    });

    it('(g) the seat is matched the way its bullet is: typed `Builder`, pane C is still refused; with --force a --down drops the lease `seat:builder`', async () => {
      const root = await heldByA();
      const typed = verb.argv.map((a) => (a === 'builder' ? 'Builder' : a));
      const before = await bytes(root);

      const refused = await cli(root, ENV_C, ...typed);
      expect(refused.code).toBe(1);
      expect(refused.err).toBe(`${REFUSAL_C}\n`);
      expect(await bytes(root)).toEqual(before);

      const forced = await cli(root, ENV_C, ...typed, '--force');
      expect(forced.code, forced.err).toBe(0);
      if (verb.kind === 'down') expect(await readLeases(root)).toEqual([]);
      expect((await loggedBlocks(root)).filter((b) => b.title === verb.auditTitle)).toHaveLength(1);
    });

    it('(h) the WHOLE write is inside seats.yml’s lock: with the lock held elsewhere nothing is written; released, it lands', async () => {
      const root = await heldByA();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = withFileLock(seatsFile(root), () => gate);
      for (let i = 0; i < 400 && !existsSync(`${seatsFile(root)}.lock`); i++) await sleep(5);
      expect(existsSync(`${seatsFile(root)}.lock`)).toBe(true);
      const before = await bytes(root);

      let finished = false;
      const running = cli(root, ENV_A, ...verb.argv).then((res) => {
        finished = true;
        return res;
      });
      await sleep(500);
      expect(finished).toBe(false);
      expect(await bytes(root)).toEqual(before);

      release();
      await held;
      const res = await running;
      expect(res.code, res.err).toBe(0);
      await expectLanded(root, verb);
      expect(existsSync(`${seatsFile(root)}.lock`)).toBe(false);
    }, 30_000);
  });
}

describe('the store: a caller with no holder is "web" — a non-holder (RCB-198)', () => {
  it('setSeatBullet DOWN, updateSeatBullet and appendSeatLog with no holder are refused naming `web`; force writes each; a DOWN with no holder and no lease needs nothing', async () => {
    const root = await heldByA();
    const store = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const before = await bytes(root);

    const down = await store.setSeatBullet('builder', 'DOWN', DOWN_TEXT);
    const update = await store.updateSeatBullet('builder', 'x');
    const log = await store.appendSeatLog('builder', 'x', undefined);
    for (const outcome of [down, update, log]) {
      expect(outcome).toEqual({ ok: false, error: REFUSAL_WEB, refused: true });
    }
    expect(await bytes(root)).toEqual(before);

    const forcedUpdate = await store.updateSeatBullet('builder', 'x', null, { force: true });
    expect(forcedUpdate.ok).toBe(true);
    const forcedLog = await store.appendSeatLog('builder', 'x', undefined, null, { force: true });
    expect(forcedLog.ok).toBe(true);
    const forcedDown = await store.setSeatBullet('builder', 'DOWN', DOWN_TEXT, null, {
      force: true,
    });
    expect(forcedDown.ok).toBe(true);
    expect(await readLeases(root)).toEqual([]);

    // the lease is gone: the same three calls need no force now
    expect((await store.setSeatBullet('builder', 'DOWN', DOWN_TEXT)).ok).toBe(true);
    expect((await store.updateSeatBullet('builder', 'y')).ok).toBe(true);
    expect((await store.appendSeatLog('builder', 'y', undefined)).ok).toBe(true);
  });

  it('an empty text is refused BEFORE the check: no audit block is written for a block that would fail', async () => {
    const root = await heldByA();
    const store = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const before = await bytes(root);

    const res = await store.appendSeatLog('builder', '   ', undefined, null, { force: true });
    expect(res).toEqual({ ok: false, error: 'text must not be empty' });
    expect(await bytes(root)).toEqual(before);
  });
});

describe('MCP append_repo_log writes as the server’s own holder (RCB-198)', () => {
  /** One MCP server over `root`, its holder as given (omitted = no pane). */
  async function mcpAppend(
    root: string,
    holder: SeatHolder | undefined,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const store = await openStore(root, { watch: false, now: () => NOW });
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW, holder });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      return (await client.callTool({
        name: 'append_repo_log',
        arguments: args,
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  }

  const textOf = (res: CallToolResult): string => {
    const first = res.content[0];
    if (first?.type !== 'text') throw new Error('expected a text result');
    return first.text;
  };

  it('holder A writes; holder C is an error result naming both labels with nothing written; C with force writes and audits; no holder is `web`', async () => {
    const root = await heldByA();
    const probe = await openStore(root, { watch: false, now: () => NOW });
    cleanups.push(() => probe.close());
    const holderA = await holderFromEnv(ENV_A, probe.config);
    const holderC = await holderFromEnv(ENV_C, probe.config);
    const args = { seat: 'builder', text: 'from mcp' };

    const asA = await mcpAppend(root, holderA, args);
    expect(asA.isError, textOf(asA)).toBeFalsy();
    expect((await loggedBlocks(root)).map((b) => b.text)).toEqual(['from mcp']);

    const before = await bytes(root);
    const asC = await mcpAppend(root, holderC, args);
    expect(asC.isError).toBe(true);
    expect(textOf(asC)).toBe(REFUSAL_C);
    const asWeb = await mcpAppend(root, undefined, args);
    expect(asWeb.isError).toBe(true);
    expect(textOf(asWeb)).toBe(REFUSAL_WEB);
    // `force: false` is not a way round it either
    const notForced = await mcpAppend(root, holderC, { ...args, force: false });
    expect(notForced.isError).toBe(true);
    expect(await bytes(root)).toEqual(before);

    const forced = await mcpAppend(root, holderC, { ...args, force: true });
    expect(forced.isError, textOf(forced)).toBeFalsy();
    const blocks = await loggedBlocks(root);
    expect(blocks.map((b) => b.title)).toEqual([
      'from mcp',
      'log --as builder --force over another holder',
      'from mcp',
    ]);
    expect(blocks[1]?.text).toBe(
      'builder is held by A7B2 · acme builder (UP 2026-09-02 22:41Z); written by 0460 · acme',
    );
    expectNoIdentity(JSON.stringify(blocks));
  });

  it('the tool carries `force` in its schema and is still inside the 700 B pin', async () => {
    const root = await makeBoard(false);
    const store = await openStore(root, { watch: false, now: () => NOW });
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      await store.close();
    });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'append_repo_log');
    expect(tool?.inputSchema.properties).toHaveProperty('force');
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThanOrEqual(700);
  });
});

describe('HTTP POST /api/log writes as `web` (RCB-198)', () => {
  it('a held seat is 409 naming `web` with nothing written; force: true is 200 and audited; a non-boolean force is 400', async () => {
    const root = await heldByA();
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = `${server.url.replace(/\/$/, '')}/api/log`;
    const post = (body: Record<string, unknown>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const before = await bytes(root);

    const refused = await post({ seat: 'builder', text: 'from the web' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(REFUSAL_WEB);
    const notForced = await post({ seat: 'builder', text: 'from the web', force: false });
    expect(notForced.status).toBe(409);
    expect(await bytes(root)).toEqual(before);

    // Truthy is not `true`: a string is a malformed request, not a way round the refusal.
    const stringly = await post({ seat: 'builder', text: 'from the web', force: 'true' });
    expect(stringly.status).toBe(400);
    expect(((await stringly.json()) as { error: string }).error).toBe('force must be a boolean');
    expect(await bytes(root)).toEqual(before);

    const forced = await post({ seat: 'builder', text: 'from the web', force: true });
    expect(forced.status).toBe(200);
    const blocks = await loggedBlocks(root);
    expect(blocks.map((b) => b.title)).toEqual([
      'log --as builder --force over another holder',
      'from the web',
    ]);
    expect(blocks[0]?.text).toBe(
      'builder is held by A7B2 · acme builder (UP 2026-09-02 22:41Z); written by web',
    );
    expectNoIdentity(JSON.stringify(blocks));
  });

  it('a seat nobody holds needs no force: 200', async () => {
    const root = await makeBoard(true);
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seat: 'builder', text: 'nobody holds it' }),
    });
    expect(res.status).toBe(200);
  });
});
