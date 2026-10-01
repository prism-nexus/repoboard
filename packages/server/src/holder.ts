/**
 * RCB-195 (slice B of RCB-194): who holds a seat, the I/O half. Core's `holder.ts` is pure — it
 * turns an env record plus a few measured facts into a `SeatHolder`. Measuring those facts is this
 * file's job: the parent pid and hostname, and the process start time (`ps -o lstart=`) that,
 * with the pid, tells a live holder from a recycled pid (RCB-194 P2). Called once, at the CLI
 * entry (RCB-194 P3), and the result handed down — nothing below the entry reads the identity
 * from `process.env`. RCB-197: `probeHolder` is the same kind of measurement made about a
 * RECORDED holder (is its pid still that process?), for the claim the store decides under its locks.
 */
import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  type BoardConfig,
  boardIdentityEnv,
  type HolderProbe,
  holderIdentity,
  type SeatHolder,
} from '@repoboard/core';

/** `ps` is a local, instant read; a hung one must not hang a seat verb. */
const PS_TIMEOUT_MS = 5000;

/**
 * RCB-195: when process `pid` started, as `ps -o lstart=` prints it — `Tue Sep 29 12:34:56 2026`,
 * forced to UTC and the C locale (`TZ=UTC LC_ALL=C`) so the same process always reads the same
 * text, whatever locale or zone the caller runs in. Trimmed; `null` when `ps` fails, prints
 * nothing (the pid does not exist: an exited process has no start time), or `pid` is not a
 * positive integer (`ps -p 0` and `ps -p -1` are not questions about a process). NEVER throws — a
 * missing answer is `null`, not a guessed timestamp.
 */
export function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        {
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
          timeout: PS_TIMEOUT_MS,
          encoding: 'utf8',
        },
        (error, stdout) => {
          const text = error === null ? stdout.trim() : '';
          resolve(text === '' ? null : text);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** What `holderFromEnv` reads from the machine, overridable so a test can pin each of them. */
export interface HolderDeps {
  /** Default `process.ppid`. `null` = the caller has none. */
  ppid?: number | null;
  /** Default `os.hostname()`. */
  hostname?: string | null;
  /** Default `processStartTime`. Called with the RESOLVED pid (`CLAUDE_PID`, else `ppid`). */
  startOf?: (pid: number) => Promise<string | null>;
}

/**
 * RCB-195: who is running this command — core's `holderIdentity` over `env`, with the board's own
 * `seats.identityEnv` order (`boardIdentityEnv`, so an override cannot be half-applied) and the
 * measured parent pid and hostname; `start` is the start time of the pid `holderIdentity`
 * RESOLVED (`CLAUDE_PID` first, else `ppid`), never of some other process. A holder with no
 * resolvable pid has `start: null` and `startOf` is not called. Every answer that cannot be had is
 * `null` (an empty hostname included).
 */
export async function holderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  cfg: BoardConfig,
  deps: HolderDeps = {},
): Promise<SeatHolder> {
  const host = deps.hostname !== undefined ? deps.hostname : hostname();
  const known = holderIdentity(env, {
    identityEnv: boardIdentityEnv(cfg),
    ppid: deps.ppid !== undefined ? deps.ppid : process.ppid,
    host: host === '' ? null : host,
    start: null,
  });
  const start = known.pid === null ? null : await (deps.startOf ?? processStartTime)(known.pid);
  return { ...known, start };
}

/** What `probeHolder` reads from the machine, overridable so a test can pin each of them. */
export interface ProbeDeps {
  /** Default `os.hostname()`. */
  hostname?: string | null;
  /** Default `process.kill(pid, 0)`; throws as `kill(2)` does (`ESRCH`, `EPERM`). */
  kill?: (pid: number) => void;
  /** Default `processStartTime`. Called only for a pid the signal found alive. */
  startOf?: (pid: number) => Promise<string | null>;
}

/**
 * RCB-197: what this machine can say NOW about a RECORDED holder's pid — the measured half of
 * core's `holderLiveness`, which decides. `host` is this machine's hostname (an empty one is `null`,
 * as in `holderFromEnv`); `signal` is `kill(pid, 0)`: it returned = `alive`, `EPERM` = `eperm` (the
 * process exists, it is not ours), `ESRCH` = `esrch`, any other error = `null`; `start` is
 * `processStartTime(pid)`, asked ONLY for an `alive`/`eperm` pid — a pid that is gone has none. A
 * holder with no pid has `signal` and `start` both `null`. NEVER throws: whatever cannot be
 * measured is `null`, which `holderLiveness` reads as `unknown`, never as dead.
 */
export async function probeHolder(
  recorded: SeatHolder,
  deps: ProbeDeps = {},
): Promise<HolderProbe> {
  try {
    const name = deps.hostname !== undefined ? deps.hostname : hostname();
    const host = name === null || name === '' ? null : name;
    const pid = recorded.pid;
    if (pid === null) return { host, signal: null, start: null };
    let signal: HolderProbe['signal'];
    try {
      (deps.kill ?? ((p: number) => process.kill(p, 0)))(pid);
      signal = 'alive';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      signal = code === 'ESRCH' ? 'esrch' : code === 'EPERM' ? 'eperm' : null;
    }
    const start =
      signal === 'alive' || signal === 'eperm'
        ? await (deps.startOf ?? processStartTime)(pid)
        : null;
    return { host, signal, start };
  } catch {
    return { host: null, signal: null, start: null };
  }
}

/**
 * RCB-195: the ONE write of `.repoboard/local/seats.yml` — atomic (`<file>.<pid>.tmp`, then
 * rename over the target), so a reader never sees half a file. The caller holds `seats.yml`'s file
 * lock and has already kept the file out of the local repo (`excludeSeatsFromLocalGit`) and past
 * `refuseWriteWithoutBoard`; this function only writes.
 */
export async function writeSeatsFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
