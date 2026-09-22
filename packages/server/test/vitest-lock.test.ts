/**
 * RCB-81 — `scripts/vitest-lock.sh take` must refuse a lane window only when it is imminent or
 * live, never merely because it lies somewhere in the future. See docs/RCB-81-BRIEF.md.
 *
 * Each case spawns the real script against scratch paths: `VITEST_LOCK_DIR` is a fresh tmp dir
 * (removed after the case), `FPJ_ROOT` is a tmp dir that exists but has no `.repoboard/` (so the
 * fpj-side `window check` is skipped), and `FPJ_LANE_WINDOWS` is a scratch lane file the script
 * never has to share with the real `/tmp/fpj-lane-windows`.
 *
 * The script ALSO runs `node dist/cli.js window check vitest-lock` against THIS repo's own
 * `.repoboard/leases.yml` (read-only) — the case set below assumes that file's `windows:` list is
 * empty today (it is: `leases: []` / `windows: []`), so that check always passes and the lane-file
 * check below is the only thing under test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'vitest-lock.sh');
const CLI = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli.js');
const hasCli = existsSync(CLI);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** ISO-8601 (Z, seconds precision) offset from now by `ms` milliseconds. */
function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface TakeResult {
  status: number | null;
  stdout: string;
}

function runTake(opts: { lockDir: string; fpjRoot: string; laneFile: string }): TakeResult {
  const res = spawnSync('sh', [SCRIPT, 'take'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITEST_LOCK_DIR: opts.lockDir,
      VITEST_LOCK_PID: String(process.pid),
      FPJ_ROOT: opts.fpjRoot,
      FPJ_LANE_WINDOWS: opts.laneFile,
      REPOBOARD_SUITE_MINUTES: '5',
    },
  });
  return { status: res.status, stdout: res.stdout };
}

/** Fresh scratch layout for one case: a tmp root, a no-board fpj stand-in, and paths for the
 * lock dir and lane file (neither pre-created — the script/test create what they need). */
async function scratch(): Promise<{ lockDir: string; fpjRoot: string; laneFile: string }> {
  const root = await makeTempDir('rcb-81-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fpjRoot = join(root, 'no-fpj');
  mkdirSync(fpjRoot, { recursive: true });
  return { lockDir: join(root, 'lock'), fpjRoot, laneFile: join(root, 'lanes') };
}

function writeLane(path: string, startMs: number, endMs: number, name = 'w'): void {
  writeFileSync(path, `${isoOffset(startMs)} ${isoOffset(endMs)} ${name}\n`);
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('vitest-lock.sh take — lane window START, not just END (RCB-81)', () => {
  it.skipIf(!hasCli)(
    'case 1: window starts +2h, ends +2h20m (far future) → take succeeds',
    async () => {
      const { lockDir, fpjRoot, laneFile } = await scratch();
      writeLane(laneFile, 2 * HOUR, 2 * HOUR + 20 * MIN);
      const { status, stdout } = runTake({ lockDir, fpjRoot, laneFile });
      expect(status).toBe(0);
      expect(stdout).toContain('took vitest-lock');
      expect(existsSync(join(lockDir, 'owner'))).toBe(true);
    },
  );

  it.skipIf(!hasCli)('case 2: window starts +3m, ends +23m (imminent) → take refused', async () => {
    const { lockDir, fpjRoot, laneFile } = await scratch();
    writeLane(laneFile, 3 * MIN, 23 * MIN);
    const { status, stdout } = runTake({ lockDir, fpjRoot, laneFile });
    expect(status).toBe(3);
    expect(stdout).toContain('lane window live:');
    expect(existsSync(lockDir)).toBe(false);
  });

  it.skipIf(!hasCli)('case 3: window starts −20m, ends −5m (past) → take succeeds', async () => {
    const { lockDir, fpjRoot, laneFile } = await scratch();
    writeLane(laneFile, -20 * MIN, -5 * MIN);
    const { status, stdout } = runTake({ lockDir, fpjRoot, laneFile });
    expect(status).toBe(0);
    expect(stdout).toContain('took vitest-lock');
    expect(existsSync(join(lockDir, 'owner'))).toBe(true);
  });

  it.skipIf(!hasCli)('case 4: window starts −1m, ends +10m (live now) → take refused', async () => {
    const { lockDir, fpjRoot, laneFile } = await scratch();
    writeLane(laneFile, -1 * MIN, 10 * MIN);
    const { status, stdout } = runTake({ lockDir, fpjRoot, laneFile });
    expect(status).toBe(3);
    expect(stdout).toContain('lane window live:');
    expect(existsSync(lockDir)).toBe(false);
  });
});

/**
 * RCB-86 — the script itself ships neutral defaults; THIS rig's fpj-specific paths
 * (`/tmp/fpj-vitest.lock`, `$HOME/Projects/Repos/freshpickedjobs`, `/tmp/fpj-lane-windows`) live
 * only in the gitignored `.repoboard/local/env`, sourced by the script if present, with the
 * environment always winning over the file's `${X:-value}` defaults.
 *
 * Cases (a) and (b) below run against the REAL `REPO_ROOT` (the script always resolves
 * `.repoboard/local/env` from its own location, not from spawn `cwd`), so on THIS rig — which has
 * that file, by design (RCB-83) — FPJ_ROOT and FPJ_LANE_WINDOWS fall back to the rig's own values
 * whenever the test omits them, exactly as a real caller would see. That is intentional: the point
 * of (a) is that a lane file nothing points to is never consulted, not that no fpj interaction
 * happens at all. At the time this suite was written, this rig's own `/tmp/fpj-lane-windows`
 * window (13:30–13:50Z) and `leases.yml` (`windows: []`, both repos) were not live, so the
 * rig-default fallback does not itself refuse; if that ever changes, (a) would need a live rig,
 * not the script, to fail — see the note on case (c).
 */
describe('vitest-lock.sh — neutral defaults (RCB-86)', () => {
  /** `process.env` minus FPJ_ROOT/FPJ_LANE_WINDOWS: simulates a caller that never set them, so
   * either the script's own (now neutral) fallback or the rig's `.repoboard/local/env` decides. */
  function envWithoutFpjKeys(overrides: Record<string, string>): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.FPJ_ROOT;
    delete base.FPJ_LANE_WINDOWS;
    return { ...base, ...overrides };
  }

  function run(args: string[], env: NodeJS.ProcessEnv): TakeResult {
    const res = spawnSync('sh', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env });
    return { status: res.status, stdout: res.stdout };
  }

  it.skipIf(!hasCli)(
    '(a) FPJ_ROOT/FPJ_LANE_WINDOWS absent from env: take succeeds, then release succeeds',
    async () => {
      const root = await makeTempDir('rcb-86-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const lockDir = join(root, 'lock');
      // Would refuse if read (start=now, end=+10m) — but nothing points FPJ_LANE_WINDOWS at it.
      const laneFile = join(root, 'lane-nobody-points-to');
      writeLane(laneFile, 0, 10 * MIN);

      const env = envWithoutFpjKeys({
        VITEST_LOCK_DIR: lockDir,
        VITEST_LOCK_PID: String(process.pid),
      });

      const took = run(['take'], env);
      expect(took.status).toBe(0);
      expect(took.stdout).toContain('took vitest-lock');
      expect(existsSync(join(lockDir, 'owner'))).toBe(true);

      const released = run(['release'], env);
      expect(released.status).toBe(0);
    },
  );

  it.skipIf(!hasCli)(
    '(b) same env but FPJ_LANE_WINDOWS points at that scratch lane file: take refused',
    async () => {
      const root = await makeTempDir('rcb-86-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const lockDir = join(root, 'lock');
      const laneFile = join(root, 'lane-live');
      writeLane(laneFile, 0, 10 * MIN);

      const env = envWithoutFpjKeys({
        VITEST_LOCK_DIR: lockDir,
        VITEST_LOCK_PID: String(process.pid),
        FPJ_LANE_WINDOWS: laneFile,
      });

      const { status, stdout } = run(['take'], env);
      expect(status).toBe(3);
      expect(stdout).toContain('lane window live:');
      expect(existsSync(lockDir)).toBe(false);
    },
  );

  it('(c) the script text carries no fpj-specific path — those live only in the rig env file', () => {
    // Deliberately NOT asserting on an env-file case here: the real `.repoboard/local/env` exists
    // on this rig and would be sourced by the script — that is by design (RCB-83/RCB-86). This
    // case checks only the script's own text, independent of what any env file sets.
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toMatch(/fpj-vitest|fpj-lane-windows|Repos\/freshpickedjobs/);
  });
});

/**
 * RCB-114 — an agent seat's every Bash tool call is a fresh one-shot shell whose parent is the
 * long-lived `claude` process, not a shell that survives to the next tool call. `SELF_PID` must
 * therefore prefer `$CLAUDE_PID` (which Claude Code exports into every tool shell) over `$PPID`,
 * or `take` records a pid that's already dead by the time the same seat's own `release` runs.
 *
 * Each case runs the script through a wrapper, `sh -c 'sh "$0" "$@"; exit $?' SCRIPT verb`, so the script's
 * own `$PPID` is that wrapper shell — which exits as soon as the verb returns. This is what
 * reproduces the bug: a direct `spawnSync('sh', [SCRIPT, verb])` hides it, because `$PPID` there
 * is node itself, which never dies mid-test.
 */
describe('vitest-lock.sh — owner pid survives one-shot shells (RCB-114)', () => {
  function runWrapped(verb: string, env: NodeJS.ProcessEnv): TakeResult {
    // The trailing `exit $?` keeps the wrapper alive as the script's parent: without it, sh
    // execs its last command and the script's $PPID is node again, which hides the bug.
    const res = spawnSync('sh', ['-c', 'sh "$0" "$@"; exit $?', SCRIPT, verb], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
    });
    return { status: res.status, stdout: res.stdout };
  }

  function ownerPid(lockDir: string): string {
    const line = readFileSync(join(lockDir, 'owner'), 'utf8').split('\n')[0] ?? '';
    return line.split(' ')[0] ?? '';
  }

  /** Scratch lock dir and a no-board fpj root, as the existing cases above use. The base env has
   * `VITEST_LOCK_PID` and `CLAUDE_PID` deleted before applying `overrides` —
   * the suite itself may run under Claude, so the real values (if any) must not leak into a case
   * that means to test them unset. */
  async function scratchEnv(
    overrides: Record<string, string>,
  ): Promise<{ lockDir: string; env: NodeJS.ProcessEnv }> {
    const root = await makeTempDir('rcb-114-');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const fpjRoot = join(root, 'no-fpj');
    mkdirSync(fpjRoot, { recursive: true });
    const lockDir = join(root, 'lock');
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.VITEST_LOCK_PID;
    delete base.CLAUDE_PID;
    delete base.FPJ_LANE_WINDOWS;
    // A path that never exists: deleting FPJ_LANE_WINDOWS is not enough, the rig env file would
    // put /tmp/fpj-lane-windows back and a live fpj window would refuse `take` with exit 3.
    const laneFile = join(root, 'no-lanes');
    return {
      lockDir,
      env: {
        ...base,
        VITEST_LOCK_DIR: lockDir,
        FPJ_ROOT: fpjRoot,
        FPJ_LANE_WINDOWS: laneFile,
        ...overrides,
      },
    };
  }

  it.skipIf(!hasCli)(
    '(a) CLAUDE_PID set (agent seat): take records it, status live, same-seat release succeeds',
    async () => {
      const { lockDir, env } = await scratchEnv({
        CLAUDE_PID: String(process.pid),
      });

      const took = runWrapped('take', env);
      expect(took.status).toBe(0);
      expect(took.stdout).toContain('took vitest-lock');
      expect(ownerPid(lockDir)).toBe(String(process.pid));

      const status = runWrapped('status', env);
      expect(status.stdout).toContain('live');

      const released = runWrapped('release', env);
      expect(released.status).toBe(0);
      expect(released.stdout).toContain('released vitest-lock');
      expect(existsSync(lockDir)).toBe(false);
    },
  );

  it.skipIf(!hasCli)(
    '(b) neither VITEST_LOCK_PID nor CLAUDE_PID set: owner pid is the wrapper shell, not ' +
      'process.pid — same-seat release without --force fails NOT ours (human-terminal fallback unchanged)',
    async () => {
      const { lockDir, env } = await scratchEnv({});

      const took = runWrapped('take', env);
      expect(took.status).toBe(0);
      expect(ownerPid(lockDir)).not.toBe(String(process.pid));

      const released = runWrapped('release', env);
      expect(released.status).toBe(1);
      expect(released.stdout).toContain('NOT ours');
      expect(existsSync(lockDir)).toBe(true);
    },
  );

  it.skipIf(!hasCli)('(c) VITEST_LOCK_PID=1 overrides CLAUDE_PID: owner pid is 1', async () => {
    const { lockDir, env } = await scratchEnv({
      VITEST_LOCK_PID: '1',
      CLAUDE_PID: String(process.pid),
    });

    const took = runWrapped('take', env);
    expect(took.status).toBe(0);
    expect(ownerPid(lockDir)).toBe('1');
  });
});
