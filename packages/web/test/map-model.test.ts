import { defaultBoardConfig, type RepoSnapshot } from '@repoboard/core';
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  churnOpacity,
  countNodes,
  findDir,
  formatLines,
  graphData,
  graphDirOptions,
  langColor,
  recentBucket,
  whoIsWhere,
} from '../src/map/model.js';
import { card } from './helpers.jsx';

type File = RepoSnapshot['files'][number];
const f = (path: string, bytes: number, lang = 'typescript'): File => ({
  path,
  bytes,
  lines: 1,
  lang,
  commits30d: 0,
  commits90d: 0,
  lastCommitAt: null,
});

describe('buildTree', () => {
  it('nests by directory and appends ghosts to their directory', () => {
    const root = buildTree(
      [f('src/a.ts', 10), f('src/x/b.ts', 5), f('README.md', 1)],
      [
        { path: 'src/x/gone.ts', cardId: 'RB-1', color: '#f00' },
        { path: 'lib/new.ts', cardId: 'RB-1', color: '#f00' },
      ],
    );
    expect(root.children?.map((c) => c.name)).toEqual(['src', 'README.md', 'lib']);
    const x = findDir(root, 'src/x');
    expect(x?.children?.map((c) => `${c.kind}:${c.name}`)).toEqual(['file:b.ts', 'ghost:gone.ts']);
    expect(findDir(root, 'lib')?.children?.[0]).toMatchObject({ kind: 'ghost', ghostOf: 'RB-1' });
    expect(findDir(root, 'nope')).toBeNull();
  });

  it('aggregates tiny leaves per directory above 3,000 files, keeping highlighted paths', () => {
    // 3,500 files of 1 byte in 10 dirs plus one 1 MB file: the tiny ones are < 0.1 % of the root.
    const files: File[] = [f('big/huge.ts', 1_000_000)];
    for (let i = 0; i < 3500; i++) files.push(f(`d${i % 10}/f${i}.ts`, 1));
    const plain = buildTree(files);
    expect(countNodes(plain)).toBeLessThan(40); // 1 root + 11 dirs + 1 big + 10 "…" tiles
    const more = findDir(plain, 'd3')?.children;
    expect(more).toHaveLength(1);
    expect(more?.[0]).toMatchObject({ kind: 'more', count: 350, bytes: 350 });

    const kept = buildTree(files, [], { keep: new Set(['d3/f3.ts']) });
    const d3 = findDir(kept, 'd3')?.children ?? [];
    expect(d3.map((c) => c.kind).sort()).toEqual(['file', 'more']);
    expect(d3.find((c) => c.kind === 'more')?.count).toBe(349);

    // Under the threshold nothing is folded.
    expect(countNodes(buildTree(files.slice(0, 2000)))).toBeGreaterThan(2000);
  });
});

describe('heat', () => {
  it('churnOpacity: sqrt scale with a 0.15 floor', () => {
    expect(churnOpacity(0, 10)).toBe(0.15);
    expect(churnOpacity(10, 10)).toBe(1);
    expect(churnOpacity(1, 100)).toBe(0.15); // sqrt(0.01) = 0.1 → floor
    expect(churnOpacity(25, 100)).toBe(0.5);
    expect(churnOpacity(3, 0)).toBe(0.15);
  });

  it('recentBucket', () => {
    const now = Date.parse('2026-09-03T12:00:00Z');
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    expect(recentBucket(ago(1), now)).toBe('today');
    expect(recentBucket(ago(48), now)).toBe('week');
    expect(recentBucket(ago(24 * 20), now)).toBe('month');
    expect(recentBucket(ago(24 * 60), now)).toBe('older');
    expect(recentBucket(null, now)).toBe('never');
    expect(recentBucket('garbage', now)).toBe('never');
  });

  it('language color is stable and K3 lines render as a dash', () => {
    expect(langColor('tsx')).toBe(langColor('typescript'));
    expect(langColor('weird')).toBe(langColor('other'));
    expect(formatLines(null)).toBe('—');
    expect(formatLines(42)).toBe('42');
  });
});

describe('whoIsWhere', () => {
  const config = defaultBoardConfig();
  const now = Date.now();
  const known = new Set(['src/a.ts', 'src/b.ts']);

  it('active cards with files highlight; idle cards only when pinned or hovered', () => {
    const active = card('RB-1', 'doing', {
      assignee: 'claude/x',
      updated: new Date(now).toISOString(),
      files: ['src/a.ts', 'src/missing.ts'],
    });
    const stale = card('RB-2', 'doing', {
      assignee: 'claude/y',
      updated: new Date(now - 3 * 3_600_000).toISOString(),
      files: ['src/b.ts'],
    });
    const noFiles = card('RB-3', 'doing', { assignee: 'z', updated: new Date(now).toISOString() });

    const w = whoIsWhere([active, stale, noFiles], config, now, [], null, known);
    expect(w.cards.map((c) => `${c.card.id}:${c.why}`)).toEqual(['RB-1:active']);
    expect(w.byPath.get('src/a.ts')?.[0]).toMatchObject({ assignee: 'claude/x', why: 'active' });
    expect(w.ghosts).toEqual([
      { path: 'src/missing.ts', cardId: 'RB-1', color: expect.any(String) },
    ]);

    const pinned = whoIsWhere([active, stale], config, now, ['RB-2'], null, known);
    expect(pinned.byPath.get('src/b.ts')?.[0]?.why).toBe('pinned');
    const hovered = whoIsWhere([active, stale], config, now, [], 'RB-2', known);
    expect(hovered.byPath.get('src/b.ts')?.[0]?.why).toBe('hover');
    // Active wins over pinned for the same card: one entry, why = active.
    const both = whoIsWhere([active], config, now, ['RB-1'], 'RB-1', known);
    expect(both.cards).toHaveLength(1);
    expect(both.cards[0]?.why).toBe('active');
  });

  it('with no config nothing is active (inert), pins still work', () => {
    const c = card('RB-1', 'doing', { assignee: 'a', files: ['src/a.ts'] });
    expect(whoIsWhere([c], null, now, [], null, known).cards).toHaveLength(0);
    expect(whoIsWhere([c], null, now, ['RB-1'], null, known).cards).toHaveLength(1);
  });
});

describe('graph model', () => {
  const edges = [
    { from: 'a/x.ts', to: 'a/y.ts' },
    { from: 'a/x.ts', to: 'b/z.ts' },
    { from: 'b/z.ts', to: 'a/y.ts' },
  ];
  it('nodes are files with ≥ 1 edge, with in/out degree; a directory filter keeps inside edges', () => {
    const all = graphData([], edges);
    expect(all.nodes.map((n) => `${n.id}:${n.inDegree}/${n.outDegree}`)).toEqual([
      'a/x.ts:0/2',
      'a/y.ts:2/0',
      'b/z.ts:1/1',
    ]);
    expect(all.totalNodes).toBe(3);
    const a = graphData([], edges, 'a');
    expect(a.nodes.map((n) => n.id)).toEqual(['a/x.ts', 'a/y.ts']);
    expect(a.links).toEqual([{ source: 'a/x.ts', target: 'a/y.ts' }]);
    expect(a.totalNodes).toBe(3);
  });
  it('directory options count nodes per prefix, biggest first', () => {
    expect(graphDirOptions(edges)).toEqual([
      { path: 'a', nodes: 2 },
      { path: 'b', nodes: 1 },
    ]);
  });
});
