/**
 * RCB-98 (plan docs/SYSTEMS-FLOW-PLAN.md §3.4): the Flow view — the third top-level view, beside
 * Board and Map. Per-system, not per-file: rows by `layer`, an env switch (`dev`/`prod`/`both`),
 * one-env dashing, a `none` environment's note in place of the diagram, and a drawer with the
 * row's fields, its `pointers` resolved live, and backlinks (cards whose `refs:`/`files:` name a
 * path under one of them). Layout comes from core's `layoutSystems` (RCB-95), pure, 0 KB added —
 * this file only draws the boxes and edges it returns. Fun stays off here (plan D9).
 *
 * RCB-174: the diagram is a pan/zoom canvas (`usePanZoom`, one transform on an inner `<g>`), not a
 * shrink-to-fit SVG — a wide map (2,593 px) keeps its 12 px text legible and is navigated,
 * not squinted at. Toolbar: Fit / 100% / − / + and a filter (id, name, kind). Clicking a box also
 * focuses it: everything but the box and its direct neighbours dims. While the drawer is open the
 * canvas is narrowed by its width and a hidden selected box is panned into view.
 *
 * RCB-175: legibility. Every edge ends in an arrowhead (one `<marker>` per edge style); every box
 * carries its kind as a glyph and a family-coloured name (`flow-kinds.tsx`, plus a collapsible
 * legend of the kinds on this map); id and name are clipped to the box with an ellipsis (the full
 * text is the box's `<title>`); rows sit on alternating bands; the environments' note is shown
 * under the env switch; and a connection that runs both ways is drawn as two offset lines.
 *
 * RCB-176: a connection is a thing you can open. Each edge has a wide transparent hit path over
 * its route (hover lights the line, click selects the connection) and its `label`, when set, sits
 * at the route's midpoint; the connection drawer shows the row's own fields (from/to are buttons
 * that open those systems) and its `pointers` resolved live; the system drawer's connection list
 * links both ways. The selection is mirrored to `?view=flow&system=` / `&conn=` (`flow-url.ts`).
 *
 * RCB-180: a summary strip under the toolbar (data stores, externals, entry points — core's
 * `flowOverview`, each id a button that selects that box) and, when `systems.yml` has `paths:`, a
 * toolbar `Paths` select that walks one route hop by hop: the current hop's edge(s) and its two
 * boxes stay lit, everything else dims (the same dimming as a focus), Esc or `none` ends it.
 */
import {
  type BoardConfig,
  type Card,
  type Connection,
  defaultBoardConfig,
  flowOverview,
  layoutSystems,
  type ResolvedRef,
  type Source,
  type SystemKind,
  type SystemRow,
  type SystemsDoc,
  type SystemsLayout,
  systemsSummary,
  unblockerInfo,
} from '@repoboard/core';
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { RefsList } from '../components/RefsList.jsx';
import { useBoardState, useStore } from '../hooks.js';
import { apiPath } from '../repo-key.js';
import type { FlowEnv, State } from '../store.js';
import type { RepoGitPayload, SystemTestsPayload } from '../wire.js';
import { FlowLegend, GLYPH_SIZE, KIND_META, KindGlyph, kindsPresent } from './flow-kinds.jsx';
import { clearFlowUrl, type FlowSelection, readFlowUrl, writeFlowUrl } from './flow-url.js';
import { type Transform, usePanZoom } from './usePanZoom.js';

const ENVS: readonly FlowEnv[] = ['dev', 'prod', 'both'];

// Abstract layout units (core's `layoutSystems`) to pixels: a box is 1x1 unit, so setting these
// two constants equal to a box's on-screen size keeps every edge endpoint (computed in core from
// the SAME abstract box geometry) landing exactly on the box's border/centre — no separate fudge.
const SCALE_X = 170;
const SCALE_Y = 64;
const LABEL_W = 88;
const PAD = 20;

function px(x: number, y: number): { x: number; y: number } {
  return { x: LABEL_W + x * SCALE_X + PAD, y: y * SCALE_Y + PAD };
}

/** The diagram's size in the same pixels `px` returns — what the canvas fits and pans over. */
export function flowContentSize(layout: SystemsLayout): { w: number; h: number } {
  return {
    w: Math.max(LABEL_W + layout.width * SCALE_X + PAD * 2, LABEL_W + PAD * 2),
    h: Math.max(layout.height * SCALE_Y + PAD * 2, PAD * 2),
  };
}

/** Each row's band, in pixels (RCB-192). Rows are not a fixed distance apart: a row gap grows with
 * its track count, so its height varies from gap to gap. The bands tile the diagram: the first
 * starts at 0, the last ends at `contentH`, and the boundary between two rows is the midpoint of
 * the upper row's bottom and the lower row's top, so every band holds its box row. Where a gap has
 * not grown (rows two boxes, 128 px, apart) that boundary is half a box below the upper row, and
 * a middle band is 128 px tall. */
function rowBands(layout: SystemsLayout, contentH: number): { top: number; bottom: number }[] {
  const tops = layout.rows.map((row) => px(0, row.boxes[0]?.y ?? 0).y);
  return tops.map((top, i) => {
    const above = tops[i - 1];
    const below = tops[i + 1];
    return {
      top: above === undefined ? 0 : (above + SCALE_Y + top) / 2,
      bottom: below === undefined ? contentH : (top + SCALE_Y + below) / 2,
    };
  });
}

/** Where a box's text may run: the box less 8 px of padding each side. The id line also gives up
 * the glyph's corner (`GLYPH_SIZE` plus a 6 px gap) — the name line sits below the glyph. */
const TEXT_PAD = 8;
const NAME_MAX_W = SCALE_X - TEXT_PAD * 2;
const ID_MAX_W = NAME_MAX_W - GLYPH_SIZE - 6;
const ID_FONT_PX = 12;
const NAME_FONT_PX = 11;

/** SVG cannot ellipsize text, and jsdom cannot measure it, so the width is ESTIMATED — on the
 * high side, so a clipped string is never wider than its room. Monospace is exactly 0.6 em a
 * character in every font in `--font-mono`. For the proportional name: `M W @ %` count 0.95 em,
 * other capitals, digits and `m w # &` 0.74 em, narrow glyphs (`i j l r t f 1 I` and
 * punctuation) 0.36 em, the rest 0.56 em (typical lower-case Latin is ~0.5 em; these numbers are
 * estimates, not measurements of any one font). */
function textWidth(text: string, fontPx: number, mono: boolean): number {
  if (mono) return text.length * 0.6 * fontPx;
  let em = 0;
  for (const ch of text) {
    em += /[MW@%]/.test(ch)
      ? 0.95
      : /[A-Z0-9mw#&]/.test(ch)
        ? 0.74
        : /[ijlrtf1I.,:;'!|()/ -]/.test(ch)
          ? 0.36
          : 0.56;
  }
  return em * fontPx;
}

/** `text` if it fits in `maxW` px, else its longest prefix that fits with a `…` after it. The
 * full text always goes in the box's `<title>` — this only decides what is drawn. */
export function fitText(text: string, fontPx: number, mono: boolean, maxW: number): string {
  if (textWidth(text, fontPx, mono) <= maxW) return text;
  const ellipsisW = (mono ? 0.6 : 1) * fontPx;
  let n = text.length;
  while (n > 0 && textWidth(text.slice(0, n), fontPx, mono) + ellipsisW > maxW) n -= 1;
  return `${text.slice(0, n).trimEnd()}…`;
}

interface Pt {
  x: number;
  y: number;
}

/** The width of an edge's transparent hit path — the click target a 1.5 px line is not. */
export const EDGE_HIT_W = 14;

/** The label's font size, and the widest it is drawn (px) before it is cut with an ellipsis; the
 * full text is the edge's `<title>` and the drawer's `label` field. */
const EDGE_LABEL_FONT_PX = 10;
const EDGE_LABEL_MAX_W = 160;

/** The point halfway along `points` (by length, not by count of vertices). */
export function polylineMidpoint(points: readonly Pt[]): Pt {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a !== undefined && b !== undefined) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  let left = total / 2;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 0 && left <= len) {
      const f = left / len;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    left -= len;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** The `doc.connections` row behind each of `layout.edges` (same index). The layout carries no id
 * or label — only from/to — and emits exactly one edge per visible row, in `doc.connections`
 * order, so the k-th edge of a (from,to) pair is the k-th row of that pair visible in `layout.env`
 * (`layoutSystems`' own rule: `both` shows every row, `dev`/`prod` only rows tagged with it). */
export function connectionsForEdges(
  doc: SystemsDoc,
  layout: SystemsLayout,
): (Connection | undefined)[] {
  const rowsOf = new Map<string, Connection[]>();
  const used = new Map<string, number>();
  return layout.edges.map((e) => {
    const key = `${e.from}>${e.to}`;
    let rows = rowsOf.get(key);
    if (rows === undefined) {
      rows = doc.connections.filter(
        (c) =>
          c.from === e.from &&
          c.to === e.to &&
          (layout.env === 'both' || c.env.includes(layout.env)),
      );
      rowsOf.set(key, rows);
    }
    const k = used.get(key) ?? 0;
    used.set(key, k + 1);
    return rows[k];
  });
}

/** The row a `conn=` selection names: the pair's row with that `id`; with no `id`, the pair's only
 * row (two rows and no `id` is ambiguous — `undefined`, never a silent pick). */
export function findConnection(
  doc: SystemsDoc,
  ref: { from: string; to: string; id: string | null },
): Connection | undefined {
  const pair = doc.connections.filter((c) => c.from === ref.from && c.to === ref.to);
  if (ref.id !== null) return pair.find((c) => c.id === ref.id);
  return pair.length === 1 ? pair[0] : undefined;
}

/** RCB-180: one `paths:` entry (`SystemsDoc.paths`), and one step of walking it. */
type FlowPath = NonNullable<SystemsDoc['paths']>[number];
export interface PathHop {
  from: string;
  to: string;
}

/** The consecutive pairs of a path's `hops` — the steps of the walk, `hops.length - 1` of them. */
export function pathSteps(path: FlowPath): PathHop[] {
  return path.hops.flatMap((from, i) => {
    const to = path.hops[i + 1];
    return to === undefined ? [] : [{ from, to }];
  });
}

/** A path can be walked in `layout` only when EVERY step has a drawn edge: a system or a connection
 * that the env leaves out breaks the route, and a route with a gap is not shown as if it did not. */
export function pathDrawn(path: FlowPath, layout: SystemsLayout): boolean {
  const steps = pathSteps(path);
  return (
    steps.length > 0 &&
    steps.every((h) => layout.edges.some((e) => e.from === h.from && e.to === h.to))
  );
}

/** The content-px rectangle holding a step's two boxes and every edge between them (parallel rows
 * of the pair included), padded by the edge hit width — what a step pans into view. `null` when the
 * step is not drawn. */
export function hopRect(
  layout: SystemsLayout,
  hop: PathHop,
): { x: number; y: number; w: number; h: number } | null {
  const boxes = layout.rows
    .flatMap((r) => r.boxes)
    .filter((b) => b.id === hop.from || b.id === hop.to);
  const pts = [
    ...boxes.flatMap((b) => [px(b.x, b.y), px(b.x + b.w, b.y + b.h)]),
    ...layout.edges
      .filter((e) => e.from === hop.from && e.to === hop.to)
      .flatMap((e) => e.points.map((p) => px(p.x, p.y))),
  ];
  if (boxes.length === 0 || pts.length === 0) return null;
  const left = Math.min(...pts.map((p) => p.x)) - EDGE_HIT_W;
  const top = Math.min(...pts.map((p) => p.y)) - EDGE_HIT_W;
  return {
    x: left,
    y: top,
    w: Math.max(...pts.map((p) => p.x)) + EDGE_HIT_W - left,
    h: Math.max(...pts.map((p) => p.y)) + EDGE_HIT_W - top,
  };
}

/** An id for each mounted Flow view. The arrowhead `<marker>`s and the legend are found by id, and
 * ids share ONE namespace per document, so two views (or two React roots — where `useId` would
 * hand both `:r0:`) must never reuse one. A skipped number (StrictMode runs the initializer
 * twice) costs nothing. */
let flowViewSeq = 0;
function nextFlowViewId(): string {
  flowViewSeq += 1;
  return `flow-${flowViewSeq}`;
}

/** One arrowhead per edge STYLE; `blocked` and `planned` are separate because a blocked edge is
 * coral and a marker's colour is not inherited from the line it ends. */
type EdgeStyle = 'live' | 'dashed' | 'planned' | 'blocked';

function edgeStyle(e: { status: string; dashed: boolean }): EdgeStyle {
  if (e.status === 'planned' || e.status === 'blocked') return e.status;
  return e.dashed ? 'dashed' : 'live';
}

const EDGE_STYLES: readonly EdgeStyle[] = ['live', 'dashed', 'planned', 'blocked'];

/** The note line under the env switch: the note for the env on show; under `both`, each env's
 * note (`dev: … · prod: …`, or once when they read the same). `null` when there is nothing to
 * say — a `note: null` env, or a `none` env (its reason has its own place: the canvas). */
export function envNoteLine(notes: SystemsLayout['notes'], env: FlowEnv): string | null {
  const dev = notes.dev?.trim() || null;
  const prod = notes.prod?.trim() || null;
  if (env !== 'both') return env === 'dev' ? dev : prod;
  if (dev !== null && prod !== null) return dev === prod ? dev : `dev: ${dev} · prod: ${prod}`;
  if (dev !== null) return `dev: ${dev}`;
  if (prod !== null) return `prod: ${prod}`;
  return null;
}

/** `Transform` as the SVG attribute; offsets rounded to 0.01 px and scale to 0.001, so the DOM
 * is not 15-digit noise (the state itself is never rounded). */
function transformAttr(t: Transform): string {
  return `translate(${Math.round(t.x * 100) / 100} ${Math.round(t.y * 100) / 100}) scale(${Math.round(t.k * 1000) / 1000})`;
}

/** The spec text before the first `#` or `:` — the path half of a card's `refs:`/`files:` entry
 * (K7 forms: `path#Heading`, `path@Token`, `path:L10-L20`, or a bare `path`). */
function specPath(spec: string): string {
  const hash = spec.indexOf('#');
  const colon = spec.indexOf(':');
  const cut = hash === -1 ? colon : colon === -1 ? hash : Math.min(hash, colon);
  return cut === -1 ? spec : spec.slice(0, cut);
}

function pathUnderOrEqual(path: string, pointer: string): boolean {
  return path === pointer || path.startsWith(`${pointer}/`);
}

/** System-level who-is-where (plan §3.4): every card whose `refs:`/`files:` path equals or falls
 * under one of `pointers`. `[]` when the system has no pointers — an unconfigured system points
 * at nothing, so it backlinks nothing, never "everything" (CLAUDE.md: inert, not dangerous). */
export function backlinksFor(cards: readonly Card[], pointers: readonly string[]): Card[] {
  if (pointers.length === 0) return [];
  return cards.filter((c) => {
    const specs = [...(c.refs ?? []), ...(c.files ?? [])];
    return specs.some((spec) => {
      const path = specPath(spec);
      return pointers.some((ptr) => pathUnderOrEqual(path, ptr));
    });
  });
}

type SystemRefsState =
  | { kind: 'loading' }
  | { kind: 'ok'; refs: ResolvedRef[] }
  | { kind: 'error'; message: string };

/** GET `url`, an `/api/.../refs` route, as a `SystemRefsState` — the system and the connection
 * drawers both resolve their `pointers` through it. */
async function loadRefs(url: string): Promise<SystemRefsState> {
  if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
  const res = await fetch(url);
  if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return { kind: 'error', message: `${url} → not an array` };
  return { kind: 'ok', refs: data as ResolvedRef[] };
}

/** Mirrors `Drawer.tsx`'s `useRefs`: fetched live on every select, never cached; `url: null` (the
 * row has no pointers) fetches nothing at all — no dead network call. */
function useRefsAt(url: string | null): SystemRefsState {
  const [state, setState] = useState<SystemRefsState>({ kind: 'loading' });
  useEffect(() => {
    if (url === null) {
      setState({ kind: 'ok', refs: [] });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    loadRefs(url)
      .catch(
        (e: unknown): SystemRefsState => ({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}

function useSystemRefs(systemId: string, pointers: readonly string[]): SystemRefsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  return useRefsAt(
    pointers.length === 0
      ? null
      : apiPath(`/api/systems/${encodeURIComponent(systemId)}/refs`, repoKey),
  );
}

/** RCB-173's route: `/api/systems/connections/:from/:to/refs`, with `?id=` when the row has one
 * (a pair that several rows share is ambiguous without it — the server answers 400). */
function useConnectionRefs(conn: Connection): SystemRefsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const query = conn.id === undefined ? '' : `?id=${encodeURIComponent(conn.id)}`;
  return useRefsAt(
    (conn.pointers ?? []).length === 0
      ? null
      : apiPath(
          `/api/systems/connections/${encodeURIComponent(conn.from)}/${encodeURIComponent(conn.to)}/refs${query}`,
          repoKey,
        ),
  );
}

/** RCB-178: a system's `docs`, resolved through the docs route — `path#Heading` is a ref spec, so
 * the same `RefsList` renders them. Skipped entirely when the system has no docs. */
function useSystemDocs(systemId: string, docs: readonly string[]): SystemRefsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  return useRefsAt(
    docs.length === 0
      ? null
      : apiPath(`/api/systems/${encodeURIComponent(systemId)}/docs`, repoKey),
  );
}

function isRepoGit(v: unknown): v is RepoGitPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.root === 'string' &&
    (o.web === null || typeof o.web === 'string') &&
    (o.head === null || typeof o.head === 'string')
  );
}

/** RCB-178: `GET /api/git` — where the served root is and its GitHub coordinates. Any failure is
 * `null` (no links), never an error the drawer has to show. */
async function loadGit(url: string): Promise<RepoGitPayload | null> {
  if (typeof fetch !== 'function') return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data: unknown = await res.json();
  return isRepoGit(data) ? data : null;
}

/** RCB-178: fetched live each time a drawer opens on `selection` (a different system or
 * connection is a different open), never cached — the commit moves under the page. `enabled:
 * false` (nothing in the drawer to link to) fetches nothing at all. `null` until it answers. */
function useRepoGit(enabled: boolean, selection: string): RepoGitPayload | null {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [git, setGit] = useState<RepoGitPayload | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selection` identity is the refetch trigger, by design (mirrors useSystemRefs)
  useEffect(() => {
    setGit(null);
    if (!enabled) return;
    let alive = true;
    loadGit(apiPath('/api/git', repoKey))
      .catch((): RepoGitPayload | null => null)
      .then((next) => {
        if (alive) setGit(next);
      });
    return () => {
      alive = false;
    };
  }, [enabled, selection, repoKey]);
  return git;
}

/** A repo-relative path as URL path segments: each segment encoded, the slashes kept. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** A ref whose spec is just its path names the whole file; every other spec form (`:L`, `#`, `@`)
 * names a span. The wire's `start`/`end` alone cannot say which — a whole file has them too. */
function isWholeFile(r: ResolvedRef): boolean {
  return r.spec.trim() === r.path;
}

/** RCB-178: `vscode://file/<root>/<path>:<start>` — the root's segments are URI-encoded (roots hold
 * spaces), a whole file has no `:<start>`, and an unresolved ref has no link at all. The root's own
 * leading `/` is the slash after `file`. */
function editorHref(root: string, r: ResolvedRef): string | null {
  if (r.text === null || r.path === null) return null;
  const rooted = `/${root.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const dir = rooted
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  const at = isWholeFile(r) || r.start === null ? '' : `:${r.start}`;
  return `vscode://file${dir}/${encodePath(r.path)}${at}`;
}

/** RCB-178: `<web>/blob/<head>/<path>#L<start>-L<end>` (`#L<n>` for one line, no anchor for a whole
 * file). `null` — no link, never a broken one — for an unresolved ref or when `web` or `head` is
 * unknown. */
function githubHref(git: RepoGitPayload, r: ResolvedRef): string | null {
  if (git.web === null || git.head === null || r.text === null || r.path === null) return null;
  const base = `${git.web}/blob/${git.head}/${encodePath(r.path)}`;
  if (isWholeFile(r) || r.start === null || r.end === null) return base;
  return r.start === r.end ? `${base}#L${r.start}` : `${base}#L${r.start}-L${r.end}`;
}

/** RCB-178: `RefsList`'s `linksFor` for a drawer, or `undefined` while `/api/git` has not answered
 * (or could not) — then the head lines are what they were. */
function refLinksFor(git: RepoGitPayload | null): ((r: ResolvedRef) => ReactNode) | undefined {
  if (git === null) return undefined;
  return (r) => {
    const editor = editorHref(git.root, r);
    const github = githubHref(git, r);
    if (editor === null && github === null) return null;
    return (
      <span className="drawer__ref-links">
        {editor === null ? null : (
          <a className="drawer__ref-link" href={editor} title="Open in VS Code">
            editor
          </a>
        )}
        {github === null ? null : (
          <a
            className="drawer__ref-link"
            href={github}
            target="_blank"
            rel="noreferrer noopener"
            title="Open on GitHub, at the current commit"
          >
            GitHub
          </a>
        )}
      </span>
    );
  };
}

/** RCB-178: a copy button beside a runtime value. A clipboard that is missing (an insecure page has
 * none) or refuses shows "copy failed" — the click is never silent. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const clip: Clipboard | undefined =
      typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined || typeof clip.writeText !== 'function') {
      setState('failed');
      return;
    }
    try {
      clip.writeText(text).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <button
        type="button"
        className="flow-copy"
        aria-label={`${state === 'copied' ? 'copied' : 'copy'} ${label}`}
        onClick={copy}
      >
        {state === 'copied' ? 'copied' : 'copy'}
      </button>
      {state === 'failed' ? (
        <span className="flow-copy__failed" role="status">
          copy failed
        </span>
      ) : null}
    </>
  );
}

type SystemTestsState =
  | { kind: 'loading' }
  | { kind: 'ok'; tests: SystemTestsPayload | null }
  | { kind: 'error'; message: string };

/** Mirrors `useSystemRefs` exactly: fetched live on every select, never cached, skipped entirely
 * when the system has no pointers (no dead network call) — `tests: null` there, not an empty
 * payload, since "no pointers" and "pointers with zero tests" are different facts. */
function useSystemTests(systemId: string, pointers: readonly string[]): SystemTestsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [state, setState] = useState<SystemTestsState>({ kind: 'loading' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `systemId` identity is the refetch trigger, by design (mirrors useSystemRefs)
  useEffect(() => {
    if (pointers.length === 0) {
      setState({ kind: 'ok', tests: null });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    const url = apiPath(`/api/systems/${encodeURIComponent(systemId)}/tests`, repoKey);
    const load = async (): Promise<SystemTestsState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const data: unknown = await res.json();
      return { kind: 'ok', tests: data as SystemTestsPayload };
    };
    load()
      .catch(
        (e: unknown): SystemTestsState => ({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [systemId]);
  return state;
}

/** RCB-113: the `· <pct>%` or `· <reason>` suffix `measured.pointers` adds to a pointer's line —
 * `''` when this pointer has no counterpart there (never true today; `measured.pointers` walks
 * the same pointer list, in the same order). */
function measuredSuffix(payload: SystemTestsPayload, pointer: string): string {
  const m = payload.measured.pointers.find((p) => p.pointer === pointer);
  if (m === undefined) return '';
  return m.pct !== null ? ` · ${m.pct.toFixed(1)}%` : ` · ${m.reason}`;
}

/** One `<li>` per pointer, per the wire contract: a non-null `tests` gives its count and file
 * list, a null `tests` with a `reason` gives the reason, otherwise `none` — plus RCB-113's
 * measured-coverage suffix. */
function testsLine(payload: SystemTestsPayload, p: SystemTestsPayload['pointers'][number]): string {
  const suffix = measuredSuffix(payload, p.pointer);
  if (p.tests !== null) {
    return p.tests.length === 0
      ? `${p.pointer} — none${suffix}`
      : `${p.pointer} — ${p.tests.length}: ${p.tests.join(', ')}${suffix}`;
  }
  if (p.reason !== null) return `${p.pointer} — ${p.reason}${suffix}`;
  return `${p.pointer} — none${suffix}`;
}

/** Mirrors `RefsList`'s collapsed toggle (RCB-109): closed shows nothing of `tests[]`, only a
 * `show`/`hide` button; open reveals the per-pointer list and the source sentence below it. */
function TestsToggle({ payload }: { payload: SystemTestsPayload }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="drawer__ref-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'hide' : 'show'}
      </button>
      {open ? (
        <>
          <ul className="drawer__files mono">
            {payload.pointers.map((p) => (
              <li key={p.pointer}>{testsLine(payload, p)}</li>
            ))}
          </ul>
          <p className="mono muted">{payload.source}</p>
          <p className="mono muted">{payload.measured.source}</p>
        </>
      ) : null}
    </>
  );
}

interface UnblockerRowsProps {
  ids: readonly string[];
  cards: readonly Card[];
  config: BoardConfig | null;
  onOpenCard: (id: string) => void;
}

/** RCB-161 slice 2: one row per `unblocked_by` id — shared by the drawer's own "Unblocked by"
 * section and a non-live connection's line, so both go through the SAME resolution
 * (`unblockerInfo`, core; also `repoboard systems show`'s CLI output) rather than a second
 * rendering of the same data. Empty list: the one "nothing recorded" line. */
function UnblockerRows({ ids, cards, config, onOpenCard }: UnblockerRowsProps) {
  if (ids.length === 0) {
    return <p className="rail__empty">Nothing recorded unblocks this yet.</p>;
  }
  return (
    <ul className="drawer__files mono">
      {ids.map((id) => {
        const info = unblockerInfo(id, cards, config ?? defaultBoardConfig());
        const nextStep = info.nextStep;
        return (
          <li key={id}>
            {info.card ? (
              <button type="button" className="who__body" onClick={() => onOpenCard(id)}>
                {id} — {info.card.title} [{info.card.status}]
              </button>
            ) : (
              <span>{id} (not on this board)</span>
            )}
            {info.decision ? (
              <div className="muted">
                <div>decision: {info.decision.question}</div>
                {info.decision.options.map((o) => (
                  <div key={o.letter}>
                    {o.letter}: {o.text}
                  </div>
                ))}
              </div>
            ) : nextStep ? (
              <button
                type="button"
                className="who__body muted"
                onClick={() => onOpenCard(nextStep.id)}
              >
                next step: {nextStep.id} {nextStep.title}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function sourceText(source: Source): string {
  return 'hand' in source
    ? `hand: ${source.hand} · ${source.at}`
    : `detected: ${source.detected} · ${source.at}`;
}

interface SystemDrawerProps {
  system: SystemRow;
  doc: SystemsDoc;
  cards: readonly Card[];
  config: BoardConfig | null;
  onClose: () => void;
  onOpenCard: (id: string) => void;
  /** RCB-176: the other end of a connection row, as a button. */
  onSelectSystem: (id: string) => void;
  /** RCB-176: a connection row's own button. */
  onOpenConnection: (conn: Connection) => void;
}

/** A system id (or connection end) as a button that opens that system. */
function SystemLink({ id, name, onSelect }: { id: string; name?: string; onSelect: () => void }) {
  return (
    <button type="button" className="flow-link" title={name} onClick={onSelect}>
      {id}
    </button>
  );
}

function SystemDrawer({
  system,
  doc,
  cards,
  config,
  onClose,
  onOpenCard,
  onSelectSystem,
  onOpenConnection,
}: SystemDrawerProps) {
  const refs = useSystemRefs(system.id, system.pointers);
  const docs = useSystemDocs(system.id, system.docs);
  const git = useRepoGit(system.pointers.length > 0 || system.docs.length > 0, system.id);
  const linksFor = refLinksFor(git);
  const tests = useSystemTests(system.id, system.pointers);
  const connections = useMemo(
    () => doc.connections.filter((c) => c.from === system.id || c.to === system.id),
    [doc.connections, system.id],
  );
  const backlinks = useMemo(() => backlinksFor(cards, system.pointers), [cards, system.pointers]);

  return (
    <aside className="drawer" role="dialog" aria-modal="false" data-testid="flow-drawer">
      <div className="drawer__bar">
        <span className="mono drawer__id">{system.id}</span>
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h2 className="drawer__title">{system.name}</h2>
      <p className="drawer__meta mono">
        {system.kind} · {system.layer} · {system.env.join('+')}
        {system.status !== 'live' ? ` · ${system.status}` : ''}
      </p>
      <div className="drawer__fields">
        <div className="field">
          <span className="field__label">runtime dev</span>
          <div className="field__row flow-runtime">
            <span className="mono field__static">{system.runtime.dev ?? '—'}</span>
            {system.runtime.dev ? (
              <CopyButton key={system.runtime.dev} text={system.runtime.dev} label="runtime dev" />
            ) : null}
          </div>
        </div>
        <div className="field">
          <span className="field__label">runtime prod</span>
          <div className="field__row flow-runtime">
            <span className="mono field__static">{system.runtime.prod ?? '—'}</span>
            {system.runtime.prod ? (
              <CopyButton
                key={system.runtime.prod}
                text={system.runtime.prod}
                label="runtime prod"
              />
            ) : null}
          </div>
        </div>
      </div>
      {system.why ? (
        <section className="drawer__section">
          <h3>Why</h3>
          <p>{system.why}</p>
        </section>
      ) : null}
      {system.status !== 'live' || system.unblockedBy.length > 0 ? (
        <section className="drawer__section" data-testid="flow-drawer-unblockers">
          <h3>Unblocked by ({system.unblockedBy.length})</h3>
          <UnblockerRows
            ids={system.unblockedBy}
            cards={cards}
            config={config}
            onOpenCard={onOpenCard}
          />
        </section>
      ) : null}
      <section className="drawer__section">
        <h3>Connections ({connections.length})</h3>
        {connections.length === 0 ? (
          <p className="rail__empty">No connections.</p>
        ) : (
          <ul className="drawer__files mono">
            {connections.map((c, i) => (
              <li key={`${c.from}-${c.to}-${i.toString()}`} data-connection={`${c.from}-${c.to}`}>
                <div>
                  {c.from === system.id ? (
                    <strong>{c.from}</strong>
                  ) : (
                    <SystemLink
                      id={c.from}
                      name={doc.systems.find((s) => s.id === c.from)?.name}
                      onSelect={() => onSelectSystem(c.from)}
                    />
                  )}{' '}
                  →{' '}
                  {c.to === system.id ? (
                    <strong>{c.to}</strong>
                  ) : (
                    <SystemLink
                      id={c.to}
                      name={doc.systems.find((s) => s.id === c.to)?.name}
                      onSelect={() => onSelectSystem(c.to)}
                    />
                  )}
                  {c.status !== 'live' ? ` · ${c.status}` : ''}
                </div>
                {c.via ? <span className="muted">via {c.via}</span> : null}
                {c.unblockedBy.length > 0 ? (
                  <UnblockerRows
                    ids={c.unblockedBy}
                    cards={cards}
                    config={config}
                    onOpenCard={onOpenCard}
                  />
                ) : null}
                <button
                  type="button"
                  className="flow-link flow-link--open"
                  onClick={() => onOpenConnection(c)}
                >
                  open connection{c.id === undefined ? '' : ` · ${c.id}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {system.docs.length > 0 ? (
        <section className="drawer__section" data-testid="flow-drawer-docs">
          <h3>Docs</h3>
          {docs.kind === 'loading' ? (
            <ul className="drawer__files mono muted">
              {system.docs.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : docs.kind === 'error' ? (
            <div className="drawer__ref drawer__ref--error" role="alert">
              <div className="drawer__ref-head mono">could not load docs</div>
              <div className="drawer__ref-error">{docs.message}</div>
            </div>
          ) : (
            <RefsList refs={docs.refs} collapsed linksFor={linksFor} />
          )}
        </section>
      ) : null}
      {system.pointers.length > 0 ? (
        <section className="drawer__section" data-testid="flow-drawer-refs">
          <h3>Pointers</h3>
          {refs.kind === 'loading' ? (
            <ul className="drawer__files mono muted">
              {system.pointers.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : refs.kind === 'error' ? (
            <div className="drawer__ref drawer__ref--error" role="alert">
              <div className="drawer__ref-head mono">could not load references</div>
              <div className="drawer__ref-error">{refs.message}</div>
            </div>
          ) : (
            <RefsList refs={refs.refs} collapsed linksFor={linksFor} />
          )}
        </section>
      ) : null}
      <section className="drawer__section" data-testid="flow-drawer-tests">
        <h3>Tests</h3>
        {tests.kind === 'loading' ? (
          <p className="mono muted">loading…</p>
        ) : tests.kind === 'error' ? (
          <div className="drawer__ref drawer__ref--error" role="alert">
            <div className="drawer__ref-head mono">could not load tests</div>
            <div className="drawer__ref-error">{tests.message}</div>
          </div>
        ) : tests.tests === null ? (
          <p className="mono">tests: n/a (no pointers)</p>
        ) : (
          <>
            <p className="mono">{tests.tests.line}</p>
            <p className="mono">{tests.tests.measured.line}</p>
            {tests.tests.pointers.some((p) => p.tests !== null) ? (
              <TestsToggle payload={tests.tests} />
            ) : null}
          </>
        )}
      </section>
      <section className="drawer__section" data-testid="flow-drawer-backlinks">
        <h3>Backlinks ({backlinks.length})</h3>
        {backlinks.length === 0 ? (
          <p className="rail__empty">No card references this system.</p>
        ) : (
          <ul className="drawer__files mono">
            {backlinks.map((c) => (
              <li key={c.id}>
                <button type="button" className="who__body" onClick={() => onOpenCard(c.id)}>
                  {c.id} — {c.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="drawer__provenance mono muted">
        owner: {system.owner ?? '—'} · {sourceText(system.source)}
      </p>
    </aside>
  );
}

interface ConnectionDrawerProps {
  conn: Connection;
  doc: SystemsDoc;
  cards: readonly Card[];
  config: BoardConfig | null;
  onClose: () => void;
  onOpenCard: (id: string) => void;
  onSelectSystem: (id: string) => void;
}

/** RCB-176: one connection row, the same drawer slot as a system's. Every field the row has —
 * `label`, `via`, `env`, `status`, `unblocked_by`, `source`, and `pointers` resolved live — and
 * its two ends as buttons that open those systems. A missing `label` / `via` reads `—`, never a
 * blank that could be mistaken for an empty string. */
function ConnectionDrawer({
  conn,
  doc,
  cards,
  config,
  onClose,
  onOpenCard,
  onSelectSystem,
}: ConnectionDrawerProps) {
  const refs = useConnectionRefs(conn);
  const pointers = conn.pointers ?? [];
  const git = useRepoGit(pointers.length > 0, `${conn.from}>${conn.to}#${conn.id ?? ''}`);
  const linksFor = refLinksFor(git);
  return (
    <aside className="drawer" role="dialog" aria-modal="false" data-testid="flow-conn-drawer">
      <div className="drawer__bar">
        <span className="mono drawer__id">
          connection{conn.id === undefined ? '' : ` · ${conn.id}`}
        </span>
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h2 className="drawer__title" data-testid="flow-conn-ends">
        <SystemLink
          id={conn.from}
          name={doc.systems.find((s) => s.id === conn.from)?.name}
          onSelect={() => onSelectSystem(conn.from)}
        />{' '}
        →{' '}
        <SystemLink
          id={conn.to}
          name={doc.systems.find((s) => s.id === conn.to)?.name}
          onSelect={() => onSelectSystem(conn.to)}
        />
      </h2>
      <div className="drawer__fields">
        <div className="field">
          <span className="field__label">label</span>
          <span className="mono field__static">{conn.label ?? '—'}</span>
        </div>
        <div className="field">
          <span className="field__label">via</span>
          <span className="mono field__static">{conn.via ?? '—'}</span>
        </div>
        <div className="field">
          <span className="field__label">env</span>
          <span className="mono field__static">{conn.env.join('+')}</span>
        </div>
        <div className="field">
          <span className="field__label">status</span>
          <span className="mono field__static">{conn.status}</span>
        </div>
      </div>
      {conn.status !== 'live' || conn.unblockedBy.length > 0 ? (
        <section className="drawer__section" data-testid="flow-conn-unblockers">
          <h3>Unblocked by ({conn.unblockedBy.length})</h3>
          <UnblockerRows
            ids={conn.unblockedBy}
            cards={cards}
            config={config}
            onOpenCard={onOpenCard}
          />
        </section>
      ) : null}
      {pointers.length > 0 ? (
        <section className="drawer__section" data-testid="flow-conn-refs">
          <h3>Pointers</h3>
          {refs.kind === 'loading' ? (
            <ul className="drawer__files mono muted">
              {pointers.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : refs.kind === 'error' ? (
            <div className="drawer__ref drawer__ref--error" role="alert">
              <div className="drawer__ref-head mono">could not load references</div>
              <div className="drawer__ref-error">{refs.message}</div>
            </div>
          ) : (
            <RefsList refs={refs.refs} collapsed linksFor={linksFor} />
          )}
        </section>
      ) : null}
      <p className="drawer__provenance mono muted">{sourceText(conn.source)}</p>
    </aside>
  );
}

/** RCB-180: the strip under the toolbar — what the map holds at a glance. Three labelled groups
 * with their counts (`flowOverview`, over the systems this env draws); each id is a button that
 * selects that box, exactly as clicking it does. An empty group reads `none`, never a blank. */
function OverviewStrip({
  overview,
  onSelect,
}: {
  overview: ReturnType<typeof flowOverview>;
  onSelect: (id: string) => void;
}) {
  const groups = [
    { key: 'data', label: 'Data stores', ids: overview.dataStores },
    { key: 'external', label: 'Externals', ids: overview.externals },
    { key: 'entry', label: 'Entry points', ids: overview.entryPoints },
  ];
  return (
    <div className="flow__strip" data-testid="flow-strip">
      {groups.map((g) => (
        <div key={g.key} className="flow__group" data-testid={`flow-group-${g.key}`}>
          <span className="flow__group-label">
            {g.label} ({g.ids.length})
          </span>
          {g.ids.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            g.ids.map((id) => (
              <button
                key={id}
                type="button"
                className="flow-link mono"
                onClick={() => onSelect(id)}
              >
                {id}
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

interface DiagramProps {
  doc: SystemsDoc;
  layout: SystemsLayout;
  selectedSystem: string | null;
  /** RCB-176: the connection whose drawer is open; its edge is drawn selected. */
  selectedConn: Connection | null;
  /** The box whose neighbourhood is lit; everything else dims. `null`: nothing focused. */
  focusId: string | null;
  /** RCB-180: the step of a path being walked. Its edge(s) and two boxes are lit and everything
   * else dims, whatever is focused. `null`: no walk. */
  hop: PathHop | null;
  /** The toolbar's filter text; `''` is inert (nothing dims). */
  filter: string;
  tf: Transform;
  /** This view's id (`nextFlowViewId`), the prefix of every id the diagram defines. */
  viewId: string;
  onSelect: (id: string) => void;
  onSelectConn: (conn: Connection) => void;
}

function Diagram({
  doc,
  layout,
  selectedSystem,
  selectedConn,
  focusId,
  hop,
  filter,
  tf,
  viewId,
  onSelect,
  onSelectConn,
}: DiagramProps) {
  const query = filter.trim().toLowerCase();
  // `null` = no filter: every box matches. Otherwise the ids whose id, name or kind contains the
  // text (case-insensitive) — the same three fields the toolbar's placeholder names.
  const matching = useMemo(() => {
    if (query === '') return null;
    const ids = new Set<string>();
    for (const s of doc.systems) {
      if ([s.id, s.name, s.kind].some((field) => field.toLowerCase().includes(query)))
        ids.add(s.id);
    }
    return ids;
  }, [doc, query]);
  // `null` = no focus. Otherwise the focused box and its direct neighbours in THIS env's layout
  // (a focus on a box the env switch just removed lights nothing and dims nothing). A path's step
  // (RCB-180) takes over: its two boxes are the lit set, and the edges follow below.
  const lit = useMemo(() => {
    if (hop !== null) return new Set<string>([hop.from, hop.to]);
    if (focusId === null || !layout.rows.some((r) => r.boxes.some((b) => b.id === focusId))) {
      return null;
    }
    const ids = new Set<string>([focusId]);
    for (const e of layout.edges) {
      if (e.from === focusId) ids.add(e.to);
      if (e.to === focusId) ids.add(e.from);
    }
    return ids;
  }, [layout, focusId, hop]);
  const focused = lit === null || hop !== null ? null : focusId;
  const markerBase = `${viewId}-arrow`;
  const { w: contentW, h: contentH } = flowContentSize(layout);
  const bands = rowBands(layout, contentH);
  // A connection with a reverse partner in this layout (A→B with B→A) is marked `data-two-way`.
  const routes = new Set(layout.edges.map((e) => `${e.from}>${e.to}`));
  // The row behind each edge (core emits one edge per visible row, in `doc.connections` order).
  const rows = useMemo(() => connectionsForEdges(doc, layout), [doc, layout]);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  return (
    <svg
      width="100%"
      height="100%"
      className="flow-svg"
      role="img"
      aria-label="Systems flow diagram"
      data-testid="flow-svg"
    >
      <title>Systems flow diagram</title>
      <defs>
        {EDGE_STYLES.map((style) => (
          <marker
            key={style}
            id={`${markerBase}-${style}`}
            className={`flow-arrow flow-arrow--${style}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={8}
            markerHeight={8}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0.5 0.8 L9 5 L0.5 9.2 z" />
          </marker>
        ))}
      </defs>
      <g data-testid="flow-viewport" transform={transformAttr(tf)}>
        {layout.rows.map((row, i) => {
          // Slots tile the diagram (see `rowBands`), so alternate ones read as bands. A <path>,
          // not a <rect>: the diagram's rects are its boxes, and a count of them is how the tests
          // tell how many systems are on show.
          const { top, bottom } = bands[i] ?? { top: 0, bottom: contentH };
          return (
            <path
              key={row.layer}
              d={`M0 ${top} H${contentW} V${bottom} H0 Z`}
              className={`flow-band${i % 2 === 1 ? ' flow-band--alt' : ''}`}
              data-band={row.layer}
            />
          );
        })}
        {layout.rows.map((row) => {
          const rowY = row.boxes[0]?.y ?? 0;
          const at = px(0, rowY);
          return (
            <text key={row.layer} x={PAD} y={at.y + SCALE_Y / 2} className="flow-row-label mono">
              {row.layer}
            </text>
          );
        })}
        {layout.edges.map((e, i) => {
          // Core routes every edge on ports and lanes of its own (RCB-179): a two-way pair and the
          // rows of one pair come out as separate lines, so each is drawn exactly where core put it.
          const drawn = e.points.map((p) => {
            const at = px(p.x, p.y);
            return { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 };
          });
          const twoWay = e.from !== e.to && routes.has(`${e.to}>${e.from}`);
          const notLive = e.status !== 'live';
          // The walked step's own edge(s) — every parallel row of the pair — are lit (RCB-180).
          const onHop = hop !== null && e.from === hop.from && e.to === hop.to;
          // An edge stays lit only when BOTH ends match the filter, and (with a focus) only when
          // it runs to or from the focused box; during a walk, only when it is the step's own.
          const dim =
            (matching !== null && !(matching.has(e.from) && matching.has(e.to))) ||
            (hop !== null && !onHop) ||
            (focused !== null && e.from !== focused && e.to !== focused);
          const conn = rows[i];
          const selected = conn !== undefined && conn === selectedConn;
          const label = conn?.label;
          const mid = label ? polylineMidpoint(drawn) : null;
          const name = `${e.from} → ${e.to}`;
          return (
            <Fragment key={`${e.from}-${e.to}-${i.toString()}`}>
              <polyline
                points={drawn.map((p) => `${p.x},${p.y}`).join(' ')}
                className={`flow-edge${notLive ? ` flow-edge--${e.status}` : ''}${dim ? ' flow-edge--dim' : ''}${onHop ? ' flow-edge--hop' : ''}${hoverEdge === i ? ' flow-edge--hover' : ''}${selected ? ' flow-edge--selected' : ''}`}
                data-edge={`${e.from}-${e.to}`}
                data-dashed={e.dashed}
                data-status={notLive ? e.status : undefined}
                data-two-way={twoWay ? 'true' : undefined}
                strokeDasharray={notLive ? '1 4' : e.dashed ? '4 3' : undefined}
                markerEnd={`url(#${markerBase}-${edgeStyle(e)})`}
              />
              {conn !== undefined ? (
                // biome-ignore lint/a11y/noStaticElementInteractions: SVG node, like the boxes; the connection list in each end's drawer is the keyboard path to the same drawer
                <path
                  d={`M${drawn.map((p) => `${p.x},${p.y}`).join(' L')}`}
                  className="flow-edge__hit"
                  data-edge-hit={`${e.from}-${e.to}`}
                  data-edge-id={conn.id}
                  strokeWidth={EDGE_HIT_W}
                  onMouseEnter={() => setHoverEdge(i)}
                  onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
                  onClick={() => onSelectConn(conn)}
                >
                  <title>{label ? `${name} — ${label}` : name}</title>
                </path>
              ) : null}
              {mid !== null && label ? (
                <text
                  x={Math.round(mid.x * 100) / 100}
                  y={Math.round(mid.y * 100) / 100}
                  textAnchor="middle"
                  className={`flow-edge__label${dim ? ' flow-edge__label--dim' : ''}`}
                  data-edge-label={`${e.from}-${e.to}`}
                >
                  {fitText(label, EDGE_LABEL_FONT_PX, false, EDGE_LABEL_MAX_W)}
                </text>
              ) : null}
            </Fragment>
          );
        })}
        {layout.rows
          .flatMap((row) => row.boxes)
          .map((box) => {
            const at = px(box.x, box.y);
            const system = doc.systems.find((s) => s.id === box.id);
            const name = system?.name ?? box.id;
            const kind = system?.kind;
            const selected = selectedSystem === box.id;
            const notLive = box.status !== 'live';
            const dim =
              (matching !== null && !matching.has(box.id)) || (lit !== null && !lit.has(box.id));
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: SVG node; the drawer's close button is the keyboard path back out
              <g
                key={box.id}
                className={`flow-box ${selected ? 'flow-box--selected' : ''}${notLive ? ` flow-box--${box.status}` : ''}${dim ? ' flow-box--dim' : ''}${hop !== null && (box.id === hop.from || box.id === hop.to) ? ' flow-box--hop' : ''}`}
                data-box={box.id}
                data-kind={kind}
                data-status={notLive ? box.status : undefined}
                onClick={() => onSelect(box.id)}
              >
                <title>{`${box.id} — ${name}`}</title>
                <rect
                  x={at.x}
                  y={at.y}
                  width={SCALE_X}
                  height={SCALE_Y}
                  rx={6}
                  data-dashed={box.dashed}
                  strokeDasharray={notLive ? '1 4' : box.dashed ? '4 3' : undefined}
                />
                <text x={at.x + TEXT_PAD} y={at.y + 18} className="flow-box__id mono">
                  {fitText(box.id, ID_FONT_PX, true, ID_MAX_W)}
                </text>
                <text x={at.x + TEXT_PAD} y={at.y + 34} className="flow-box__name">
                  {fitText(name, NAME_FONT_PX, false, NAME_MAX_W)}
                </text>
                {kind ? (
                  <>
                    <KindGlyph
                      kind={kind}
                      x={at.x + SCALE_X - TEXT_PAD - GLYPH_SIZE}
                      y={at.y + 6}
                    />
                    <text
                      x={at.x + TEXT_PAD}
                      y={at.y + SCALE_Y - 8}
                      className={`flow-box__kind mono flow-fam--${KIND_META[kind].family}`}
                    >
                      {kind}
                    </text>
                  </>
                ) : null}
                {notLive ? (
                  <text
                    x={at.x + SCALE_X / 2}
                    y={at.y + SCALE_Y - 8}
                    textAnchor="middle"
                    className="flow-box__badge mono"
                  >
                    {box.status}
                  </text>
                ) : null}
                <text
                  x={at.x + SCALE_X - TEXT_PAD}
                  y={at.y + SCALE_Y - 8}
                  textAnchor="end"
                  className="flow-box__env mono muted"
                >
                  {system ? system.env.join('+') : ''}
                </text>
              </g>
            );
          })}
      </g>
    </svg>
  );
}

/** RCB-111: the confirm's `<repoName>` — `state.repos`' entry for `repoKey ?? repos.primary`,
 * or `'this'` when repos have not loaded yet (mirrors the rest of the store's "absent means
 * inert, never a crash" reasoning). */
function planRepoName(repos: State['repos'], repoKey: State['repoKey']): string {
  if (!repos) return 'this';
  const key = repoKey ?? repos.primary;
  return repos.repos.find((r) => r.key === key)?.name ?? 'this';
}

export function FlowView() {
  const store = useStore();
  const { systems, flowEnv, cards, hasBoard, repos, repoKey, config } = useBoardState();
  // RCB-176: what is open in the drawer — a system or a connection, never both. Read once from the
  // URL on mount (`flow-url.ts`); an id that names nothing opens nothing (and is written out of
  // the URL again once the doc is known).
  const [fromUrl] = useState(readFlowUrl);
  const [selection, setSelection] = useState<FlowSelection | null>(fromUrl);
  // Which box is dimming its non-neighbours. Set with a SYSTEM selection, but cleared on its own by
  // a background click / Esc, which leave the drawer open (and closing the drawer clears both).
  const [focusId, setFocusId] = useState<string | null>(
    fromUrl?.kind === 'system' ? fromUrl.id : null,
  );
  const [filter, setFilter] = useState('');
  // RCB-180: the path being walked (by name) and its step. Which path is a name, not an index, so
  // a live `systems.yml` edit that reorders `paths:` does not switch the walk to another route.
  const [pathName, setPathName] = useState<string | null>(null);
  const [pathStep, setPathStep] = useState(0);
  const [legendOpen, setLegendOpen] = useState(false);
  const [viewId] = useState(nextFlowViewId);
  const legendId = `${viewId}-legend`;
  const [planConfirming, setPlanConfirming] = useState(false);
  const [planPending, setPlanPending] = useState(false);

  const doc = systems?.doc ?? null;
  const layout = useMemo(() => (doc ? layoutSystems(doc, flowEnv) : null), [doc, flowEnv]);
  // A `none` environment shows its note in place of the diagram (no canvas, no toolbar).
  const noneNote = layout && flowEnv !== 'both' ? layout.none[flowEnv] : undefined;
  const content = useMemo(
    () => (layout && noneNote === undefined ? flowContentSize(layout) : null),
    [layout, noneNote],
  );
  // The legend lists the kinds of the boxes on show, never the whole vocabulary.
  const legendKinds = useMemo(() => {
    if (!doc || !layout) return [];
    const onShow = new Set(layout.rows.flatMap((r) => r.boxes.map((b) => b.id)));
    const kinds: SystemKind[] = doc.systems
      .filter((sys) => onShow.has(sys.id))
      .map((sys) => sys.kind);
    return kindsPresent(kinds);
  }, [doc, layout]);
  const envNote = layout ? envNoteLine(layout.notes, flowEnv) : null;
  // RCB-180: the strip's three groups, over the systems this env draws.
  const overview = useMemo(
    () => (doc && content ? flowOverview(doc, flowEnv) : null),
    [doc, flowEnv, content],
  );
  // The walk in progress: `null` when none is chosen, or when the path named is gone or (in this
  // env) has a hop that is not drawn. The step is clamped, so a live edit that shortens the path
  // cannot leave it past its end.
  const walk = useMemo(() => {
    if (pathName === null || layout === null || content === null) return null;
    const path = doc?.paths?.find((p) => p.name === pathName);
    if (path === undefined || !pathDrawn(path, layout)) return null;
    const steps = pathSteps(path);
    const step = Math.min(pathStep, steps.length - 1);
    const hop = steps[step];
    return hop === undefined ? null : { name: path.name, count: steps.length, step, hop };
  }, [doc, layout, content, pathName, pathStep]);
  // A walk the env switch (or an edit) has broken ends; it does not lie in wait to resume.
  useEffect(() => {
    if (pathName !== null && walk === null) setPathName(null);
  }, [pathName, walk]);
  const pz = usePanZoom(content, flowEnv);
  const { reveal } = pz;
  const selectedSystem = selection?.kind === 'system' ? selection.id : null;
  const selected = doc?.systems.find((s) => s.id === selectedSystem) ?? null;
  const selectedConn =
    selection?.kind === 'conn' && doc ? (findConnection(doc, selection) ?? null) : null;
  // What the drawer is actually showing (an unknown id is nothing), as the URL and the reveal key.
  const shown: FlowSelection | null =
    selected !== null
      ? { kind: 'system', id: selected.id }
      : selectedConn !== null
        ? {
            kind: 'conn',
            from: selectedConn.from,
            to: selectedConn.to,
            id: selectedConn.id ?? null,
          }
        : null;
  const shownKey =
    shown === null
      ? ''
      : shown.kind === 'system'
        ? `s:${shown.id}`
        : `c:${shown.from},${shown.to},${shown.id ?? ''}`;
  const urlReady = systems !== null;

  // RCB-176: the address bar follows the drawer — `view=flow` while this view is open, plus
  // `system=` / `conn=` for what is selected, and none of the three once the view is left. Not
  // before the first snapshot: until the doc is known a URL selection cannot be told from a stale
  // one, and writing `null` then would erase the very link that opened this view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shownKey` is `shown`'s identity
  useEffect(() => {
    if (urlReady) writeFlowUrl(shown);
  }, [urlReady, shownKey]);
  useEffect(() => clearFlowUrl, []);

  // A selected box hidden by the (just narrowed) canvas or by the current pan is panned into
  // view; so is a selected connection's route. On selection change only: a live systems.yml edit
  // must not yank the reader's view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shownKey` is the trigger, by design
  useLayoutEffect(() => {
    if (shown === null || layout === null || doc === null) return;
    if (shown.kind === 'system') {
      const box = layout.rows.flatMap((r) => r.boxes).find((b) => b.id === shown.id);
      if (!box) return;
      const at = px(box.x, box.y);
      reveal({ x: at.x, y: at.y, w: SCALE_X, h: SCALE_Y });
      return;
    }
    const rows = connectionsForEdges(doc, layout);
    const edge = layout.edges.find((_, i) => rows[i] === selectedConn);
    if (!edge) return;
    const pts = edge.points.map((p) => px(p.x, p.y));
    const left = Math.min(...pts.map((p) => p.x)) - EDGE_HIT_W;
    const top = Math.min(...pts.map((p) => p.y)) - EDGE_HIT_W;
    reveal({
      x: left,
      y: top,
      w: Math.max(...pts.map((p) => p.x)) + EDGE_HIT_W - left,
      h: Math.max(...pts.map((p) => p.y)) + EDGE_HIT_W - top,
    });
  }, [shownKey]);

  // Each step of a walk pans, minimally, to show its two boxes and its edge(s). On step change
  // only, like the selection reveal above.
  const walkKey = walk === null ? '' : `${walk.name}:${walk.step}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `walkKey` is the trigger, by design
  useLayoutEffect(() => {
    if (walk === null || layout === null) return;
    const rect = hopRect(layout, walk.hop);
    if (rect !== null) reveal(rect);
  }, [walkKey]);

  // A box picked from the diagram or from a drawer's link: opens that system and focuses it.
  const selectSystem = (id: string) => {
    setSelection({ kind: 'system', id });
    setFocusId(id);
  };
  const closeDrawer = () => {
    setSelection(null);
    setFocusId(null);
  };
  const openCard = (id: string) => {
    store.select(id);
    store.setView('board');
  };
  const endWalk = () => setPathName(null);
  const choosePath = (name: string) => {
    setPathName(name === '' ? null : name);
    setPathStep(0);
  };
  // Esc on the select or a step button ends the walk (on the canvas it does, below).
  const onPathKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && walk !== null) endWalk();
  };
  // A connection has no box to focus on: whatever was focused is let go.
  const selectConnection = (conn: Connection) => {
    setSelection({ kind: 'conn', from: conn.from, to: conn.to, id: conn.id ?? null });
    setFocusId(null);
  };

  if (systems === null) {
    return (
      <div className="map-empty" data-testid="flow">
        <p>Loading…</p>
      </div>
    );
  }

  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f') {
      e.preventDefault();
      pz.fit();
    } else if (e.key === '0') {
      e.preventDefault();
      pz.actual();
    } else if (e.key === 'Escape') {
      // One Esc ends a walk; the next one lets go of the focus, as it always did.
      if (walk !== null) endWalk();
      else setFocusId(null);
    }
  };
  // A click that reached the canvas without landing on a box: the background. (A drag's click is
  // swallowed by `usePanZoom` before it gets here.)
  const onCanvasClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!(e.target instanceof Element) || e.target.closest('[data-box]') === null) {
      setFocusId(null);
    }
  };

  return (
    <div className={`flow${shown !== null ? ' flow--drawer' : ''}`} data-testid="flow">
      <div className="flow__bar map__bar">
        <div className="flow__env">
          <fieldset className="seg">
            <legend className="sr-only">Environment</legend>
            {ENVS.map((e) => {
              const note =
                e !== 'both' && doc && 'none' in doc.environments[e]
                  ? doc.environments[e].none
                  : undefined;
              return (
                <button
                  key={e}
                  type="button"
                  className={`seg__btn ${flowEnv === e ? 'seg__btn--on' : ''}`}
                  aria-pressed={flowEnv === e}
                  title={note}
                  onClick={() => store.setFlowEnv(e)}
                >
                  {e}
                </button>
              );
            })}
          </fieldset>
          {content && envNote !== null ? (
            <p className="flow__envnote muted" data-testid="flow-envnote" title={envNote}>
              {envNote}
            </p>
          ) : null}
        </div>
        {content ? (
          <>
            <fieldset className="seg">
              <legend className="sr-only">Zoom</legend>
              <button type="button" className="seg__btn" title="Fit all (f)" onClick={pz.fit}>
                Fit
              </button>
              <button
                type="button"
                className="seg__btn"
                title="Actual size (0)"
                onClick={pz.actual}
              >
                100%
              </button>
              <button
                type="button"
                className="seg__btn"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={pz.zoomOut}
              >
                −
              </button>
              <button
                type="button"
                className="seg__btn"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={pz.zoomIn}
              >
                +
              </button>
            </fieldset>
            <input
              type="search"
              className="flow__filter"
              placeholder="Filter: id, name, kind"
              aria-label="Filter systems"
              data-testid="flow-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFilter('');
              }}
            />
            {(doc?.paths ?? []).length > 0 ? (
              <div className="flow__paths">
                <label className="flow__paths-pick">
                  <span>Paths</span>
                  <select
                    className="flow__select"
                    data-testid="flow-paths"
                    value={walk?.name ?? ''}
                    onChange={(e) => choosePath(e.target.value)}
                    onKeyDown={onPathKeyDown}
                  >
                    <option value="">none</option>
                    {(doc?.paths ?? []).map((p) => {
                      const drawn = layout !== null && pathDrawn(p, layout);
                      return (
                        <option key={p.name} value={p.name} disabled={!drawn}>
                          {drawn ? p.name : `${p.name} (not in ${flowEnv})`}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {walk !== null ? (
                  <>
                    <div className="seg">
                      <button
                        type="button"
                        className="seg__btn"
                        disabled={walk.step === 0}
                        onClick={() => setPathStep(walk.step - 1)}
                        onKeyDown={onPathKeyDown}
                      >
                        Prev
                      </button>
                      <span className="flow__step" data-testid="flow-path-step">
                        Step {walk.step + 1} of {walk.count}
                      </span>
                      <button
                        type="button"
                        className="seg__btn"
                        disabled={walk.step === walk.count - 1}
                        onClick={() => setPathStep(walk.step + 1)}
                        onKeyDown={onPathKeyDown}
                      >
                        Next
                      </button>
                    </div>
                    <span className="mono" data-testid="flow-path-hop">
                      {walk.hop.from} → {walk.hop.to}
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            {legendKinds.length > 0 ? (
              <div className="seg">
                <button
                  type="button"
                  className={`seg__btn ${legendOpen ? 'seg__btn--on' : ''}`}
                  aria-expanded={legendOpen}
                  aria-controls={legendOpen ? legendId : undefined}
                  title="What the glyphs and colours mean"
                  onClick={() => setLegendOpen((o) => !o)}
                >
                  Legend
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        {overview !== null ? <OverviewStrip overview={overview} onSelect={selectSystem} /> : null}
      </div>
      <div className="flow__canvas">
        {!systems.exists ? (
          <>
            <p className="flow-note" data-testid="flow-no-file">
              {systemsSummary(null, []).line}
            </p>
            {hasBoard ? (
              planConfirming ? (
                <div data-testid="flow-plan-confirm">
                  <p className="muted">
                    {`Create 4 cards on the ${planRepoName(repos, repoKey)} board: a parent and three steps (detect → hand-correct → connect)?`}
                  </p>
                  <button
                    type="button"
                    className="toggle"
                    disabled={planPending}
                    onClick={() => {
                      setPlanPending(true);
                      void store.planSystemsMap().finally(() => setPlanPending(false));
                    }}
                  >
                    Create 4 cards
                  </button>
                  <button type="button" className="toggle" onClick={() => setPlanConfirming(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="toggle"
                  data-testid="flow-plan"
                  onClick={() => setPlanConfirming(true)}
                >
                  Plan the systems map
                </button>
              )
            ) : null}
          </>
        ) : doc === null ? (
          <div className="flow-errors" data-testid="flow-errors">
            {systems.errors.map((e) => (
              <pre key={e}>{e}</pre>
            ))}
          </div>
        ) : layout === null ? null : noneNote !== undefined ? (
          <p className="flow-note">{noneNote}</p>
        ) : (
          <>
            <div
              ref={pz.ref}
              className="flow-pan"
              role="application"
              aria-label="Systems flow canvas — f fits, 0 is 100%, Esc ends a path walk or clears focus"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the pan/zoom surface is the ARIA `application` pattern; it must take focus for f / 0 / Esc
              tabIndex={0}
              data-testid="flow-canvas"
              onKeyDown={onCanvasKeyDown}
              onClick={onCanvasClick}
            >
              <Diagram
                doc={doc}
                layout={layout}
                selectedSystem={selectedSystem}
                selectedConn={selectedConn}
                focusId={focusId}
                hop={walk?.hop ?? null}
                filter={filter}
                tf={pz.tf}
                viewId={viewId}
                onSelect={selectSystem}
                onSelectConn={selectConnection}
              />
            </div>
            {legendOpen && legendKinds.length > 0 ? (
              <FlowLegend id={legendId} kinds={legendKinds} />
            ) : null}
          </>
        )}
      </div>
      {selected && doc ? (
        <SystemDrawer
          system={selected}
          doc={doc}
          cards={cards}
          config={config}
          onClose={closeDrawer}
          onOpenCard={openCard}
          onSelectSystem={selectSystem}
          onOpenConnection={selectConnection}
        />
      ) : selectedConn && doc ? (
        <ConnectionDrawer
          key={shownKey}
          conn={selectedConn}
          doc={doc}
          cards={cards}
          config={config}
          onClose={closeDrawer}
          onOpenCard={openCard}
          onSelectSystem={selectSystem}
        />
      ) : null}
    </div>
  );
}
