/**
 * RCB-209: `scripts/public-guard.sh` (staged / msg / push) and the store's `check` share one
 * private denylist, `.repoboard/local/public-denylist.txt`. Every fixture is a git repo under
 * `os.tmpdir()` with its own local layer and its own denylist (written here — the owner's real
 * one is never read); git runs without the user's or the system's config, so a global
 * `core.hooksPath` cannot fire in a fixture. The pattern is `acme-secret`: a stand-in.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBoardConfig, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/store.js';
import { makeTempDir, NOW } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/public-guard.sh', import.meta.url));
const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];
const ZEROS = '0'.repeat(40);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, stdin?: string): Promise<Ran> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', rej);
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    // A hook that refuses may exit before reading its stdin; the write then fails with EPIPE
    // (CI 36809663939, Node 22: 2 unhandled errors). The exit code is the result, not the pipe.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') rej(e);
    });
    child.stdin.end(stdin ?? '');
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  return r.stdout.trim();
}

const guard = (cwd: string, args: string[], stdin?: string) =>
  run('bash', [SCRIPT, ...args], cwd, stdin);

/**
 * A board in a git repo with a gitignored `.repoboard/local/`. `denylist` is the file's text, or
 * `null` for no file. `localRepo` makes the local layer its own git repo (what makes a missing
 * denylist worth an info finding); `localLayer: false` leaves no `.repoboard/local/` at all.
 */
async function makeRepo(
  denylist: string | null,
  opts: { localRepo?: boolean; localLayer?: boolean } = {},
): Promise<string> {
  const root = await makeTempDir('repoboard-guard-');
  dirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await mkdir(join(root, '.repoboard'), { recursive: true });
  await writeFile(join(root, '.repoboard', 'board.yml'), serializeBoard(defaultBoardConfig()));
  await writeFile(join(root, '.gitignore'), '.repoboard/local/\n');
  if (opts.localLayer !== false) {
    await mkdir(join(root, '.repoboard', 'local'), { recursive: true });
    if (opts.localRepo) await git(join(root, '.repoboard', 'local'), 'init', '-q', '-b', 'main');
    if (denylist !== null) {
      await writeFile(join(root, '.repoboard', 'local', 'public-denylist.txt'), denylist);
    }
  }
  await writeFile(join(root, 'README.md'), 'a clean readme\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'base');
  return root;
}

/** A blank line, then one pattern — the shape that would match EVERY line if the blank leaked. */
const DENY = '\nacme-secret\n';

async function stage(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text);
  }
  await git(root, 'add', '-A');
}

describe('public-guard.sh staged', () => {
  it('a staged added line that matches exits 1, names file:line, and never echoes the match', async () => {
    const root = await makeRepo(DENY);
    await stage(root, { 'leak.txt': 'one\nthe Acme-Secret plan\nthree\n' });
    const r = await guard(root, ['staged']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('leak.txt:2');
    expect(r.stderr.toLowerCase()).not.toContain('acme-secret');
    expect(r.stdout).toBe('');
  });

  it('the denylist blank line is not a wildcard: an innocent staged file exits 0', async () => {
    const root = await makeRepo(DENY);
    await stage(root, { 'notes.txt': 'nothing to see\n\nhere either\n' });
    const r = await guard(root, ['staged']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('reports the right line in a later hunk, a spaced path, and skips a removed matching line', async () => {
    const root = await makeRepo(DENY);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    await stage(root, { 'my notes.txt': `${lines.join('\n')}\n` });
    await git(root, 'commit', '-q', '-m', 'notes');
    lines.splice(24, 0, '+++ looks like a header, says acme-secret');
    lines[2] = 'line 3 ACME-SECRET';
    await stage(root, { 'my notes.txt': `${lines.join('\n')}\n` });
    const hit = await guard(root, ['staged']);
    expect(hit.code).toBe(1);
    expect(hit.stderr).toContain('my notes.txt:3');
    expect(hit.stderr).toContain('my notes.txt:25');
    await git(root, 'commit', '-q', '--no-verify', '-m', 'leak');
    // Removing the matching lines adds nothing that matches.
    await stage(root, {
      'my notes.txt': `${lines.filter((l) => !/acme-secret/i.test(l)).join('\n')}\n`,
    });
    expect((await guard(root, ['staged'])).code).toBe(0);
  });

  it('a missing denylist exits 0 silently, even with a would-be hit staged', async () => {
    const root = await makeRepo(null);
    await stage(root, { 'leak.txt': 'acme-secret\n' });
    const r = await guard(root, ['staged']);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('a blank-only file, and a comment-only file, exit 0 silently', async () => {
    const root = await makeRepo('\n   \n\t\n');
    await stage(root, { 'leak.txt': 'acme-secret\n\nanything\n' });
    const blank = await guard(root, ['staged']);
    expect(blank.code).toBe(0);
    expect(blank.stdout + blank.stderr).toBe('');
    await writeFile(
      join(root, '.repoboard', 'local', 'public-denylist.txt'),
      '# acme-secret is listed below, not here\n',
    );
    const comment = await guard(root, ['staged']);
    expect(comment.code).toBe(0);
    expect(comment.stdout + comment.stderr).toBe('');
  });

  it('a lockfile hit is ignored at any depth; the same text in a notes file is not', async () => {
    const root = await makeRepo(DENY);
    const integrity = 'sha512-acme-secret==\n';
    await stage(root, {
      'pnpm-lock.yaml': integrity,
      'packages/x/package-lock.json': integrity,
      'packages/y/yarn.lock': integrity,
    });
    expect((await guard(root, ['staged'])).code).toBe(0);
    await stage(root, { 'notes.md': integrity });
    const r = await guard(root, ['staged']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('notes.md:1');
    expect(r.stderr).not.toContain('lock');
  });

  it('a pattern grep cannot compile exits 1 — a guard that cannot run does not wave a commit through', async () => {
    const root = await makeRepo('acme-(secret\n');
    await stage(root, { 'notes.txt': 'innocent\n' });
    const r = await guard(root, ['staged']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not compile');
  });
});

describe('public-guard.sh msg', () => {
  it('a message line that matches exits 1 with its line number; the text is not echoed', async () => {
    const root = await makeRepo(DENY);
    await writeFile(join(root, 'MSG'), 'subject\n\nthe ACME-SECRET roadmap\n');
    const r = await guard(root, ['msg', join(root, 'MSG')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('commit message line 3');
    expect(r.stderr.toLowerCase()).not.toContain('acme-secret');
  });

  it('skips `#` lines and everything under the scissors line; a clean message exits 0', async () => {
    const root = await makeRepo(DENY);
    await writeFile(
      join(root, 'MSG'),
      [
        'subject',
        '',
        '# Please enter the commit message; acme-secret',
        `# ${'-'.repeat(24)} >8 ${'-'.repeat(24)}`,
        'diff --git a/x b/x',
        '+acme-secret',
        '',
      ].join('\n'),
    );
    expect((await guard(root, ['msg', join(root, 'MSG')])).code).toBe(0);
  });

  it('a missing denylist exits 0; no file argument is a usage error (2)', async () => {
    const root = await makeRepo(null);
    await writeFile(join(root, 'MSG'), 'acme-secret\n');
    expect((await guard(root, ['msg', join(root, 'MSG')])).code).toBe(0);
    const usage = await guard(await makeRepo(DENY), ['msg']);
    expect(usage.code).toBe(2);
  });
});

describe('public-guard.sh push', () => {
  const refLine = (sha: string, remote = ZEROS) =>
    `refs/heads/main ${sha} refs/heads/main ${remote}\n`;

  it('a tracked line at the pushed sha that matches exits 1 (sha:ref, path:line)', async () => {
    const root = await makeRepo(DENY);
    await stage(root, { 'leak.txt': 'fine\nAcme-Secret\n' });
    await git(root, 'commit', '-q', '-m', 'innocent words');
    const sha = await git(root, 'rev-parse', 'HEAD');
    const r = await guard(root, ['push', 'origin', 'url'], refLine(sha));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refs/heads/main: leak.txt:2');
    expect(r.stderr.toLowerCase()).not.toContain('acme-secret');
  });

  it('an outgoing commit message that matches exits 1 naming the commit, though the tree is clean', async () => {
    const root = await makeRepo(DENY);
    const base = await git(root, 'rev-parse', 'HEAD');
    await stage(root, { 'notes.txt': 'innocent\n' });
    await git(root, 'commit', '-q', '-m', 'Acme-Secret launch notes');
    const sha = await git(root, 'rev-parse', 'HEAD');
    const short = await git(root, 'rev-parse', '--short', 'HEAD');
    // New branch (remote sha all zeros): every commit no remote has is outgoing.
    const fresh = await guard(root, ['push', 'origin', 'url'], refLine(sha));
    expect(fresh.code).toBe(1);
    expect(fresh.stderr).toContain(`commit ${short} message`);
    expect(fresh.stderr.toLowerCase()).not.toContain('acme-secret');
    // Existing branch: remote..local is just that commit.
    const ranged = await guard(root, ['push', 'origin', 'url'], refLine(sha, base));
    expect(ranged.code).toBe(1);
    expect(ranged.stderr).toContain(`commit ${short} message`);
  });

  it('remote..local scans only what is outgoing: an older pushed message does not block', async () => {
    const root = await makeRepo(DENY);
    await stage(root, { 'a.txt': 'one\n' });
    await git(root, 'commit', '-q', '-m', 'acme-secret, long since pushed');
    const pushed = await git(root, 'rev-parse', 'HEAD');
    await stage(root, { 'b.txt': 'two\n' });
    await git(root, 'commit', '-q', '-m', 'a clean follow-up');
    const sha = await git(root, 'rev-parse', 'HEAD');
    const r = await guard(root, ['push', 'origin', 'url'], refLine(sha, pushed));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });

  it("a new branch's outgoing commits are those no tracking ref of THIS remote has, not of any remote (RCB-213)", async () => {
    const root = await makeRepo(DENY);
    await stage(root, { 'notes.txt': 'innocent\n' });
    await git(root, 'commit', '-q', '-m', 'Acme-Secret launch notes');
    const sha = await git(root, 'rev-parse', 'HEAD');
    const short = await git(root, 'rev-parse', '--short', 'HEAD');
    // Another remote already has the commit; that says nothing about what `origin` holds.
    await git(root, 'update-ref', 'refs/remotes/mirror/main', sha);
    const other = await guard(root, ['push', 'origin', 'url'], refLine(sha));
    expect(other.code).toBe(1);
    expect(other.stderr).toContain(`commit ${short} message`);
    expect(other.stderr.toLowerCase()).not.toContain('acme-secret');
    // No remote name to scope by: every commit is outgoing, never fewer.
    expect((await guard(root, ['push'], refLine(sha))).code).toBe(1);
    // The same commit under THIS remote's tracking refs is not outgoing.
    await git(root, 'update-ref', 'refs/remotes/origin/main', sha);
    const same = await guard(root, ['push', 'origin', 'url'], refLine(sha));
    expect(same.code).toBe(0);
    expect(same.stderr).toBe('');
  });

  it('a match one outgoing commit adds and the next removes is still caught: commit, file:line, no text', async () => {
    const root = await makeRepo(DENY);
    const base = await git(root, 'rev-parse', 'HEAD');
    await stage(root, { 'leak.txt': 'one\nthe Acme-Secret plan\nthree\n' });
    await git(root, 'commit', '-q', '-m', 'add notes');
    const shortA = await git(root, 'rev-parse', '--short', 'HEAD');
    await git(root, 'rm', '-q', 'leak.txt');
    await git(root, 'commit', '-q', '-m', 'drop notes');
    const shortB = await git(root, 'rev-parse', '--short', 'HEAD');
    const tip = await git(root, 'rev-parse', 'HEAD');
    // New branch (everything outgoing) and an existing branch (base..tip): the tip tree is clean in
    // both, so only the history scan can see line 2 of the file that was added and removed.
    for (const remote of [ZEROS, base]) {
      const r = await guard(root, ['push', 'origin', 'url'], refLine(tip, remote));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`commit ${shortA} leak.txt:2`);
      expect(r.stderr).not.toContain('refs/heads/main: leak.txt');
      expect(r.stderr).not.toContain(shortB);
      expect(r.stderr.toLowerCase()).not.toContain('acme-secret');
    }
  });

  it('a merge TREESAME to its parent does not hide the side commits that added a match', async () => {
    const root = await makeRepo(DENY);
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', '-q', '-c', 'side');
    await stage(root, { 'side.txt': 'x\nAcme-Secret\n' });
    await git(root, 'commit', '-q', '-m', 'side add');
    const shortSide = await git(root, 'rev-parse', '--short', 'HEAD');
    await git(root, 'rm', '-q', 'side.txt');
    await git(root, 'commit', '-q', '-m', 'side drop');
    await git(root, 'switch', '-q', 'main');
    await git(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merge = await git(root, 'rev-parse', 'HEAD');
    // The precondition: the merge changes nothing, so default history simplification drops the side.
    expect(await git(root, 'rev-parse', 'HEAD^{tree}')).toBe(
      await git(root, 'rev-parse', `${base}^{tree}`),
    );
    const r = await guard(root, ['push', 'origin', 'url'], refLine(merge, base));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`commit ${shortSide} side.txt:2`);
    expect(r.stderr).not.toContain('refs/heads/main: side.txt');
    expect(r.stderr.toLowerCase()).not.toContain('acme-secret');
  });

  it('a lockfile hit in the pushed tree is ignored; the same text in a notes file is not', async () => {
    const root = await makeRepo(DENY);
    await stage(root, {
      'pnpm-lock.yaml': 'sha512-acme-secret==\n',
      'pkg/yarn.lock': 'acme-secret\n',
    });
    await git(root, 'commit', '-q', '-m', 'lockfiles');
    const lock = await git(root, 'rev-parse', 'HEAD');
    expect((await guard(root, ['push', 'origin', 'url'], refLine(lock))).code).toBe(0);
    await stage(root, { 'notes.md': 'x\nacme-secret\n' });
    await git(root, 'commit', '-q', '-m', 'notes');
    const notes = await git(root, 'rev-parse', 'HEAD');
    const r = await guard(root, ['push', 'origin', 'url'], refLine(notes));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refs/heads/main: notes.md:2');
    expect(r.stderr).not.toContain('lock');
  });

  it('a clean push and a ref deletion (local sha all zeros) exit 0; a missing denylist exits 0', async () => {
    const root = await makeRepo(DENY);
    const sha = await git(root, 'rev-parse', 'HEAD');
    expect((await guard(root, ['push', 'origin', 'url'], refLine(sha))).code).toBe(0);
    expect((await guard(root, ['push', 'origin', 'url'], refLine(ZEROS, sha))).code).toBe(0);
    await rm(join(root, '.repoboard', 'local', 'public-denylist.txt'));
    await stage(root, { 'leak.txt': 'acme-secret\n' });
    await git(root, 'commit', '-q', '-m', 'acme-secret');
    const leaky = await git(root, 'rev-parse', 'HEAD');
    expect((await guard(root, ['push', 'origin', 'url'], refLine(leaky))).code).toBe(0);
  });
});

describe('.githooks', () => {
  it('each hook is executable and execs the script with its own mode', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const modes: Record<string, string> = {
      'pre-commit': 'staged',
      'commit-msg': 'msg',
      'pre-push': 'push',
    };
    for (const hook of HOOKS) {
      const path = join(repoRoot, '.githooks', hook);
      expect((await stat(path)).mode & 0o111).not.toBe(0);
      const text = await run('cat', [path], repoRoot);
      expect(text.stdout.trim().split('\n')).toEqual([
        '#!/bin/sh',
        `exec "$(git rev-parse --show-toplevel)/scripts/public-guard.sh" ${modes[hook]} "$@"`,
      ]);
    }
  });

  it('wired as core.hooksPath, a leaking commit and a leaking message are refused, a clean one lands', async () => {
    const root = await makeRepo(DENY);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, '.githooks'), { recursive: true });
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    await copyFile(SCRIPT, join(root, 'scripts', 'public-guard.sh'));
    await run('chmod', ['+x', join(root, 'scripts', 'public-guard.sh')], root);
    for (const hook of HOOKS) {
      await copyFile(join(repoRoot, '.githooks', hook), join(root, '.githooks', hook));
      await run('chmod', ['+x', join(root, '.githooks', hook)], root);
    }
    await git(root, 'config', 'core.hooksPath', '.githooks');
    const before = await git(root, 'rev-parse', 'HEAD');

    await stage(root, { 'leak.txt': 'acme-secret\n' });
    const blocked = await run('git', ['commit', '-q', '-m', 'innocent'], root);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('leak.txt:1');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);

    await run('git', ['reset', '-q', '--', 'leak.txt'], root);
    await rm(join(root, 'leak.txt'));
    await stage(root, { 'ok.txt': 'fine\n' });
    const badMsg = await run('git', ['commit', '-q', '-m', 'about acme-secret'], root);
    expect(badMsg.code).not.toBe(0);
    expect(badMsg.stderr).toContain('commit message line 1');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);

    const ok = await run('git', ['commit', '-q', '-m', 'fine'], root);
    expect(ok.code).toBe(0);
    expect(await git(root, 'rev-parse', 'HEAD')).not.toBe(before);
  });
});

describe('store.check: public denylist (RCB-209)', () => {
  async function findings(root: string) {
    const store = await openStore(root, { watch: false, now: () => NOW });
    try {
      const out = await store.check(false, []);
      return { ...out, public: out.findings.filter((f) => f.kind.startsWith('public-denylist-')) };
    } finally {
      await store.close();
    }
  }

  it('a tracked hit is one error finding: counts and path:line, never the matched text', async () => {
    const root = await makeRepo(DENY);
    await stage(root, {
      'leak.txt': 'one\nthe Acme-Secret plan\n',
      'pnpm-lock.yaml': 'sha512-acme-secret==\n',
    });
    await git(root, 'commit', '-q', '-m', 'leak');
    // Untracked files are not "tracked files": this one must not count.
    await writeFile(join(root, 'scratch.txt'), 'acme-secret\n');
    const out = await findings(root);
    expect(out.public).toHaveLength(1);
    const [f] = out.public;
    expect(f?.kind).toBe('public-denylist-hit');
    expect(f?.level).toBe('error');
    expect(f?.message).toBe(
      'public: 1 lines in 1 tracked files match .repoboard/local/public-denylist.txt — leak.txt:2',
    );
    expect(f?.message.toLowerCase()).not.toContain('acme-secret');
    expect(out.exitCode).toBe(1);
  });

  it('a clean tree (blank line in the denylist included) has no public finding', async () => {
    const root = await makeRepo(DENY);
    const out = await findings(root);
    expect(out.public).toEqual([]);
  });

  it('an invalid pattern is public-denylist-invalid (error), not a silent pass', async () => {
    const root = await makeRepo('acme-(secret\n');
    const out = await findings(root);
    expect(out.public.map((f) => [f.kind, f.level])).toEqual([
      ['public-denylist-invalid', 'error'],
    ]);
    expect(out.exitCode).toBe(1);
  });

  it('a file with no patterns is no finding at all', async () => {
    const root = await makeRepo('# nothing yet\n\n');
    await stage(root, { 'leak.txt': 'acme-secret\n' });
    await git(root, 'commit', '-q', '-m', 'x');
    expect((await findings(root)).public).toEqual([]);
  });

  it('a missing file is info only when the local layer is its own git repo; no local layer is inert', async () => {
    const withRepo = await findings(await makeRepo(null, { localRepo: true }));
    expect(withRepo.public.map((f) => [f.kind, f.level])).toEqual([
      ['public-denylist-missing', 'info'],
    ]);
    const localNoRepo = await findings(await makeRepo(null));
    expect(localNoRepo.public).toEqual([]);
    const noLayer = await findings(await makeRepo(null, { localLayer: false }));
    expect(noLayer.public).toEqual([]);
  });
});
