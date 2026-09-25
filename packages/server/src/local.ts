/**
 * RCB-83 step 1: `.repoboard/local/` — a second, local-only git repo nested inside the (public)
 * one, gitignored by the tool itself. It holds machine facts (`RIG.md`: build, ports, locks, seat
 * names, other repos on this machine) that must never ship in the public tree.
 *
 * RCB-93: the running record (`STATE.md`, `log/`) follows this rule — it lives where it already
 * is. An UNTRACKED top-level record moves into `.repoboard/local/` on `local init` (nothing else
 * could be reading it there). A TRACKED one is left in place unless `local init --move-record`,
 * since the store reads `.repoboard/STATE.md`/`log/` at the top level whenever it exists — see
 * `moveIntoLocal` and `store.ts`'s `load()`.
 *
 * All git calls run via `spawn('git', …)` with `cwd` = the local dir itself, so once `git init`
 * has run there every command is scoped to THAT nested repo (git resolves `.git` from `cwd`
 * upward, and the nested `.git` shadows the parent's) — never the parent repo this tool also
 * manages. Nothing here ever runs `git` with `cwd` = the parent root.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The minimal shape `scaffoldIfAbsent` needs — structurally satisfied by `CliIO`. */
export interface LocalIO {
  stdout: { write(chunk: string): unknown };
}

/** `created <path>` / `kept <path>` — never overwrites an existing file (locked decision 3). */
export async function scaffoldIfAbsent(
  path: string,
  content: string,
  io: LocalIO,
  label: string,
): Promise<void> {
  const present = await stat(path).then(
    () => true,
    () => false,
  );
  if (present) {
    io.stdout.write(`kept ${label}\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  io.stdout.write(`created ${label}\n`);
}

export function localDir(root: string): string {
  return join(root, '.repoboard', 'local');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Is there a `.repoboard/local/` directory at all — not necessarily a git repo yet. */
export function hasLocal(root: string): Promise<boolean> {
  return isDirectory(localDir(root));
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One `git` invocation, cwd = `dir`. Never throws — a non-zero exit is data, not an exception. */
function runGit(dir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (e) => {
      resolve({ code: 1, stdout, stderr: String(e) });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function rigTemplate(): string {
  return [
    '# RIG — <this machine>',
    '',
    '## Build',
    '<how to build, typecheck and test on this machine>',
    '',
    '## Ports',
    '<ports this rig binds, and what serves each one>',
    '',
    '## Locks',
    '<lock files / lease resource names this rig uses>',
    '',
    '## Seat names',
    '<the seat names in use on this rig, one per terminal>',
    '',
    '## Other repos on this machine',
    '<other repos this rig touches — read-only unless said otherwise>',
    '',
  ].join('\n');
}

const GITIGNORE_LINE = '.repoboard/local/';

const LOCAL_YML_NAME = 'local.yml';

function localYmlPath(root: string): string {
  return join(localDir(root), LOCAL_YML_NAME);
}

/**
 * RCB-128: is `.repoboard/local/local.yml`'s one meaningful line exactly `remote: none` — the
 * owner's opt-out ack for a local layer with no backup on purpose (freshpickedjobs). Blank lines
 * and `#`-comments are ignored; anything else in the file (or a second meaningful line) means it
 * is NOT the ack — an ack this loose would silence `check` on a typo. Absent file is also not an
 * ack, never thrown.
 */
async function readRemoteAck(root: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(localYmlPath(root), 'utf8');
  } catch {
    return false;
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return lines.length === 1 && lines[0] === 'remote: none';
}

/** Write the `remote: none` ack — the local dir must already exist. */
async function writeRemoteAck(root: string): Promise<void> {
  await writeFile(localYmlPath(root), 'remote: none\n', 'utf8');
}

/** Remove the ack file, if any — never throws when it is already absent. */
async function removeRemoteAck(root: string): Promise<void> {
  await unlink(localYmlPath(root)).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  });
}

async function ensureGitignored(root: string, io: LocalIO): Promise<void> {
  const path = join(root, '.gitignore');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const already = text.split('\n').some((line) => line.trim() === GITIGNORE_LINE);
  if (already) {
    io.stdout.write('kept .gitignore\n');
    return;
  }
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  await writeFile(path, `${text}${sep}${GITIGNORE_LINE}\n`, 'utf8');
  io.stdout.write(`ignored ${GITIGNORE_LINE} in .gitignore\n`);
}

export interface LocalInitOptions {
  /** RCB-128: the literal string `'none'` is the opt-out ack, not a git remote — it writes
   * `local.yml` (`remote: none`) and sets NO `origin`. */
  remote?: string;
  io: LocalIO;
  now?: () => Date;
  /** RCB-93: move a TRACKED `.repoboard/STATE.md`/`log/` into `.repoboard/local/` too. Default
   * false — an untracked record still moves unconditionally, unchanged from before RCB-93. */
  moveRecord?: boolean;
}

/**
 * `repoboard local init [--remote <url>|none]`. Idempotent: mkdir + scaffold RIG.md (never
 * overwrites), ensure the root `.gitignore` carries the exact `.repoboard/local/` line, `git init
 * -q` only when `local/.git` is absent, set a REPO-LOCAL `user.name`/`user.email` only when `git
 * config user.email` is empty inside that repo (never touches global config), point `origin` at
 * `--remote` when given, then `localSync`. Never pushes beyond what `localSync` itself does.
 *
 * RCB-128: `--remote none` is the owner's ack that this local layer has no backup ON PURPOSE — it
 * writes `local.yml` instead of setting a remote, and `check`'s `local-no-remote` goes quiet. A
 * later `--remote <url>` supersedes the ack (a real remote is strictly more backed up than the
 * ack it replaces) and removes the file, saying so.
 */
export async function localInit(root: string, opts: LocalInitOptions): Promise<void> {
  const dir = localDir(root);
  await mkdir(dir, { recursive: true });
  await scaffoldIfAbsent(join(dir, 'RIG.md'), rigTemplate(), opts.io, '.repoboard/local/RIG.md');
  await ensureGitignored(root, opts.io);

  const gitDirPresent = await isDirectory(join(dir, '.git'));
  if (!gitDirPresent) {
    await runGit(dir, ['init', '-q']);
  }

  const email = await runGit(dir, ['config', 'user.email']);
  if (email.stdout.trim().length === 0) {
    await runGit(dir, ['config', 'user.name', 'repoboard']);
    await runGit(dir, ['config', 'user.email', 'repoboard@localhost']);
  }

  // RCB-128: `--remote none` writes the opt-out ack instead of a git remote. `--remote <url>`
  // sets/updates `origin` as before, and removes a pre-existing ack — a real remote supersedes it.
  if (opts.remote === 'none') {
    await writeRemoteAck(root);
    opts.io.stdout.write('wrote .repoboard/local/local.yml (remote: none)\n');
  } else if (opts.remote) {
    const hadAck = await readRemoteAck(root);
    const existing = await runGit(dir, ['remote', 'get-url', 'origin']);
    if (existing.code === 0) {
      await runGit(dir, ['remote', 'set-url', 'origin', opts.remote]);
    } else {
      await runGit(dir, ['remote', 'add', 'origin', opts.remote]);
    }
    if (hadAck) {
      await removeRemoteAck(root);
      opts.io.stdout.write('removed .repoboard/local/local.yml (remote: none) — real remote set\n');
    }
  }

  // RCB-93: the record lives where it already is. An UNTRACKED top-level STATE.md/log/ still
  // moves in unconditionally (today's behaviour, unchanged) — nothing else could be reading it.
  // A TRACKED one is left in place unless `--move-record`: the store (see `store.ts` `load()`)
  // reads `.repoboard/STATE.md`/`log/` at the top level whenever it exists, tracked or not, so a
  // bare `local init` never makes a committed record read as missing for every other seat.
  const moveRecord = opts.moveRecord ?? false;
  await moveIntoLocal(root, 'STATE.md', opts.io, moveRecord);
  await moveIntoLocal(root, 'log', opts.io, moveRecord);

  // Neither record exists at the top level at all (nothing tracked, nothing to move) — mkdir the
  // local log dir now so the store's `isDirectory(local/log)` check (`resolveLogDir()`) sees it
  // from the very first write, rather than falling back to `.repoboard/log/` until the first log.
  const stateAtTop = await stat(join(root, '.repoboard', 'STATE.md')).then(
    () => true,
    () => false,
  );
  const logAtTop = await isDirectory(join(root, '.repoboard', 'log'));
  if (!stateAtTop && !logAtTop) {
    await mkdir(join(localDir(root), 'log'), { recursive: true });
  }

  const sync = await localSync(root, 'repoboard local: init');
  // A remote given to a repo that already has its commits: `localSync` found nothing to commit,
  // so it pushed nothing — push the existing history now, or the backup silently stays empty.
  // `--remote none` set no origin, so there is nothing to push.
  if (opts.remote && opts.remote !== 'none' && sync.status === 'clean') {
    const push = await runGit(dir, ['push', '-q', '-u', 'origin', 'HEAD']);
    if (push.code !== 0) {
      opts.io.stdout.write(`warning: local: push failed: ${push.stderr.trim() || 'push failed'}\n`);
    } else {
      opts.io.stdout.write('pushed .repoboard/local/ to origin\n');
    }
  }
}

/**
 * RCB-93: is `.repoboard/<relPath>` tracked in the ROOT repo's git index? A file is checked with
 * `ls-files --error-unmatch` (exit 0 = tracked); a directory (`log`) is checked with a plain
 * `ls-files` — any tracked file under it counts, so non-empty stdout means tracked. Any git
 * failure — untracked, or root is not a git repository at all — is treated as untracked; the
 * store makes no git calls either, so "no git" and "not tracked" collapse to the same thing here.
 */
async function isTrackedInGit(root: string, relPath: string, isDir: boolean): Promise<boolean> {
  if (isDir) {
    const res = await runGit(root, ['ls-files', '--', relPath]);
    return res.code === 0 && res.stdout.trim().length > 0;
  }
  const res = await runGit(root, ['ls-files', '--error-unmatch', '--', relPath]);
  return res.code === 0;
}

/**
 * Move `.repoboard/<name>` into `.repoboard/local/<name>` when the former exists and the latter
 * does not — UNLESS `<name>` is tracked in the root repo's git index and `moveRecord` is false, in
 * which case it is left exactly where it is (RCB-93: the record lives where it already is; the
 * store reads it there). Tracked and moved: also `git rm -r --cached` it in the ROOT repo so the
 * parent index shows the removal staged for the owner to commit. Untracked: unchanged behaviour —
 * always moves. Prints `moved …` / `kept … (tracked in git; …)`; silent when there is nothing to
 * move (both present, or neither). Never merges or overwrites.
 */
async function moveIntoLocal(
  root: string,
  name: string,
  io: LocalIO,
  moveRecord: boolean,
): Promise<void> {
  const from = join(root, '.repoboard', name);
  const to = join(localDir(root), name);
  const fromPresent = await stat(from).then(
    () => true,
    () => false,
  );
  const toPresent = await stat(to).then(
    () => true,
    () => false,
  );
  if (!fromPresent || toPresent) return;

  const relPath = `.repoboard/${name}`;
  const isDir = await isDirectory(from);
  const tracked = await isTrackedInGit(root, relPath, isDir);

  if (tracked && !moveRecord) {
    io.stdout.write(
      `kept ${relPath} (tracked in git; pass --move-record to move it into .repoboard/local/)\n`,
    );
    return;
  }

  await rename(from, to);
  io.stdout.write(`moved ${relPath} → .repoboard/local/${name}\n`);

  if (tracked) {
    await runGit(root, ['rm', '-r', '-q', '--cached', '--', relPath]);
  }
}

export interface LocalSyncResult {
  status: 'no-local' | 'clean' | 'committed';
  pushed: boolean | null;
  error?: string;
}

/**
 * Stage everything, commit if there is anything staged, push only when `origin` exists.
 * `pushed: null` means there was nothing to push to (no remote) or nothing to push (clean/no
 * commit needed); a push failure is returned as data, never thrown, so a caller can warn and
 * carry on rather than fail the write that triggered the sync.
 */
export async function localSync(root: string, message: string): Promise<LocalSyncResult> {
  if (!(await hasLocal(root))) return { status: 'no-local', pushed: null };
  const dir = localDir(root);

  await runGit(dir, ['add', '-A']);
  const diff = await runGit(dir, ['diff', '--cached', '--quiet']);
  if (diff.code === 0) return { status: 'clean', pushed: null };

  const commit = await runGit(dir, ['commit', '-q', '-m', message]);
  if (commit.code !== 0) {
    // Unexpected (there WAS something staged) — surfaced as an error, never thrown.
    return {
      status: 'committed',
      pushed: null,
      error: commit.stderr.trim() || 'commit failed',
    };
  }

  const remote = await runGit(dir, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0) return { status: 'committed', pushed: null };

  const push = await runGit(dir, ['push', '-q', '-u', 'origin', 'HEAD']);
  if (push.code !== 0) {
    return { status: 'committed', pushed: false, error: push.stderr.trim() || 'push failed' };
  }
  return { status: 'committed', pushed: true };
}

export interface LocalStatus {
  isRepo: boolean;
  hasRemote: boolean;
  dirty: boolean;
  ahead: number | null;
  /** RCB-128: true iff `.repoboard/local/local.yml` says `remote: none` — the owner's opt-out ack
   * for a local layer with no backup on purpose. */
  remoteAck: boolean;
}

/** `null` when there is no `.repoboard/local/` directory at all. */
export async function localStatus(root: string): Promise<LocalStatus | null> {
  if (!(await hasLocal(root))) return null;
  const dir = localDir(root);
  const remoteAck = await readRemoteAck(root);

  const isRepo = await isDirectory(join(dir, '.git'));
  if (!isRepo) return { isRepo: false, hasRemote: false, dirty: false, ahead: null, remoteAck };

  const status = await runGit(dir, ['status', '--porcelain']);
  const dirty = status.stdout.trim().length > 0;

  const remote = await runGit(dir, ['remote', 'get-url', 'origin']);
  const hasRemote = remote.code === 0;

  const count = await runGit(dir, ['rev-list', '--count', '@{u}..HEAD']);
  const parsed = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
  const ahead = Number.isNaN(parsed) ? null : parsed;

  return { isRepo, hasRemote, dirty, ahead, remoteAck };
}
