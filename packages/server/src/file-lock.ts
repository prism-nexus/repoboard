/**
 * RCB-133: a cross-process advisory lock, `<target>.lock`, held by exactly one process at a
 * time. `CardStore`'s `mutate`/`enqueue` only serialize writers WITHIN one process — two
 * processes (two CLI one-shots, or a CLI next to `serve`) each start from their own in-memory
 * copy of leases.yml/STATE.md, so the second process's read-modify-write can silently drop the
 * first's. This is the one thing that makes a read-modify-write span exclusive across processes
 * too: acquire before the read, release after the write.
 *
 * No new dependency — `open(path, 'wx')` is the primitive (POSIX `O_CREAT|O_EXCL`): it succeeds
 * only when the file did not already exist, atomically, so two processes racing to create the
 * same lock file can never both win.
 */
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

export interface FileLockOptions {
  /** How long to keep retrying before giving up. Default 5000ms. */
  timeoutMs?: number;
  /** A lock older than this is presumed abandoned and stolen. Default 30000ms. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
/** Backoff between retries: 10-50ms, jittered, so two waiters do not lock-step retry forever. */
const BACKOFF_MIN_MS = 10;
const BACKOFF_MAX_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(): number {
  return BACKOFF_MIN_MS + Math.floor(Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS + 1));
}

/** True unless `pid` is definitely gone (`ESRCH`) — `EPERM` means it exists but we cannot signal
 * it, which still counts as alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface LockInfo {
  pid: number;
  time: string;
}

/** The lock file holds one line: `<pid> <ISO time>`. Tolerant of trailing whitespace/newline;
 * unparseable content (a hand-created file, say) yields `null`, not a throw. */
function parseLockInfo(text: string): LockInfo | null {
  const m = /^(\d+)\s+(\S.*)$/.exec(text.trim());
  if (!m) return null;
  const pid = Number.parseInt(m[1] as string, 10);
  if (!Number.isFinite(pid)) return null;
  return { pid, time: (m[2] as string).trim() };
}

/** Read the current lock's parsed content and mtime. `null` when the lock is already gone
 * (ENOENT) — a race with the holder's own release, treated the same as "go ahead and retry". */
async function readLock(
  lockPath: string,
): Promise<{ info: LockInfo | null; mtimeMs: number; text: string } | null> {
  try {
    const [text, st] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    return { info: parseLockInfo(text), mtimeMs: st.mtimeMs, text };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function unlinkIgnoreMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Run `fn` with `<target>.lock` held. Retries a held lock with a short jittered backoff until
 * `opts.timeoutMs` (default 5000) elapses, then throws. A lock is stolen outright — no waiting —
 * when its holder's pid is provably dead (`process.kill(pid, 0)` throws `ESRCH`) or the lock is
 * older than `opts.staleMs` (default 30000): a process that died mid-lock must not wedge every
 * other writer forever. The lock is always released in `finally`, even when `fn` throws.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}`, 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const lock = await readLock(lockPath);
      if (lock === null) continue; // released between our open() and this read — retry now
      const deadPid = lock.info !== null && !isAlive(lock.info.pid);
      const stale = Date.now() - lock.mtimeMs > staleMs;
      if (deadPid || stale) {
        // Steal only the lock we judged: two waiters can judge the same stale lock, and the
        // first may already have replaced it with its own fresh one. Re-read and unlink only
        // if it is byte- and mtime-identical to what we judged; the window left is the gap
        // between this re-read and the unlink, not the whole judge-then-unlink span.
        const again = await readLock(lockPath);
        if (again !== null && again.text === lock.text && again.mtimeMs === lock.mtimeMs) {
          await unlinkIgnoreMissing(lockPath);
        }
        continue; // retry the create immediately, no backoff
      }
      if (Date.now() >= deadline) {
        const pid = lock.info?.pid ?? '?';
        const time = lock.info?.time ?? 'unknown time';
        throw new Error(
          `${basename(target)} is locked by pid ${pid} since ${time}; ` +
            `if that process is gone, remove ${lockPath}`,
        );
      }
      await sleep(jitteredBackoff());
    }
  }

  try {
    return await fn();
  } finally {
    await unlinkIgnoreMissing(lockPath);
  }
}
