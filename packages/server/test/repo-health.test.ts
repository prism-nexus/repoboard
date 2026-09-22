/**
 * RCB-112 A: the server half of the repo dashboard — `repoDashboard`, `gateLedgerPath`,
 * `loadGateHealth`. Git fixtures follow `scanner.test.ts`'s own pattern (a real temp git repo,
 * never mocked); the gate ledger is a real file under a real temp root.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SYSTEM_TESTS_SOURCE, type SystemsDoc } from '@repoboard/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasLocal, localDir, localInit } from '../src/local.js';
import * as refs from '../src/refs.js';
import { gateLedgerPath, loadGateHealth, repoDashboard } from '../src/repo-health.js';
import { makeTempDir } from './helpers.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await makeTempDir('repoboard-repo-health-');
  dirs.push(d);
  return d;
}

async function git(cwd: string, args: string[], at?: string): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

const NOW = new Date('2026-09-22T18:00:00Z');

describe('repoDashboard: empty temp dir (CONTROL — no .git, no .repoboard/)', () => {
  it('every band answers its null state, never throws', async () => {
    const root = await tempDir();
    const dash = await repoDashboard(root, null, NOW);
    expect(dash.health).toEqual({
      checks: { tests: null, typecheck: null, lint: null, build: null },
      ledger: null,
      errors: [],
      source: '.repoboard/gate.jsonl',
    });
    expect(dash.commits).toEqual({
      branch: null,
      head: null,
      originMain: null,
      perDay: null,
      byWho: null,
      source: expect.any(String),
    });
    expect(dash.coverage).toBeNull();
    expect(dash.coverageSource).toBe(SYSTEM_TESTS_SOURCE);
  });
});

describe('gateLedgerPath', () => {
  it('.repoboard/gate.jsonl when there is no .repoboard/local/ directory', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.repoboard'), { recursive: true });
    expect(await hasLocal(root)).toBe(false);
    expect(await gateLedgerPath(root)).toBe(join(root, '.repoboard', 'gate.jsonl'));
  });

  it('.repoboard/local/gate.jsonl once .repoboard/local/ exists', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.repoboard'), { recursive: true });
    await localInit(root, { io: { stdout: { write: () => true } } });
    expect(await hasLocal(root)).toBe(true);
    expect(await gateLedgerPath(root)).toBe(join(localDir(root), 'gate.jsonl'));
  });
});

describe('loadGateHealth / repoDashboard health band', () => {
  it('reads the ledger, reduces to the newest per check, surfaces a bad line as an error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.repoboard'), { recursive: true });
    const lines = [
      JSON.stringify({
        at: '2026-09-22T09:00:00Z',
        sha: 'aaa1111',
        as: 'builder',
        tests: { files: 200, passed: 1200, skipped: 4, failed: 0 },
        typecheck: 0,
        lint: null,
        build: null,
        note: null,
      }),
      'not json',
      JSON.stringify({
        at: '2026-09-22T11:00:00Z',
        sha: 'bbb2222',
        as: 'builder',
        tests: null,
        typecheck: null,
        lint: 0,
        build: 0,
        note: 'clean',
      }),
    ];
    await writeFile(join(root, '.repoboard', 'gate.jsonl'), `${lines.join('\n')}\n`);

    const health = await loadGateHealth(root);
    expect(health.ledger).toBe('.repoboard/gate.jsonl');
    expect(health.errors).toEqual(['line 2: not valid JSON']);
    expect(health.checks.tests).toMatchObject({
      ok: true,
      at: '2026-09-22T09:00:00Z',
      sha: 'aaa1111',
    });
    expect(health.checks.typecheck).toMatchObject({ ok: true, at: '2026-09-22T09:00:00Z' });
    expect(health.checks.lint).toMatchObject({ ok: true, at: '2026-09-22T11:00:00Z' });
    expect(health.checks.build).toMatchObject({ ok: true, at: '2026-09-22T11:00:00Z' });

    const dash = await repoDashboard(root, null, NOW);
    expect(dash.health).toEqual(health);
  });

  it('no ledger file (but .repoboard/ exists): every check null, ledger null, no error', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.repoboard'), { recursive: true });
    const health = await loadGateHealth(root);
    expect(health).toEqual({
      checks: { tests: null, typecheck: null, lint: null, build: null },
      ledger: null,
      errors: [],
      source: '.repoboard/gate.jsonl',
    });
  });
});

describe('repoDashboard: commits band (real git repo)', () => {
  it('branch, HEAD commits (newest-first, agent from trailer), no origin/main, cadence + byWho', async () => {
    const root = await tempDir();
    await git(root, ['init', '-q', '-b', 'main']);
    await writeFile(join(root, 'a.txt'), 'one\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'first commit'], '2026-09-22T09:00:00Z');
    await writeFile(join(root, 'a.txt'), 'two\n');
    await git(
      root,
      [
        'commit',
        '-q',
        '-am',
        'second commit\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
      ],
      '2026-09-22T10:00:00Z',
    );

    const dash = await repoDashboard(root, null, NOW);
    expect(dash.commits.branch).toBe('main');
    expect(dash.commits.originMain).toBeNull();
    expect(dash.commits.head).toHaveLength(2);
    expect(dash.commits.head?.[0]).toMatchObject({
      subject: 'second commit',
      agent: 'Claude Sonnet 5',
    });
    expect(dash.commits.head?.[1]).toMatchObject({ subject: 'first commit', agent: null });

    expect(dash.commits.perDay).toHaveLength(14);
    const today = dash.commits.perDay?.at(-1);
    expect(today).toMatchObject({ date: '2026-09-22', count: 2 });
    expect(dash.commits.byWho).toEqual(
      expect.arrayContaining([
        { who: 'Claude Sonnet 5', count: 1 },
        { who: 't', count: 1 },
      ]),
    );
  });

  it('origin/main present (a remote-tracking ref, no real remote needed): commits reported', async () => {
    const root = await tempDir();
    await git(root, ['init', '-q', '-b', 'main']);
    await writeFile(join(root, 'a.txt'), 'one\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'only commit'], '2026-09-22T09:00:00Z');
    const sha = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['update-ref', 'refs/remotes/origin/main', sha]);

    const dash = await repoDashboard(root, null, NOW);
    expect(dash.commits.originMain).toHaveLength(1);
    expect(dash.commits.originMain?.[0]).toMatchObject({ subject: 'only commit' });
  });

  it('a git repo with zero commits (unborn HEAD): head/perDay/byWho null, no throw', async () => {
    const root = await tempDir();
    await git(root, ['init', '-q', '-b', 'main']);
    const dash = await repoDashboard(root, null, NOW);
    expect(dash.commits.head).toBeNull();
    expect(dash.commits.perDay).toBeNull();
    expect(dash.commits.byWho).toBeNull();
  });
});

// ---- CONTROL: the coverage band's test corpus is read ONCE for every system, not once per system

function sysRow(id: string, pointer: string): SystemsDoc['systems'][number] {
  return {
    id,
    name: id,
    kind: 'service',
    layer: 'app',
    env: ['dev'],
    runtime: {},
    owner: null,
    pointers: [pointer],
    docs: [],
    why: null,
    source: { hand: 'test', at: '2026-09-22T00:00:00Z' },
  };
}

describe('repoDashboard: coverage band — corpus read once (CONTROL)', () => {
  it('3 systems, 2 test files: readRepoText is called twice, not six times', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const A = 1;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export const B = 1;\n');
    await writeFile(join(root, 'src', 'c.ts'), 'export const C = 1;\n');
    await writeFile(join(root, 'test', 'a.test.ts'), "import '../src/a.ts';\n");
    await writeFile(join(root, 'test', 'b.test.ts'), "import '../src/b.ts';\n// src/c.ts\n");

    const doc: SystemsDoc = {
      environments: { dev: { note: null }, prod: { note: null } },
      systems: [
        sysRow('sys-a', 'src/a.ts'),
        sysRow('sys-b', 'src/b.ts'),
        sysRow('sys-c', 'src/c.ts'),
      ],
      connections: [],
    };

    const spy = vi.spyOn(refs, 'readRepoText');
    const dash = await repoDashboard(root, doc, NOW);

    expect(dash.coverage).toEqual([
      { id: 'sys-a', line: 'tests: 1 file' },
      { id: 'sys-b', line: 'tests: 1 file' },
      { id: 'sys-c', line: 'tests: 1 file' },
    ]);
    expect(dash.coverageSource).toBe(SYSTEM_TESTS_SOURCE);
    // 2 test files in the tree, 3 systems asking about them: the corpus must be read ONCE for
    // the whole dashboard, so this is 2 (one read per test file), never 2 × 3 = 6.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('an empty systems list: coverage is [] (a real answer), not null', async () => {
    const root = await tempDir();
    const doc: SystemsDoc = {
      environments: { dev: { note: null }, prod: { note: null } },
      systems: [],
      connections: [],
    };
    const dash = await repoDashboard(root, doc, NOW);
    expect(dash.coverage).toEqual([]);
  });
});
