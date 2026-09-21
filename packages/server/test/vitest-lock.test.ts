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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
