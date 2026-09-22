/**
 * RCB-97 A (plan docs/SYSTEMS-FLOW-PLAN.md §3.3): the agent-facing surface over `systems.ts`
 * (RCB-95) — a one-line cold-start summary for `repoboard seat`, a fixed-width table for
 * `repoboard systems`, and a single row's full detail for `repoboard systems show <id>`. Pure,
 * I/O-free, and `./refs.js`-free (§0.5): pointer RESOLUTION is the server's job, which appends
 * `formatResolvedRefs` after `formatSystemRow`'s text.
 */
import type { Connection, Source, SystemEnv, SystemsDoc } from './systems.js';

/** `repoboard seat`'s one line (§3.3) — which environments the file's systems actually cover. */
export type SystemsEnvs = 'dev+prod' | 'dev only' | 'prod only' | 'dev none' | 'prod none' | 'none';

export interface SystemsSummary {
  systems: number;
  connections: number;
  envs: SystemsEnvs;
  line: string;
}

/** UTF-8 byte length, mirroring `refs.ts`'s private `utf8Bytes` (duplicated, not imported — this
 * module stays `./refs.js`-free by the brief). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `dev+prod` / `dev` / `prod` from a non-empty `SystemEnv[]` (already validated by `parseSystems`
 * — `env` is never empty on a row that reached this far). */
function envTag(env: readonly SystemEnv[]): string {
  const hasDev = env.includes('dev');
  const hasProd = env.includes('prod');
  if (hasDev && hasProd) return 'dev+prod';
  return hasDev ? 'dev' : 'prod';
}

/** §3.1: `{none}` (no story by design) > `{note}` (a story, possibly not yet written down). Both
 * `null`/absent halves collapse to `'none'`/`'dev+prod'` the same way `systemsSummary` do. */
function computeEnvs(doc: SystemsDoc | null): SystemsEnvs {
  if (doc === null) return 'dev+prod';
  const dev = doc.environments.dev;
  const prod = doc.environments.prod;
  const devNone = 'none' in dev;
  const prodNone = 'none' in prod;
  if (devNone && prodNone) return 'none';
  if (prodNone) return 'prod none';
  if (devNone) return 'dev none';
  const hasDev = doc.systems.some((s) => s.env.includes('dev'));
  const hasProd = doc.systems.some((s) => s.env.includes('prod'));
  if (hasDev && hasProd) return 'dev+prod';
  if (hasDev) return 'dev only';
  if (hasProd) return 'prod only';
  return 'dev+prod';
}

/**
 * `repoboard seat`'s one line (§3.3: "a pointer, not the table"). `errors` wins over `doc` — a
 * file that fails to parse is reported as invalid regardless of what `doc` is passed (the caller's
 * contract is `doc: null` alongside non-empty `errors`); `doc === null` with no errors means
 * "no systems.yml yet" (§3.1: unconfigured is inert, one quiet line, never dangerous).
 */
export function systemsSummary(doc: SystemsDoc | null, errors: readonly string[]): SystemsSummary {
  const envs = computeEnvs(doc);
  if (errors.length > 0) {
    const k = errors.length;
    return {
      systems: 0,
      connections: 0,
      envs,
      line: `Systems: systems.yml invalid (${k} error${k === 1 ? '' : 's'}) — repoboard check`,
    };
  }
  if (doc === null) {
    return {
      systems: 0,
      connections: 0,
      envs: 'dev+prod',
      line: 'Systems: no systems.yml yet — repoboard systems detect proposes one',
    };
  }
  return {
    systems: doc.systems.length,
    connections: doc.connections.length,
    envs,
    line: `Systems: ${doc.systems.length} systems, ${doc.connections.length} connections, ${envs} — repoboard systems`,
  };
}

/** Every row of `formatSystemsTable` (header included) fits in this many UTF-8 bytes — the ONE
 * guarantee `fitRow` exists to keep. */
export const SYSTEMS_ROW_MAX_BYTES = 80;

/**
 * Append `runtime` to `prefix`, truncating `runtime` with a trailing `…` until the whole row fits
 * `SYSTEMS_ROW_MAX_BYTES` — the ONE place a row is shortened. `prefix` (the padded
 * ID/KIND/LAYER/ENV columns plus their separators) is never itself cut; a prefix alone longer than
 * the budget still gets `…` appended so the guarantee never silently fails to hold.
 */
function fitRow(prefix: string, runtime: string): string {
  const full = `${prefix}${runtime}`;
  if (utf8Bytes(full) <= SYSTEMS_ROW_MAX_BYTES) return full;
  let cut = runtime;
  while (cut.length > 0) {
    cut = cut.slice(0, -1);
    const candidate = `${prefix}${cut}…`;
    if (utf8Bytes(candidate) <= SYSTEMS_ROW_MAX_BYTES) return candidate;
  }
  return `${prefix}…`;
}

function environmentLine(e: SystemsDoc['environments']['dev']): string {
  if ('none' in e) return `none: ${e.none}`;
  return e.note ?? '-';
}

function runtimeOf(s: SystemsDoc['systems'][number]): string {
  return `${s.runtime.dev ?? '-'}→${s.runtime.prod ?? '-'}`;
}

/**
 * `repoboard systems` (§3.3): two environment lines, then — when there is any system — a
 * fixed-width `ID  KIND  LAYER  ENV  RUNTIME` table in file order (never resorted; file order is
 * the author's own order). `SYSTEMS_ROW_MAX_BYTES` holds for every row via `fitRow`.
 */
export function formatSystemsTable(doc: SystemsDoc): string {
  const lines: string[] = [
    `dev: ${environmentLine(doc.environments.dev)}`,
    `prod: ${environmentLine(doc.environments.prod)}`,
  ];
  if (doc.systems.length === 0) {
    lines.push('(no systems)');
    return `${lines.join('\n')}\n`;
  }

  const header = ['ID', 'KIND', 'LAYER', 'ENV'] as const;
  const rows = doc.systems.map((s) => [s.id, s.kind, s.layer, envTag(s.env)]);
  const allRows: readonly (readonly string[])[] = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...allRows.map((r) => (r[i] ?? '').length)));

  const prefixOf = (cells: readonly string[]): string =>
    cells.map((cell, i) => `${cell.padEnd(widths[i] ?? 0)}  `).join('');

  lines.push(fitRow(prefixOf(header), 'RUNTIME'));
  for (const s of doc.systems) {
    lines.push(fitRow(prefixOf([s.id, s.kind, s.layer, envTag(s.env)]), runtimeOf(s)));
  }

  return `${lines.join('\n')}\n`;
}

function sourceLine(s: Source): string {
  if ('detected' in s) return `detected ${s.detected} at ${s.at}`;
  return `hand ${s.hand} at ${s.at}`;
}

function connectionLine(c: Connection): string {
  return `  ${c.from} → ${c.to} (${c.via ?? '-'}) [${envTag(c.env)}]`;
}

/**
 * `repoboard systems show <id>` (§3.3): every field of one row, `null` when `id` is unknown.
 * Pointer RESOLUTION is the server's job — it appends `formatResolvedRefs` after this text; this
 * function only ever prints `pointers`/`docs` as raw, unresolved strings.
 */
export function formatSystemRow(doc: SystemsDoc, id: string): string | null {
  const system = doc.systems.find((s) => s.id === id);
  if (!system) return null;

  const lines: string[] = [
    `id: ${system.id}`,
    `name: ${system.name}`,
    `kind: ${system.kind}`,
    `layer: ${system.layer}`,
    `env: ${envTag(system.env)}`,
    `runtime dev: ${system.runtime.dev ?? '-'}`,
    `runtime prod: ${system.runtime.prod ?? '-'}`,
    `owner: ${system.owner ?? '-'}`,
    `why: ${system.why ?? '-'}`,
    `source: ${sourceLine(system.source)}`,
    'pointers:',
    ...(system.pointers.length > 0 ? system.pointers.map((p) => `  ${p}`) : ['  (none)']),
    'docs:',
    ...(system.docs.length > 0 ? system.docs.map((d) => `  ${d}`) : ['  (none)']),
    'connections:',
  ];

  const touching = doc.connections.filter((c) => c.from === id || c.to === id);
  if (touching.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of touching) lines.push(connectionLine(c));
  }

  return `${lines.join('\n')}\n`;
}
