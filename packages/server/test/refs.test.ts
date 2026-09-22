/**
 * K7: the path guard and live resolution, against temp directories only.
 * `resolveRepoPath` is the only path from a ref spec to the filesystem; every rejection it
 * promises is exercised here, including a symlink whose realpath leaves the root.
 */
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitLines } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatResolvedRefs,
  mergeResolvedRefs,
  readRepoText,
  resolveCardRefs,
  resolveRefSpec,
  resolveRepoPath,
} from '../src/refs.js';
import { makeTempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const PLAN = [
  '# Plan',
  '',
  '## §5 Phases',
  '- **P6.1** README.',
  '  more',
  '',
  '## §6 Layout',
  'x',
].join('\n');

/** A root with docs/plan.md, .git/config, a binary, and a sibling dir a symlink points into. */
async function repo() {
  const root = await makeTempDir('repoboard-refs-');
  const outside = await makeTempDir('repoboard-refs-outside-');
  dirs.push(root, outside);
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'docs', 'plan.md'), `${PLAN}\n`);
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(join(outside, 'secret.md'), 'outside\n');
  await symlink(join(outside, 'secret.md'), join(root, 'docs', 'link.md'));
  await symlink(join(root, '.git', 'config'), join(root, 'docs', 'gitlink'));
  return { root, outside };
}

async function rejected(root: string, rel: string): Promise<string> {
  const r = await resolveRepoPath(root, rel);
  if (r.ok) throw new Error(`expected "${rel}" to be rejected, got ${r.path}`);
  return r.error;
}

describe('resolveRepoPath (the one path guard)', () => {
  it('accepts a relative path inside the root and returns its realpath', async () => {
    const { root } = await repo();
    const r = await resolveRepoPath(root, 'docs/plan.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(await realpath(join(root, 'docs', 'plan.md')));
  });

  it('rejects absolute paths, in every spelling', async () => {
    const { root } = await repo();
    expect(await rejected(root, '/etc/hosts')).toMatch(/absolute path/);
    expect(await rejected(root, join(root, 'docs', 'plan.md'))).toMatch(/absolute path/);
    expect(await rejected(root, 'C:\\Windows\\win.ini')).toMatch(/absolute path/);
    expect(await rejected(root, '\\\\server\\share')).toMatch(/absolute path/);
  });

  it('rejects any ".." segment, even one that would stay inside the root', async () => {
    const { root } = await repo();
    expect(await rejected(root, '../../etc/hosts')).toMatch(/"\.\." not allowed/);
    expect(await rejected(root, 'docs/../docs/plan.md')).toMatch(/"\.\." not allowed/);
    expect(await rejected(root, 'docs\\..\\docs\\plan.md')).toMatch(/"\.\." not allowed/);
  });

  it('rejects .git/ by name and by symlink', async () => {
    const { root } = await repo();
    expect(await rejected(root, '.git/config')).toMatch(/\.git\/ not allowed/);
    expect(await rejected(root, '.git')).toMatch(/\.git\/ not allowed/);
    expect(await rejected(root, 'docs/gitlink')).toMatch(/\.git\/ not allowed/);
  });

  it('rejects a symlink whose realpath leaves the root, and the root itself', async () => {
    const { root } = await repo();
    expect(await rejected(root, 'docs/link.md')).toMatch(/outside the repo/);
    expect(await rejected(root, '.')).toMatch(/outside the repo/);
    expect(await rejected(root, '')).toBe('empty path');
    expect(await rejected(root, 'a\0b')).toMatch(/NUL/);
  });

  it('a missing file is "not found", not a guess', async () => {
    const { root } = await repo();
    expect(await rejected(root, 'docs/nope.md')).toBe('not found: docs/nope.md');
  });
});

describe('readRepoText', () => {
  it('refuses a directory, a binary extension, a NUL byte, and a file over 2 MB', async () => {
    const { root } = await repo();
    const dir = await resolveRepoPath(root, 'docs');
    if (!dir.ok) throw new Error(dir.error);
    expect(await readRepoText(dir.path, 'docs')).toEqual({ ok: false, error: 'not a file: docs' });
    expect(await readRepoText(join(root, 'pic.png'), 'pic.png')).toEqual({
      ok: false,
      error: 'binary file (.png): pic.png',
    });
    expect(await readRepoText(join(root, 'blob.dat'), 'blob.dat')).toEqual({
      ok: false,
      error: 'binary file (NUL byte): blob.dat',
    });
    const big = join(root, 'big.txt');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const r = await readRepoText(big, 'big.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^file is 2097153 bytes \(limit 2097152\): big\.txt$/);
  });
});

describe('resolveRefSpec / resolveCardRefs', () => {
  it('resolves each form against the file and reads the file again every call', async () => {
    const { root } = await repo();
    const first = await resolveRefSpec(root, 'docs/plan.md#§5 Phases');
    expect(first).toEqual({
      spec: 'docs/plan.md#§5 Phases',
      path: 'docs/plan.md',
      start: 3,
      end: 6,
      text: '## §5 Phases\n- **P6.1** README.\n  more\n',
      truncated: false,
      error: null,
    });
    await writeFile(
      join(root, 'docs', 'plan.md'),
      `${PLAN.replace('  more', '  more\n  appended')}\n`,
    );
    const second = await resolveRefSpec(root, 'docs/plan.md#§5 Phases');
    expect(second.text).toContain('appended');
    expect(second.end).toBe(7);
    expect(await resolveRefSpec(root, 'docs/plan.md@P6.1')).toMatchObject({ start: 4, end: 6 });
    expect(await resolveRefSpec(root, 'docs/plan.md:L1')).toMatchObject({ text: '# Plan' });
    expect(await resolveRefSpec(root, 'docs/plan.md')).toMatchObject({ start: 1, end: 9 });
  });

  it('every failure is text null with the reason, and the card order is kept', async () => {
    const { root } = await repo();
    const refs = await resolveCardRefs(root, {
      id: 'RB-1',
      title: 't',
      status: 'todo',
      created: '2026-09-02T22:00:00Z',
      updated: '2026-09-02T22:00:00Z',
      body: '',
      refs: [
        'docs/plan.md#Nope',
        '../../etc/hosts',
        'docs/../docs/plan.md',
        '.git/config',
        'docs/link.md',
        'pic.png',
        'docs/plan.md:L99',
        '#bare',
        'docs/plan.md:L1',
      ],
    });
    expect(refs.map((r) => [r.spec, r.text === null, r.path])).toEqual([
      ['docs/plan.md#Nope', true, 'docs/plan.md'],
      ['../../etc/hosts', true, '../../etc/hosts'],
      ['docs/../docs/plan.md', true, 'docs/../docs/plan.md'],
      ['.git/config', true, '.git/config'],
      ['docs/link.md', true, 'docs/link.md'],
      ['pic.png', true, 'pic.png'],
      ['docs/plan.md:L99', true, 'docs/plan.md'],
      ['#bare', true, null],
      ['docs/plan.md:L1', false, 'docs/plan.md'],
    ]);
    expect(refs.map((r) => r.error)).toEqual([
      'heading "Nope" not found in docs/plan.md',
      '".." not allowed in path: ../../etc/hosts',
      '".." not allowed in path: docs/../docs/plan.md',
      '.git/ not allowed: .git/config',
      'path resolves outside the repo: docs/link.md',
      'binary file (.png): pic.png',
      'line 99 is past the end of docs/plan.md (8 lines)',
      '"#bare": missing path before "#"',
      null,
    ]);
    const bare = { id: 'x', title: 't', status: 's', created: '', updated: '', body: '' };
    expect(await resolveCardRefs(root, bare)).toEqual([]);
  });
});

describe('formatResolvedRefs (CLI --resolve)', () => {
  it('prints a fenced block headed path:start-end, and one line per unresolved ref', () => {
    const out = formatResolvedRefs([
      {
        spec: 'a.md#X',
        path: 'a.md',
        start: 3,
        end: 6,
        text: '## X\nbody',
        truncated: false,
        error: null,
      },
      {
        spec: 'a.md:L9',
        path: 'a.md',
        start: 9,
        end: 9,
        text: 'nine',
        truncated: true,
        error: null,
      },
      {
        spec: 'b.md#Y',
        path: 'b.md',
        start: null,
        end: null,
        text: null,
        truncated: false,
        error: 'nope',
      },
    ]);
    expect(out).toBe(
      [
        'a.md:3-6',
        '```',
        '## X\nbody',
        '```',
        '',
        'a.md:9 (truncated)',
        '```',
        'nine',
        '```',
        '',
        'b.md#Y — unresolved: nope',
        '',
      ].join('\n'),
    );
  });
});

describe('mergeResolvedRefs / --resolve prints overlapping spans once (RCB-106)', () => {
  function linesText(from: number, to: number): string {
    const ls: string[] = [];
    for (let i = from; i <= to; i++) ls.push(`l${i}`);
    return ls.join('\n');
  }
  function resolvedFixture(
    spec: string,
    path: string,
    start: number,
    end: number,
    truncated = false,
  ) {
    return { spec, path, start, end, text: linesText(start, end), truncated, error: null };
  }
  function unresolvedFixture(spec: string, error: string) {
    return { spec, path: null, start: null, end: null, text: null, truncated: false, error };
  }

  it('merges a truncated whole-file ref with an overlapping heading ref into one satisfies block', () => {
    const pathRef = resolvedFixture('d.md', 'd.md', 1, 200, true);
    const headingRef = resolvedFixture('d.md#H', 'd.md', 173, 213);
    const merged = mergeResolvedRefs([pathRef, headingRef]);
    expect(merged).toHaveLength(1);
    const [m] = merged;
    if (m === undefined || !('specs' in m)) throw new Error('expected a resolved group');
    expect(m.path).toBe('d.md');
    expect(m.start).toBe(1);
    expect(m.end).toBe(213);
    expect(m.truncated).toBe(true);
    expect(m.specs).toEqual(['d.md', 'd.md#H']);
    const lines = splitLines(m.text);
    expect(lines).toHaveLength(213);
    expect(lines[0]).toBe('l1');
    expect(lines[212]).toBe('l213');

    const out = formatResolvedRefs([pathRef, headingRef]);
    expect(out).toContain('d.md:1-213 (truncated) — satisfies: d.md, d.md#H');
    expect(out.match(/\bl173\b/g)).toHaveLength(1);
  });

  it('does not merge across a one-line gap; both blocks keep plain heads, unchanged bytes', () => {
    const a = resolvedFixture('e.md:L3-6', 'e.md', 3, 6);
    const b = resolvedFixture('e.md:L8-9', 'e.md', 8, 9);
    expect(mergeResolvedRefs([a, b])).toHaveLength(2);
    const out = formatResolvedRefs([a, b]);
    expect(out).toBe(
      ['e.md:3-6', '```', a.text, '```', '', 'e.md:8-9', '```', b.text, '```', ''].join('\n'),
    );
  });

  it('merges touching spans (no gap) into one block satisfying both', () => {
    const a = resolvedFixture('f.md:L3-6', 'f.md', 3, 6);
    const b = resolvedFixture('f.md:L7-9', 'f.md', 7, 9);
    const merged = mergeResolvedRefs([a, b]);
    expect(merged).toHaveLength(1);
    const [m] = merged;
    if (m === undefined || !('specs' in m)) throw new Error('expected a resolved group');
    expect(m.start).toBe(3);
    expect(m.end).toBe(9);
    expect(m.specs).toEqual(['f.md:L3-6', 'f.md:L7-9']);
    expect(splitLines(m.text)).toEqual(['l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
  });

  it('never merges across different files, even with identical line numbers', () => {
    const a = resolvedFixture('a.md:L3-6', 'a.md', 3, 6);
    const b = resolvedFixture('b.md:L3-6', 'b.md', 3, 6);
    expect(mergeResolvedRefs([a, b])).toHaveLength(2);
  });

  it("keeps card order: a merged group sits at its first member's position, an unresolved ref between them stays in place", () => {
    const b1 = resolvedFixture('b.md:L10-12', 'b.md', 10, 12);
    const bad = unresolvedFixture('#bare', '"#bare": missing path before "#"');
    const a = resolvedFixture('a.md:L1-2', 'a.md', 1, 2);
    const b2 = resolvedFixture('b.md:L11-14', 'b.md', 11, 14);
    const merged = mergeResolvedRefs([b1, bad, a, b2]);
    expect(merged).toHaveLength(3);
    const [first, second, third] = merged;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected three entries');
    }
    if (!('specs' in first)) throw new Error('expected a resolved group');
    expect(first.path).toBe('b.md');
    expect(first.start).toBe(10);
    expect(first.end).toBe(14);
    expect(first.specs).toEqual(['b.md:L10-12', 'b.md:L11-14']);
    if (!('error' in second)) throw new Error('expected the unresolved passthrough');
    expect(second.spec).toBe('#bare');
    if (!('specs' in third)) throw new Error('expected a resolved group');
    expect(third.path).toBe('a.md');
    expect(third.specs).toEqual(['a.md:L1-2']);
  });

  it('specs come out in CARD order even when the later ref starts earlier in the file', () => {
    const later = resolvedFixture('b.md:L11-14', 'b.md', 11, 14);
    const earlier = resolvedFixture('b.md:L10-12', 'b.md', 10, 12);
    const merged = mergeResolvedRefs([later, earlier]);
    expect(merged).toHaveLength(1);
    const [only] = merged;
    if (only === undefined || !('specs' in only)) throw new Error('expected a resolved group');
    expect(only.start).toBe(10);
    expect(only.end).toBe(14);
    expect(only.specs).toEqual(['b.md:L11-14', 'b.md:L10-12']);
  });

  it('merges an identical spec resolved twice into one block, spec listed twice, text once', () => {
    const a = resolvedFixture('g.md:L3-6', 'g.md', 3, 6);
    const dup = resolvedFixture('g.md:L3-6', 'g.md', 3, 6);
    const merged = mergeResolvedRefs([a, dup]);
    expect(merged).toHaveLength(1);
    const [m] = merged;
    if (m === undefined || !('specs' in m)) throw new Error('expected a resolved group');
    expect(m.specs).toEqual(['g.md:L3-6', 'g.md:L3-6']);
    expect(m.text).toBe('l3\nl4\nl5\nl6');

    const out = formatResolvedRefs([a, dup]);
    expect(out).toContain('satisfies: g.md:L3-6, g.md:L3-6');
    expect(out.match(/\bl3\b/g)).toHaveLength(1);
  });
});
