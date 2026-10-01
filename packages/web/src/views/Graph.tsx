/**
 * P4.4 import graph. d3-force layout; nodes = files with ≥ 1 edge, sized by in-degree, colored by
 * top-level directory. Drag to move a node, scroll to zoom, drag the background to pan, click a
 * node for the file panel. Same "who is where" outline as the treemap.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { baseName, type GraphData, type Highlight } from '../map/model.js';
import { useSize } from '../map/useSize.js';
import type { Timing } from './Treemap.jsx';

interface GNode extends SimulationNodeDatum {
  id: string;
  dir: string;
  r: number;
  inDegree: number;
}
type GLink = SimulationLinkDatum<GNode>;

export interface GraphProps {
  data: GraphData;
  colors: ReadonlyMap<string, string>;
  highlights: ReadonlyMap<string, Highlight[]>;
  fun: boolean;
  onFileClick: (path: string) => void;
  onTiming?: (t: Timing) => void;
}

interface Transform {
  x: number;
  y: number;
  k: number;
}

const SETTLE_TICKS = 200;
const MIN_K = 0.2;
const MAX_K = 8;
const CLICK_SLOP = 3;

function radius(inDegree: number): number {
  return 4 + 2.2 * Math.sqrt(inDegree);
}

function endpoint(v: string | number | GNode): GNode | null {
  return typeof v === 'object' ? v : null;
}

export function Graph({ data, colors, highlights, fun, onFileClick, onTiming }: GraphProps) {
  // Written on every render, read in the commit effect: how long this render took to paint.
  const renderStart = useRef(0);
  renderStart.current = performance.now();
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { w, h } = useSize(boxRef);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [tf, setTf] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);

  // Mutable simulation state, rebuilt only when the data or the canvas size changes.
  const sim = useMemo(() => {
    const t0 = performance.now();
    const nodes: GNode[] = data.nodes.map((n) => ({
      id: n.id,
      dir: n.dir,
      inDegree: n.inDegree,
      r: radius(n.inDegree),
    }));
    const links: GLink[] = data.links.map((l) => ({ source: l.source, target: l.target }));
    const simulation = forceSimulation<GNode>(nodes)
      .force(
        'link',
        forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance(36)
          .strength(0.4),
      )
      .force('charge', forceManyBody<GNode>().strength(-70))
      .force(
        'collide',
        forceCollide<GNode>().radius((d) => d.r + 3),
      )
      .force('x', forceX<GNode>(w / 2).strength(0.04))
      .force('y', forceY<GNode>(h / 2).strength(0.04))
      .stop();
    for (let i = 0; i < SETTLE_TICKS; i++) simulation.tick();
    return { simulation, nodes, links, settleMs: performance.now() - t0 };
  }, [data, w, h]);

  useEffect(() => {
    const { simulation } = sim;
    let raf = 0;
    simulation.on('tick', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        bump();
      });
    });
    return () => {
      simulation.on('tick', null);
      simulation.stop();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sim]);

  useEffect(() => {
    onTiming?.({
      layoutMs: sim.settleMs,
      commitMs: performance.now() - renderStart.current,
      nodes: sim.nodes.length + sim.links.length,
    });
  }, [sim, onTiming]);

  // Wheel zoom about the cursor. Native listener: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setTf((t) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, t.k * Math.exp(-e.deltaY * 0.0015)));
        const s = k / t.k;
        return { k, x: mx - (mx - t.x) * s, y: my - (my - t.y) * s };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const toLocal = useCallback((clientX: number, clientY: number, t: Transform) => {
    const r = svgRef.current?.getBoundingClientRect();
    const px = clientX - (r?.left ?? 0);
    const py = clientY - (r?.top ?? 0);
    return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
  }, []);

  const tfRef = useRef(tf);
  tfRef.current = tf;

  const onNodeDown = (node: GNode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const { simulation } = sim;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < CLICK_SLOP) return;
      if (!moved) {
        moved = true;
        simulation.alphaTarget(0.3).restart();
      }
      const p = toLocal(ev.clientX, ev.clientY, tfRef.current);
      node.fx = p.x;
      node.fy = p.y;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        simulation.alphaTarget(0);
        node.fx = null;
        node.fy = null;
      } else {
        onFileClick(node.id);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y };
    const move = (ev: PointerEvent) =>
      setTf((t) => ({
        ...t,
        x: start.tx + ev.clientX - start.x,
        y: start.ty + ev.clientY - start.y,
      }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const labelled = useMemo(() => {
    // Labels for the most-imported files only, so the picture stays legible; hover shows the rest.
    const sorted = [...sim.nodes].sort((a, b) => b.inDegree - a.inDegree);
    return new Set(sorted.slice(0, 40).map((n) => n.id));
  }, [sim]);

  return (
    <div className="graph" ref={boxRef} data-testid="graph">
      <svg
        ref={svgRef}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="graph__svg"
        role="img"
        aria-label="Import graph"
        onPointerDown={onBackgroundDown}
        data-nodes={sim.nodes.length}
        data-links={sim.links.length}
      >
        <title>Import graph</title>
        <g transform={`translate(${tf.x} ${tf.y}) scale(${tf.k})`}>
          {sim.links.map((l, i) => {
            const s = endpoint(l.source);
            const t = endpoint(l.target);
            if (!s || !t) return null;
            const lit = hover !== null && (s.id === hover || t.id === hover);
            return (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: links have no identity beyond endpoints
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                className={`gr-link ${lit ? 'gr-link--lit' : ''}`}
              />
            );
          })}
          {sim.nodes.map((n) => {
            const hl = highlights.get(n.id);
            const first = hl?.[0];
            const activeBy = hl
              ?.filter((x) => x.why === 'active')
              .map((x) => x.assignee)
              .join(',');
            const emojis = hl ? [...new Set(hl.map((x) => x.emoji))].slice(0, 3).join('') : '';
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: SVG node; hundreds of them, keyboard path is the rail and file panel
              <g
                key={n.id}
                className={`gr-node ${first && fun ? 'gr-node--glow' : ''}`}
                style={first ? ({ '--hl': first.color } as React.CSSProperties) : undefined}
                transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                onPointerDown={onNodeDown(n)}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                data-node={n.id}
                data-active-by={activeBy || undefined}
              >
                <circle
                  r={n.r}
                  fill={colors.get(n.dir) ?? '#a3a3a3'}
                  className={`gr-node__dot ${first ? 'gr-node__dot--hl' : ''}`}
                />
                {emojis ? (
                  <text
                    x={n.r * 0.7}
                    y={-n.r * 0.7}
                    fontSize={12}
                    className="gr-node__emoji"
                    pointerEvents="none"
                  >
                    {emojis}
                  </text>
                ) : null}
                {labelled.has(n.id) || hover === n.id || first ? (
                  <text
                    y={n.r + 10}
                    textAnchor="middle"
                    className={`gr-node__label ${hover === n.id ? 'gr-node__label--hover' : ''}`}
                    pointerEvents="none"
                  >
                    {hover === n.id ? n.id : baseName(n.id)}
                  </text>
                ) : null}
                <title>
                  {n.id} · imported by {n.inDegree}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
