/** RCB-133: `withFileLock` — a cross-process advisory lock around a read-modify-write span.
 * Every fixture lives under `os.tmpdir()` (never this repo). */
import { spawn } from 'node:child_process';
import { rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/file-lock.js';
import { makeTempDir, sleep } from './helpers.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('file-lock-test-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('withFileLock', () => {
  it('a second holder waits until the first releases (order recorded)', async () => {
    const dir = await tempDir();
    const target = join(dir, 'leases.yml');
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(target, async () => {
      order.push('first-in');
      await firstMayFinish;
      order.push('first-out');
    });
    await sleep(20); // let the first call actually create the lock file first
    const second = withFileLock(target, async () => {
      order.push('second-in');
    });

    await sleep(60);
    // Mutual exclusion, not timing luck: the second call cannot have run yet — nothing has
    // released the lock.
    expect(order).toEqual(['first-in']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });

  it('the timeout throws "<basename> is locked by pid <pid> since <time>; if that process is gone, remove <lockpath>"', async () => {
    const dir = await tempDir();
    const target = join(dir, 'STATE.md');
    const lockPath = `${target}.lock`;
    let releaseHolder: () => void = () => {};
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withFileLock(target, async () => {
      await holderMayFinish;
    });
    await sleep(20); // let the holder actually create the lock file first

    await expect(withFileLock(target, async () => undefined, { timeoutMs: 150 })).rejects.toThrow(
      new RegExp(
        `^STATE\\.md is locked by pid ${process.pid} since .+; if that process is gone, remove ${lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      ),
    );

    releaseHolder();
    await holder;
  });

  it('a lock whose pid is dead (spawned, waited for exit) is stolen without waiting out the timeout', async () => {
    const dir = await tempDir();
    const target = join(dir, 'leases.yml');
    const lockPath = `${target}.lock`;

    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = await new Promise<number>((resolve, reject) => {
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('spawn did not return a pid'));
        return;
      }
      child.on('exit', () => resolve(pid));
      child.on('error', reject);
    });
    await sleep(50); // margin past the exit event, so the pid is unambiguously gone

    await writeFile(lockPath, `${deadPid} ${new Date().toISOString()}`, 'utf8');
    const start = Date.now();
    let ran = false;
    await withFileLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 5000, staleMs: 30_000 },
    );
    const elapsedMs = Date.now() - start;
    expect(ran).toBe(true);
    // Stolen immediately, not waited out — well under the 5000ms timeout.
    expect(elapsedMs).toBeLessThan(2000);
    await expect(stat(lockPath)).rejects.toThrow(/ENOENT/);
  });

  it('a lock older than staleMs is stolen even though its recorded pid is this very (alive) process', async () => {
    const dir = await tempDir();
    const target = join(dir, 'leases.yml');
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, `${process.pid} ${new Date().toISOString()}`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old); // backdate mtime well past staleMs

    const start = Date.now();
    let ran = false;
    await withFileLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 5000, staleMs: 1000 },
    );
    const elapsedMs = Date.now() - start;
    expect(ran).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('the lock file is gone after fn throws', async () => {
    const dir = await tempDir();
    const target = join(dir, 'leases.yml');
    const lockPath = `${target}.lock`;
    await expect(
      withFileLock(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(lockPath)).rejects.toThrow(/ENOENT/);
  });

  it('a missing target directory surfaces its own error rather than a silent no-op', async () => {
    const dir = await tempDir();
    const target = join(dir, 'nested', 'leases.yml'); // 'nested' does not exist
    await expect(withFileLock(target, async () => undefined)).rejects.toThrow(/ENOENT/);
  });
});
