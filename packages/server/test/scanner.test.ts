import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EDGE_CAP,
  findImportSpecifiers,
  langOf,
  parseGitLog,
  resolveImport,
  scanRepo,
} from '../src/scanner.js';
import { makeTempDir } from './helpers.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

async function tempDir(): Promise<string> {
  const d = await makeTempDir('repoboard-scan-');
  dirs.push(d);
  return d;
}

describe('scanRepo in a git repo', () => {
  it('lists tracked files with bytes, lines, lang, activity and head', async () => {
    const root = await tempDir();
    await git(root, 'init', '-q', '-b', 'main');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n');
    await writeFile(join(root, 'README.md'), '# hi\n');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x0a, 0x0a, 0x0a]));
    await writeFile(join(root, 'node_modules', 'x', 'i.js'), 'ignored\n');
    await writeFile(join(root, '.gitignore'), 'node_modules\nignored.txt\n');
    await writeFile(join(root, 'ignored.txt'), 'nope\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'one');
    await writeFile(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\n');
    await git(root, 'commit', '-q', '-am', 'two');
    const sha = await git(root, 'rev-parse', 'HEAD');
    // Untracked but not ignored: an agent's brand-new file must show up before `git add`.
    await writeFile(join(root, 'fresh.txt'), 'new\n');

    const snap = await scanRepo(root, { now: () => new Date() });
    const byPath = Object.fromEntries(snap.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      '.gitignore',
      'README.md',
      'fresh.txt',
      'logo.png',
      'src/a.ts',
    ]);
    expect(byPath['fresh.txt']).toMatchObject({ commits30d: 0, commits90d: 0, lastCommitAt: null });
    expect(byPath['src/a.ts']).toMatchObject({
      bytes: 24,
      lines: 4,
      lang: 'typescript',
      commits30d: 2,
      commits90d: 2,
    });
    expect(byPath['src/a.ts']?.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byPath['README.md']).toMatchObject({ lines: 1, lang: 'markdown', commits90d: 1 });
    // Binary: bytes counted, newlines deliberately not — null, never a plausible 0 (K3).
    expect(byPath['logo.png']).toMatchObject({ bytes: 5, lines: null, lang: 'image' });
    expect(snap.head).toEqual({ branch: 'main', sha });
    expect(snap.edges).toEqual([]);
    expect(snap.truncated).toBe(false);
    expect(snap.languages.typescript).toBe(24);
    expect(snap.root).toBe(root);
    expect(snap.scannedAt).toMatch(/Z$/);
  });

  it('handles a repo with no commits: untracked files listed, no activity, head null', async () => {
    const root = await tempDir();
    await git(root, 'init', '-q');
    await writeFile(join(root, 'x.txt'), 'x\n');
    const snap = await scanRepo(root);
    expect(snap.files).toEqual([
      {
        path: 'x.txt',
        bytes: 2,
        lines: 1,
        lang: 'text',
        commits30d: 0,
        commits90d: 0,
        lastCommitAt: null,
      },
    ]);
    expect(snap.head).toBeNull();
  });
});

describe('scanRepo without git', () => {
  it('walks the tree, skipping node_modules/.git/dist, and flags truncation at the cap', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'lib'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'lib', 'a.py'), 'print(1)\n');
    await writeFile(join(root, 'lib', 'b.rs'), 'fn main(){}\n');
    await writeFile(join(root, 'c.go'), 'package main\n');
    await writeFile(join(root, 'node_modules', 'n.js'), '');
    await writeFile(join(root, 'dist', 'd.js'), '');

    const snap = await scanRepo(root);
    expect(snap.files.map((f) => f.path).sort()).toEqual(['c.go', 'lib/a.py', 'lib/b.rs']);
    expect(snap.head).toBeNull();
    expect(snap.files.every((f) => f.commits90d === 0 && f.lastCommitAt === null)).toBe(true);

    const capped = await scanRepo(root, { cap: 2 });
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('import graph (P4.4)', () => {
  it('fills edges for three files that import each other, resolving .js → .ts and index', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src', 'util'), { recursive: true });
    await writeFile(
      join(root, 'src', 'a.ts'),
      [
        "import { b } from './b.js';", // TS ESM convention: .js specifier, .ts on disk
        "import type { T } from './util';", // directory → util/index.ts
        "import React from 'react';", // bare: ignored
        "import './missing.js';", // unresolvable: ignored
        'export const a = 1;',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'b.ts'),
      ["export * from './c';", "const lazy = () => import('./a.js');", 'export const b = 2;'].join(
        '\n',
      ),
    );
    await writeFile(
      join(root, 'src', 'c.ts'),
      ["const a = require('./a');", "import { b } from './b.js';", 'export const c = 3;'].join(
        '\n',
      ),
    );
    await writeFile(join(root, 'src', 'util', 'index.ts'), 'export type T = number;\n');
    await writeFile(join(root, 'README.md'), "not code: import x from './a'\n");

    const snap = await scanRepo(root);
    const edges = snap.edges.map((e) => `${e.from} -> ${e.to}`).sort();
    expect(edges).toEqual([
      'src/a.ts -> src/b.ts',
      'src/a.ts -> src/util/index.ts',
      'src/b.ts -> src/a.ts',
      'src/b.ts -> src/c.ts',
      'src/c.ts -> src/a.ts',
      'src/c.ts -> src/b.ts',
    ]);
    // The JS/TS files were line-counted from the same read.
    expect(snap.files.find((f) => f.path === 'src/a.ts')?.lines).toBe(4);
    expect(EDGE_CAP).toBe(5000);
  });

  it('findImportSpecifiers keeps only relative specifiers across all four forms', () => {
    const src = [
      "import a from './a';",
      "import { b, c as d } from '../b.tsx';",
      "import * as ns from './ns.js';",
      "import type { X } from './x';",
      "import './side-effect';",
      "export { y } from './y';",
      "export * from './z';",
      "const p = import('./dyn');",
      "const q = require('./req');",
      "import bare from 'react';",
      "import scoped from '@repoboard/core';",
      "require('node:fs');",
      'export const notAnImport = 1;',
    ].join('\n');
    expect(findImportSpecifiers(src)).toEqual([
      './a',
      '../b.tsx',
      './ns.js',
      './x',
      './side-effect',
      './y',
      './z',
      './dyn',
      './req',
    ]);
  });

  it('resolveImport tries literal, .js→.ts, extensions, then index, and refuses to escape the root', () => {
    const known = new Set(['src/a.ts', 'src/b.js', 'src/c.tsx', 'src/d/index.tsx', 'src/e.ts']);
    expect(resolveImport('src/x.ts', './b.js', known)).toBe('src/b.js');
    expect(resolveImport('src/x.ts', './a.js', known)).toBe('src/a.ts');
    expect(resolveImport('src/x.ts', './c.js', known)).toBe('src/c.tsx');
    expect(resolveImport('src/x.ts', './a', known)).toBe('src/a.ts');
    expect(resolveImport('src/x.ts', './d', known)).toBe('src/d/index.tsx');
    expect(resolveImport('src/d/index.tsx', '../e', known)).toBe('src/e.ts');
    expect(resolveImport('src/x.ts', './nope', known)).toBeNull();
    expect(resolveImport('src/x.ts', '../../outside', known)).toBeNull();
  });
});

describe('parseGitLog', () => {
  it('splits 30d/90d by commit date and takes the newest commit as lastCommitAt', () => {
    const now = new Date('2026-09-02T00:00:00Z');
    const out = [
      'aaa\x002026-09-01T10:00:00+00:00',
      '',
      'a.ts',
      'b.ts',
      '',
      'bbb\x002026-07-01T10:00:00+00:00',
      '',
      'a.ts',
      '',
    ].join('\n');
    const m = parseGitLog(out, now);
    expect(m.get('a.ts')).toEqual({
      commits30d: 1,
      commits90d: 2,
      lastCommitAt: '2026-09-01T10:00:00+00:00',
    });
    expect(m.get('b.ts')).toEqual({
      commits30d: 1,
      commits90d: 1,
      lastCommitAt: '2026-09-01T10:00:00+00:00',
    });
  });
});

describe('langOf', () => {
  it('maps extensions, lock files, and falls back to other', () => {
    expect(langOf('a/b.tsx')).toBe('tsx');
    expect(langOf('pnpm-lock.yaml')).toBe('lock');
    expect(langOf('Dockerfile')).toBe('docker');
    expect(langOf('weird.xyz')).toBe('other');
    expect(langOf('LICENSE')).toBe('other');
  });
});
