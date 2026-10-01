/**
 * RCB-195 (slice B of RCB-194): `seat --up/--down` records WHO holds a seat, server side.
 *
 * The holder (terminal pane, session, pid, start time, host) goes in `.repoboard/local/seats.yml` —
 * beside STATE.md, gitignored, never in anything git-tracked (repoboard is public) — and the SEATS
 * bullet carries only the short label (`A7B2 · acme builder`). Every `run` below is handed an
 * explicit `env`, so the machine running the suite (which may itself be an iTerm pane with a
 * `CLAUDE_PID`) can never leak its own identity into a fixture. All boards live under
 * `os.tmpdir()`; nothing outside them is touched.
 */
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  defaultBoardConfig,
  parseHolder,
  parseLeases,
  serializeBoard,
  toIso,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { withFileLock } from '../src/file-lock.js';
import { holderFromEnv, processStartTime } from '../src/holder.js';
import { excludeSeatsFromLocalGit, localDir } from '../src/local.js';
import { makeTempRepoboard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

/** Two panes whose ids share their first four characters (`A7B2`) and differ after. */
const PANE_A = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
const PANE_B = 'A7B2B4E1-9F8E-4D7C-A6B5-1234567890AB';
const SESSION = 'session-7f3a9c2e-privacy-marker';

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

/** `env` is ALWAYS explicit — see the header. */
async function cli(root: string, env: Record<string, string>, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd: root, stdout, stderr, env, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

/**
 * What an iTerm pane running Claude Code exports: the pane, the Claude session, the Claude pid.
 * RCB-197: one pid is one holder (`sameHolder`), so two panes that hold seats at the same time must
 * have different LIVE pids — `pid` defaults to this process, and a test with a second pane passes
 * `process.ppid`.
 */
function paneEnv(pane: string, pid: number = process.pid): Record<string, string> {
  return {
    REPOBOARD_ACTOR: 'test-actor',
    ITERM_SESSION_ID: `w0t0p0:${pane}`,
    CLAUDE_CODE_SESSION_ID: SESSION,
    CLAUDE_PID: String(pid),
  };
}

/** No pane, no session, no `CLAUDE_PID`: the environment every pre-RCB-195 caller ran in. */
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
const localState = (root: string) => join(localDir(root), 'STATE.md');

/** `git -C .repoboard/local <args>` — the NESTED repo, never the root. */
async function localGit(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', localDir(root), ...args]);
  return stdout;
}

/** The `seat:` leases in `seats.yml`, parsed the way the store parses them. */
async function readLeases(root: string) {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'));
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

/** Every file under `dir`, recursively, skipping any `.git` directory (its objects are compressed). */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('seat --up/--down records the holder (RCB-195 slice B)', () => {
  it('(a) --up writes the lease to seats.yml and labels the bullet', async () => {
    const root = await makeBoard(true);
    const up = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    expect(up.code).toBe(0);
    expect(up.out).toBe(
      'restamped SEATS [seatboard] builder: UP 2026-09-02 22:41Z · A7B2 · acme builder\n',
    );

    const leases = await readLeases(root);
    expect(leases).toHaveLength(1);
    const lease = leases[0];
    expect(lease?.resource).toBe('seat:builder');
    expect(lease?.since).toBe(toIso(NOW));
    const holder = parseHolder(lease?.holder ?? '');
    expect(holder.pane).toBe(PANE_A);
    expect(holder.session).toBe(SESSION);
    expect(holder.pid).toBe(process.pid);
    expect(holder.host).toBe(hostname());
    expect(holder.start).not.toBeNull();
    // The start time is the one `ps` gives for CLAUDE_PID — this very process — not a guess.
    expect(holder.start).toBe(await processStartTime(process.pid));

    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: UP 2026-09-02 22:41Z · A7B2 · acme builder.** holding RCB-195',
    );
  });

  it('(b) no local layer: no seats.yml, and the bullet is byte-identical to an env-less run', async () => {
    const withPane = await makeBoard(false);
    const bare = await makeBoard(false);
    const a = await cli(withPane, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    const b = await cli(bare, BARE_ENV, 'seat', 'builder', '--up', 'holding RCB-195');
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    // Nothing private has anywhere to live: no local directory, so no seats.yml (and none is made).
    expect(existsSync(localDir(withPane))).toBe(false);
    expect(existsSync(seatsFile(withPane))).toBe(false);

    const stateA = await readFile(join(withPane, '.repoboard', 'STATE.md'), 'utf8');
    const stateB = await readFile(join(bare, '.repoboard', 'STATE.md'), 'utf8');
    expect(stateA).toBe(stateB);
    expect(stateA).toContain('builder: UP 2026-09-02 22:41Z.** holding RCB-195');
    expect(a.out).toBe(b.out);
    expect(a.out).not.toContain('A7B2');
  });

  it('(c) two seats whose panes share four characters: the second tag widens to six', async () => {
    const root = await makeBoard(true);
    const first = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'a');
    // RCB-197: pane B is another process (`process.ppid`) — with `process.pid` it would be pane A's
    // holder by pid, which is a different test.
    const second = await cli(
      root,
      paneEnv(PANE_B, process.ppid),
      'seat',
      'ops',
      '--up',
      'b',
      '--json',
    );
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.out.endsWith(' · A7B2 · acme builder\n')).toBe(true);

    const json = JSON.parse(second.out) as Record<string, unknown>;
    expect(json.holderLabel).toBe('A7B2B4 · acme ops');
    expect(await bulletOf(root, 'ops')).toMatch(/ · A7B2B4 · acme ops\.\*\* b$/);
    // The first seat's bullet is not rewritten by the second's UP.
    expect(await bulletOf(root, 'builder')).toMatch(/ · A7B2 · acme builder\.\*\* a$/);
    expect((await readLeases(root)).map((l) => l.resource).sort()).toEqual([
      'seat:builder',
      'seat:ops',
    ]);
  });

  it('(c2) a pane is not a collision with itself: claiming its own seat again keeps the tag at four', async () => {
    // RCB-197: this used to be one pane holding TWO seats (`builder`, then `ops`). A pane that holds
    // one seat is now refused a second unless `--from` (seat-claim.test.ts (e)), so the case that is
    // left is a pane's own lease being re-recorded — it must not widen against itself.
    const root = await makeBoard(true);
    await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'a');
    const again = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'b');
    expect(again.code).toBe(0);
    expect(await bulletOf(root, 'builder')).toMatch(/ · A7B2 · acme builder\.\*\* b$/);
  });

  it('(c3) a holder with no pane still gets its lease recorded, and no label', async () => {
    const root = await makeBoard(true);
    const up = await cli(
      root,
      { ...BARE_ENV, CLAUDE_PID: String(process.pid) },
      'seat',
      'builder',
      '--up',
      'a',
    );
    expect(up.code).toBe(0);
    expect(up.out).toBe('restamped SEATS [seatboard] builder: UP 2026-09-02 22:41Z\n');
    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: UP 2026-09-02 22:41Z.** a',
    );
    const holder = parseHolder((await readLeases(root))[0]?.holder ?? '');
    expect(holder.pane).toBeNull();
    expect(holder.pid).toBe(process.pid);
  });

  it('(d) --down removes the lease and the label; --update keeps both', async () => {
    const root = await makeBoard(true);
    await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    const seatsBefore = await readFile(seatsFile(root), 'utf8');

    const upd = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--update', 'still holding');
    expect(upd.code).toBe(0);
    expect(await readFile(seatsFile(root), 'utf8')).toBe(seatsBefore);
    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: UP 2026-09-02 22:41Z · A7B2 · acme builder.** still holding',
    );

    const down = await cli(
      root,
      paneEnv(PANE_A),
      'seat',
      'builder',
      '--down',
      'stood down\nin-flight: none\nowes: none',
      '--json',
    );
    expect(down.code).toBe(0);
    expect((JSON.parse(down.out) as Record<string, unknown>).holderLabel).toBeNull();
    expect(await readLeases(root)).toEqual([]);
    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: DOWN 2026-09-02 22:41Z.** stood down',
    );
  });

  it('(d2) --down on a board that never recorded a holder does not create seats.yml', async () => {
    const root = await makeBoard(true);
    const down = await cli(
      root,
      paneEnv(PANE_A),
      'seat',
      'builder',
      '--down',
      'never up\nin-flight: none\nowes: none',
    );
    expect(down.code).toBe(0);
    expect(existsSync(seatsFile(root))).toBe(false);
  });

  it('(e) PRIVACY: the pane uuid and the session id are in seats.yml and nowhere else under .repoboard/', async () => {
    const root = await makeBoard(true);
    const up = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    expect(up.code).toBe(0);
    await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--update', 'still holding');
    await cli(root, paneEnv(PANE_A), 'log', '--as', 'builder', 'a log block');

    const files = await filesUnder(join(root, '.repoboard'));
    // Not vacuous: the identity IS recorded, in exactly one file.
    expect(files).toContain(seatsFile(root));
    const seatsText = await readFile(seatsFile(root), 'utf8');
    expect(seatsText).toContain(PANE_A);
    expect(seatsText).toContain(SESSION);
    for (const file of files) {
      if (file === seatsFile(root)) continue;
      const text = await readFile(file, 'utf8');
      const rel = relative(root, file);
      expect(text, `${rel} must not hold the pane uuid`).not.toContain(PANE_A);
      expect(text, `${rel} must not hold the session id`).not.toContain(SESSION);
    }
    // What the command printed, and what the local repo committed, carry only the short label.
    expect(up.out + up.err).not.toContain(PANE_A);
    expect(up.out + up.err).not.toContain(SESSION);
    const committed = await localGit(root, 'log', '--all', '-p', '--format=');
    expect(committed).toContain('A7B2 · acme builder');
    expect(committed).not.toContain(PANE_A);
    expect(committed).not.toContain(SESSION);
  });

  it('(f) seats.yml is never committed, tracked or left as a dirty file in the local repo', async () => {
    // CONTROL (run by the seat, not part of the suite): make `excludeSeatsFromLocalGit`'s BODY a
    // no-op. That covers both call sites — the seats writer and `localSync` — and `git add -A` then
    // commits seats.yml, so assertion (1) below must FAIL (and (2) with it). Removing only the
    // `localSync` call would prove nothing: the writer's own call would still exclude the file.
    const root = await makeBoard(true);
    const up = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    expect(up.code).toBe(0);
    expect(existsSync(seatsFile(root))).toBe(true); // the file exists, or nothing below proves anything

    const committedPaths = await localGit(root, 'log', '--all', '--name-only', '--format=');
    expect(committedPaths).toContain('STATE.md'); // the log call works and the --up commit is in it
    // (1) localSync committed nothing containing seats.yml — in any commit, on any ref.
    expect(committedPaths).not.toContain('seats.yml');
    // (2) it is not in the index either.
    expect(await localGit(root, 'ls-files')).not.toContain('seats.yml');
    // (3) and it is not sitting there as an untracked file.
    expect(await localGit(root, 'status', '--porcelain')).toBe('');
  });

  it('(h) a seats.yml that does not parse is {ok:false}: exit 1, and NEITHER file is written', async () => {
    // CONTROL: replace the `!parsed.ok` return in `setSeatBulletHeld` with a fall-through to an
    // empty doc — the hand edit is overwritten and STATE.md is written, so both asserts fail.
    const root = await makeBoard(true);
    const garbage = 'leases: [\n  - this is not: yaml\n';
    await writeFile(seatsFile(root), garbage, 'utf8');
    const up = await cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');
    expect(up.code).toBe(1);
    expect(up.err).toContain('seats.yml');
    expect(await readFile(seatsFile(root), 'utf8')).toBe(garbage);
    expect(existsSync(localState(root))).toBe(false);
  });

  it('(i) lock order: the seats.yml lock is taken BEFORE STATE.md’s, not after', async () => {
    // CONTROL: nest the two `withFileLock` calls in `setSeatBulletHeld` the other way round — the
    // CLI then blocks on STATE.md's lock without ever creating seats.yml.lock, the poll below
    // times out and this fails.
    const root = await makeBoard(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withFileLock(localState(root), () => gate);
    // Our own STATE.md lock must exist before the CLI starts, or the order proves nothing.
    for (let i = 0; i < 400 && !existsSync(`${localState(root)}.lock`); i++) await sleep(5);
    expect(existsSync(`${localState(root)}.lock`)).toBe(true);
    const running = cli(root, paneEnv(PANE_A), 'seat', 'builder', '--up', 'holding RCB-195');

    let sawSeatsLock = false;
    for (let i = 0; i < 400 && !sawSeatsLock; i++) {
      sawSeatsLock = existsSync(`${seatsFile(root)}.lock`);
      if (!sawSeatsLock) await sleep(25);
    }
    // While STATE.md is held by someone else the command has the seats lock and has written nothing.
    expect(sawSeatsLock).toBe(true);
    expect(existsSync(localState(root))).toBe(false);
    expect(existsSync(seatsFile(root))).toBe(false);

    release();
    await held;
    const up = await running;
    expect(up.code).toBe(0);
    expect(existsSync(`${seatsFile(root)}.lock`)).toBe(false);
    expect(existsSync(`${localState(root)}.lock`)).toBe(false);
    expect((await readLeases(root)).map((l) => l.resource)).toEqual(['seat:builder']);
  }, 30_000);
});

describe('excludeSeatsFromLocalGit (RCB-195)', () => {
  const excludeFile = (root: string) => join(localDir(root), '.git', 'info', 'exclude');

  it('lists seats.yml and seats.yml.lock, and running it again changes nothing', async () => {
    const root = await makeBoard(true);
    await excludeSeatsFromLocalGit(root);
    const once = await readFile(excludeFile(root), 'utf8');
    const lines = once.split('\n').map((l) => l.trim());
    expect(lines).toContain('seats.yml');
    expect(lines).toContain('seats.yml.lock');
    await excludeSeatsFromLocalGit(root);
    expect(await readFile(excludeFile(root), 'utf8')).toBe(once);
  });

  it('appends after existing lines (even without a trailing newline) and keeps them', async () => {
    const root = await makeBoard(true);
    await writeFile(excludeFile(root), '*.swp', 'utf8');
    await excludeSeatsFromLocalGit(root);
    const lines = (await readFile(excludeFile(root), 'utf8')).split('\n');
    expect(lines[0]).toBe('*.swp');
    expect(lines).toContain('seats.yml');
    expect(lines).toContain('seats.yml.lock');
    // A line already present is not duplicated.
    await appendFile(excludeFile(root), '# tail\n', 'utf8');
    await excludeSeatsFromLocalGit(root);
    const after = (await readFile(excludeFile(root), 'utf8')).split('\n');
    expect(after.filter((l) => l === 'seats.yml')).toHaveLength(1);
  });

  it('does nothing when the local layer is not a git repo (and creates no .git)', async () => {
    const repo = await makeTempRepoboard();
    dirs.push(repo.root);
    await mkdir(localDir(repo.root), { recursive: true });
    await excludeSeatsFromLocalGit(repo.root);
    expect(existsSync(join(localDir(repo.root), '.git'))).toBe(false);
  });
});

describe('processStartTime / holderFromEnv (RCB-195)', () => {
  it('(g) processStartTime: a live pid has a start time, an exited child’s pid has none', async () => {
    const own = await processStartTime(process.pid);
    expect(own).not.toBeNull();
    expect(own?.length ?? 0).toBeGreaterThan(0);
    expect(own).toBe(own?.trim());

    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    await once(child, 'exit');
    expect(await processStartTime(pid ?? 0)).toBeNull();
  });

  it('processStartTime: a pid that is not a positive integer is null, never a question to ps', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await processStartTime(bad)).toBeNull();
    }
  });

  it('holderFromEnv measures the start time of the RESOLVED pid (CLAUDE_PID, else ppid)', async () => {
    const asked: number[] = [];
    const deps = {
      ppid: 999,
      hostname: 'box',
      startOf: async (pid: number) => {
        asked.push(pid);
        return `started-${pid}`;
      },
    };
    const env = { ITERM_SESSION_ID: 'w0t0p0:AAAA-1', CLAUDE_CODE_SESSION_ID: 's-1' };
    const viaEnv = await holderFromEnv({ ...env, CLAUDE_PID: '4321' }, defaultBoardConfig(), deps);
    expect(viaEnv).toEqual({
      pane: 'AAAA-1',
      session: 's-1',
      start: 'started-4321',
      host: 'box',
      pid: 4321,
    });
    const viaPpid = await holderFromEnv(env, defaultBoardConfig(), deps);
    expect(viaPpid.pid).toBe(999);
    expect(viaPpid.start).toBe('started-999');
    expect(asked).toEqual([4321, 999]);
  });

  it('holderFromEnv follows the board’s seats.identityEnv, and asks nobody when there is no pid', async () => {
    const asked: number[] = [];
    const cfg = { ...defaultBoardConfig(), seats: { identityEnv: ['MY_PANE'] } };
    const h = await holderFromEnv({ ITERM_SESSION_ID: 'w0t0p0:ITERM', MY_PANE: 'x:MINE' }, cfg, {
      ppid: null,
      hostname: 'box',
      startOf: async (pid) => {
        asked.push(pid);
        return 'never';
      },
    });
    expect(h.pane).toBe('MINE');
    expect(h.pid).toBeNull();
    expect(h.start).toBeNull();
    expect(asked).toEqual([]);
  });

  it('holderFromEnv with no deps reads this machine: its hostname, its parent pid, a real start time', async () => {
    const h = await holderFromEnv({}, defaultBoardConfig());
    expect(h.host).toBe(hostname());
    expect(h.pid).toBe(process.ppid);
    expect(h.start).toBe(await processStartTime(process.ppid));
  });
});
