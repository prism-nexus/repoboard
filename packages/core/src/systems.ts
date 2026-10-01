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
import { CARD_ID_SHAPE } from './phases.js';

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

/** RCB-161 slice 1 (plan §3.1): a row/connection's build state — `live` (default, absent on disk)
 * is today's every row; `planned`/`blocked` are new. Drives the Flow view's "what unblocks this"
 * (slice 2, not here). */
export const SYSTEM_STATUSES = ['live', 'planned', 'blocked'] as const;
export type SystemStatus = (typeof SYSTEM_STATUSES)[number];

/** §3.1 / plan Q5: 4,096 B originally (half the CLAUDE.md budget), raised to 16,384 B by the owner
 * 2026-09-29 (RCB-173) — a member's file is 9,727 B. WARNED, not enforced (`systems-over-budget`,
 * `parseSystems`). No `board.yml` override exists for it, so none is read (core has no I/O). */
export const DEFAULT_SYSTEMS_BUDGET_BYTES = 16384;

/** RCB-173: a connection `label` is a short edge caption — 1 to this many characters. */
export const CONNECTION_LABEL_MAX = 40;

/** RCB-180: a `paths:` entry's `name` is a short menu label — 1 to this many characters. */
export const FLOW_PATH_NAME_MAX = 40;

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
  /** RCB-161 slice 1: absent on disk (YAML has no `status:` key) → `'live'`. */
  status: SystemStatus;
  /** RCB-161 slice 1: YAML key `unblocked_by`, a list of card ids; absent on disk → `[]`. */
  unblockedBy: string[];
  source: Source;
}

export interface Connection {
  from: string;
  to: string;
  /** RCB-173: optional id, `[a-z0-9-]+` — the only thing that lets two rows share a (from,to)
   * pair. Absent on disk → absent here; never written back when absent. */
  id?: string;
  /** RCB-173: optional short caption (1..`CONNECTION_LABEL_MAX` chars). Absent on disk → absent. */
  label?: string;
  via: string | null;
  env: SystemEnv[];
  /** RCB-173: code refs, the same grammar and resolver as `SystemRow.pointers`. Absent (or `[]`)
   * on disk → absent here; an empty list is never written back. */
  pointers?: string[];
  /** RCB-161 slice 1: absent on disk (YAML has no `status:` key) → `'live'`. */
  status: SystemStatus;
  /** RCB-161 slice 1: YAML key `unblocked_by`, a list of card ids; absent on disk → `[]`. */
  unblockedBy: string[];
  source: Source;
}

/** RCB-162: a hand "no" on a detected candidate — `systems.yml` had nowhere to record a rejection,
 * so every `detect --apply` re-added what a member board's hand review turned down. Two shapes:
 * a whole system (`id`) or one connection (`from`/`to`); `why` is the provenance of the "no" and
 * is required (never a plausible-looking rejection with no reason on file). */
export type Rejection = { id: string; why: string } | { from: string; to: string; why: string };

/** RCB-180: a named walk-through — "a request goes web → api → db". `hops` are system ids in
 * travel order (>= 2); each consecutive pair must be a connection `hops[i]` → `hops[i+1]`
 * (`validateSemantics`). Drawn nowhere by itself: the Flow view steps through it hop by hop. */
export interface FlowPath {
  name: string;
  hops: string[];
  source: Source;
}

export interface SystemsDoc {
  environments: { dev: Environment; prod: Environment };
  systems: SystemRow[];
  connections: Connection[];
  /** RCB-162: absent on disk (no `rejected:` key) -> `[]`, same convention as `unblocked_by`. */
  rejected: Rejection[];
  /** RCB-180: absent on disk (no `paths:` key, or an empty list) -> absent here, never `[]`; the
   * optional-field rule of RCB-173's `id`/`label`/`pointers`, so a doc literal without it stays
   * valid and `serializeSystems` writes the key only when there is something to write. */
  paths?: FlowPath[];
}

/** RCB-173: a parse that SUCCEEDED but that the owner should look at — inert, never an error.
 * `message` is the human line (`systems-<kind>: …`, the same channel and wording style as RCB-163's
 * `systems-unblocker-unknown`); the other fields are the numbers/names behind it. */
export type SystemsWarning =
  | {
      kind: 'systems-unknown-key';
      /** `systems[2]`, `connections[0]`, or `top level`. */
      path: string;
      key: string;
      message: string;
    }
  | { kind: 'systems-over-budget'; bytes: number; budget: number; message: string };

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
  // RCB-161 slice 1: `status` is checked against SYSTEM_STATUSES in `validateSemantics` (like
  // `kind`/`layer`), not `z.enum` here, so a bad value is reported with the row named rather than
  // a generic zod issue. `unblocked_by` entries are checked against CARD_ID_SHAPE the same way.
  status: z.string().optional(),
  unblocked_by: z.array(z.string()).default(() => []),
  source: SourceInputSchema,
});

/** RCB-162: mirrors `SourceInputSchema`'s "exactly one of" pattern — a rejection is a system
 * (`id`) XOR a connection (`from` + `to`), never both, never neither; `from`/`to` come as a pair
 * or not at all. `why` is required and non-empty at the schema level (not a semantic check), so a
 * missing/empty `why` reports as an ordinary zod issue naming the `rejected[i]` path. */
const RejectionInputSchema = z
  .looseObject({
    id: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    why: z.string().min(1),
  })
  .refine((r) => (r.from !== undefined) === (r.to !== undefined), {
    message: 'a "from"/"to" rejected entry needs both',
  })
  .refine((r) => (r.id !== undefined) !== (r.from !== undefined), {
    message: 'rejected entry must have exactly one of "id" or "from"/"to"',
  });

const ConnectionInputSchema = z.looseObject({
  from: z.string().min(1),
  to: z.string().min(1),
  // RCB-173: `id`/`label` shape is checked in `validateSemantics` (row named in the message), not
  // here. `pointers` is the same `z.array(z.string())` a system row has — the grammar IS "a
  // string `resolveRefSpec` understands"; nothing in core narrows it further.
  id: z.string().optional(),
  label: z.string().optional(),
  via: z.string().nullable().default(null),
  pointers: z.array(z.string()).optional(),
  env: z.array(z.string()),
  status: z.string().optional(),
  unblocked_by: z.array(z.string()).default(() => []),
  source: SourceInputSchema,
});

/** RCB-180: `name` length and uniqueness, `hops` count and each hop's id are checked in
 * `validateSemantics` (the path named in the message), not here. */
const PathInputSchema = z.looseObject({
  name: z.string(),
  hops: z.array(z.string()),
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
  rejected: z.array(RejectionInputSchema).default(() => []),
  paths: z.array(PathInputSchema).optional(),
});

type RawSystemsDoc = z.infer<typeof SystemsDocInputSchema>;
type RawSource = z.infer<typeof SourceInputSchema>;
type RawEnvironment = z.infer<typeof EnvironmentInputSchema>;
type RawRejection = z.infer<typeof RejectionInputSchema>;

export type SystemsParseResult =
  | { ok: true; doc: SystemsDoc; warnings: SystemsWarning[] }
  | { ok: false; errors: string[] };

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
    if (row.status !== undefined && !(SYSTEM_STATUSES as readonly string[]).includes(row.status)) {
      errors.push(`${label}: unknown status "${row.status}"`);
    }
    for (const id of row.unblocked_by) {
      if (!CARD_ID_SHAPE.test(id)) {
        errors.push(`${label}: unblocked_by entry "${id}" is not a card id`);
      }
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
    if (conn.id !== undefined && !ID_RE.test(conn.id)) {
      errors.push(`connections[${i}]: invalid id "${conn.id}" (must match ${ID_RE.source})`);
    }
    if (
      conn.label !== undefined &&
      ([...conn.label].length < 1 || [...conn.label].length > CONNECTION_LABEL_MAX)
    ) {
      errors.push(`connections[${i}]: label must be 1-${CONNECTION_LABEL_MAX} characters`);
    }
    if (
      conn.status !== undefined &&
      !(SYSTEM_STATUSES as readonly string[]).includes(conn.status)
    ) {
      errors.push(`connections[${i}]: unknown status "${conn.status}"`);
    }
    for (const id of conn.unblocked_by) {
      if (!CARD_ID_SHAPE.test(id)) {
        errors.push(`connections[${i}]: unblocked_by entry "${id}" is not a card id`);
      }
    }
  });

  // RCB-173: a (from,to) pair is unique unless EVERY row of that pair carries its own distinct `id`
  // (`applyDetected` and `mergeCandidates` match a candidate to a row by that pair). One error per
  // offending row after the pair's first, naming both indexes, in `connections:` array order.
  const pairGroups = new Map<string, number[]>();
  raw.connections.forEach((conn, i) => {
    const key = `${conn.from}→${conn.to}`;
    const group = pairGroups.get(key);
    if (group) group.push(i);
    else pairGroups.set(key, [i]);
  });
  raw.connections.forEach((conn, i) => {
    const key = `${conn.from}→${conn.to}`;
    const group = pairGroups.get(key) ?? [];
    const first = group[0];
    if (first === undefined || first === i) return;
    const ids = group.map((j) => raw.connections[j]?.id);
    const allDistinct = ids.every((id) => id !== undefined) && new Set(ids).size === ids.length;
    if (!allDistinct) {
      errors.push(
        `connections[${i}]: duplicate connection "${key}" (also connections[${first}]) — rows sharing a from/to pair each need a distinct id`,
      );
    }
  });

  // RCB-180: a path is a walk along connections. Per path, in `paths:` array order: its name
  // (1..FLOW_PATH_NAME_MAX characters, unique), its hop count (>= 2), each hop's id, then each
  // consecutive pair against the connection list (direction matters; parallel rows all match).
  const pathNames = new Map<string, number>();
  (raw.paths ?? []).forEach((path, i) => {
    const label = `paths[${i}] (name "${path.name}")`;
    const nameLength = [...path.name].length;
    if (nameLength < 1 || nameLength > FLOW_PATH_NAME_MAX) {
      errors.push(`${label}: name must be 1-${FLOW_PATH_NAME_MAX} characters`);
    }
    const first = pathNames.get(path.name);
    if (first === undefined) pathNames.set(path.name, i);
    else errors.push(`${label}: duplicate name "${path.name}" (also paths[${first}])`);
    if (path.hops.length < 2) {
      errors.push(`${label}: needs at least 2 hops`);
    }
    path.hops.forEach((id, j) => {
      if (!knownIds.has(id)) errors.push(`${label}: hops[${j}] names unknown system "${id}"`);
    });
    path.hops.slice(0, -1).forEach((a, j) => {
      const b = path.hops[j + 1];
      // An unknown hop is already reported above; the pair check would only repeat it.
      if (b === undefined || !knownIds.has(a) || !knownIds.has(b)) return;
      if (raw.connections.some((c) => c.from === a && c.to === b)) return;
      const reverse = raw.connections.some((c) => c.from === b && c.to === a);
      errors.push(`${label}: hop ${a}→${b} is not a connection${reverse ? ` (${b}→${a} is)` : ''}`);
    });
  });

  // RCB-162: a rejection naming a row that is ALSO still in systems/connections is a stale or
  // contradictory "no" — the owner rejected it, then it (re)appeared, and nobody reconciled that.
  // A duplicate rejection (same key twice) is caught here too, in `rejected:` array order.
  const seenRejectionKeys = new Set<string>();
  raw.rejected.forEach((r, i) => {
    const key = r.id !== undefined ? r.id : `${r.from}→${r.to}`;
    if (seenRejectionKeys.has(key)) {
      errors.push(`rejected[${i}]: duplicate rejection "${key}"`);
    }
    seenRejectionKeys.add(key);
    if (r.id !== undefined) {
      if (knownIds.has(r.id)) errors.push(`rejected but present: ${key}`);
    } else if (r.from !== undefined && r.to !== undefined) {
      const present = raw.connections.some((c) => c.from === r.from && c.to === r.to);
      if (present) errors.push(`rejected but present: ${key}`);
    }
  });

  return errors;
}

/** UTF-8 byte length without `TextEncoder`/`Buffer` (core has no Node types, and no I/O). A lone
 * surrogate counts 3, as the encoder's U+FFFD replacement would. */
function utf8ByteLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

function unknownKeyWarning(path: string, label: string, key: string): SystemsWarning {
  return {
    kind: 'systems-unknown-key',
    path,
    key,
    message: `systems-unknown-key: ${label}: unknown key "${key}" — ignored, and dropped if systems detect --apply rewrites the file`,
  };
}

/**
 * RCB-173: the inert findings of a doc that ALREADY parsed. `looseObject` kept every key the file
 * had, so an unknown one (a typo, a field from a newer repoboard) is found by diffing each mapping
 * against its schema's own `shape` — there is no second list of known keys to forget to update.
 * Order: top level, systems (array order), connections (array order), paths (array order, RCB-180),
 * then the byte budget.
 */
function systemsWarnings(raw: RawSystemsDoc, text: string): SystemsWarning[] {
  const warnings: SystemsWarning[] = [];
  const knownTop = new Set(Object.keys(SystemsDocInputSchema.shape));
  for (const key of Object.keys(raw)) {
    if (!knownTop.has(key)) warnings.push(unknownKeyWarning('top level', 'top level', key));
  }
  const knownSystem = new Set(Object.keys(SystemRowInputSchema.shape));
  raw.systems.forEach((row, i) => {
    for (const key of Object.keys(row)) {
      if (!knownSystem.has(key)) {
        warnings.push(unknownKeyWarning(`systems[${i}]`, `systems[${i}] (id "${row.id}")`, key));
      }
    }
  });
  const knownConnection = new Set(Object.keys(ConnectionInputSchema.shape));
  raw.connections.forEach((conn, i) => {
    for (const key of Object.keys(conn)) {
      if (!knownConnection.has(key)) {
        warnings.push(
          unknownKeyWarning(
            `connections[${i}]`,
            `connections[${i}] (${conn.from}→${conn.to})`,
            key,
          ),
        );
      }
    }
  });
  // RCB-180: a `paths[i]` entry is checked like the rows above. `serializeSystems` writes only
  // name/hops/source, so a typo'd key here is dropped by `systems detect --apply`.
  const knownPath = new Set(Object.keys(PathInputSchema.shape));
  (raw.paths ?? []).forEach((path, i) => {
    for (const key of Object.keys(path)) {
      if (!knownPath.has(key)) {
        warnings.push(unknownKeyWarning(`paths[${i}]`, `paths[${i}] (name "${path.name}")`, key));
      }
    }
  });
  const bytes = utf8ByteLength(text);
  if (bytes > DEFAULT_SYSTEMS_BUDGET_BYTES) {
    warnings.push({
      kind: 'systems-over-budget',
      bytes,
      budget: DEFAULT_SYSTEMS_BUDGET_BYTES,
      message: `systems-over-budget: .repoboard/systems.yml is ${bytes} B, over the ${DEFAULT_SYSTEMS_BUDGET_BYTES} B budget (warned, not enforced)`,
    });
  }
  return warnings;
}

function toSource(raw: RawSource): Source {
  if (raw.detected !== undefined) return { detected: raw.detected, at: raw.at };
  return { hand: raw.hand as string, at: raw.at };
}

function toEnvironment(raw: RawEnvironment): Environment {
  if (raw.none) return { none: raw.none };
  return { note: raw.note ?? null };
}

/** Schema's `.refine`s already enforce "exactly one of id / from+to" (mirrors `toSource`). */
function toRejection(raw: RawRejection): Rejection {
  if (raw.id !== undefined) return { id: raw.id, why: raw.why };
  return { from: raw.from as string, to: raw.to as string, why: raw.why };
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
      status: (row.status ?? 'live') as SystemStatus,
      unblockedBy: row.unblocked_by,
      source: toSource(row.source),
    })),
    connections: raw.connections.map((conn) => ({
      from: conn.from,
      to: conn.to,
      // RCB-173: the three optional fields exist on the object only when the file had them
      // (and, for `pointers`, only when non-empty) — no `label: undefined` keys, no `[]` written.
      ...(conn.id !== undefined ? { id: conn.id } : {}),
      ...(conn.label !== undefined ? { label: conn.label } : {}),
      via: conn.via,
      env: conn.env as SystemEnv[],
      ...(conn.pointers !== undefined && conn.pointers.length > 0
        ? { pointers: conn.pointers }
        : {}),
      status: (conn.status ?? 'live') as SystemStatus,
      unblockedBy: conn.unblocked_by,
      source: toSource(conn.source),
    })),
    rejected: raw.rejected.map(toRejection),
    // RCB-180: present only when the file had at least one path — no `paths: undefined` key.
    ...(raw.paths !== undefined && raw.paths.length > 0
      ? {
          paths: raw.paths.map((p) => ({
            name: p.name,
            hops: p.hops,
            source: toSource(p.source),
          })),
        }
      : {}),
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
  return { ok: true, doc: toSystemsDoc(result.data), warnings: systemsWarnings(result.data, text) };
}

/** What "no systems.yml yet" renders from (§3.1: unconfigured is inert, not dangerous). */
export function emptySystemsDoc(): SystemsDoc {
  return {
    environments: { dev: { note: null }, prod: { note: null } },
    systems: [],
    connections: [],
    rejected: [],
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
  /** RCB-161 slice 2: copied from the row's `status` — the Flow view's "what's not live yet". */
  status: SystemStatus;
}

export interface LayoutEdge {
  from: string;
  to: string;
  dashed: boolean;
  via: string | null;
  /** RCB-179: an orthogonal polyline from a port on the source's top/bottom side to a port on the
   * target's (first and last point), running inside row gaps and column gaps only. */
  points: LayoutPoint[];
  /** RCB-161 slice 2: copied from the connection's `status`. */
  status: SystemStatus;
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

/** The grid `layoutSystems` places boxes on (§3.4): a box is `BOX` x `BOX` at `x = col * COL_PITCH`.
 * Between two columns there is a `COL_PITCH - BOX` wide column gap and between two rows a row gap
 * that is `ROW_PITCH - BOX` tall at least — no box is ever in one. A row's `y` is its top: over
 * every row above it, `BOX` plus the row gap below that row (RCB-192), which is `row * ROW_PITCH`
 * while no gap has grown. */
const COL_PITCH = 1.5;
const ROW_PITCH = 2;
const BOX = 1;
/** RCB-192: the least distance between two tracks in a row gap, and from the first and last track
 * to the gap's edges. Flow draws 1 unit as 64 px (`SCALE_Y`) and an arrowhead is 8 px, so 8 / 64
 * = 0.125 units keeps every stub at least as long as its arrowhead. A gap holding `t` tracks is
 * `MIN_TRACK_PITCH * (t + 1)` tall when that exceeds `ROW_PITCH - BOX`, i.e. from 8 tracks on. */
const MIN_TRACK_PITCH = 0.125;

/** Two x (or y) values this close are the same line. Ports, lanes and tracks are all computed from
 * small rationals, so an honest coincidence differs by rounding error at most. */
const SAME = 1e-9;

/** RCB-179: what one more route already in a column gap adds to the price of choosing it, in the
 * layout units a route pays per unit of sideways travel. Below the 3 units a whole extra column
 * costs, so crowding spreads long routes over the gaps that cost the same, never sends one further. */
const CHANNEL_CROWD_COST = 0.35;
/** The right margin (beyond the last column) is not a gap between boxes, so its lanes are not
 * squeezed into 0.5: the first lane sits this far right of the last column, the next ones this
 * far apart. The first lane is where K14's detour ran. */
const MARGIN_LANE_START = 0.25;
const MARGIN_LANE_PITCH = 0.125;

type Side = 'top' | 'bottom';

/** One part of a route inside one row gap: a horizontal run on a track (a y), plus the vertical
 * stubs joining it to the gap's boundaries. `tops` hang from the gap's top boundary down to the
 * run; `bots` run from the run down to the gap's bottom boundary. */
interface RoutePiece {
  leg: RouteLeg;
  gap: number;
  tops: number[];
  bots: number[];
  lo: number;
  hi: number;
  /** Assigned by `solveGap`; -1 until then. */
  track: number;
  y: number;
  /** Set on the upper half of a doglegged net: the piece its jog runs down to. */
  below: RoutePiece | null;
}

/** A route's stretch through one row gap, in travel order. `enterX`/`leaveX` are where the route
 * arrives at and leaves the horizontal run; `enterTop`/`leaveTop` say which boundary of the gap
 * each stub hangs from (a route going down enters at the top, one going up at the bottom). */
interface RouteLeg {
  gap: number;
  enterX: number;
  leaveX: number;
  enterTop: boolean;
  leaveTop: boolean;
  pieces: RoutePiece[];
  /** x of the vertical joining the two pieces of a doglegged leg; `null` for an ordinary leg. */
  jog: number | null;
}

interface RoutePlan {
  from: LayoutBox;
  to: LayoutBox;
  rowFrom: number;
  rowTo: number;
  dir: 'same' | 'down' | 'up';
  exitX: number;
  entryX: number;
  /** One vertical line from port to port: both ports on one x, nothing in between. */
  straight: boolean;
  /** A long route's vertical run: the column gap it runs in (`col`), the row gaps it spans
   * (`lo`..`hi`), and its x once lanes are allocated. */
  channel: { col: number; lo: number; hi: number; x: number } | null;
  legs: RouteLeg[];
}

/** Strongly connected components of a small digraph (Tarjan), each sorted ascending, ordered by
 * their smallest member — so the order is a function of the graph alone. */
function stronglyConnected(succ: readonly ReadonlySet<number>[]): number[][] {
  const index: number[] = succ.map(() => -1);
  const low: number[] = succ.map(() => 0);
  const onStack: boolean[] = succ.map(() => false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  const visit = (v: number): void => {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = true;
    for (const w of [...(succ[v] ?? [])].sort((a, b) => a - b)) {
      if ((index[w] ?? -1) < 0) {
        visit(w);
        low[v] = Math.min(low[v] ?? 0, low[w] ?? 0);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v] ?? 0, index[w] ?? 0);
      }
    }
    if (low[v] === index[v]) {
      const component: number[] = [];
      for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
        onStack[w] = false;
        component.push(w);
        if (w === v) break;
      }
      components.push(component.sort((a, b) => a - b));
    }
  };
  for (let v = 0; v < succ.length; v += 1) if ((index[v] ?? -1) < 0) visit(v);
  return components.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

const spansOverlap = (a: RoutePiece, b: RoutePiece): boolean =>
  a.lo <= b.hi + SAME && b.lo <= a.hi + SAME;

/** How many perpendicular crossings a pair of pieces has when `above` is drawn on the higher
 * track: above's bottom stubs drop through below's run if they land inside it, and below's top
 * stubs come down through above's run if they land inside that. */
function pairCrossings(above: RoutePiece, below: RoutePiece): number {
  const inside = (x: number, p: RoutePiece) => x > p.lo + SAME && x < p.hi - SAME;
  return (
    above.bots.filter((x) => inside(x, below)).length +
    below.tops.filter((x) => inside(x, above)).length
  );
}

/**
 * Give every piece in one row gap a track, so that no two runs share a y where they overlap and no
 * two stubs share an x where they overlap. The one place a shared x is possible is a bottom port of
 * the row above facing a top port of the row below in the same column (same fraction of the box):
 * the route hanging from the upper one must then sit on a higher track than the one rising to the
 * lower (`hardEdges`). When two routes need each other above (an X of two crossing edges) neither
 * order works, so one of them gets a dogleg: its top stub and its bottom stub go to two tracks,
 * joined by a vertical at an x no other vertical uses — after which no piece has both a top and a
 * bottom stub to conflict on, and the constraint graph is acyclic.
 *
 * `statics` are the x of every vertical that crosses this gap without belonging to a piece (long
 * lanes and straight lines), so a jog never lands on one.
 *
 * Sets each piece's `track` and returns the number of tracks; the `y` of a track is placed by
 * `routeEdges` once every gap's height, and so every row's top, is known (RCB-192).
 */
function solveGap(pieces: RoutePiece[], statics: readonly number[]): number {
  const hardEdges = (): Set<number>[] => {
    const succ = pieces.map(() => new Set<number>());
    pieces.forEach((a, i) => {
      pieces.forEach((b, j) => {
        if (i === j) return;
        if (a.below === b || a.tops.some((t) => b.bots.some((x) => Math.abs(t - x) <= SAME))) {
          succ[i]?.add(j);
        }
      });
    });
    return succ;
  };

  for (;;) {
    const cycle = stronglyConnected(hardEdges()).find((c) => c.length > 1);
    const at = cycle?.find(
      (i) => (pieces[i]?.tops.length ?? 0) > 0 && (pieces[i]?.bots.length ?? 0) > 0,
    );
    const piece = at === undefined ? undefined : pieces[at];
    if (at === undefined || piece === undefined) break;
    const taken = [
      ...statics,
      ...pieces.flatMap((q) => [...q.tops, ...q.bots]),
      ...pieces.flatMap((q) => (q.leg.jog === null ? [] : [q.leg.jog])),
    ];
    const bounds = [piece.lo, piece.hi];
    const inner = taken.filter((x) => x > piece.lo + SAME && x < piece.hi - SAME);
    const marks = [...bounds, ...inner].sort((a, b) => a - b);
    let jog = (piece.lo + piece.hi) / 2;
    let widest = -1;
    for (let k = 0; k + 1 < marks.length; k += 1) {
      const a = marks[k] ?? 0;
      const b = marks[k + 1] ?? 0;
      if (b - a > widest + SAME) {
        widest = b - a;
        jog = (a + b) / 2;
      }
    }
    const lower: RoutePiece = {
      leg: piece.leg,
      gap: piece.gap,
      tops: [],
      bots: piece.bots,
      lo: Math.min(jog, ...piece.bots),
      hi: Math.max(jog, ...piece.bots),
      track: -1,
      y: 0,
      below: null,
    };
    const upper: RoutePiece = {
      leg: piece.leg,
      gap: piece.gap,
      tops: piece.tops,
      bots: [],
      lo: Math.min(jog, ...piece.tops),
      hi: Math.max(jog, ...piece.tops),
      track: -1,
      y: 0,
      below: lower,
    };
    pieces[at] = upper;
    pieces.push(lower);
    piece.leg.pieces = [upper, lower];
    piece.leg.jog = jog;
  }

  const succ = hardEdges();
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>();
    const todo = [from];
    for (let v = todo.pop(); v !== undefined; v = todo.pop()) {
      if (v === to) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      todo.push(...(succ[v] ?? []));
    }
    return false;
  };
  // Where overlapping runs still have a free choice, put on top the one whose stubs cross the
  // other's run the fewer times; a preference that would close a cycle is dropped.
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      const a = pieces[i];
      const b = pieces[j];
      if (a === undefined || b === undefined || !spansOverlap(a, b)) continue;
      const aFirst = pairCrossings(a, b);
      const bFirst = pairCrossings(b, a);
      if (aFirst === bFirst) continue;
      const [u, v] = aFirst < bFirst ? [i, j] : [j, i];
      if (!reaches(v, u)) succ[u]?.add(v);
    }
  }

  const indegree = pieces.map(() => 0);
  for (const out of succ) for (const j of out) indegree[j] = (indegree[j] ?? 0) + 1;
  const assigned: number[] = [];
  const isDone = pieces.map(() => false);
  for (let step = 0; step < pieces.length; step += 1) {
    const ready = pieces.findIndex((_, k) => !isDone[k] && indegree[k] === 0);
    const next = ready >= 0 ? ready : pieces.findIndex((_, k) => !isDone[k]);
    const piece = pieces[next];
    if (piece === undefined) break;
    let track = 0;
    succ.forEach((out, p) => {
      if (isDone[p] && out.has(next)) track = Math.max(track, (pieces[p]?.track ?? -1) + 1);
    });
    const clashes = (t: number): boolean =>
      assigned.some((k) => {
        const other = pieces[k];
        return other !== undefined && other.track === t && spansOverlap(other, piece);
      });
    while (clashes(track)) track += 1;
    piece.track = track;
    isDone[next] = true;
    assigned.push(next);
    for (const j of succ[next] ?? []) indegree[j] = (indegree[j] ?? 0) - 1;
  }

  return pieces.reduce((n, p) => Math.max(n, p.track + 1), 0);
}

/** RCB-192: how tall a row gap holding `tracks` tracks is — `ROW_PITCH - BOX` (1 unit) until
 * `MIN_TRACK_PITCH * (tracks + 1)` exceeds it, so a gap of 7 tracks or fewer is exactly as tall as
 * it was before growth. */
const gapHeight = (tracks: number): number =>
  Math.max(ROW_PITCH - BOX, MIN_TRACK_PITCH * (tracks + 1));

/**
 * RCB-179: orthogonal routes for every edge at once — routes that share nothing.
 *
 * - **Ports.** The edges on one side of a box are spread along it, the k-th of n at
 *   `x + w * (k + 1) / (n + 1)`, ordered by the far end's x (ties: connection order). An edge
 *   leaves the bottom of its source and enters the top of its target when the target is a row
 *   below; the other way round when it is above; a same-row edge uses both bottoms. Entries and
 *   exits share the spread, so no two edges meet a box at one point.
 * - **Straight.** Two boxes in one column with equal ports and nothing between them (K14's case)
 *   are joined by one vertical line.
 * - **Lanes.** Otherwise the route bends inside the row gap below/above its source (its horizontal
 *   run gets a track of its own where runs overlap) and, when the target is more than one row
 *   away, drops along a lane in a column gap — or right of the last column — to the row gap next to
 *   its target. Column gaps and the margin hold no box, so such a route never enters one.
 * - **Tracks.** See `solveGap`. A row gap grows with its track count (RCB-192): `gapHeight`. So a
 *   row's top is not `row * ROW_PITCH` but, over every row above it, `BOX` plus the gap below it;
 *   the route ends are placed on those tops, and the tops are returned for `layoutSystems`.
 *
 * Returns one point list per element of `ends`, in order, and each row's top y. Deterministic:
 * every choice is by index or coordinate, never by object identity.
 */
function routeEdges(
  ends: readonly { from: LayoutBox; to: LayoutBox }[],
  rowOf: ReadonlyMap<string, number>,
  allBoxes: readonly LayoutBox[],
  rowCount: number,
): { routes: LayoutPoint[][]; tops: number[] } {
  const colCount = allBoxes.reduce((m, b) => Math.max(m, Math.round(b.x / COL_PITCH) + 1), 1);
  const plans: RoutePlan[] = ends.map(({ from, to }) => {
    const rowFrom = rowOf.get(from.id) ?? 0;
    const rowTo = rowOf.get(to.id) ?? 0;
    return {
      from,
      to,
      rowFrom,
      rowTo,
      dir: rowTo === rowFrom ? 'same' : rowTo > rowFrom ? 'down' : 'up',
      exitX: 0,
      entryX: 0,
      straight: false,
      channel: null,
      legs: [],
    };
  });

  // Ports: every edge end is a slot on one side of its box.
  interface Slot {
    edge: number;
    entry: boolean;
    far: number;
  }
  const slots = new Map<LayoutBox, Record<Side, Slot[]>>();
  const addSlot = (box: LayoutBox, side: Side, slot: Slot): void => {
    let sides = slots.get(box);
    if (sides === undefined) {
      sides = { top: [], bottom: [] };
      slots.set(box, sides);
    }
    sides[side].push(slot);
  };
  plans.forEach((p, edge) => {
    addSlot(p.from, p.dir === 'up' ? 'top' : 'bottom', { edge, entry: false, far: p.to.x });
    addSlot(p.to, p.dir === 'down' ? 'top' : 'bottom', { edge, entry: true, far: p.from.x });
  });
  for (const [box, sides] of slots) {
    for (const side of ['top', 'bottom'] as const) {
      const list = sides[side].sort(
        (a, b) => a.far - b.far || a.edge - b.edge || Number(a.entry) - Number(b.entry),
      );
      list.forEach((slot, k) => {
        const plan = plans[slot.edge];
        if (plan === undefined) return;
        const x = box.x + (box.w * (k + 1)) / (list.length + 1);
        if (slot.entry) plan.entryX = x;
        else plan.exitX = x;
      });
    }
  }

  // A straight line needs one column, one x, and no box between the ends.
  for (const p of plans) {
    if (p.dir === 'same' || p.from.x !== p.to.x || Math.abs(p.exitX - p.entryX) > SAME) continue;
    const lo = Math.min(p.rowFrom, p.rowTo);
    const hi = Math.max(p.rowFrom, p.rowTo);
    // By row, not by `y`: the boxes' y is set from the rows' tops only once the routes are known.
    if (
      allBoxes.some((b) => {
        const row = rowOf.get(b.id) ?? 0;
        return b.x === p.from.x && row > lo && row < hi;
      })
    ) {
      continue;
    }
    p.straight = true;
    p.entryX = p.exitX;
  }

  // Long routes: pick the column gap with the least sideways travel (then the least crowded, then
  // the one nearest the midpoint, then the right-hand one), then give overlapping ones distinct lanes.
  const inColumn: { lo: number; hi: number }[][] = Array.from({ length: colCount }, () => []);
  for (const p of plans) {
    if (p.dir === 'same' || p.straight || Math.abs(p.rowTo - p.rowFrom) < 2) continue;
    const lo = Math.min(p.rowFrom, p.rowTo);
    const hi = Math.max(p.rowFrom, p.rowTo) - 1;
    const mid = (p.exitX + p.entryX) / 2;
    let best = { col: 0, cost: Number.POSITIVE_INFINITY, off: Number.POSITIVE_INFINITY };
    for (let col = 0; col < colCount; col += 1) {
      const centre = col * COL_PITCH + BOX + (COL_PITCH - BOX) / 2;
      const crowd = (inColumn[col] ?? []).filter((c) => c.lo <= hi && lo <= c.hi).length;
      const cost =
        Math.abs(p.exitX - centre) + Math.abs(p.entryX - centre) + CHANNEL_CROWD_COST * crowd;
      const off = Math.abs(centre - mid);
      if (
        cost < best.cost - SAME ||
        (Math.abs(cost - best.cost) <= SAME && off <= best.off + SAME)
      ) {
        best = { col, cost, off };
      }
    }
    p.channel = { col: best.col, lo, hi, x: 0 };
    inColumn[best.col]?.push({ lo, hi });
  }
  for (let col = 0; col < colCount; col += 1) {
    const members = plans
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.channel?.col === col)
      .sort((a, b) => (a.p.channel?.lo ?? 0) - (b.p.channel?.lo ?? 0) || a.i - b.i);
    const laneEnd: number[] = [];
    const laneOf = members.map(({ p }) => {
      const span = p.channel;
      if (span === null) return 0;
      let lane = laneEnd.findIndex((end) => end < span.lo);
      if (lane < 0) {
        lane = laneEnd.length;
        laneEnd.push(span.hi);
      } else laneEnd[lane] = span.hi;
      return lane;
    });
    const left = col * COL_PITCH + BOX;
    members.forEach(({ p }, m) => {
      if (p.channel === null) return;
      const lane = laneOf[m] ?? 0;
      p.channel.x =
        col < colCount - 1
          ? left + ((COL_PITCH - BOX) * (lane + 1)) / (laneEnd.length + 1)
          : left + MARGIN_LANE_START + MARGIN_LANE_PITCH * lane;
    });
  }

  // Legs: the stretch of each route inside each row gap it crosses.
  const gapPieces: RoutePiece[][] = Array.from({ length: rowCount }, () => []);
  const statics: number[][] = Array.from({ length: rowCount }, () => []);
  for (const p of plans) {
    const spanLo = Math.min(p.rowFrom, p.rowTo);
    const spanHi = Math.max(p.rowFrom, p.rowTo) - 1;
    const fixedX = p.straight ? p.exitX : p.channel?.x;
    if (fixedX !== undefined) {
      for (let g = spanLo; g <= spanHi; g += 1) statics[g]?.push(fixedX);
    }
    if (p.straight) continue;
    const first = p.dir === 'up' ? p.rowFrom - 1 : p.rowFrom;
    const last = p.dir === 'down' ? p.rowTo - 1 : p.dir === 'up' ? p.rowTo : p.rowFrom;
    const gaps = p.channel === null ? [first] : [first, last];
    const waypoints = p.channel === null ? [p.exitX, p.entryX] : [p.exitX, p.channel.x, p.entryX];
    gaps.forEach((gap, k) => {
      const enterX = waypoints[k] ?? 0;
      const leaveX = waypoints[k + 1] ?? 0;
      const enterTop = p.dir !== 'up';
      const leaveTop = p.dir !== 'down';
      const leg: RouteLeg = { gap, enterX, leaveX, enterTop, leaveTop, pieces: [], jog: null };
      const piece: RoutePiece = {
        leg,
        gap,
        tops: [...(enterTop ? [enterX] : []), ...(leaveTop ? [leaveX] : [])],
        bots: [...(enterTop ? [] : [enterX]), ...(leaveTop ? [] : [leaveX])],
        lo: Math.min(enterX, leaveX),
        hi: Math.max(enterX, leaveX),
        track: -1,
        y: 0,
        below: null,
      };
      leg.pieces.push(piece);
      p.legs.push(leg);
      gapPieces[gap]?.push(piece);
    });
  }
  const gapTracks = gapPieces.map((pieces, gap) => solveGap(pieces, statics[gap] ?? []));
  // Every gap is solved, the one below the last row too, so every gap's height is known: a row's
  // top is the sum of `BOX` and the height of each gap above it (exact: heights are multiples of
  // `MIN_TRACK_PITCH`, a power of two), and a track sits at its share of its gap.
  const gapHeights = gapTracks.map(gapHeight);
  const tops: number[] = [];
  let y = 0;
  for (const height of gapHeights) {
    tops.push(y);
    y += BOX + height;
  }
  const topOf = (row: number): number => tops[row] ?? 0;
  gapPieces.forEach((pieces, gap) => {
    const top = topOf(gap) + BOX;
    for (const p of pieces) {
      p.y = top + ((gapHeights[gap] ?? 0) * (p.track + 1)) / ((gapTracks[gap] ?? 0) + 1);
    }
  });

  const routes = plans.map((p) => {
    const points: LayoutPoint[] = [
      {
        x: p.exitX,
        y: p.dir === 'up' ? topOf(p.rowFrom) : topOf(p.rowFrom) + p.from.h,
      },
    ];
    for (const leg of p.legs) {
      const [a, b] = leg.pieces;
      if (a === undefined) continue;
      if (leg.jog === null || b === undefined) {
        points.push({ x: leg.enterX, y: a.y }, { x: leg.leaveX, y: a.y });
      } else {
        // a is the upper half of the dogleg (it holds the top stub), b the lower.
        const yIn = leg.enterTop ? a.y : b.y;
        const yOut = leg.enterTop ? b.y : a.y;
        points.push(
          { x: leg.enterX, y: yIn },
          { x: leg.jog, y: yIn },
          { x: leg.jog, y: yOut },
          { x: leg.leaveX, y: yOut },
        );
      }
    }
    points.push({ x: p.entryX, y: p.dir === 'down' ? topOf(p.rowTo) : topOf(p.rowTo) + p.to.h });
    return points;
  });
  return { routes, tops };
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
  const rowOf = new Map<string, number>();

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
        x: col * COL_PITCH,
        // Provisional: the grid's y with every gap ungrown. Set to the row's top after routing.
        y: rowIndex * ROW_PITCH,
        w: BOX,
        h: BOX,
        dashed: env === 'both' && bothEnvsShown && (system?.env.length ?? 0) === 1,
        status: system?.status ?? 'live',
      };
      boxOf.set(id, box);
      rowOf.set(id, rowIndex);
      return box;
    });
    rows.push({ layer, boxes });
  }

  const allBoxes = [...boxOf.values()];
  const resolved = visibleConnections.flatMap((c) => {
    const from = boxOf.get(c.from);
    const to = boxOf.get(c.to);
    return from && to ? [{ c, from, to }] : [];
  });
  const { routes, tops } = routeEdges(resolved, rowOf, allBoxes, rows.length);
  // A row's y is its top, which depends on how tall the row gaps above it came out (RCB-192).
  rows.forEach((row, i) => {
    for (const box of row.boxes) box.y = tops[i] ?? box.y;
  });
  const edges: LayoutEdge[] = resolved.map(({ c }, i) => ({
    from: c.from,
    to: c.to,
    dashed: env === 'both' && bothEnvsShown && c.env.length === 1,
    via: c.via,
    points: routes[i] ?? [],
    status: c.status,
  }));

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

/** RCB-180: the three groups the Flow view's summary strip lists — system ids in `systems:` file
 * order (not the layout's own row/column order). */
export interface FlowOverview {
  dataStores: string[];
  externals: string[];
  entryPoints: string[];
}

/**
 * RCB-180: what the map holds at a glance, over exactly the systems `layoutSystems(doc, env)`
 * draws — so it agrees with the canvas in every env, and a `none` environment (nothing drawn) has
 * three empty groups. `dataStores`: layer `data`. `externals`: layer `external`. `entryPoints`: no
 * drawn connection INTO it and at least one OUT of it, in that env (a connection to itself is
 * neither; an isolated system has no outgoing connection and is not an entry). The groups are
 * independent: a system may be in more than one.
 */
export function flowOverview(doc: SystemsDoc, env: 'dev' | 'prod' | 'both'): FlowOverview {
  const layout = layoutSystems(doc, env);
  const drawn = new Map<string, SystemLayer>();
  for (const row of layout.rows) for (const box of row.boxes) drawn.set(box.id, row.layer);
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const e of layout.edges) {
    if (e.from === e.to) continue;
    outgoing.add(e.from);
    incoming.add(e.to);
  }
  const ids = doc.systems.map((s) => s.id).filter((id) => drawn.has(id));
  return {
    dataStores: ids.filter((id) => drawn.get(id) === 'data'),
    externals: ids.filter((id) => drawn.get(id) === 'external'),
    entryPoints: ids.filter((id) => outgoing.has(id) && !incoming.has(id)),
  };
}
