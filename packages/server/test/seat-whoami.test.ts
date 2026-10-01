/**
 * RCB-199 (slice B of RCB-194's S4): who holds a seat, asked from outside. `seat whoami` answers
 * for THIS pane, `seat list` shows the holder next to each bullet, and `seat <name>` (and the MCP
 * `get_seat`) carry the seat's holder in the bundle. All of it is a READ of
 * `.repoboard/local/seats.yml`: nothing here may create a file or a lock.
 *
 * Two panes are two live processes: pane A is this process (`process.pid`), pane B its parent
 * (`process.ppid`). One pid is one holder (`sameHolder`), so two panes that share a pid would be
 * the SAME holder. Every `run` below is handed an explicit `env` — the machine running the suite
 * may itself be an iTerm pane, and its own ITERM_SESSION_ID/CLAUDE_PID must never reach a fixture.
 * All boards live under `os.tmpdir()`. A dead holder is made the way `seat-claim.test.ts` makes
 * one: pid 99999999 patched into `seats.yml`.
 *
 * CONTROL (run by the seat, not part of the suite): (1) have the store's `seatHolders` take
 * `withFileLock(this.seatsPath, …)` around its read — (g) must fail, whoami then waits out the
 * lock `(g)` holds. (2) Make `seat whoami` fall through to the bundle (delete its `typedName ===
 * 'whoami'` branch) — every test here that reads `label` fails. (3) Break the direction you fear
 * for the DEAD line: have `renderSeatList` emit the `!` line for every row — (l2) fails on the
 * live one.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import {
  defaultBoardConfig,
  formatHolder,
  parseHolder,
  parseLeases,
  type SeatHolder,
  serializeBoard,
  serializeLeases,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { localDir } from '../src/local.js';
import { makeTempRepoboard, NOW } from './helpers.js';

/** Two panes whose ids share their first four characters (`A7B2`); only pane A is used here. */
const PANE_A = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
/** A pane that shares nothing with pane A. */
const PANE_C = '0460D7A9-3E1F-4B2C-9D8E-5A6B7C8D9E0F';
const SESSION_A = 'session-a-7f3a9c2e-privacy-marker';
/** The two live pids: this process and its parent. */
const PID_A = process.pid;
const PID_B = process.ppid;
/** A pid that names no process (`kill -0` says ESRCH). */
const DEAD_PID = 99999999;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** `env` is ALWAYS explicit — the machine running the suite may itself be an iTerm pane. */
async function cli(root: string, env: Record<string, string>, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd: root, stdout, stderr, env, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

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
/** Pane C is a different pane in a different process (this one's parent). */
const ENV_C = paneEnv(PANE_C, PID_B, 'session-c');
/** No pane env at all — only a pid (the parent's, never the recorded holder's). */
const ENV_NO_PANE: Record<string, string> = {
  REPOBOARD_ACTOR: 'test-actor',
  CLAUDE_PID: String(PID_B),
};
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

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

const seatsFile = (root: string) => join(localDir(root), 'seats.yml');

async function readLeaseDoc(root: string) {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc;
}

/** Overwrite fields of `seat`'s recorded holder in `seats.yml` — how a test makes a holder dead. */
async function patchHolder(root: string, seat: string, patch: Partial<SeatHolder>): Promise<void> {
  const doc = await readLeaseDoc(root);
  const leases = doc.leases.map((l) =>
    l.resource === `seat:${seat}`
      ? { ...l, holder: formatHolder({ ...parseHolder(l.holder), ...patch }) }
      : l,
  );
  await writeFile(seatsFile(root), serializeLeases({ ...doc, leases }), 'utf8');
}

/** The holder recorded for `seat`, parsed back. */
async function holderOf(root: string, seat: string): Promise<SeatHolder> {
  const lease = (await readLeaseDoc(root)).leases.find((l) => l.resource === `seat:${seat}`);
  if (lease === undefined) throw new Error(`no lease for ${seat}`);
  return parseHolder(lease.holder);
}

/** Record `seat` as held by `holder` too — how ONE pane comes to hold two seats, which `seat --up`
 * itself refuses (it needs `--from`). */
async function addLease(root: string, seat: string, holder: SeatHolder): Promise<void> {
  const doc = await readLeaseDoc(root);
  const lease = {
    resource: `seat:${seat}`,
    holder: formatHolder(holder),
    since: '2026-09-02T22:41:10Z',
  };
  await writeFile(
    seatsFile(root),
    serializeLeases({ ...doc, leases: [...doc.leases, lease] }),
    'utf8',
  );
}

/** Every file (sha1 of its bytes) and directory under `root` — a tree a read must leave identical. */
async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await walk(path);
      } else {
        out[rel] = createHash('sha1')
          .update(await readFile(path))
          .digest('hex');
      }
    }
  };
  await walk(root);
  return out;
}

/** A board with `builder` UP from pane A (a live holder: this very process). */
async function boardWithBuilderUp(): Promise<string> {
  const root = await makeBoard(true);
  const up = await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-199');
  expect(up.code).toBe(0);
  return root;
}

describe('seat whoami (RCB-199 slice B)', () => {
  it('(a) the pane that holds a seat is told so: `A7B2 · acme builder`, exit 0, nothing on stderr', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(0);
    expect(res.out).toBe('A7B2 · acme builder\n');
    expect(res.err).toBe('');
  });

  it('(b) two panes, two labels: another pane holds no seat — `0460 · no seat`, exit 0', async () => {
    const root = await boardWithBuilderUp();
    const mine = await cli(root, ENV_A, 'seat', 'whoami');
    const other = await cli(root, ENV_C, 'seat', 'whoami');
    expect(other.code).toBe(0);
    expect(other.err).toBe('');
    expect(mine.out).toBe('A7B2 · acme builder\n');
    expect(other.out).toBe('0460 · no seat\n');
  });

  it('(b2) the same pane after /clear — a new session and a new pid — is still the seat it held', async () => {
    const root = await boardWithBuilderUp();
    const cleared = await cli(
      root,
      paneEnv(PANE_A, PID_B, 'session-after-clear'),
      'seat',
      'whoami',
    );
    expect(cleared.code).toBe(0);
    expect(cleared.out).toBe('A7B2 · acme builder\n');
  });

  it('(c) --json: label, tag, seat, alsoHolds, this holder, the seat’s lease, its bullet', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'whoami', '--json');
    expect(res.code).toBe(0);
    const json = JSON.parse(res.out) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      ['alsoHolds', 'bullet', 'holder', 'label', 'lease', 'seat', 'tag'].sort(),
    );
    expect(json).toMatchObject({
      label: 'A7B2 · acme builder',
      tag: 'A7B2',
      seat: 'builder',
      alsoHolds: [],
      holder: { pane: PANE_A, session: SESSION_A, pid: PID_A, host: hostname() },
      lease: {
        seat: 'builder',
        tag: 'A7B2',
        label: 'A7B2 · acme builder',
        holder: { pane: PANE_A, pid: PID_A },
        liveness: { state: 'alive' },
      },
    });
    // the start time is measured (`ps`), never a placeholder — and it is the one the lease recorded
    const me = json.holder as SeatHolder;
    expect(typeof me.start).toBe('string');
    expect((json.lease as { holder: SeatHolder }).holder.start).toBe(me.start);
    expect(typeof (json.lease as { since: unknown }).since).toBe('string');
    expect(json.bullet).toContain('builder: UP 2026-09-02 22:41Z');
    expect(json.bullet).toContain('A7B2 · acme builder');
  });

  it('(c2) --json for a pane that holds nothing: seat, lease and bullet are null; alsoHolds is []', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_C, 'seat', 'whoami', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({
      label: '0460 · no seat',
      tag: '0460',
      seat: null,
      alsoHolds: [],
      lease: null,
      bullet: null,
      holder: { pane: PANE_C, pid: PID_B },
    });
  });

  it('(d) a process with no pane env at all: `(no pane) · no seat`, exit 0', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_NO_PANE, 'seat', 'whoami');
    expect(res.code).toBe(0);
    expect(res.out).toBe('(no pane) · no seat\n');
    const json = await cli(root, ENV_NO_PANE, 'seat', 'whoami', '--json');
    expect(JSON.parse(json.out)).toMatchObject({
      tag: '(no pane)',
      seat: null,
      holder: { pane: null },
    });
  });

  it('(e) a pane recorded as holding two seats says so: ` (also holds tester)`; --json alsoHolds names it', async () => {
    const root = await boardWithBuilderUp();
    await addLease(root, 'tester', await holderOf(root, 'builder'));
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(0);
    expect(res.out).toBe('A7B2 · acme builder (also holds tester)\n');
    const json = await cli(root, ENV_A, 'seat', 'whoami', '--json');
    expect(JSON.parse(json.out)).toMatchObject({ seat: 'builder', alsoHolds: ['tester'] });
  });

  it('(f) a board with no local layer records no holder: `A7B2 · no seat`, exit 0, and nothing is created', async () => {
    const root = await makeBoard(false);
    const before = await treeSnapshot(root);
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(0);
    expect(res.out).toBe('A7B2 · no seat\n');
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it('(g) whoami is a READ: the tree stays byte-identical, and it answers while seats.yml is locked by someone else', async () => {
    const root = await boardWithBuilderUp();
    // A live process holds both locks (this one, just now): a reader that took either would wait
    // out its 5 s timeout and fail — whoami must not wait at all.
    const lockLine = `${process.pid} ${new Date().toISOString()}\n`;
    await writeFile(`${seatsFile(root)}.lock`, lockLine);
    await writeFile(join(localDir(root), 'STATE.md.lock'), lockLine);
    const before = await treeSnapshot(root);
    const seatsBefore = await readFile(seatsFile(root), 'utf8');

    for (const args of [['whoami'], ['whoami', '--json']]) {
      const res = await cli(root, ENV_A, 'seat', ...args);
      expect(res.code).toBe(0);
      expect(res.err).toBe('');
    }
    const other = await cli(root, ENV_C, 'seat', 'whoami');
    expect(other.out).toBe('0460 · no seat\n');

    expect(await treeSnapshot(root)).toEqual(before);
    expect(await readFile(seatsFile(root), 'utf8')).toBe(seatsBefore);
  });

  it('(h) a seats.yml that does not parse is exit 1 with `seat whoami: …` on stderr — never a guess', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), 'leases: [\n', 'utf8');
    const before = await treeSnapshot(root);
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(1);
    expect(res.out).toBe('');
    expect(res.err).toMatch(/^seat whoami: .*seats\.yml/);
    const json = await cli(root, ENV_A, 'seat', 'whoami', '--json');
    expect(json.code).toBe(1);
    expect(json.out).toBe('');
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it('(i) --up/--down/--update with whoami is a usage error, and nothing is written', async () => {
    const root = await boardWithBuilderUp();
    const before = await treeSnapshot(root);
    const res = await cli(root, ENV_A, 'seat', 'whoami', '--down', 'x');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/not valid with whoami/);
    expect(await treeSnapshot(root)).toEqual(before);
  });
});

describe('seat list shows who holds each seat (RCB-199 slice B)', () => {
  /** builder: held by pane A (alive); tester: held by pane C, whose process is then gone. */
  async function boardWithLiveAndDead(): Promise<string> {
    const root = await boardWithBuilderUp();
    const up = await cli(root, ENV_C, 'seat', 'tester', '--up', 'testing RCB-199');
    expect(up.code).toBe(0);
    await patchHolder(root, 'tester', { pid: DEAD_PID });
    return root;
  }

  it('(l1) the header names PANE, LABEL and LIVE; a live holder reads `alive`', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'list');
    expect(res.code).toBe(0);
    expect(res.err).toBe('');
    const lines = res.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^NAME\s+STATUS\s+STAMP\s+PANE\s+LABEL\s+LIVE\s+IN-FLIGHT$/);
    expect(lines[1]).toMatch(
      /^builder\s+UP\s+2026-09-02 22:41Z\s+A7B2\s+A7B2 · acme builder\s+alive\s+-$/,
    );
    // a live holder makes no `!` line
    expect(lines).toHaveLength(2);
  });

  it('(l2) a dead holder reads `dead: no process`, and ONLY that row gets a `!` line', async () => {
    const root = await boardWithLiveAndDead();
    const res = await cli(root, ENV_A, 'seat', 'list');
    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    const builder = lines.find((l) => l.startsWith('builder'));
    const tester = lines.find((l) => l.startsWith('tester'));
    expect(builder).toMatch(/\s+A7B2\s+A7B2 · acme builder\s+alive\s+-$/);
    expect(tester).toMatch(/\s+0460\s+0460 · acme tester\s+dead: no process\s+-$/);
    const bangs = lines.filter((l) => l.startsWith('! '));
    expect(bangs).toEqual(['! tester UP: holder 0460 is dead: no process']);
  });

  it('(l3) --json is SeatListRow[]: name/status/stamp/inFlight plus label, tag and the liveness object', async () => {
    const root = await boardWithLiveAndDead();
    const res = await cli(root, ENV_A, 'seat', 'list', '--json');
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.out) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.name)).toEqual(['builder', 'tester']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['inFlight', 'label', 'live', 'name', 'stamp', 'status', 'tag'].sort(),
      );
    }
    expect(rows[0]).toMatchObject({
      status: 'UP',
      label: 'A7B2 · acme builder',
      tag: 'A7B2',
      live: { state: 'alive' },
    });
    expect(rows[1]).toMatchObject({
      status: 'UP',
      label: '0460 · acme tester',
      tag: '0460',
      live: { state: 'dead', reason: 'no-process' },
    });
  });

  it('(l4) a seats.yml that does not parse is a stderr `warning:`; the rows still print, holder columns `-`', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), 'leases: [\n', 'utf8');
    const res = await cli(root, ENV_A, 'seat', 'list');
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/^warning: .*seats\.yml/);
    // the bullet's own label is still what it says; the recorded holder is unknown
    expect(res.out.trimEnd().split('\n')[1]).toMatch(
      /^builder\s+UP\s+2026-09-02 22:41Z\s+-\s+A7B2 · acme builder\s+-\s+-$/,
    );
    const json = await cli(root, ENV_A, 'seat', 'list', '--json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject([{ name: 'builder', tag: null, live: null }]);
  });
});

describe('seat <name> carries the seat’s holder in its bundle (RCB-199 slice B)', () => {
  it('(s1) --json: `holder` is the recorded holder with tag, label and liveness; `holderError` is null', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'builder', '--json');
    expect(res.code).toBe(0);
    const bundle = JSON.parse(res.out) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      name: 'builder',
      holder: {
        seat: 'builder',
        tag: 'A7B2',
        label: 'A7B2 · acme builder',
        holder: { pane: PANE_A },
        liveness: { state: 'alive' },
      },
      holderError: null,
    });
  });

  it('(s2) a seat with no lease has `holder: null`', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'tester', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({ name: 'tester', holder: null, holderError: null });
  });

  it('(s3) a seats.yml that does not parse: the bundle still prints, `holder` null, `holderError` says why, stderr warns', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), 'leases: [\n', 'utf8');
    const res = await cli(root, ENV_A, 'seat', 'builder', '--json');
    expect(res.code).toBe(0);
    expect(res.err).toContain('warning: ');
    expect(res.err).toContain('seats.yml');
    const bundle = JSON.parse(res.out) as { holder: unknown; holderError: string };
    expect(bundle.holder).toBeNull();
    expect(bundle.holderError).toContain('seats.yml');
  });
});
