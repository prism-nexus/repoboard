/**
 * RCB-95 (plan docs/SYSTEMS-FLOW-PLAN.md §3.1, §3.4): the `systems.yml` model — types, a pure
 * YAML+zod parser/validator, and a pure layered layout. Detectors, surfaces, and the Flow view
 * (PH.2-PH.4) all read this one module; core never reads a file (§3.5: no I/O here).
 *
 * Parse pipeline mirrors board.ts: YAML (`schema: 'core'`) -> zod (`z.looseObject`, structural
 * shape + defaults) -> semantic checks (unknown kind/layer, duplicate id, dangling connection,
 * env subset) that collect EVERY error, not just the first, each naming its row.
 */
import * as YAML from 'yaml';
import { z } from 'zod';

/** Diagram row membership. Order here is NOT significant (§3.1 list order); `SYSTEM_LAYERS`
 * below is the one place the diagram's row ORDER lives. */
export const SYSTEM_KINDS = [
  'client',
  'service',
  'worker',
  'job',
  'db',
  'cache',
  'queue',
  'storage',
  'auth',
  'email',
  'ci',
  'external',
  'tool',
] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

/** THE one place the Flow view's row order lives (§3.4): client, edge, app, data, external, ops. */
export const SYSTEM_LAYERS = ['client', 'edge', 'app', 'data', 'external', 'ops'] as const;
export type SystemLayer = (typeof SYSTEM_LAYERS)[number];

export const SYSTEM_ENVS = ['dev', 'prod'] as const;
export type SystemEnv = (typeof SYSTEM_ENVS)[number];

/** §3.1: half the CLAUDE.md budget; `board.yml` may raise it (not read here — core has no I/O). */
export const DEFAULT_SYSTEMS_BUDGET_BYTES = 4096;

/** Provenance on every row (CLAUDE.md conventions): hand or detected, never both. */
export type Source = { detected: string; at: string } | { hand: string; at: string };

/** `{note}` = has a story (possibly no note yet, `null`); `{none}` = no story by design. */
export type Environment = { note: string | null } | { none: string };

export interface SystemRow {
  id: string;
  name: string;
  kind: SystemKind;
  layer: SystemLayer;
  env: SystemEnv[];
  runtime: { dev?: string | null; prod?: string | null };
  owner: string | null;
  pointers: string[];
  docs: string[];
  why: string | null;
  source: Source;
}

export interface Connection {
  from: string;
  to: string;
  via: string | null;
  env: SystemEnv[];
  source: Source;
}

export interface SystemsDoc {
  environments: { dev: Environment; prod: Environment };
  systems: SystemRow[];
  connections: Connection[];
}

/** `.repoboard/systems.yml` id shape (§3.1): lower-case, digits, hyphens. */
const ID_RE = /^[a-z0-9-]+$/;

const SourceInputSchema = z
  .looseObject({
    detected: z.string().optional(),
    hand: z.string().optional(),
    at: z.string(),
  })
  .refine((s) => (s.detected !== undefined) !== (s.hand !== undefined), {
    message: 'source must have exactly one of "detected" or "hand"',
  });

const RuntimeInputSchema = z.looseObject({
  dev: z.string().nullable().optional(),
  prod: z.string().nullable().optional(),
});

const SystemRowInputSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  layer: z.string(),
  env: z.array(z.string()),
  runtime: RuntimeInputSchema.default(() => ({})),
  owner: z.string().nullable().default(null),
  pointers: z.array(z.string()).default(() => []),
  docs: z.array(z.string()).default(() => []),
  why: z.string().nullable().default(null),
  source: SourceInputSchema,
});

const ConnectionInputSchema = z.looseObject({
  from: z.string().min(1),
  to: z.string().min(1),
  via: z.string().nullable().default(null),
  env: z.array(z.string()),
  source: SourceInputSchema,
});

const EnvironmentInputSchema = z.looseObject({
  note: z.string().nullable().optional(),
  none: z.string().nullable().optional(),
});

const EnvironmentsInputSchema = z.looseObject({
  dev: EnvironmentInputSchema,
  prod: EnvironmentInputSchema,
});

/** `environments` is REQUIRED with both keys (§3.1); `systems`/`connections` default to `[]` —
 * an empty file body still yields a valid, empty doc once `environments` is given. */
const SystemsDocInputSchema = z.looseObject({
  environments: EnvironmentsInputSchema,
  systems: z.array(SystemRowInputSchema).default(() => []),
  connections: z.array(ConnectionInputSchema).default(() => []),
});

type RawSystemsDoc = z.infer<typeof SystemsDocInputSchema>;
type RawSource = z.infer<typeof SourceInputSchema>;
type RawEnvironment = z.infer<typeof EnvironmentInputSchema>;

export type SystemsParseResult = { ok: true; doc: SystemsDoc } | { ok: false; errors: string[] };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function isValidEnvList(env: readonly string[]): env is SystemEnv[] {
  return env.length > 0 && env.every((e) => (SYSTEM_ENVS as readonly string[]).includes(e));
}

/**
 * Every semantic rule §3.1 asks for, collected — not first-only — each naming its row by index,
 * in row order (systems in array order, then connections in array order).
 */
function validateSemantics(raw: RawSystemsDoc): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const knownIds = new Set(raw.systems.map((s) => s.id));

  raw.systems.forEach((row, i) => {
    const label = `systems[${i}] (id "${row.id}")`;
    if (!ID_RE.test(row.id)) {
      errors.push(`${label}: invalid id "${row.id}" (must match ${ID_RE.source})`);
    }
    if (!(SYSTEM_KINDS as readonly string[]).includes(row.kind)) {
      errors.push(`${label}: unknown kind "${row.kind}"`);
    }
    if (!(SYSTEM_LAYERS as readonly string[]).includes(row.layer)) {
      errors.push(`${label}: unknown layer "${row.layer}"`);
    }
    if (seenIds.has(row.id)) {
      errors.push(`systems[${i}]: duplicate id "${row.id}"`);
    }
    seenIds.add(row.id);
    if (!isValidEnvList(row.env)) {
      errors.push(`${label}: env must be a non-empty subset of dev, prod`);
    }
  });

  raw.connections.forEach((conn, i) => {
    if (!knownIds.has(conn.from)) {
      // Worded to avoid the literal `from"` substring: the purity scanner's specifier regex
      // (packages/core/test/purity.test.ts) treats a bare `from` followed by a quote as an
      // import, and a validation-error string is not an import.
      errors.push(`connections[${i}]: source system "${conn.from}" is unknown`);
    }
    if (!knownIds.has(conn.to)) {
      errors.push(`connections[${i}]: "to" names unknown system "${conn.to}"`);
    }
    if (!isValidEnvList(conn.env)) {
      errors.push(`connections[${i}]: env must be a non-empty subset of dev, prod`);
    }
  });

  return errors;
}

function toSource(raw: RawSource): Source {
  if (raw.detected !== undefined) return { detected: raw.detected, at: raw.at };
  return { hand: raw.hand as string, at: raw.at };
}

function toEnvironment(raw: RawEnvironment): Environment {
  if (raw.none) return { none: raw.none };
  return { note: raw.note ?? null };
}

function toSystemsDoc(raw: RawSystemsDoc): SystemsDoc {
  return {
    environments: {
      dev: toEnvironment(raw.environments.dev),
      prod: toEnvironment(raw.environments.prod),
    },
    systems: raw.systems.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as SystemKind,
      layer: row.layer as SystemLayer,
      env: row.env as SystemEnv[],
      runtime: { dev: row.runtime.dev ?? null, prod: row.runtime.prod ?? null },
      owner: row.owner,
      pointers: row.pointers,
      docs: row.docs,
      why: row.why,
      source: toSource(row.source),
    })),
    connections: raw.connections.map((conn) => ({
      from: conn.from,
      to: conn.to,
      via: conn.via,
      env: conn.env as SystemEnv[],
      source: toSource(conn.source),
    })),
  };
}

/** Parse `.repoboard/systems.yml`. Never throws; core never reads the file itself. */
export function parseSystems(text: string): SystemsParseResult {
  let data: unknown;
  try {
    data = YAML.parse(text, { schema: 'core' });
  } catch (e) {
    return { ok: false, errors: [`systems.yml is not valid YAML: ${(e as Error).message}`] };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['systems.yml must be a YAML mapping'] };
  }
  const result = SystemsDocInputSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map(formatIssue) };
  }
  const errors = validateSemantics(result.data);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: toSystemsDoc(result.data) };
}

/** What "no systems.yml yet" renders from (§3.1: unconfigured is inert, not dangerous). */
export function emptySystemsDoc(): SystemsDoc {
  return {
    environments: { dev: { note: null }, prod: { note: null } },
    systems: [],
    connections: [],
  };
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBox {
  id: string;
  layer: SystemLayer;
  x: number;
  y: number;
  w: number;
  h: number;
  dashed: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  dashed: boolean;
  via: string | null;
  points: LayoutPoint[];
}

export interface LayoutRow {
  layer: SystemLayer;
  boxes: LayoutBox[];
}

export interface SystemsLayout {
  env: 'dev' | 'prod' | 'both';
  rows: LayoutRow[];
  edges: LayoutEdge[];
  notes: { dev: string | null; prod: string | null };
  none: { dev?: string; prod?: string };
  width: number;
  height: number;
}

/**
 * Stable topological sort: `baseOrder` (already id-ascending) is the tie-break and the fallback
 * for any node a cycle keeps at nonzero in-degree forever — a row is drawn either way, never
 * hangs. `edges` are `[from, to]` pairs meaning "from before to", restricted by the caller to
 * pairs whose both ends are in `baseOrder`.
 */
function stableTopoSort(
  baseOrder: readonly string[],
  edges: readonly (readonly [string, string])[],
): string[] {
  const indexOf = new Map(baseOrder.map((id, i) => [id, i]));
  const indegree = new Map(baseOrder.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(baseOrder.map((id) => [id, []]));
  for (const [from, to] of edges) {
    if (from === to) continue;
    adjacency.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const remaining = new Set(baseOrder);
  const result: string[] = [];
  const byBaseOrder = (a: string, b: string) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0).sort(byBaseOrder);
    const pick = ready[0] ?? [...remaining].sort(byBaseOrder)[0];
    if (pick === undefined) break;
    result.push(pick);
    remaining.delete(pick);
    for (const next of adjacency.get(pick) ?? []) {
      if (remaining.has(next)) indegree.set(next, (indegree.get(next) ?? 0) - 1);
    }
  }
  return result;
}

/** Three-segment orthogonal path between two boxes' centres (§3.4), elbow at the midpoint y. */
function edgePoints(from: LayoutBox, to: LayoutBox): LayoutPoint[] {
  const x1 = from.x + from.w / 2;
  const x2 = to.x + to.w / 2;
  if (from.y === to.y) {
    const midY = from.y + from.h + 0.5;
    return [
      { x: x1, y: from.y + from.h },
      { x: x1, y: midY },
      { x: x2, y: midY },
      { x: x2, y: to.y + to.h },
    ];
  }
  const targetAbove = to.y < from.y;
  const y1 = targetAbove ? from.y : from.y + from.h;
  const y2 = targetAbove ? to.y + to.h : to.y;
  const midY = (y1 + y2) / 2;
  return [
    { x: x1, y: y1 },
    { x: x1, y: midY },
    { x: x2, y: midY },
    { x: x2, y: y2 },
  ];
}

/**
 * Pure layered layout (§3.4), no library. `both` shows every system/connection; `dev`/`prod`
 * shows only rows/edges tagged with that env, and a `none` environment for that exact view
 * short-circuits to an empty diagram (the view prints the note instead). Deterministic: the same
 * doc + env give byte-identical JSON, because every ordering choice here is by id or by an
 * explicit edge, never by object identity or insertion order of a Set/Map over unsorted input.
 */
export function layoutSystems(doc: SystemsDoc, env: 'dev' | 'prod' | 'both'): SystemsLayout {
  const notes = {
    dev: 'note' in doc.environments.dev ? doc.environments.dev.note : null,
    prod: 'note' in doc.environments.prod ? doc.environments.prod.note : null,
  };
  const none: { dev?: string; prod?: string } = {};
  if ('none' in doc.environments.dev) none.dev = doc.environments.dev.none;
  if ('none' in doc.environments.prod) none.prod = doc.environments.prod.none;

  if (env !== 'both' && 'none' in doc.environments[env]) {
    return { env, rows: [], edges: [], notes, none, width: 0, height: 0 };
  }

  // A row/edge is dashed only when BOTH environments have a story to compare against (neither is
  // `none`) — otherwise "both" degenerates to the one env that exists, and nothing is one-of-two.
  const bothEnvsShown = none.dev === undefined && none.prod === undefined;

  const visibleIds = new Set(
    env === 'both'
      ? doc.systems.map((s) => s.id)
      : doc.systems.filter((s) => s.env.includes(env)).map((s) => s.id),
  );
  const visibleSystems = doc.systems.filter((s) => visibleIds.has(s.id));
  const visibleConnections = doc.connections.filter(
    (c) =>
      visibleIds.has(c.from) && visibleIds.has(c.to) && (env === 'both' || c.env.includes(env)),
  );

  const byLayer = new Map<SystemLayer, SystemRow[]>();
  for (const s of visibleSystems) {
    const arr = byLayer.get(s.layer);
    if (arr) arr.push(s);
    else byLayer.set(s.layer, [s]);
  }

  const rows: LayoutRow[] = [];
  const boxOf = new Map<string, LayoutBox>();

  for (const layer of SYSTEM_LAYERS) {
    const systemsInLayer = byLayer.get(layer);
    if (!systemsInLayer || systemsInLayer.length === 0) continue;
    const rowIndex = rows.length;
    const byId = new Map(systemsInLayer.map((s) => [s.id, s]));
    const ids = [...byId.keys()].sort((a, b) => a.localeCompare(b, 'en'));
    const idSet = new Set(ids);
    const withinRowEdges: (readonly [string, string])[] = visibleConnections
      .filter((c) => idSet.has(c.from) && idSet.has(c.to))
      .map((c) => [c.from, c.to] as const);
    const ordered = stableTopoSort(ids, withinRowEdges);
    const boxes: LayoutBox[] = ordered.map((id, col) => {
      const system = byId.get(id);
      const box: LayoutBox = {
        id,
        layer,
        x: col * 1.5,
        y: rowIndex * 2,
        w: 1,
        h: 1,
        dashed: env === 'both' && bothEnvsShown && (system?.env.length ?? 0) === 1,
      };
      boxOf.set(id, box);
      return box;
    });
    rows.push({ layer, boxes });
  }

  const edges: LayoutEdge[] = visibleConnections.flatMap((c) => {
    const from = boxOf.get(c.from);
    const to = boxOf.get(c.to);
    if (!from || !to) return [];
    return [
      {
        from: c.from,
        to: c.to,
        dashed: env === 'both' && bothEnvsShown && c.env.length === 1,
        via: c.via,
        points: edgePoints(from, to),
      },
    ];
  });

  const allX = [
    ...rows.flatMap((r) => r.boxes.flatMap((b) => [b.x, b.x + b.w])),
    ...edges.flatMap((e) => e.points.map((p) => p.x)),
  ];
  const allY = [
    ...rows.flatMap((r) => r.boxes.flatMap((b) => [b.y, b.y + b.h])),
    ...edges.flatMap((e) => e.points.map((p) => p.y)),
  ];
  const width = allX.length > 0 ? Math.max(...allX) : 0;
  const height = allY.length > 0 ? Math.max(...allY) : 0;

  return { env, rows, edges, notes, none, width, height };
}
