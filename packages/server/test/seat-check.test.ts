/**
 * RCB-200 (slice B): `repoboard check` shows the six SEATS findings. Core's `seatCheckFindings`
 * (slice A) judges them; `store.check` gathers what it needs (the SEATS section, the log blocks,
 * the recorded holders with their pid probed) and passes the result through. This file is the
 * wire: it drives `run(['check', '--json'])` against boards under `os.tmpdir()`, and every board's
 * STATE.md, log file and `seats.yml` is written HERE, directly, so the finding each one is meant
 * to fire is readable from the fixture.
 *
 * Two live processes stand in for two live panes: pane A is this process (`process.pid`), pane B
 * its parent (`process.ppid`); one pid is one holder (`sameHolder`), so they cannot share one. A
 * holder's start time is the one the store records (`processStartTime`, `ps -o lstart=`). A dead
 * holder is pid 99999999 (`kill -0` says ESRCH). Every `run` below is handed an explicit `env` —
 * the machine running the suite may itself be an iTerm pane, and its own ITERM_SESSION_ID and
 * CLAUDE_PID must never reach a fixture. The clock is fixed (`NOW`), so "logged after it stood
 * down" is decided on the fixture's times, never on today's.
 *
 * CONTROL (run by the seat, not part of the suite): (1) have `check` hand `seatCheckFindings` `[]`
 * instead of `null` for a board with no local layer (`seatHolders()` itself answers `[]` there) —
 * (c) fails: the labelled UP bullet then has "no lease" to disagree with. (2) The same on a
 * `seats.yml` that does not parse (`[]` where `held.error` is set) — (d) fails. (3) Drop the
 * `seatFindings:` property from the `checkFindings` call — (a) fails (six kinds missing), and so do
 * (b2), (c) and (d), whose non-holder finding disappears with it.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendLogBlock,
  dailyLogHeader,
  defaultBoardConfig,
  type Finding,
  formatHolder,
  formatLogBlock,
  initialStateText,
  parseHolder,
  parseLeases,
  type SeatHolder,
  serializeBoard,
  serializeLeases,
  setStateSection,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { processStartTime } from '../src/holder.js';
import { localDir } from '../src/local.js';
import { makeTempRepoboard } from './helpers.js';

/** The fixture clock: after every stamp and log block below, so `stale-state` never fires. */
const NOW = new Date('2026-09-30T01:00:00Z');
const DAY = '2026-09-30';
/** The board's display name (board.yml `name`): the `[seatboard]` prefix on its bullets and blocks. */
const BOARD = 'seatboard';

/** Three panes with distinct first four characters (`A7B2`, `1D3F`, `D00D`). */
const PANE_BUILDER = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
const PANE_OPS = '1D3F9C41-7D2A-4B6F-8E13-5A9C0B7D2E14';
const PANE_SCOUT = 'D00D7A15-3C9E-4F21-B8A6-1E4D7C2B9F03';
const SESSION_A = 'session-a-7f3a9c2e-privacy-marker';
/** The two live pids: this process and its parent. */
const PID_A = process.pid;
const PID_B = process.ppid;
/** A pid that names no process (`kill -0` says ESRCH). */
const DEAD_PID = 99999999;

/** The six kinds this card adds — every other finding on a fixture board is noise to these tests. */
const SEAT_KINDS: readonly Finding['kind'][] = [
  'seat-duplicate-bullet',
  'seat-name-ambiguous',
  'seat-log-while-down',
  'seat-up-dead-holder',
  'pane-holds-two-seats',
  'seat-lease-bullet-drift',
];

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

const ENV_A = paneEnv(PANE_BUILDER, PID_A, SESSION_A);
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

/** A board named `seatboard` with short name `acme`, with or without a local layer (`local init`). */
async function makeBoard(withLocal: boolean): Promise<string> {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  await writeFile(
    join(repo.root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: BOARD, shortName: 'acme' }),
  );
  if (withLocal) {
    const init = await cli(repo.root, BARE_ENV, 'local', 'init');
    expect(init.code).toBe(0);
  }
  return repo.root;
}

const seatsFile = (root: string) => join(localDir(root), 'seats.yml');
const localStateFile = (root: string) => join(localDir(root), 'STATE.md');
const localLogFile = (root: string) => join(localDir(root), 'log', `${DAY}.md`);

/** STATE.md with `seats` as its SEATS section, stamped `NOW` — at `where`, the top level or the local layer. */
async function writeState(root: string, seats: string, where: 'top' | 'local'): Promise<void> {
  const opts = { now: NOW, actor: 'test-actor' };
  const made = setStateSection(initialStateText(opts), 'seats', seats, opts);
  if (!made.ok) throw new Error(made.error);
  const path = where === 'local' ? localStateFile(root) : join(root, '.repoboard', 'STATE.md');
  await writeFile(path, made.text, 'utf8');
}

interface LoggedBlock {
  seat: string;
  ts: string;
}

/** One `[seatboard] <SEAT> <ts>: note` block per entry, in the shape `repoboard log` writes. */
function logBlock(b: LoggedBlock): string {
  return formatLogBlock({ seat: b.seat, ts: b.ts, title: 'note', text: 'x', repo: BOARD });
}

/** A daily log file at `path` holding `blocks`, oldest first. */
async function writeLog(path: string, blocks: readonly LoggedBlock[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let text = `${dailyLogHeader(DAY)}\n`;
  for (const b of blocks) text = appendLogBlock(text, logBlock(b));
  await writeFile(path, text, 'utf8');
}

function holderAt(pane: string, pid: number, start: string | null): SeatHolder {
  return { pane, session: null, start, host: hostname(), pid };
}

/** `seats.yml` recording exactly `held`, in that order — the file `seat --up` would have written. */
async function writeSeats(
  root: string,
  held: readonly { seat: string; holder: SeatHolder }[],
): Promise<void> {
  const leases = held.map(({ seat, holder }) => ({
    resource: `seat:${seat}`,
    holder: formatHolder(holder),
    since: '2026-09-29T18:00:00Z',
  }));
  await writeFile(seatsFile(root), serializeLeases({ leases, windows: [] }), 'utf8');
}

/** Overwrite fields of `seat`'s recorded holder in `seats.yml` — how a test makes a holder dead. */
async function patchHolder(root: string, seat: string, patch: Partial<SeatHolder>): Promise<void> {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  const leases = parsed.doc.leases.map((l) =>
    l.resource === `seat:${seat}`
      ? { ...l, holder: formatHolder({ ...parseHolder(l.holder), ...patch }) }
      : l,
  );
  await writeFile(seatsFile(root), serializeLeases({ ...parsed.doc, leases }), 'utf8');
}

/** `check --json`: the exit code, and the findings — stderr must be silent (no throw, no warning). */
async function check(root: string): Promise<{ code: number; findings: Finding[] }> {
  const res = await cli(root, BARE_ENV, 'check', '--json');
  expect(res.err).toBe('');
  return { code: res.code, findings: JSON.parse(res.out) as Finding[] };
}

const seatKindsOf = (findings: readonly Finding[]): string[] =>
  findings.filter((f) => SEAT_KINDS.includes(f.kind)).map((f) => f.kind);

/** A stand-down in the shape `seat --down` writes: a stamp, then the `in-flight:` and `owes:` lines. */
const coordinatorDown = (stamp: string): string =>
  `- **[${BOARD}] coordinator: DOWN ${stamp}.** stood down\n  in-flight: none\n  owes: none`;

/**
 * ONE seeded bad board, one finding of each kind (the bullet numbers count the unstamped one):
 * - `builder` is stamped twice (bullets 1 and 3)                       -> seat-duplicate-bullet
 * - `ops` is stamped for this board and for `[elsewhere]` (4, 5)       -> seat-name-ambiguous
 * - `coordinator` is DOWN 20:16Z and logged at 00:38Z                  -> seat-log-while-down
 * - `scout` is UP, its holder's pid is gone                            -> seat-up-dead-holder
 * - `ops` and `writer` are both held by pane 1D3F                      -> pane-holds-two-seats
 * - `writer` holds a lease and has no bullet                           -> seat-lease-bullet-drift
 * `builder`, `ops` and `scout` carry the label of the pane that holds them, so no other drift.
 */
const BAD_SEATS = [
  `- **[${BOARD}] builder: UP 2026-09-29 18:00Z · A7B2 · acme builder.** in-flight: RCB-200`,
  '- Owner tasks elsewhere: ACME-9',
  `- **[${BOARD}] builder: UP 2026-09-29 19:00Z · A7B2 · acme builder.** in-flight: none`,
  `- **[${BOARD}] ops: UP 2026-09-29 18:30Z · 1D3F · acme ops.** watching CI`,
  '- **[elsewhere] ops: UP 2026-09-29 18:40Z.** watching the other board',
  `- **[${BOARD}] scout: UP 2026-09-29 18:50Z · D00D · acme scout.** reading`,
  coordinatorDown('2026-09-29 20:16Z'),
].join('\n');

async function seededBadBoard(): Promise<string> {
  const root = await makeBoard(true);
  await writeState(root, BAD_SEATS, 'local');
  await writeLog(localLogFile(root), [{ seat: 'coordinator', ts: '2026-09-30T00:38:12Z' }]);
  const startA = await processStartTime(PID_A);
  const startB = await processStartTime(PID_B);
  await writeSeats(root, [
    { seat: 'builder', holder: holderAt(PANE_BUILDER, PID_A, startA) },
    { seat: 'ops', holder: holderAt(PANE_OPS, PID_B, startB) },
    { seat: 'writer', holder: holderAt(PANE_OPS, PID_B, startB) },
    { seat: 'scout', holder: holderAt(PANE_SCOUT, DEAD_PID, startA) },
  ]);
  return root;
}

/**
 * A clean board: a REAL `seat builder --up` from pane A (bullet and lease written by the store,
 * the label the pane's own) beside a DOWN coordinator whose newest log block is in its DOWN minute
 * (00:10:40Z is minute 00:10; the bullet's stamp has minute resolution, so that block is the last
 * one it wrote before it stood down, not one after it).
 */
async function cleanBoard(): Promise<string> {
  const root = await makeBoard(true);
  await writeState(root, coordinatorDown('2026-09-30 00:10Z'), 'local');
  await writeLog(localLogFile(root), [
    { seat: 'coordinator', ts: '2026-09-30T00:02:00Z' },
    { seat: 'coordinator', ts: '2026-09-30T00:10:40Z' },
  ]);
  const up = await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-200');
  expect(up.code).toBe(0);
  return root;
}

describe('check shows the SEATS findings (RCB-200 slice B)', () => {
  it('(a) a seeded bad board fires each of the six kinds exactly once, and exits 1', async () => {
    const root = await seededBadBoard();
    const { code, findings } = await check(root);

    expect(seatKindsOf(findings).sort()).toEqual([...SEAT_KINDS].sort());
    const of = (kind: Finding['kind']): Finding => {
      const found = findings.find((f) => f.kind === kind);
      if (found === undefined) throw new Error(`no ${kind} finding`);
      return found;
    };
    expect(of('seat-duplicate-bullet').level).toBe('error');
    expect(of('seat-duplicate-bullet').message).toContain(
      'bullets 1 and 3 are both seat "builder"',
    );
    expect(of('seat-name-ambiguous').level).toBe('warning');
    expect(of('seat-name-ambiguous').message).toContain('seat "ops" is stamped on 2 boards');
    // RCB-207: the bullet a seat verb takes is the FIRST ops bullet (4; 5 is `[elsewhere]`'s).
    expect(of('seat-name-ambiguous').message.endsWith(' — a seat verb takes bullet 4')).toBe(true);
    expect(of('seat-log-while-down').level).toBe('warning');
    expect(of('seat-log-while-down').message).toContain(
      'seat "coordinator" is DOWN since 2026-09-29 20:16Z but its newest log block is 2026-09-30T00:38:12Z',
    );
    expect(of('seat-up-dead-holder').level).toBe('warning');
    expect(of('seat-up-dead-holder').message).toContain(
      'seat "scout" is UP but its holder D00D is dead: no process',
    );
    expect(of('pane-holds-two-seats').level).toBe('error');
    expect(of('pane-holds-two-seats').message).toContain('1D3F holds ops and writer');
    expect(of('seat-lease-bullet-drift').level).toBe('warning');
    expect(of('seat-lease-bullet-drift').message).toContain(
      'seat "writer": lease says held by 1D3F; SEATS has no bullet for it',
    );

    expect(code).toBe(1);
    // the exit code is the seat findings' own: nothing else on this board is an error
    expect(findings.filter((f) => !SEAT_KINDS.includes(f.kind) && f.level === 'error')).toEqual([]);
  });

  it('(b) a clean board — a real seat --up, a DOWN coordinator whose block is in its DOWN minute — has none of the six, exit 0', async () => {
    const root = await cleanBoard();

    // the board is what it claims to be: both bullets are in STATE.md, and the lease is recorded
    const state = await readFile(localStateFile(root), 'utf8');
    expect(state).toContain(`[${BOARD}] coordinator: DOWN 2026-09-30 00:10Z.`);
    expect(state).toContain(`[${BOARD}] builder: UP 2026-09-30 01:00Z · A7B2 · acme builder.`);
    expect(await readFile(seatsFile(root), 'utf8')).toContain('seat:builder');

    const { code, findings } = await check(root);
    expect(seatKindsOf(findings)).toEqual([]);
    expect(code).toBe(0);
  });

  it('(b2) the clean board is not clean by vacuity: a block a minute after the DOWN, then a gone holder, each fire their one finding', async () => {
    const root = await cleanBoard();
    const log = localLogFile(root);
    await writeFile(
      log,
      appendLogBlock(
        await readFile(log, 'utf8'),
        logBlock({ seat: 'coordinator', ts: '2026-09-30T00:11:00Z' }),
      ),
      'utf8',
    );
    const logged = await check(root);
    expect(seatKindsOf(logged.findings)).toEqual(['seat-log-while-down']);
    expect(logged.code).toBe(0); // a warning: blocks only with --strict

    await patchHolder(root, 'builder', { pid: DEAD_PID });
    const gone = await check(root);
    expect(seatKindsOf(gone.findings).sort()).toEqual([
      'seat-log-while-down',
      'seat-up-dead-holder',
    ]);
  });

  it('(c) with no .repoboard/local there is no holder to disagree with: a labelled UP bullet fires nothing (inert), the log check still runs', async () => {
    const root = await makeBoard(false);
    expect(existsSync(localDir(root))).toBe(false);
    await writeState(
      root,
      [
        `- **[${BOARD}] builder: UP 2026-09-30 00:30Z · A7B2 · acme builder.** working`,
        coordinatorDown('2026-09-29 20:16Z'),
      ].join('\n'),
      'top',
    );
    await writeLog(join(root, '.repoboard', 'log', `${DAY}.md`), [
      { seat: 'coordinator', ts: '2026-09-30T00:38:12Z' },
    ]);

    const { code, findings } = await check(root);
    // no seat-lease-bullet-drift for `builder` — and `seatFindings` IS wired in on this board
    expect(seatKindsOf(findings)).toEqual(['seat-log-while-down']);
    expect(code).toBe(0);
    expect(existsSync(localDir(root))).toBe(false); // a read: check created nothing
  });

  it('(d) a seats.yml that does not parse: no holder finding, and check still answers (no throw, no stderr)', async () => {
    const root = await makeBoard(true);
    // `builder` is stamped twice and labelled UP with no lease readable: were the unreadable file
    // taken for "no leases", both labelled bullets would be drift
    await writeState(
      root,
      [
        `- **[${BOARD}] builder: UP 2026-09-30 00:30Z · A7B2 · acme builder.** working`,
        `- **[${BOARD}] scout: UP 2026-09-30 00:31Z · D00D · acme scout.** reading`,
        `- **[${BOARD}] builder: UP 2026-09-30 00:32Z · A7B2 · acme builder.** again`,
      ].join('\n'),
      'local',
    );
    await writeFile(seatsFile(root), 'leases: [\n', 'utf8');

    const { code, findings } = await check(root);
    expect(seatKindsOf(findings)).toEqual(['seat-duplicate-bullet']);
    expect(code).toBe(1);
    // the file was only read
    expect(await readFile(seatsFile(root), 'utf8')).toBe('leases: [\n');
  });
});
