/**
 * RCB-222: `scripts/publish.sh` picks chosen card commits from `dev` onto a detached worktree of
 * the public remote's `main`, runs the public check over them, and (with `--apply`) pushes a
 * `publish/<ids>` branch and opens a pull request. Every fixture lives under `os.tmpdir()`: a bare
 * `origin`, a clone with `dev` ahead of `main`, and a fake `gh` first on PATH that records its argv.
 * Nothing here touches the real repo or a real remote; git runs without the user's or the
 * system's config. The denylist pattern is `acme-secret`: a stand-in.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/publish.sh', import.meta.url));
const PR_URL = 'https://example.test/acme/demo/pull/7';
const SLOW = 60_000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, pathPrefix?: string): Promise<Ran> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH ?? ''}` } : {}),
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
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') rej(e);
    });
    child.stdin.end('');
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Fixture {
  /** The caller's clone, on `dev`. */
  work: string;
  /** The bare remote. */
  origin: string;
  /** Where the fake `gh` appends one line per argument of every call. */
  ghLog: string;
  bin: string;
  /** The `dev` commit whose patch is already on main (picked there from another clone). */
  onMain: string;
  publish: (...args: string[]) => Promise<Ran>;
  /** The remote's refs, as `git ls-remote` prints them. */
  remoteRefs: () => Promise<string>;
  /** What a caller can see of its own checkout: HEAD, status, worktrees, local refs. */
  callerState: () => Promise<string>;
}

/**
 * `denylist` is the local-layer file's text, or `null` for no file. `dev` is ahead of `main` by
 * `ABC-1: a`, `ABC-2: b`, `ABC-3: c`, `ABC-1: a2` and `ABC-9: leak` (adds `acme-secret`); the
 * `ABC-3` patch is then put on origin's main from a second clone, so the caller's `origin/main`
 * is stale until the script fetches.
 */
async function makeFixture(denylist: string | null): Promise<Fixture> {
  const root = await makeTempDir('repoboard-publish-');
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  const bin = join(root, 'bin');
  const ghLog = join(root, 'gh.log');
  await mkdir(origin);
  await git(origin, 'init', '-q', '--bare', '-b', 'main');
  await mkdir(work);
  await git(work, 'init', '-q', '-b', 'main');
  await writeFile(join(work, '.gitignore'), '.repoboard/local/\n');
  await writeFile(join(work, 'README.md'), 'a clean readme\n');
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'base');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'main');
  await git(work, 'fetch', '-q', 'origin');
  if (denylist !== null) {
    await mkdir(join(work, '.repoboard', 'local'), { recursive: true });
    await writeFile(join(work, '.repoboard', 'local', 'public-denylist.txt'), denylist);
  }
  await git(work, 'checkout', '-q', '-b', 'dev');
  const commit = async (file: string, text: string, subject: string): Promise<string> => {
    await writeFile(join(work, file), text);
    await git(work, 'add', '-A');
    await git(work, 'commit', '-q', '-m', subject);
    return git(work, 'rev-parse', 'HEAD');
  };
  await commit('a.txt', 'a\n', 'ABC-1: a');
  await commit('b.txt', 'b\n', 'ABC-2: b');
  const onMain = await commit('c.txt', 'c\n', 'ABC-3: c');
  await commit('a2.txt', 'a2\n', 'ABC-1: a2');
  await commit('leak.txt', 'the acme-secret plan\n', 'ABC-9: leak');

  // The same patch lands on origin's main as a different commit, from another clone.
  await git(root, 'clone', '-q', origin, other);
  await git(other, 'fetch', '-q', work, 'dev');
  await git(other, 'cherry-pick', onMain);
  await git(other, 'push', '-q', 'origin', 'main');

  await mkdir(bin);
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${ghLog}'; done\nprintf '%s\\n' '${PR_URL}'\n`,
  );
  await chmod(join(bin, 'gh'), 0o755);

  return {
    work,
    origin,
    ghLog,
    bin,
    onMain,
    publish: (...args) => run('bash', [SCRIPT, ...args], work, bin),
    remoteRefs: () => git(work, 'ls-remote', 'origin'),
    callerState: async () =>
      [
        await git(work, 'rev-parse', 'HEAD'),
        await git(work, 'symbolic-ref', 'HEAD'),
        await git(work, 'status', '--porcelain'),
        await git(work, 'worktree', 'list', '--porcelain'),
        await git(work, 'for-each-ref', 'refs/heads', 'refs/tags'),
        await git(work, 'stash', 'list'),
      ].join('\n--\n'),
  };
}

const DENY = '# the private patterns\n\nacme-secret\n';

describe('publish.sh', () => {
  it(
    'a dry run of ABC-1 lists both ABC-1 commits, oldest first, and nothing else; pushes nothing',
    async () => {
      const fx = await makeFixture(DENY);
      const before = await fx.remoteRefs();
      const r = await fx.publish('ABC-1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('public check: 1 patterns, clean');
      const lines = r.stdout.split('\n').filter((l) => /^[0-9a-f]{7,} ABC-/.test(l));
      expect(lines.map((l) => l.replace(/^[0-9a-f]+ /, ''))).toEqual(['ABC-1: a', 'ABC-1: a2']);
      expect(r.stdout).toContain('a.txt');
      expect(r.stdout).toContain('a2.txt');
      expect(r.stdout).not.toContain('b.txt');
      expect(r.stdout).toContain('dry run: nothing pushed');
      expect(await fx.remoteRefs()).toBe(before);
      await expect(readFile(fx.ghLog, 'utf8')).rejects.toThrow();
    },
    SLOW,
  );

  it(
    'the commit already on main by patch is never re-picked; an unknown sha exits 1',
    async () => {
      const fx = await makeFixture(DENY);
      const before = await fx.remoteRefs();
      const byId = await fx.publish('ABC-3');
      expect(byId.code).toBe(1);
      expect(byId.stdout).not.toContain('ABC-3: c');
      const bySha = await fx.publish(fx.onMain);
      expect(bySha.code).toBe(1);
      expect(bySha.stdout).not.toContain('dry run');
      const unknown = await fx.publish('deadbeef'.repeat(5));
      expect(unknown.code).toBe(1);
      expect(unknown.stdout).not.toContain('dry run');
      // Picked together with a candidate, the already-landed commit still does not go out.
      const both = await fx.publish('ABC-2', fx.onMain);
      expect(both.code).toBe(1);
      expect(await fx.remoteRefs()).toBe(before);
    },
    SLOW,
  );

  /**
   * RCB-224's shape: dev has `RCB-1: a` (on top of the fixture's ABC commits); main moves by an
   * unrelated commit and then gets a copy of `a` with a different sha (a rebase merge); dev merges
   * origin/main back; dev then has `RCB-1: b`.
   */
  async function makeMergedBack(): Promise<{ fx: Fixture; aSha: string }> {
    const fx = await makeFixture(DENY);
    const root = dirname(fx.work);
    const other = join(root, 'other-224');
    await writeFile(join(fx.work, 'rcb1a.txt'), 'a\n');
    await git(fx.work, 'add', '-A');
    await git(fx.work, 'commit', '-q', '-m', 'RCB-1: a');
    const aSha = await git(fx.work, 'rev-parse', 'HEAD');
    // Main moves by one unrelated commit, then takes a copy of `a` on top (a new sha).
    await git(root, 'clone', '-q', fx.origin, other);
    await writeFile(join(other, 'unrelated.txt'), 'u\n');
    await git(other, 'add', '-A');
    await git(other, 'commit', '-q', '-m', 'unrelated');
    await git(other, 'fetch', '-q', fx.work, 'dev');
    await git(other, 'cherry-pick', aSha);
    expect(await git(other, 'rev-parse', 'HEAD')).not.toBe(aSha);
    await git(other, 'push', '-q', 'origin', 'main');
    // The merge-back, then a new dev commit.
    await git(fx.work, 'fetch', '-q', 'origin');
    await git(fx.work, 'merge', '-q', '--no-edit', 'origin/main');
    await writeFile(join(fx.work, 'rcb1b.txt'), 'b\n');
    await git(fx.work, 'add', '-A');
    await git(fx.work, 'commit', '-q', '-m', 'RCB-1: b');
    return { fx, aSha };
  }

  it(
    'after a merge-back, a dev commit already on main as a copy is not re-picked; the new one is',
    async () => {
      const { fx } = await makeMergedBack();
      const r = await fx.publish('RCB-1');
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('RCB-1: b');
      expect(r.stdout).not.toContain('RCB-1: a');
      expect(r.stdout).toContain('dry run: nothing pushed');
    },
    SLOW,
  );

  it(
    'after a merge-back, the sha of the commit already on main as a copy is not a candidate',
    async () => {
      const { fx, aSha } = await makeMergedBack();
      const r = await fx.publish(aSha);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('is not a candidate');
      expect(r.stdout).not.toContain('dry run');
    },
    SLOW,
  );

  it(
    'a candidate selected by its sha is picked',
    async () => {
      const fx = await makeFixture(DENY);
      const sha = await git(fx.work, 'rev-parse', 'dev~3'); // ABC-2: b
      const subject = await git(fx.work, 'log', '-1', '--format=%s', sha);
      const r = await fx.publish(sha);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`branch: publish/${sha.slice(0, 7)}`);
      expect(r.stdout).toContain(subject);
    },
    SLOW,
  );

  it(
    'a selected commit that adds acme-secret exits 1, pushes nothing and never prints the text',
    async () => {
      const fx = await makeFixture(DENY);
      const before = await fx.remoteRefs();
      for (const apply of [[], ['--apply']]) {
        const r = await fx.publish(...apply, 'ABC-9');
        expect(r.code).toBe(1);
        expect(r.stdout).toContain('public check: 1 patterns, hits');
        expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain('acme-secret');
        expect(r.stderr).toContain('leak.txt');
      }
      expect(await fx.remoteRefs()).toBe(before);
      await expect(readFile(fx.ghLog, 'utf8')).rejects.toThrow();
    },
    SLOW,
  );

  it(
    '--apply ABC-2 pushes publish/ABC-2 with exactly one new commit and asks gh for --base main',
    async () => {
      const fx = await makeFixture(DENY);
      const r = await fx.publish('--apply', 'ABC-2');
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(PR_URL);
      const remote = await git(fx.origin, 'rev-parse', 'refs/heads/publish/ABC-2');
      expect(await git(fx.origin, 'rev-list', '--count', `main..${remote}`)).toBe('1');
      expect(await git(fx.origin, 'log', '-1', '--format=%s', remote)).toBe('ABC-2: b');
      expect(await git(fx.origin, 'diff', '--name-only', 'main', remote)).toBe('b.txt');
      // No `-x`: the message is the original's, with no "cherry picked from" trailer.
      expect(await git(fx.origin, 'log', '-1', '--format=%B', remote)).not.toContain('cherry');
      const argv = (await readFile(fx.ghLog, 'utf8')).split('\n');
      expect(argv).toContain('pr');
      expect(argv).toContain('create');
      expect(argv[argv.indexOf('--base') + 1]).toBe('main');
      expect(argv[argv.indexOf('--head') + 1]).toBe('publish/ABC-2');
      expect(argv[argv.indexOf('--title') + 1]).toBe('ABC-2: b');
    },
    SLOW,
  );

  it(
    "the caller's HEAD, status, worktrees, refs and stash are unchanged by a dry run and an apply",
    async () => {
      const fx = await makeFixture(DENY);
      // A dirty tree and a staged file: both must survive.
      await writeFile(join(fx.work, 'scratch.txt'), 'uncommitted\n');
      await writeFile(join(fx.work, 'README.md'), 'edited\n');
      await git(fx.work, 'add', 'README.md');
      const before = await fx.callerState();
      const dry = await fx.publish('ABC-1', 'ABC-2');
      expect(dry.code, dry.stderr).toBe(0);
      expect(await fx.callerState()).toBe(before);
      const applied = await fx.publish('--apply', 'ABC-1', 'ABC-2');
      expect(applied.code, applied.stderr).toBe(0);
      expect(applied.stdout).toContain('branch: publish/ABC-1-ABC-2');
      expect(await fx.callerState()).toBe(before);
      expect(await readFile(join(fx.work, 'scratch.txt'), 'utf8')).toBe('uncommitted\n');
    },
    SLOW,
  );

  it(
    'a refused run also leaves the worktree list as it found it',
    async () => {
      const fx = await makeFixture(DENY);
      const before = await fx.callerState();
      expect((await fx.publish('ABC-9')).code).toBe(1);
      expect((await fx.publish('ABC-404')).code).toBe(1);
      expect(await fx.callerState()).toBe(before);
    },
    SLOW,
  );

  it(
    'no denylist: a dry run says NO DENYLIST and exits 0; --apply exits 1 and pushes nothing',
    async () => {
      for (const deny of [null, '# only a comment\n\n   \n']) {
        const fx = await makeFixture(deny);
        const before = await fx.remoteRefs();
        const dry = await fx.publish('ABC-1');
        expect(dry.code, dry.stderr).toBe(0);
        expect(dry.stdout).toContain('public check: NO DENYLIST');
        expect(dry.stdout).toContain('dry run: nothing pushed');
        const applied = await fx.publish('--apply', 'ABC-1');
        expect(applied.code).toBe(1);
        expect(applied.stdout).toContain('public check: NO DENYLIST');
        expect(await fx.remoteRefs()).toBe(before);
        await expect(readFile(fx.ghLog, 'utf8')).rejects.toThrow();
      }
    },
    SLOW,
  );

  it(
    'usage errors exit 2 and nothing is selected without an argument',
    async () => {
      const fx = await makeFixture(DENY);
      expect((await fx.publish()).code).toBe(2);
      expect((await fx.publish('--nope', 'ABC-1')).code).toBe(2);
      expect((await fx.publish('--from')).code).toBe(2);
    },
    SLOW,
  );
});
