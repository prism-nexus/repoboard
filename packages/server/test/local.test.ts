/**
 * RCB-83 step 1: `.repoboard/local/` — a second, local-only git repo for machine facts (RIG.md)
 * and, once an owner `git mv`s them in, the running record (STATE.md, log/). `local
 * init|sync|status`, the `seat`/`log` auto-sync, `seat`'s Rig section, `check`'s
 * local-unsynced/local-no-remote findings, and the control that a root with NO local layer is
 * untouched (everything still writes `.repoboard/log/`, byte for byte). All git fixtures live
 * under `os.tmpdir()` (`makeTempRepoboard`/`makeTempDir`); nothing outside them is ever touched.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultBoardConfig, serializeBoard, toIso } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { hasLocal, localDir, localInit, localStatus, localSync } from '../src/local.js';
import { makeTempDir, makeTempRepoboard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);
const TODAY = toIso(NOW).slice(0, 10);

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

async function repoboard(cwd: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    cwd,
    stdout,
    stderr,
    env: { REPOBOARD_ACTOR: 'test-actor' },
    now: () => NOW,
  });
  return { code, out: stdout.text, err: stderr.text };
}

async function freshRepo(cards: Record<string, string> = {}): Promise<string> {
  const repo = await makeTempRepoboard(cards);
  dirs.push(repo.root);
  return repo.root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout;
}

/** A bare repo under `os.tmpdir()`, usable as `--remote <url>`. */
async function makeBareRemote(): Promise<string> {
  const dir = await makeTempDir('repoboard-bare-');
  dirs.push(dir);
  await git(dir, 'init', '-q', '--bare');
  return dir;
}

describe('repoboard local init', () => {
  it('scaffolds RIG.md, ignores .repoboard/local/, git-inits, and commits once', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'local', 'init');
    expect(res.code).toBe(0);
    expect(res.out).toContain('created .repoboard/local/RIG.md');
    expect(res.out).toContain('ignored .repoboard/local/ in .gitignore');
    expect(res.out).toContain(
      "see also: repoboard init --practices (STATE.md, today's log, leases.yml, NEXT-AGENT-PROMPT.md)",
    );

    const rig = await readFile(join(root, '.repoboard', 'local', 'RIG.md'), 'utf8');
    expect(rig).toContain('# RIG — <this machine>');
    expect(rig).toContain('## Build');
    expect(rig).toContain('## Ports');
    expect(rig).toContain('## Locks');
    expect(rig).toContain('## Seat names');
    expect(rig).toContain('## Other repos on this machine');

    const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('.repoboard/local/');

    const gitDirStat = await stat(join(root, '.repoboard', 'local', '.git'));
    expect(gitDirStat.isDirectory()).toBe(true);

    const commits = (await git(join(root, '.repoboard', 'local'), 'log', '--oneline'))
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(commits.length).toBe(1);
  });

  it('running it again is idempotent: "kept", no second commit', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    const again = await repoboard(root, 'local', 'init');
    expect(again.code).toBe(0);
    expect(again.out).toContain('kept .repoboard/local/RIG.md');
    expect(again.out).toContain('kept .gitignore');

    const commits = (await git(join(root, '.repoboard', 'local'), 'log', '--oneline'))
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(commits.length).toBe(1);

    // .gitignore was not duplicated either.
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
    expect(gitignore.split('\n').filter((l) => l.trim() === '.repoboard/local/').length).toBe(1);
  });

  it('--remote <bare> points origin at it', async () => {
    const root = await freshRepo({});
    const bare = await makeBareRemote();
    const res = await repoboard(root, 'local', 'init', '--remote', bare);
    expect(res.code).toBe(0);
    const url = (
      await git(join(root, '.repoboard', 'local'), 'remote', 'get-url', 'origin')
    ).trim();
    expect(url).toBe(bare);
  });

  it('moves a top-level STATE.md and log/ into local/ (the store reads them there from now on)', async () => {
    const root = await freshRepo({});
    const withThem = await repoboard(root, 'init', '--practices');
    expect(withThem.code).toBe(0);
    const before = await repoboard(root, 'seat', 'builder', '--up', 'here');
    expect(before.code).toBe(0);
    const res = await repoboard(root, 'local', 'init');
    expect(res.out).toContain('moved .repoboard/STATE.md → .repoboard/local/STATE.md');
    expect(res.out).toContain('moved .repoboard/log → .repoboard/local/log');
    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(false);
    expect(existsSync(join(root, '.repoboard', 'local', 'STATE.md'))).toBe(true);
    expect(existsSync(join(root, '.repoboard', 'log'))).toBe(false);
    // The seat's SEATS bullet survives the move — read from the new location.
    const after = await repoboard(root, 'seat', 'builder');
    expect(after.out).toContain('builder: UP');

    const clean = await freshRepo({});
    const res2 = await repoboard(clean, 'local', 'init');
    expect(res2.out).not.toContain('moved ');
  });
});

describe('RCB-93: a tracked record stays where it is', () => {
  /** git-init the root, add + commit `.repoboard/` so STATE.md and log/ are TRACKED there. */
  async function commitRepoboard(root: string): Promise<void> {
    await git(root, 'init', '-q');
    await git(root, 'add', '.repoboard');
    await git(root, 'commit', '-q', '-m', 'tracked record');
  }

  it('(a) a tracked STATE.md/log is kept in place without --move-record; the store keeps reading it there', async () => {
    const root = await freshRepo({});
    const init = await repoboard(root, 'init', '--practices');
    expect(init.code).toBe(0);
    await commitRepoboard(root);

    const res = await repoboard(root, 'local', 'init');
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      'kept .repoboard/STATE.md (tracked in git; pass --move-record to move it into .repoboard/local/)',
    );
    expect(res.out).toContain(
      'kept .repoboard/log (tracked in git; pass --move-record to move it into .repoboard/local/)',
    );
    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(true);
    expect(existsSync(join(root, '.repoboard', 'local', 'STATE.md'))).toBe(false);

    const up = await repoboard(root, 'seat', 'builder', '--up', 'starting work');
    expect(up.code).toBe(0);
    const topState = await readFile(join(root, '.repoboard', 'STATE.md'), 'utf8');
    expect(topState).toContain('starting work');
    expect(existsSync(join(root, '.repoboard', 'local', 'STATE.md'))).toBe(false);

    const seat = await repoboard(root, 'seat', 'builder');
    expect(seat.code).toBe(0);
    expect(seat.out).toContain('## Rig (.repoboard/local/RIG.md)');
    expect(seat.out).toContain('builder: UP');
  });

  it('(b) --move-record moves a tracked STATE.md/log and stages the removal in the root repo', async () => {
    const root = await freshRepo({});
    const init = await repoboard(root, 'init', '--practices');
    expect(init.code).toBe(0);
    await commitRepoboard(root);

    const res = await repoboard(root, 'local', 'init', '--move-record');
    expect(res.code).toBe(0);
    expect(res.out).toContain('moved .repoboard/STATE.md → .repoboard/local/STATE.md');
    expect(res.out).toContain('moved .repoboard/log → .repoboard/local/log');

    const status = await git(root, 'status', '--porcelain');
    expect(status).toContain('D  .repoboard/STATE.md');

    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(false);
    expect(existsSync(join(root, '.repoboard', 'local', 'STATE.md'))).toBe(true);

    const up = await repoboard(root, 'seat', 'builder', '--up', 'moved record work');
    expect(up.code).toBe(0);
    const localState = await readFile(join(root, '.repoboard', 'local', 'STATE.md'), 'utf8');
    expect(localState).toContain('moved record work');
    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(false);
  });

  it('(c) a bare .repoboard/local/ directory alone never flips which STATE.md the store reads', async () => {
    const root = await freshRepo({});
    const init = await repoboard(root, 'init', '--practices');
    expect(init.code).toBe(0);
    const before = await repoboard(root, 'seat', 'builder', '--up', 'before local dir existed');
    expect(before.code).toBe(0);

    await mkdir(join(root, '.repoboard', 'local'), { recursive: true });

    const res = await repoboard(root, 'seat', 'builder');
    expect(res.code).toBe(0);
    expect(res.out).toContain('builder: UP');
    expect(existsSync(join(root, '.repoboard', 'local', 'STATE.md'))).toBe(false);
  });

  it('(d) a configured board.yml logDir still wins even with a tracked STATE.md/log', async () => {
    const root = await freshRepo({});
    const init = await repoboard(root, 'init', '--practices');
    expect(init.code).toBe(0);
    await writeFile(
      join(root, '.repoboard', 'board.yml'),
      serializeBoard({ ...defaultBoardConfig(), logDir: 'docs/log' }),
    );
    await commitRepoboard(root);

    const initLocal = await repoboard(root, 'local', 'init');
    expect(initLocal.code).toBe(0);

    const res = await repoboard(root, 'log', '--as', 'x', 'y');
    expect(res.code).toBe(0);
    const text = await readFile(join(root, 'docs', 'log', `${TODAY}.md`), 'utf8');
    expect(text).toContain('y');
    expect(existsSync(join(root, '.repoboard', 'local', 'log'))).toBe(false);
  });

  it('(e) control: no top-level record at all — local init pre-creates local/log/, seat/log write there', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'local', 'init');
    expect(res.code).toBe(0);
    expect(existsSync(join(root, '.repoboard', 'local', 'log'))).toBe(true);

    const log = await repoboard(root, 'log', '--as', 'x', 'y');
    expect(log.code).toBe(0);
    const text = await readFile(join(root, '.repoboard', 'local', 'log', `${TODAY}.md`), 'utf8');
    expect(text).toContain('y');

    const up = await repoboard(root, 'seat', 'x', '--up', 'a');
    expect(up.code).toBe(0);
    const state = await readFile(join(root, '.repoboard', 'local', 'STATE.md'), 'utf8');
    expect(state).toContain('a');
    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(false);
  });
});

describe('repoboard local init --remote on an already-committed local repo', () => {
  it('pushes the existing history when there is nothing new to commit', async () => {
    const root = await freshRepo({});
    const first = await repoboard(root, 'local', 'init');
    expect(first.code).toBe(0);
    const bare = await makeTempDir('rcb-83-bare-');
    await execFileAsync('git', ['init', '-q', '--bare', bare]);
    const res = await repoboard(root, 'local', 'init', '--remote', bare);
    expect(res.code).toBe(0);
    expect(res.out).toContain('pushed .repoboard/local/ to origin');
    const { stdout } = await execFileAsync('git', ['--git-dir', bare, 'rev-parse', 'HEAD']);
    const local = await git(localDir(root), 'rev-parse', 'HEAD');
    expect(stdout.trim()).toBe(local.trim());
  });
});

describe('repoboard local sync / status', () => {
  it('status: "no .repoboard/local/" before init', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'local', 'status');
    expect(res.code).toBe(0);
    expect(res.out).toContain('no .repoboard/local/ — run repoboard local init');
  });

  it('status after init with a remote: 0 ahead, clean, remote', async () => {
    const root = await freshRepo({});
    const bare = await makeBareRemote();
    await repoboard(root, 'local', 'init', '--remote', bare);
    const res = await repoboard(root, 'local', 'status');
    expect(res.code).toBe(0);
    expect(res.out).toContain('local: 0 ahead, clean, remote');
  });

  it('status with no remote configured', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    const res = await repoboard(root, 'local', 'status');
    expect(res.out).toContain('no remote');
  });

  it('sync: "no .repoboard/local/" before init, "clean" right after init (nothing new to stage)', async () => {
    const root = await freshRepo({});
    const before = await repoboard(root, 'local', 'sync');
    expect(before.out).toContain('no .repoboard/local/ — run repoboard local init');

    await repoboard(root, 'local', 'init');
    const after = await repoboard(root, 'local', 'sync');
    expect(after.code).toBe(0);
    expect(after.out).toContain('local: clean');
  });

  it('sync with a dirty RIG.md commits it (and reports "committed")', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    await writeFile(join(root, '.repoboard', 'local', 'RIG.md'), '# RIG — edited by hand\n');
    const res = await repoboard(root, 'local', 'sync', '-m', 'edited RIG.md');
    expect(res.code).toBe(0);
    expect(res.out).toContain('local: committed');
    const status = await git(join(root, '.repoboard', 'local'), 'status', '--porcelain');
    expect(status.trim()).toBe('');
    const lastMsg = (
      await git(join(root, '.repoboard', 'local'), 'log', '-1', '--format=%s')
    ).trim();
    expect(lastMsg).toBe('edited RIG.md');
  });
});

describe('repoboard log --as <seat>: writes local/log/ and syncs it when a local layer exists', () => {
  it('writes .repoboard/local/log/<date>.md and pushes to the configured remote', async () => {
    const root = await freshRepo({});
    const bare = await makeBareRemote();
    await repoboard(root, 'local', 'init', '--remote', bare);
    const beforeHead = (await git(bare, 'rev-parse', 'HEAD')).trim();

    const res = await repoboard(root, 'log', '--as', 'builder', 'did a thing');
    expect(res.code).toBe(0);

    const localLogPath = join(root, '.repoboard', 'local', 'log', `${TODAY}.md`);
    const text = await readFile(localLogPath, 'utf8');
    expect(text).toContain('did a thing');

    // The legacy top-level log/ is untouched — writes follow the local layer, they don't fork it.
    await expect(stat(join(root, '.repoboard', 'log', `${TODAY}.md`))).rejects.toThrow();

    const afterHead = (await git(bare, 'rev-parse', 'HEAD')).trim();
    expect(afterHead).not.toBe(beforeHead);
  });

  it('a push failure warns on stderr but still exits 0', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init', '--remote', 'file:///not/a/real/remote-xyz');
    const res = await repoboard(root, 'log', '--as', 'builder', 'push should fail quietly');
    expect(res.code).toBe(0);
    expect(res.err).toContain('warning: local: push failed:');
    const text = await readFile(join(root, '.repoboard', 'local', 'log', `${TODAY}.md`), 'utf8');
    expect(text).toContain('push should fail quietly');
  });
});

describe('repoboard seat: local/STATE.md and the Rig section', () => {
  it('seat --up writes .repoboard/local/STATE.md once a local layer exists', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    const res = await repoboard(root, 'seat', 'builder', '--up', 'starting work');
    expect(res.code).toBe(0);

    const localState = await readFile(join(root, '.repoboard', 'local', 'STATE.md'), 'utf8');
    expect(localState).toContain('starting work');
    await expect(stat(join(root, '.repoboard', 'STATE.md'))).rejects.toThrow();
  });

  it('seat <name> prints the RIG.md text under "## Rig (.repoboard/local/RIG.md)"', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    const res = await repoboard(root, 'seat', 'builder');
    expect(res.code).toBe(0);
    expect(res.out).toContain('## Rig (.repoboard/local/RIG.md)');
    expect(res.out).toContain('# RIG — <this machine>');
  });

  it('with no local layer: the placeholder line, not a crash', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'seat', 'builder');
    expect(res.code).toBe(0);
    expect(res.out).toContain('(no .repoboard/local/RIG.md — run repoboard local init)');
  });
});

describe('repoboard check: local-unsynced / local-no-remote (RCB-83)', () => {
  it('an edit to RIG.md left unsynced makes check print local-unsynced', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    await writeFile(join(root, '.repoboard', 'local', 'RIG.md'), '# RIG — edited, not synced\n');
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(0); // warning-level: blocks only with --strict
    expect(res.out).toContain(
      'local: uncommitted changes in .repoboard/local/ — repoboard local sync',
    );

    const strict = await repoboard(root, 'check', '--strict');
    expect(strict.code).toBe(1);
  });

  it('no remote configured: local-no-remote, informational, never blocks', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'local', 'init');
    const res = await repoboard(root, 'check', '--strict');
    expect(res.code).toBe(0);
    expect(res.out).toContain('local: no remote — repoboard local init --remote <url>');
  });

  it('clean, synced, with a remote: no local finding at all', async () => {
    const root = await freshRepo({});
    const bare = await makeBareRemote();
    await repoboard(root, 'local', 'init', '--remote', bare);
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(0);
    expect(res.out).not.toContain('local:');
  });

  it('no .repoboard/local/ at all: no local finding — inert when unconfigured', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(0);
    expect(res.out).not.toContain('local:');
  });
});

describe('control: a root with NO local layer writes .repoboard/log/ exactly as before (RCB-83)', () => {
  it('log --as <seat> is untouched with no .repoboard/local/', async () => {
    const root = await freshRepo({});
    expect(await hasLocal(root)).toBe(false);
    const res = await repoboard(root, 'log', '--as', 'builder', 'no local layer here');
    expect(res.code).toBe(0);
    const text = await readFile(join(root, '.repoboard', 'log', `${TODAY}.md`), 'utf8');
    expect(text).toContain('no local layer here');
    await expect(stat(join(root, '.repoboard', 'local'))).rejects.toThrow();
  });
});

describe('local.ts functions directly', () => {
  it('hasLocal/localStatus/localSync all report null/false with no .repoboard/local/', async () => {
    const root = await freshRepo({});
    expect(await hasLocal(root)).toBe(false);
    expect(await localStatus(root)).toBeNull();
    expect(await localSync(root, 'x')).toEqual({ status: 'no-local', pushed: null });
  });

  it('localInit is idempotent when called back to back with the same io', async () => {
    const root = await freshRepo({});
    const sink = new Sink();
    await localInit(root, { io: { stdout: sink } });
    const firstOut = sink.text;
    sink.text = '';
    await localInit(root, { io: { stdout: sink } });
    expect(firstOut).toContain('created .repoboard/local/RIG.md');
    expect(sink.text).toContain('kept .repoboard/local/RIG.md');
    expect(await hasLocal(root)).toBe(true);
    expect(localDir(root)).toBe(join(root, '.repoboard', 'local'));
  });
});
