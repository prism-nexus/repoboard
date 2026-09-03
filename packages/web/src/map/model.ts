/**
 * P4 map model — pure functions, no React, no d3. The views (Treemap, Graph, Map) render what
 * this computes: the file tree (with aggregation and ghost tiles), the language palette, the
 * heat modes, and the "who is where" index from cards to paths.
 */
import { avatarFor, type BoardConfig, type Card, isActive, type RepoSnapshot } from '@rcb/core';

export type RepoFile = RepoSnapshot['files'][number];

// ---- language palette --------------------------------------------------------------------------

export interface LangSwatch {
  key: string;
  label: string;
  color: string;
}

/**
 * 13 language groups plus `other` (Ruby earned its slot: Homebrew's map was all gray without it). The same scanner `lang` always maps to the same key, and the
 * same key always gets the same color, on both themes. Hues were picked to stay apart from the
 * avatar palette's role (outlines) — fills are a touch desaturated so a 2 px outline still pops.
 */
export const LANG_PALETTE: readonly LangSwatch[] = [
  { key: 'typescript', label: 'TypeScript', color: '#3b7ddd' },
  { key: 'javascript', label: 'JavaScript', color: '#d9a92c' },
  { key: 'python', label: 'Python', color: '#3fa34d' },
  { key: 'go', label: 'Go', color: '#21b0c6' },
  { key: 'rust', label: 'Rust', color: '#e8743b' },
  { key: 'ruby', label: 'Ruby', color: '#cf3f3f' },
  { key: 'jvm', label: 'Java / Kotlin', color: '#8a5a3c' },
  { key: 'c', label: 'C / C++', color: '#9b6bd1' },
  { key: 'shell', label: 'Shell', color: '#6b9e2a' },
  { key: 'markup', label: 'HTML / CSS', color: '#e0559a' },
  { key: 'docs', label: 'Docs', color: '#8d99ae' },
  { key: 'config', label: 'Config', color: '#b08968' },
  { key: 'assets', label: 'Assets', color: '#5f7c8a' },
  { key: 'other', label: 'Other', color: '#a3a3a3' },
];

const LANG_KEY: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'typescript',
  javascript: 'javascript',
  jsx: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  ruby: 'ruby',
  java: 'jvm',
  kotlin: 'jvm',
  c: 'c',
  cpp: 'c',
  shell: 'shell',
  html: 'markup',
  css: 'markup',
  scss: 'markup',
  less: 'markup',
  markdown: 'docs',
  text: 'docs',
  json: 'config',
  yaml: 'config',
  toml: 'config',
  xml: 'config',
  lock: 'config',
  docker: 'config',
  make: 'config',
  image: 'assets',
  font: 'assets',
  binary: 'assets',
  svg: 'assets',
};

const COLOR_BY_KEY = new Map(LANG_PALETTE.map((s) => [s.key, s.color]));

export function langKey(lang: string): string {
  return LANG_KEY[lang] ?? 'other';
}

export function langColor(lang: string): string {
  return COLOR_BY_KEY.get(langKey(lang)) ?? '#a3a3a3';
}

// ---- heat modes --------------------------------------------------------------------------------

export type MapMode = 'size' | 'churn30' | 'churn90' | 'recent';

export const MAP_MODES: readonly { id: MapMode; label: string; title: string }[] = [
  { id: 'size', label: 'Size', title: 'Area = bytes, color = language' },
  { id: 'churn30', label: 'Churn 30d', title: 'Opacity = commits in the last 30 days (sqrt)' },
  { id: 'churn90', label: 'Churn 90d', title: 'Opacity = commits in the last 90 days (sqrt)' },
  { id: 'recent', label: 'Recent', title: 'Color = age of the last commit' },
];

/** Nothing vanishes in churn mode: the floor keeps a zero-commit file visible. */
export const CHURN_FLOOR = 0.15;
export const BASE_OPACITY = 0.92;

/** sqrt scale from 0..max onto CHURN_FLOOR..1. `max` ≤ 0 means "no data": everything at the floor. */
export function churnOpacity(commits: number, max: number): number {
  if (max <= 0 || commits <= 0) return CHURN_FLOOR;
  return Math.max(CHURN_FLOOR, Math.min(1, Math.sqrt(commits / max)));
}

export function commitsFor(file: RepoFile, mode: MapMode): number {
  return mode === 'churn90' ? file.commits90d : file.commits30d;
}

export type RecentBucket = 'today' | 'week' | 'month' | 'older' | 'never';

/** One hue ramp (warm), strongest for today; `never` sits outside the ramp in gray. */
export const RECENT_RAMP: readonly { id: RecentBucket; label: string; color: string }[] = [
  { id: 'today', label: 'Today', color: '#d7301f' },
  { id: 'week', label: 'This week', color: '#f46d43' },
  { id: 'month', label: 'This month', color: '#fdae61' },
  { id: 'older', label: 'Older', color: '#fee8c8' },
  { id: 'never', label: 'No commit in 90d', color: '#9e9e9e' },
];

const RECENT_COLOR = new Map(RECENT_RAMP.map((r) => [r.id, r.color]));

export function recentBucket(lastCommitAt: string | null, now: number): RecentBucket {
  if (lastCommitAt === null) return 'never';
  const t = Date.parse(lastCommitAt);
  if (Number.isNaN(t)) return 'never';
  const age = now - t;
  const day = 86_400_000;
  if (age < day) return 'today';
  if (age < 7 * day) return 'week';
  if (age < 30 * day) return 'month';
  return 'older';
}

export function recentColor(lastCommitAt: string | null, now: number): string {
  return RECENT_COLOR.get(recentBucket(lastCommitAt, now)) ?? '#9e9e9e';
}

// ---- tree ----------------------------------------------------------------------------------------

export type TreeKind = 'dir' | 'file' | 'ghost' | 'more';

export interface TreeNode {
  name: string;
  /** Repo-relative path; '' for the root. */
  path: string;
  kind: TreeKind;
  /** Layout weight. Files: bytes. Ghosts: a visible stand-in. `more`: the summed bytes. */
  bytes: number;
  file?: RepoFile;
  children?: TreeNode[];
  /** `more` only: how many files were folded in. */
  count?: number;
  /** `ghost` only: the card that names a path the repo no longer has. */
  ghostOf?: string;
  ghostColor?: string;
}

export interface Ghost {
  path: string;
  cardId: string;
  color: string;
}

export interface BuildTreeOptions {
  /** Aggregate small leaves when the file count exceeds this. Brief: 3,000. */
  aggregateAbove?: number;
  /** Leaves below this fraction of the root's bytes fold into a `more` tile. Brief: 0.001. */
  aggregateBelow?: number;
  /** Paths that must stay individual tiles (highlighted files), whatever their size. */
  keep?: ReadonlySet<string>;
}

export const AGGREGATE_ABOVE = 3_000;
export const AGGREGATE_BELOW = 0.001;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Build the directory tree from flat paths. Ghosts are appended to their directory (creating
 * missing directories as needed) — the layout sorts them last. Aggregation folds each
 * directory's tiny leaves (below `aggregateBelow` of the root's bytes) into one `…` node so a
 * 20,000-file repo does not become a 20,000-node SVG.
 */
export function buildTree(files: RepoFile[], ghosts: Ghost[] = [], opts: BuildTreeOptions = {}) {
  const aggregateAbove = opts.aggregateAbove ?? AGGREGATE_ABOVE;
  const aggregateBelow = opts.aggregateBelow ?? AGGREGATE_BELOW;
  const keepPaths = opts.keep;
  const root: TreeNode = { name: '', path: '', kind: 'dir', bytes: 0, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);

  const dirNode = (path: string): TreeNode => {
    const found = dirs.get(path);
    if (found) return found;
    const node: TreeNode = { name: baseName(path), path, kind: 'dir', bytes: 0, children: [] };
    dirs.set(path, node);
    dirNode(dirOf(path)).children?.push(node);
    return node;
  };

  let total = 0;
  for (const f of files) {
    total += f.bytes;
    dirNode(dirOf(f.path)).children?.push({
      name: baseName(f.path),
      path: f.path,
      kind: 'file',
      bytes: f.bytes,
      file: f,
    });
  }

  if (files.length > aggregateAbove && total > 0) {
    const threshold = total * aggregateBelow;
    for (const dir of dirs.values()) {
      const kids = dir.children ?? [];
      const keep: TreeNode[] = [];
      let folded = 0;
      let foldedBytes = 0;
      for (const k of kids) {
        if (k.kind === 'file' && k.bytes < threshold && !keepPaths?.has(k.path)) {
          folded++;
          foldedBytes += k.bytes;
        } else keep.push(k);
      }
      // Folding one file into a "…" tile saves nothing; only fold when it shrinks the DOM.
      if (folded > 1) {
        keep.push({
          name: '…',
          path: `${dir.path}/…`,
          kind: 'more',
          bytes: foldedBytes,
          count: folded,
        });
        dir.children = keep;
      }
    }
  }

  if (ghosts.length > 0) {
    const ghostBytes = ghostWeight(files);
    for (const g of ghosts) {
      dirNode(dirOf(g.path)).children?.push({
        name: baseName(g.path),
        path: g.path,
        kind: 'ghost',
        bytes: ghostBytes,
        ghostOf: g.cardId,
        ghostColor: g.color,
      });
    }
  }
  return root;
}

/** A ghost is sized like a median file so it is visible without dominating its directory. */
function ghostWeight(files: RepoFile[]): number {
  if (files.length === 0) return 1024;
  const sorted = files.map((f) => f.bytes).sort((a, b) => a - b);
  return Math.max(64, sorted[Math.floor(sorted.length / 2)] ?? 1024);
}

/** Find the subtree at `path` ('' = root). Null when the path is not a directory in the tree. */
export function findDir(root: TreeNode, path: string): TreeNode | null {
  if (path === '') return root;
  let node: TreeNode = root;
  for (const seg of path.split('/')) {
    const next = node.children?.find((c) => c.kind === 'dir' && c.name === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

export function countNodes(node: TreeNode): number {
  let n = 1;
  for (const c of node.children ?? []) n += countNodes(c);
  return n;
}

// ---- who is where --------------------------------------------------------------------------------

export type HighlightWhy = 'active' | 'pinned' | 'hover';

export interface Highlight {
  cardId: string;
  assignee: string;
  color: string;
  emoji: string;
  why: HighlightWhy;
}

export interface WhoIsWhere {
  /** Path → highlights, in the order active, pinned, hover. */
  byPath: Map<string, Highlight[]>;
  /** Cards that contribute highlights, deduped, with why they do. */
  cards: { card: Card; why: HighlightWhy; color: string; emoji: string; assignee: string }[];
  /** Highlighted paths the repo does not have, one ghost per (path, card). */
  ghosts: Ghost[];
}

const UNASSIGNED = 'unassigned';

/**
 * P4.3: which cards light up which files. Active cards (D8) always do; pinned and hovered cards do
 * on request. `data-active-by` on a tile comes from the active entries only.
 */
export function whoIsWhere(
  cards: Card[],
  config: BoardConfig | null,
  now: number,
  pinned: readonly string[],
  hoverId: string | null,
  known: ReadonlySet<string>,
): WhoIsWhere {
  const byPath = new Map<string, Highlight[]>();
  const out: WhoIsWhere = { byPath, cards: [], ghosts: [] };
  const seen = new Set<string>();
  const nowDate = new Date(now);

  const add = (card: Card, why: HighlightWhy) => {
    if (seen.has(card.id) || !card.files?.length) return;
    seen.add(card.id);
    const assignee = card.assignee ?? UNASSIGNED;
    const { color, emoji } = avatarFor(assignee);
    out.cards.push({ card, why, color, emoji, assignee });
    for (const path of card.files) {
      const list = byPath.get(path) ?? [];
      list.push({ cardId: card.id, assignee, color, emoji, why });
      byPath.set(path, list);
      if (!known.has(path)) out.ghosts.push({ path, cardId: card.id, color });
    }
  };

  if (config) for (const c of cards) if (isActive(c, config, nowDate)) add(c, 'active');
  for (const id of pinned) {
    const c = cards.find((x) => x.id === id);
    if (c) add(c, 'pinned');
  }
  if (hoverId) {
    const c = cards.find((x) => x.id === hoverId);
    if (c) add(c, 'hover');
  }
  return out;
}

/** Every card naming `path`, active or not, for the file panel. */
export function cardsNaming(cards: Card[], path: string): Card[] {
  return cards.filter((c) => c.files?.includes(path));
}

// ---- import graph (P4.4) -------------------------------------------------------------------------

export const GRAPH_NODE_LIMIT = 500;

export interface GraphNodeData {
  id: string;
  /** Top-level directory, the color key. */
  dir: string;
  inDegree: number;
  outDegree: number;
  file: RepoFile | null;
}

export interface GraphData {
  nodes: GraphNodeData[];
  links: { source: string; target: string }[];
  /** Total nodes before the `dir` filter, so the caller knows whether a picker is needed. */
  totalNodes: number;
}

function inDir(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/** Files with ≥ 1 edge, optionally restricted to a directory subtree (both endpoints inside). */
export function graphData(files: RepoFile[], edges: RepoSnapshot['edges'], dir = ''): GraphData {
  const all = new Set<string>();
  for (const e of edges) {
    all.add(e.from);
    all.add(e.to);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const links = edges.filter((e) => inDir(e.from, dir) && inDir(e.to, dir));
  const degree = new Map<string, { i: number; o: number }>();
  const touch = (p: string) => {
    const d = degree.get(p) ?? { i: 0, o: 0 };
    degree.set(p, d);
    return d;
  };
  for (const e of links) {
    touch(e.from).o++;
    touch(e.to).i++;
  }
  const nodes: GraphNodeData[] = [...degree.entries()]
    .map(([id, d]) => ({
      id,
      dir: topDir(id),
      inDegree: d.i,
      outDegree: d.o,
      file: byPath.get(id) ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    nodes,
    links: links.map((e) => ({ source: e.from, target: e.to })),
    totalNodes: all.size,
  };
}

export interface DirOption {
  path: string;
  nodes: number;
}

/**
 * Directory picker options for a graph over the limit: every directory prefix (depth 1 and 2)
 * with how many graph nodes it holds, biggest first. `''` (everything) is the caller's to add.
 */
export function graphDirOptions(edges: RepoSnapshot['edges']): DirOption[] {
  const paths = new Set<string>();
  for (const e of edges) {
    paths.add(e.from);
    paths.add(e.to);
  }
  const counts = new Map<string, number>();
  for (const p of paths) {
    const segs = p.split('/');
    for (let depth = 1; depth <= 2 && depth < segs.length; depth++) {
      const dir = segs.slice(0, depth).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, nodes]) => ({ path, nodes }))
    .sort((a, b) => b.nodes - a.nodes || (a.path < b.path ? -1 : 1));
}

/** Stable color per top-level directory: sorted names, palette in order. */
export function dirColors(dirs: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(dirs)].sort();
  const out = new Map<string, string>();
  sorted.forEach((d, i) => {
    out.set(d, LANG_PALETTE[i % (LANG_PALETTE.length - 1)]?.color ?? '#a3a3a3');
  });
  return out;
}

// ---- formatting ----------------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lines: a number, or "—" when the scanner did not count (binary, > 2 MB). K3. */
export function formatLines(lines: number | null): string {
  return lines === null ? '—' : String(lines);
}

/** Top-level directory of a path, or '(root)' for a file at the root. */
export function topDir(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '(root)' : path.slice(0, i);
}
