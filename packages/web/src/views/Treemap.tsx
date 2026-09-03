/**
 * P4.1–P4.3 treemap. SVG, d3-hierarchy only. Area = bytes, color = language (or recency),
 * opacity = churn, outline + avatar = who is working there. Directories zoom on click.
 */
import { type HierarchyRectangularNode, hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BASE_OPACITY,
  buildTree,
  churnOpacity,
  commitsFor,
  findDir,
  formatBytes,
  formatLines,
  type Ghost,
  type Highlight,
  langColor,
  type MapMode,
  type RepoFile,
  recentBucket,
  recentColor,
  type TreeNode,
} from '../map/model.js';
import { useSize } from '../map/useSize.js';
import { relTime } from '../time.js';

export interface Timing {
  /** Building the hierarchy and running the squarify layout. */
  layoutMs: number;
  /** From the start of the React render to the DOM commit. */
  commitMs: number;
  nodes: number;
}

export interface TreemapProps {
  files: RepoFile[];
  ghosts: Ghost[];
  mode: MapMode;
  /** '' = repo root. */
  zoomPath: string;
  onZoom: (path: string) => void;
  highlights: ReadonlyMap<string, Highlight[]>;
  fun: boolean;
  now: number;
  onFileClick: (path: string) => void;
  onTiming?: (t: Timing) => void;
}

type Node = HierarchyRectangularNode<TreeNode>;

const LABEL_H = 15;
/** Approximate advance width of the 10.5 px mono label font. */
const CHAR_W = 6.4;
const MIN_LABEL_W = 36;

function fitLabel(text: string, width: number): string | null {
  const max = Math.floor((width - 6) / CHAR_W);
  if (max < 3) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function kindRank(n: TreeNode): number {
  return n.kind === 'ghost' ? 2 : n.kind === 'more' ? 1 : 0;
}

export function Treemap({
  files,
  ghosts,
  mode,
  zoomPath,
  onZoom,
  highlights,
  fun,
  now,
  onFileClick,
  onTiming,
}: TreemapProps) {
  // Written on every render, read in the commit effect: how long this render took to paint.
  const renderStart = useRef(0);
  renderStart.current = performance.now();
  const boxRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(boxRef);
  const [tip, setTip] = useState<Node | null>(null);

  const keep = useMemo(() => new Set(highlights.keys()), [highlights]);
  const tree = useMemo(() => buildTree(files, ghosts, { keep }), [files, ghosts, keep]);

  const layout = useMemo(() => {
    const t0 = performance.now();
    const sub = findDir(tree, zoomPath) ?? tree;
    const root = hierarchy(sub, (d) => d.children)
      .sum((d) => (d.kind === 'dir' ? 0 : d.bytes))
      .sort((a, b) => kindRank(a.data) - kindRank(b.data) || (b.value ?? 0) - (a.value ?? 0));
    treemap<TreeNode>()
      .tile(treemapSquarify)
      .size([w, h])
      .round(true)
      .paddingOuter(2)
      .paddingInner(1)
      .paddingTop((d) =>
        d.depth === 0 ? 0 : d.x1 - d.x0 >= MIN_LABEL_W && d.y1 - d.y0 >= 2 * LABEL_H ? LABEL_H : 2,
      )(root);
    const nodes = root.descendants() as Node[];
    const dirs: Node[] = [];
    const leaves: Node[] = [];
    let maxCommits = 0;
    for (const n of nodes) {
      if (n.data.kind === 'dir') {
        if (n.depth > 0) dirs.push(n);
      } else {
        leaves.push(n);
        if (n.data.file) maxCommits = Math.max(maxCommits, commitsFor(n.data.file, mode));
      }
    }
    return { dirs, leaves, maxCommits, count: nodes.length, layoutMs: performance.now() - t0 };
  }, [tree, zoomPath, w, h, mode]);

  useEffect(() => {
    onTiming?.({
      layoutMs: layout.layoutMs,
      commitMs: performance.now() - renderStart.current,
      nodes: layout.count,
    });
  }, [layout, onTiming]);

  const onMove = useCallback((e: React.MouseEvent) => {
    const box = boxRef.current;
    const el = tipRef.current;
    if (!box || !el) return;
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Flip the tooltip to the left/top half when it would leave the box.
    const left = x > r.width - 280 ? x - 12 - el.offsetWidth : x + 14;
    const top = y > r.height - 140 ? y - 8 - el.offsetHeight : y + 14;
    el.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }, []);

  const fillFor = (n: Node): { fill: string; opacity: number } => {
    const d = n.data;
    if (d.kind === 'ghost') return { fill: 'none', opacity: 1 };
    if (d.kind === 'more') return { fill: 'var(--map-more)', opacity: 1 };
    const f = d.file;
    if (!f) return { fill: 'var(--map-more)', opacity: 1 };
    if (mode === 'recent') return { fill: recentColor(f.lastCommitAt, now), opacity: BASE_OPACITY };
    if (mode === 'size') return { fill: langColor(f.lang), opacity: BASE_OPACITY };
    return {
      fill: langColor(f.lang),
      opacity: churnOpacity(commitsFor(f, mode), layout.maxCommits),
    };
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse tracking positions the tooltip only
    <div
      className="treemap"
      ref={boxRef}
      onMouseMove={onMove}
      onMouseLeave={() => setTip(null)}
      data-testid="treemap"
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="treemap__svg"
        role="img"
        aria-label="Repository treemap"
        data-nodes={layout.count}
        data-layout-ms={layout.layoutMs.toFixed(1)}
      >
        <title>Repository treemap</title>
        {layout.dirs.map((d) => {
          const width = d.x1 - d.x0;
          const height = d.y1 - d.y0;
          const label = height >= 2 * LABEL_H ? fitLabel(d.data.name, width) : null;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG tile; the breadcrumb is the keyboard path for zoom
            <g
              key={d.data.path}
              className="tm-dir"
              data-dir={d.data.path}
              onClick={() => onZoom(d.data.path)}
              onMouseEnter={() => setTip(d)}
            >
              <rect x={d.x0} y={d.y0} width={width} height={height} className="tm-dir__bg" />
              {label ? (
                <text x={d.x0 + 4} y={d.y0 + 11} className="tm-dir__label">
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
        {layout.leaves.map((n) => {
          const d = n.data;
          const width = Math.max(0, n.x1 - n.x0);
          const height = Math.max(0, n.y1 - n.y0);
          const { fill, opacity } = fillFor(n);
          const hl = highlights.get(d.path);
          const activeBy = hl
            ?.filter((x) => x.why === 'active')
            .map((x) => x.assignee)
            .join(',');
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG tile, one per file; the rail and file panel are the keyboard path
            <rect
              key={d.path}
              x={n.x0}
              y={n.y0}
              width={width}
              height={height}
              fill={fill}
              fillOpacity={opacity}
              className={`tm-tile tm-tile--${d.kind}`}
              style={d.kind === 'ghost' ? { stroke: d.ghostColor } : undefined}
              data-tile={d.path}
              data-kind={d.kind}
              data-active-by={activeBy || undefined}
              onMouseEnter={() => setTip(n)}
              onClick={() =>
                d.kind === 'more' ? onZoom(n.parent?.data.path ?? '') : onFileClick(d.path)
              }
            />
          );
        })}
        {layout.leaves.map((n) => {
          const hl = highlights.get(n.data.path);
          if (!hl?.length || n.data.kind === 'ghost') return null;
          const first = hl[0] as Highlight;
          const width = n.x1 - n.x0;
          const height = n.y1 - n.y0;
          const emojis = [...new Set(hl.map((x) => x.emoji))].slice(0, 3).join('');
          const size = Math.min(14, height - 4, width / Math.max(1, emojis.length) - 2);
          return (
            <g
              key={`hl-${n.data.path}`}
              className={`tm-hl ${fun ? 'tm-hl--glow' : ''}`}
              style={{ '--hl': first.color } as React.CSSProperties}
              pointerEvents="none"
            >
              <rect
                x={n.x0 + 1}
                y={n.y0 + 1}
                width={Math.max(0, width - 2)}
                height={Math.max(0, height - 2)}
                className="tm-hl__ring"
              />
              {size >= 9 ? (
                <text
                  x={n.x1 - 3}
                  y={n.y0 + size + 1}
                  textAnchor="end"
                  fontSize={size}
                  className="tm-hl__emoji"
                >
                  {emojis}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div
        ref={tipRef}
        className="tm-tip"
        role="tooltip"
        hidden={tip === null}
        aria-hidden={tip === null}
      >
        {tip ? <TipBody node={tip} now={now} highlights={highlights.get(tip.data.path)} /> : null}
      </div>
    </div>
  );
}

function TipBody({
  node,
  now,
  highlights,
}: {
  node: Node;
  now: number;
  highlights: Highlight[] | undefined;
}) {
  const d = node.data;
  if (d.kind === 'dir') {
    const files = node.leaves().filter((l) => l.data.kind !== 'ghost').length;
    return (
      <>
        <div className="tm-tip__path mono">{d.path}/</div>
        <div className="tm-tip__row">
          {files} files · {formatBytes(node.value ?? 0)} · click to zoom
        </div>
      </>
    );
  }
  if (d.kind === 'more') {
    return (
      <>
        <div className="tm-tip__path mono">{d.path.slice(0, -1)}</div>
        <div className="tm-tip__row">
          {d.count} small files · {formatBytes(d.bytes)} · click to zoom in
        </div>
      </>
    );
  }
  if (d.kind === 'ghost') {
    return (
      <>
        <div className="tm-tip__path mono">{d.path}</div>
        <div className="tm-tip__row tm-tip__warn">
          not in the repo — named by {d.ghostOf} (moved, deleted, or a typo)
        </div>
      </>
    );
  }
  const f = d.file;
  if (!f) return null;
  const when =
    f.lastCommitAt === null
      ? 'no commit in 90d'
      : `last commit ${relTime(f.lastCommitAt, now)} (${recentBucket(f.lastCommitAt, now)})`;
  return (
    <>
      <div className="tm-tip__path mono">{f.path}</div>
      <div className="tm-tip__row">
        <span className="tm-tip__swatch" style={{ background: langColor(f.lang) }} />
        {f.lang} · {formatBytes(f.bytes)} · {formatLines(f.lines)} lines
      </div>
      <div className="tm-tip__row">
        {f.commits30d} commits / 30d · {f.commits90d} / 90d · {when}
      </div>
      {highlights?.length ? (
        <div className="tm-tip__row">
          {highlights.map((h) => (
            <span key={h.cardId} className="tm-tip__who" style={{ color: h.color }}>
              {h.emoji} {h.cardId}
              {h.why === 'active' ? '' : ` (${h.why})`}
            </span>
          ))}
        </div>
      ) : null}
      <div className="tm-tip__row muted">click for cards naming this file</div>
    </>
  );
}
