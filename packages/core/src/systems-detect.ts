/**
 * RCB-96 A (plan docs/SYSTEMS-FLOW-PLAN.md §3.2): pure detectors that propose `systems.yml`
 * candidates from source-file text, a pure merge that never overwrites a hand row and stamps
 * provenance, and a pure serializer. Core has NO I/O (purity test): every detector here is
 * `(rel, text) => Candidates`; the server shell (brief B) reads files on disk, expands
 * `workspaceGlobs`, and calls these. A missing answer is `null`; what cannot be classified is
 * listed under `unclassified`, never guessed (CLAUDE.md conventions).
 */
import * as YAML from 'yaml';
import type {
  Connection,
  Environment,
  Source,
  SystemEnv,
  SystemKind,
  SystemLayer,
  SystemRow,
  SystemsDoc,
} from './systems.js';

// ---------------------------------------------------------------------------------------------
// Types (brief §"packages/core/src/systems-detect.ts")
// ---------------------------------------------------------------------------------------------

export type DetectedSystem = Pick<
  SystemRow,
  'id' | 'name' | 'kind' | 'layer' | 'env' | 'runtime' | 'pointers'
> & { detected: string };

export interface DetectedConnection {
  from: string;
  to: string;
  via: string | null;
  env: SystemEnv[];
  detected: string;
}

export interface RuntimeHint {
  dir: string;
  env: SystemEnv;
  value: string;
}

export interface Unclassified {
  file: string;
  what: string;
}

export interface Candidates {
  systems: DetectedSystem[];
  connections: DetectedConnection[];
  hints: RuntimeHint[];
  unclassified: Unclassified[];
}

export function emptyCandidates(): Candidates {
  return { systems: [], connections: [], hints: [], unclassified: [] };
}

function withUnclassified(file: string, what: string): Candidates {
  return { ...emptyCandidates(), unclassified: [{ file, what }] };
}

/** Strip a leading `@scope/`, lowercase, every run of chars outside `[a-z0-9]` -> `-`, trim `-`.
 * Empty -> `'unnamed'`. */
export function toSystemId(raw: string): string {
  const noScope = raw.replace(/^@[^/]+\//, '');
  const dashed = noScope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return dashed === '' ? 'unnamed' : dashed;
}

function dirnameOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '.' : rel.slice(0, idx);
}

function basenameNoExt(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

// ---------------------------------------------------------------------------------------------
// detectPackageJson
// ---------------------------------------------------------------------------------------------

const CLIENT_DEPS = ['vite', 'react', 'svelte', 'vue', 'next', 'astro'];
const SERVICE_DEPS = [
  'hono',
  '@hono/node-server',
  'express',
  'fastify',
  'koa',
  'wrangler',
  '@cloudflare/workers-types',
];

function hasAnyDep(pkg: Record<string, unknown>, names: string[]): boolean {
  const deps = {
    ...((pkg.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  return names.some((n) => n in deps);
}

export function detectPackageJson(rel: string, text: string): Candidates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return withUnclassified(rel, `${rel}: ${(e as Error).message}`);
  }
  const pkg = parsed as Record<string, unknown>;
  const name = pkg.name;
  if (typeof name !== 'string' || name === '') {
    return withUnclassified(rel, `${rel}: package.json has no "name"`);
  }
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  const runtime = { dev: scripts.dev ?? null, prod: scripts.deploy ?? scripts.start ?? null };
  const base = {
    id: toSystemId(name),
    name,
    env: ['dev', 'prod'] as SystemEnv[],
    runtime,
    pointers: [rel],
    detected: rel,
  };

  let kind: SystemKind;
  let layer: SystemLayer;
  if (pkg.bin) {
    kind = 'tool';
    layer = 'ops';
  } else if (hasAnyDep(pkg, CLIENT_DEPS)) {
    kind = 'client';
    layer = 'client';
  } else if (hasAnyDep(pkg, SERVICE_DEPS)) {
    kind = 'service';
    layer = 'app';
  } else {
    return withUnclassified(rel, `${rel}: package "${name}" — no bin, client, or server signal`);
  }
  return { ...emptyCandidates(), systems: [{ ...base, kind, layer }] };
}

/** Pure: `pnpm-workspace.yaml`'s `packages:` list if given, else package.json `workspaces`
 * (array or `{packages}`); dedup, drop entries starting with `!`. The shell expands them. */
export function workspaceGlobs(
  rootPackageJson: string,
  pnpmWorkspaceYaml: string | null,
): string[] {
  let globs: string[] = [];
  if (pnpmWorkspaceYaml !== null) {
    try {
      const doc = YAML.parse(pnpmWorkspaceYaml, { schema: 'core' }) as
        | { packages?: unknown }
        | null
        | undefined;
      globs = Array.isArray(doc?.packages)
        ? doc.packages.filter((p): p is string => typeof p === 'string')
        : [];
    } catch {
      globs = [];
    }
  } else {
    try {
      const pkg = JSON.parse(rootPackageJson) as { workspaces?: unknown };
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) {
        globs = ws.filter((p): p is string => typeof p === 'string');
      } else if (
        ws &&
        typeof ws === 'object' &&
        Array.isArray((ws as { packages?: unknown }).packages)
      ) {
        globs = (ws as { packages: unknown[] }).packages.filter(
          (p): p is string => typeof p === 'string',
        );
      }
    } catch {
      globs = [];
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// detectWrangler — a string-aware JSONC comment/trailing-comma stripper and a minimal TOML
// subset parser feed the SAME classifier, so `.jsonc` and `.toml` yield identical candidates.
// ---------------------------------------------------------------------------------------------

function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  let quote = '';
  while (i < n) {
    const c = text.charAt(i);
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === quote) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text.charAt(i + 1) === '/') {
      while (i < n && text.charAt(i) !== '\n') i++;
      continue;
    }
    if (c === '/' && text.charAt(i + 1) === '*') {
      i += 2;
      while (i < n && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        i++;
        out += text.charAt(i);
        continue;
      }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      const next = text.charAt(j);
      if (next === '}' || next === ']') continue;
    }
    out += c;
  }
  return out;
}

function stripTomlComment(line: string): string {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (inString) {
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let quote = '';
  let cur = '';
  for (const c of s) {
    if (inString) {
      cur += c;
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      cur += c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

function parseTomlLineValue(raw: string): TomlValue | undefined {
  const s = raw.trim();
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    const values: TomlValue[] = [];
    for (const item of splitTopLevel(inner, ',')) {
      const v = parseTomlLineValue(item.trim());
      if (v === undefined) return undefined;
      values.push(v);
    }
    return values;
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj: Record<string, TomlValue> = {};
    if (inner === '') return obj;
    for (const pair of splitTopLevel(inner, ',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) return undefined;
      const k = pair.slice(0, eq).trim();
      const v = parseTomlLineValue(pair.slice(eq + 1).trim());
      if (v === undefined) return undefined;
      obj[k] = v;
    }
    return obj;
  }
  return undefined;
}

function navigateTable(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let cur = root;
  for (const seg of path) {
    let next = cur[seg];
    if (next === undefined) {
      next = {};
      cur[seg] = next;
    }
    cur = next as Record<string, unknown>;
  }
  return cur;
}

function navigateArrayTable(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  const parents = path.slice(0, -1);
  const last = path[path.length - 1] ?? '';
  let cur = root;
  for (const seg of parents) {
    let next = cur[seg];
    if (next === undefined) {
      next = {};
      cur[seg] = next;
    }
    cur = next as Record<string, unknown>;
  }
  let arr = cur[last];
  if (!Array.isArray(arr)) {
    arr = [];
    cur[last] = arr;
  }
  const item: Record<string, unknown> = {};
  (arr as unknown[]).push(item);
  return item;
}

/** A minimal TOML subset: `#` comments (string-aware), `[table]`, `[[array.table]]`, dotted
 * table names, `key = "str" | 'str' | int | true/false | [ "a", "b" ] | { k = "v", ... }`. Any
 * other line becomes an `unclassified` entry naming the file and line, never a throw. */
function parseTomlSubset(
  rel: string,
  text: string,
): { data: Record<string, unknown>; unclassified: Unclassified[] } {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const unclassified: Unclassified[] = [];
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const stripped = stripTomlComment(lines[idx] ?? '').trim();
    if (stripped === '') continue;
    const arrTableMatch = stripped.match(/^\[\[([\w.-]+)]]$/);
    const tableMatch = stripped.match(/^\[([\w.-]+)]$/);
    const kvMatch = stripped.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (arrTableMatch?.[1] !== undefined) {
      current = navigateArrayTable(root, arrTableMatch[1].split('.'));
      continue;
    }
    if (tableMatch?.[1] !== undefined) {
      current = navigateTable(root, tableMatch[1].split('.'));
      continue;
    }
    if (kvMatch?.[1] !== undefined && kvMatch[2] !== undefined) {
      const value = parseTomlLineValue(kvMatch[2]);
      if (value === undefined) {
        unclassified.push({ file: rel, what: `${rel}:${lineNo}: not understood` });
        continue;
      }
      current[kvMatch[1]] = value;
      continue;
    }
    unclassified.push({ file: rel, what: `${rel}:${lineNo}: not understood` });
  }
  return { data: root, unclassified };
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const BINDING_ARRAYS: { path: string[]; kind: SystemKind; layer: SystemLayer }[] = [
  { path: ['hyperdrive'], kind: 'db', layer: 'data' },
  { path: ['d1_databases'], kind: 'db', layer: 'data' },
  { path: ['kv_namespaces'], kind: 'cache', layer: 'data' },
  { path: ['r2_buckets'], kind: 'storage', layer: 'data' },
  { path: ['queues', 'producers'], kind: 'queue', layer: 'data' },
  { path: ['queues', 'consumers'], kind: 'queue', layer: 'data' },
  { path: ['durable_objects', 'bindings'], kind: 'service', layer: 'app' },
  { path: ['services'], kind: 'service', layer: 'app' },
];

/** Order matters: the first of these present on a binding item names it (brief). */
const ID_FIELDS = ['database_name', 'bucket_name', 'queue', 'service', 'binding'] as const;

function buildWranglerCandidates(rel: string, cfg: Record<string, unknown>): Candidates {
  const name = cfg.name;
  if (typeof name !== 'string' || name === '') {
    return withUnclassified(rel, `${rel}: wrangler config has no "name"`);
  }
  const workerId = toSystemId(name);
  const env: SystemEnv[] = ['dev', 'prod'];
  const systems: DetectedSystem[] = [
    {
      id: workerId,
      name,
      kind: 'worker',
      layer: 'edge',
      env,
      runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
      pointers: [rel],
      detected: rel,
    },
  ];
  const connections: DetectedConnection[] = [];
  const unclassified: Unclassified[] = [];

  for (const { path, kind, layer } of BINDING_ARRAYS) {
    const arr = getPath(cfg, path);
    if (!Array.isArray(arr)) continue;
    const key = path.join('.');
    const isConsumer = (path[path.length - 1] ?? '') === 'consumers';
    for (const raw of arr) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const idField = ID_FIELDS.find((f) => typeof item[f] === 'string' && item[f] !== '');
      if (!idField) {
        unclassified.push({
          file: rel,
          what: `${rel}@${key}: no ${ID_FIELDS.join('/')} to name it`,
        });
        continue;
      }
      const idValue = item[idField] as string;
      const id = toSystemId(idValue);
      const bindingValue = typeof item.binding === 'string' ? item.binding : idValue;
      systems.push({
        id,
        name: idValue,
        kind,
        layer,
        env,
        runtime: { dev: null, prod: null },
        pointers: [rel],
        detected: `${rel}@${key}`,
      });
      const via = `${key} binding ${bindingValue}`;
      if (isConsumer) {
        connections.push({ from: id, to: workerId, via, env, detected: `${rel}@${key}` });
      } else {
        connections.push({ from: workerId, to: id, via, env, detected: `${rel}@${key}` });
      }
    }
  }

  const vars = cfg.vars;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const m = k.match(/^(.+)_API_KEY$/);
      if (!m || m[1] === undefined) continue;
      const stem = m[1];
      const id = toSystemId(stem);
      systems.push({
        id,
        name: stem,
        kind: 'external',
        layer: 'external',
        env,
        runtime: { dev: null, prod: null },
        pointers: [rel],
        detected: `${rel}@${k}`,
      });
      connections.push({ from: workerId, to: id, via: k, env, detected: `${rel}@${k}` });
    }
  }

  return { systems, connections, hints: [], unclassified };
}

export function detectWrangler(rel: string, text: string): Candidates {
  if (rel.endsWith('.toml')) {
    const { data, unclassified: parseUnclassified } = parseTomlSubset(rel, text);
    const built = buildWranglerCandidates(rel, data);
    return { ...built, unclassified: [...parseUnclassified, ...built.unclassified] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (e) {
    return withUnclassified(rel, `${rel}: ${(e as Error).message}`);
  }
  return buildWranglerCandidates(rel, parsed as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------------
// detectCompose
// ---------------------------------------------------------------------------------------------

const COMPOSE_KIND_BY_IMAGE: { re: RegExp; kind: SystemKind; layer: SystemLayer }[] = [
  { re: /postgres|mysql|mariadb/, kind: 'db', layer: 'data' },
  { re: /redis|memcached|valkey/, kind: 'cache', layer: 'data' },
  { re: /rabbitmq|kafka|nats/, kind: 'queue', layer: 'data' },
  { re: /minio/, kind: 'storage', layer: 'data' },
  { re: /mailhog|mailpit/, kind: 'email', layer: 'external' },
];

function extractHostPorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  const out: string[] = [];
  for (const p of ports) {
    if (typeof p === 'string') out.push(p.split(':')[0] ?? p);
    else if (typeof p === 'number') out.push(String(p));
    else if (p && typeof p === 'object' && 'published' in (p as Record<string, unknown>)) {
      out.push(String((p as Record<string, unknown>).published));
    }
  }
  return out;
}

export function detectCompose(rel: string, text: string): Candidates {
  let doc: unknown;
  try {
    doc = YAML.parse(text, { schema: 'core' });
  } catch (e) {
    return withUnclassified(rel, `${rel}: ${(e as Error).message}`);
  }
  const services = (doc as Record<string, unknown> | null)?.services;
  if (!services || typeof services !== 'object') {
    return withUnclassified(rel, `${rel}: no "services" map`);
  }
  const systems: DetectedSystem[] = [];
  const connections: DetectedConnection[] = [];
  const unclassified: Unclassified[] = [];
  const env: SystemEnv[] = ['dev'];

  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    const image = typeof svc.image === 'string' ? svc.image : null;
    const id = toSystemId(name);
    let kind: SystemKind | null = null;
    let layer: SystemLayer | null = null;
    if (image) {
      for (const rule of COMPOSE_KIND_BY_IMAGE) {
        if (rule.re.test(image)) {
          kind = rule.kind;
          layer = rule.layer;
          break;
        }
      }
    }
    let runtimeDev: string;
    if (kind && layer) {
      const ports = extractHostPorts(svc.ports);
      runtimeDev = ports.length > 0 ? `${image} :${ports.join(',')}` : `${image}`;
    } else if (svc.build !== undefined) {
      kind = 'service';
      layer = 'app';
      const build = svc.build;
      const context =
        typeof build === 'string'
          ? build
          : typeof (build as Record<string, unknown>)?.context === 'string'
            ? ((build as Record<string, unknown>).context as string)
            : '.';
      runtimeDev = `build ${context}`;
    } else {
      unclassified.push({
        file: rel,
        what: `${rel}: service "${name}" — no recognized image or build`,
      });
      continue;
    }
    systems.push({
      id,
      name,
      kind,
      layer,
      env,
      runtime: { dev: runtimeDev, prod: null },
      pointers: [rel],
      detected: `${rel}@${name}`,
    });
    const dependsOn = svc.depends_on;
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep === 'string') {
          connections.push({
            from: id,
            to: toSystemId(dep),
            via: 'depends_on',
            env,
            detected: `${rel}@${name}`,
          });
        }
      }
    } else if (dependsOn && typeof dependsOn === 'object') {
      for (const dep of Object.keys(dependsOn as Record<string, unknown>)) {
        connections.push({
          from: id,
          to: toSystemId(dep),
          via: 'depends_on',
          env,
          detected: `${rel}@${name}`,
        });
      }
    }
  }
  return { systems, connections, hints: [], unclassified };
}

// ---------------------------------------------------------------------------------------------
// detectDockerfile
// ---------------------------------------------------------------------------------------------

export function detectDockerfile(rel: string, text: string): Candidates {
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*FROM\s+(\S+)/i);
    if (m?.[1] !== undefined) {
      return {
        ...emptyCandidates(),
        hints: [{ dir: dirnameOf(rel), env: 'prod', value: `docker ${m[1]}` }],
      };
    }
  }
  return withUnclassified(rel, `${rel}: no FROM instruction`);
}

// ---------------------------------------------------------------------------------------------
// detectWorkflow
// ---------------------------------------------------------------------------------------------

function collectRunStrings(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRunStrings(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'run' && typeof v === 'string') out.push(v);
      else collectRunStrings(v, out);
    }
  }
}

export function detectWorkflow(rel: string, text: string): Candidates {
  let doc: unknown;
  try {
    doc = YAML.parse(text, { schema: 'core' });
  } catch (e) {
    return withUnclassified(rel, `${rel}: ${(e as Error).message}`);
  }
  const obj = (doc ?? {}) as Record<string, unknown>;
  const rawName = obj.name;
  const name = typeof rawName === 'string' && rawName !== '' ? rawName : basenameNoExt(rel);
  const id = toSystemId(name);
  const env: SystemEnv[] = ['dev', 'prod'];
  const system: DetectedSystem = {
    id,
    name,
    kind: 'ci',
    layer: 'ops',
    env,
    runtime: { dev: null, prod: null },
    pointers: [rel],
    detected: rel,
  };
  const runLines: string[] = [];
  collectRunStrings(obj, runLines);
  const seen = new Set<string>();
  const connections: DetectedConnection[] = [];
  for (const line of runLines) {
    let to: string | null = null;
    let via: string | null = null;
    if (/wrangler (deploy|publish)/.test(line)) {
      to = '@worker';
      via = 'wrangler deploy';
    } else if (/drizzle-kit (migrate|push)|prisma migrate/.test(line)) {
      to = '@db';
      via = 'migrate';
    }
    if (to && via) {
      const dedupeKey = `${id}|${to}|${via}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        connections.push({ from: id, to, via, env, detected: rel });
      }
    }
  }
  return { systems: [system], connections, hints: [], unclassified: [] };
}

// ---------------------------------------------------------------------------------------------
// detectEnvExample
// ---------------------------------------------------------------------------------------------

export function detectEnvExample(rel: string, text: string): Candidates {
  const systems: DetectedSystem[] = [];
  const unclassified: Unclassified[] = [];
  const env: SystemEnv[] = ['dev', 'prod'];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_.]+)=(.*)$/);
    if (!m || m[1] === undefined) continue;
    const key = m[1];
    const secretMatch = key.match(/^(.+)_(API_KEY|API_TOKEN|SECRET_KEY|ACCESS_TOKEN)$/);
    if (secretMatch?.[1] !== undefined) {
      const stem = secretMatch[1];
      systems.push({
        id: toSystemId(stem),
        name: stem,
        kind: 'external',
        layer: 'external',
        env,
        runtime: { dev: null, prod: null },
        pointers: [rel],
        detected: `${rel}@${key}`,
      });
      continue;
    }
    if (/_(URL|DSN)$/.test(key)) {
      unclassified.push({ file: rel, what: `${rel}: ${key} — a URL, not a system` });
    }
  }
  return { systems, connections: [], hints: [], unclassified };
}

// ---------------------------------------------------------------------------------------------
// detectViteConfig
// ---------------------------------------------------------------------------------------------

export function detectViteConfig(rel: string, text: string): Candidates {
  const m = text.match(/port\s*:\s*(\d+)/);
  if (!m || m[1] === undefined) return emptyCandidates();
  return {
    ...emptyCandidates(),
    hints: [{ dir: dirnameOf(rel), env: 'dev', value: `vite dev :${m[1]}` }],
  };
}

// ---------------------------------------------------------------------------------------------
// detectDrizzleConfig / detectPrismaSchema
// ---------------------------------------------------------------------------------------------

function dbSystemFromDialect(rel: string, dialect: string): Candidates {
  let id: string | null = null;
  if (dialect === 'postgresql' || dialect === 'postgres') id = 'postgres';
  else if (dialect === 'mysql') id = 'mysql';
  else if (dialect === 'sqlite' || dialect === 'libsql') id = 'sqlite';
  if (!id) return withUnclassified(rel, `${rel}: unknown dialect "${dialect}"`);
  return {
    ...emptyCandidates(),
    systems: [
      {
        id,
        name: id,
        kind: 'db',
        layer: 'data',
        env: ['dev', 'prod'],
        runtime: { dev: null, prod: null },
        pointers: [rel],
        detected: rel,
      },
    ],
  };
}

export function detectDrizzleConfig(rel: string, text: string): Candidates {
  const m = text.match(/dialect\s*:\s*['"](\w+)['"]/);
  if (!m || m[1] === undefined) return withUnclassified(rel, `${rel}: no "dialect" found`);
  return dbSystemFromDialect(rel, m[1]);
}

export function detectPrismaSchema(rel: string, text: string): Candidates {
  const dsBlock = text.match(/datasource\s+\w+\s*{([^}]*)}/);
  const scope = dsBlock?.[1] ?? text;
  const m = scope.match(/provider\s*=\s*"(\w+)"/);
  if (!m || m[1] === undefined)
    return withUnclassified(rel, `${rel}: no "provider" found in datasource`);
  return dbSystemFromDialect(rel, m[1]);
}

// ---------------------------------------------------------------------------------------------
// mergeCandidates
// ---------------------------------------------------------------------------------------------

/** Concatenates `parts`; dedups systems by id (first wins, pointers unioned in order); resolves
 * `'@worker'`/`'@db'` placeholders to the ONE system of that kind (else unclassified); applies
 * hints to the system whose pointers include `<dir>/package.json`, only where that runtime env
 * is still null (a hint never overwrites); dedups connections by `(from,to)`; a connection naming
 * an id not in `systems` becomes unclassified. */
export function mergeCandidates(parts: Candidates[]): Candidates {
  const allSystems = parts.flatMap((p) => p.systems);
  const allConnections = parts.flatMap((p) => p.connections);
  const allHints = parts.flatMap((p) => p.hints);
  const unclassified: Unclassified[] = parts.flatMap((p) => p.unclassified);

  const systemById = new Map<string, DetectedSystem>();
  for (const s of allSystems) {
    const existing = systemById.get(s.id);
    if (!existing) {
      systemById.set(s.id, { ...s, pointers: [...new Set(s.pointers)] });
      continue;
    }
    const pointers = [...existing.pointers];
    for (const p of s.pointers) if (!pointers.includes(p)) pointers.push(p);
    systemById.set(s.id, { ...existing, pointers });
  }
  const systems = [...systemById.values()];
  const systemIds = new Set(systems.map((s) => s.id));
  const workers = systems.filter((s) => s.kind === 'worker');
  const dbs = systems.filter((s) => s.kind === 'db');

  function resolvePlaceholder(idOrPlaceholder: string): { id: string } | { error: string } {
    if (idOrPlaceholder === '@worker') {
      const only = workers.length === 1 ? workers[0] : undefined;
      return only ? { id: only.id } : { error: 'worker' };
    }
    if (idOrPlaceholder === '@db') {
      const only = dbs.length === 1 ? dbs[0] : undefined;
      return only ? { id: only.id } : { error: 'db' };
    }
    return { id: idOrPlaceholder };
  }

  const resolvedConnections: DetectedConnection[] = [];
  for (const c of allConnections) {
    const fromR = resolvePlaceholder(c.from);
    const toR = resolvePlaceholder(c.to);
    if ('error' in fromR || 'error' in toR) {
      const kind = 'error' in fromR ? fromR.error : (toR as { error: string }).error;
      unclassified.push({
        file: c.detected,
        what: `${c.detected}: no unique ${kind} system to connect to`,
      });
      continue;
    }
    const from = fromR.id;
    const to = toR.id;
    if (!systemIds.has(from) || !systemIds.has(to)) {
      unclassified.push({
        file: c.detected,
        what: `${c.detected}: connection ${from}→${to} names an unknown system`,
      });
      continue;
    }
    resolvedConnections.push({ ...c, from, to });
  }

  const seenPairs = new Set<string>();
  const connections: DetectedConnection[] = [];
  for (const c of resolvedConnections) {
    const key = `${c.from}→${c.to}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    connections.push(c);
  }

  for (const hint of allHints) {
    const pkgPointer = hint.dir === '.' ? 'package.json' : `${hint.dir}/package.json`;
    const target = systems.find((s) => s.pointers.includes(pkgPointer));
    if (!target) {
      unclassified.push({
        file: hint.dir,
        what: `${hint.value}: no system at "${pkgPointer}" to attach to`,
      });
      continue;
    }
    const current = target.runtime[hint.env];
    if (current !== null && current !== undefined) continue;
    target.runtime = { ...target.runtime, [hint.env]: hint.value };
  }

  return { systems, connections, hints: [], unclassified };
}

// ---------------------------------------------------------------------------------------------
// applyDetected / staleDetected
// ---------------------------------------------------------------------------------------------

/** K15: drop every env whose `doc.environments[env]` is `{ none }` — a prod-none repo should not
 * need a hand edit on every detected row or connection. Inert rule: never write an empty env
 * list; if filtering would empty it, keep the candidate's env unchanged. */
function filterNoneEnvs(doc: SystemsDoc, env: SystemEnv[]): SystemEnv[] {
  const filtered = env.filter((e) => !('none' in doc.environments[e]));
  return filtered.length === 0 ? env : filtered;
}

export function applyDetected(
  doc: SystemsDoc,
  c: Candidates,
  at: string,
): { doc: SystemsDoc; added: string[]; updated: string[]; skipped: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  const systems = [...doc.systems];
  for (const cand of c.systems) {
    const idx = systems.findIndex((s) => s.id === cand.id);
    if (idx === -1) {
      systems.push({
        id: cand.id,
        name: cand.name,
        kind: cand.kind,
        layer: cand.layer,
        env: filterNoneEnvs(doc, cand.env),
        runtime: { dev: cand.runtime.dev ?? null, prod: cand.runtime.prod ?? null },
        owner: null,
        pointers: cand.pointers,
        docs: [],
        why: null,
        source: { detected: cand.detected, at },
      });
      added.push(cand.id);
      continue;
    }
    const existing = systems[idx];
    if (existing === undefined) continue;
    if ('hand' in existing.source) {
      skipped.push(cand.id);
      continue;
    }
    systems[idx] = {
      id: cand.id,
      name: cand.name,
      kind: cand.kind,
      layer: cand.layer,
      env: filterNoneEnvs(doc, cand.env),
      runtime: { dev: cand.runtime.dev ?? null, prod: cand.runtime.prod ?? null },
      owner: existing.owner,
      pointers: cand.pointers,
      docs: existing.docs,
      why: existing.why,
      source: { detected: cand.detected, at },
    };
    updated.push(cand.id);
  }

  const connections = [...doc.connections];
  for (const cand of c.connections) {
    const idx = connections.findIndex((cn) => cn.from === cand.from && cn.to === cand.to);
    const key = `${cand.from}→${cand.to}`;
    if (idx === -1) {
      connections.push({
        from: cand.from,
        to: cand.to,
        via: cand.via,
        env: filterNoneEnvs(doc, cand.env),
        source: { detected: cand.detected, at },
      });
      added.push(key);
      continue;
    }
    const existing = connections[idx];
    if (existing === undefined) continue;
    if ('hand' in existing.source) {
      skipped.push(key);
      continue;
    }
    connections[idx] = {
      from: cand.from,
      to: cand.to,
      via: cand.via,
      env: filterNoneEnvs(doc, cand.env),
      source: { detected: cand.detected, at },
    };
    updated.push(key);
  }

  return {
    doc: { environments: doc.environments, systems, connections },
    added,
    updated,
    skipped,
  };
}

/** Ids of `source.detected` systems absent from `c.systems` (PH.3's `systems-stale` reads
 * this). */
export function staleDetected(doc: SystemsDoc, c: Candidates): string[] {
  const candidateIds = new Set(c.systems.map((s) => s.id));
  return doc.systems
    .filter((s) => 'detected' in s.source && !candidateIds.has(s.id))
    .map((s) => s.id);
}

// ---------------------------------------------------------------------------------------------
// formatDetectReport / serializeSystems
// ---------------------------------------------------------------------------------------------

export function formatDetectReport(
  c: Candidates,
  plan: { added: string[]; updated: string[]; skipped: string[] },
): string {
  const headers = ['ID', 'KIND', 'LAYER', 'ENV', 'FROM'];
  const rows = c.systems.map((s) => [s.id, s.kind, s.layer, s.env.join(','), s.detected]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const padRow = (cols: string[]) =>
    cols
      .map((v, i) => v.padEnd(widths[i] ?? v.length))
      .join('  ')
      .trimEnd();

  const lines: string[] = [padRow(headers)];
  for (const r of rows) lines.push(padRow(r));
  for (const conn of c.connections) {
    lines.push(`connections: ${conn.from}→${conn.to} (${conn.via ?? 'null'})`);
  }
  if (c.unclassified.length > 0) {
    lines.push('unclassified:');
    for (const u of c.unclassified) lines.push(`  ${u.file}: ${u.what}`);
  }
  lines.push(
    `${c.systems.length} systems, ${c.connections.length} connections, ${c.unclassified.length} unclassified — ${plan.added.length} to add, ${plan.updated.length} to update, ${plan.skipped.length} hand rows kept`,
  );
  return lines.join('\n');
}

function serializeEnvironment(e: Environment): Record<string, unknown> {
  if ('none' in e) return { none: e.none };
  return { note: e.note };
}

function serializeSource(s: Source): Record<string, unknown> {
  if ('detected' in s) return { detected: s.detected, at: s.at };
  return { hand: s.hand, at: s.at };
}

/** `YAML.stringify(ordered, { schema: 'core', lineWidth: 0 })`, key order `environments ->
 * systems -> connections`, row keys in §3.1 order; omits `owner`/`why`/`via` when null, `docs`
 * when empty, a `runtime` key when null (`parseSystems` normalises them back). Round-trips. */
export function serializeSystems(doc: SystemsDoc): string {
  const environments = {
    dev: serializeEnvironment(doc.environments.dev),
    prod: serializeEnvironment(doc.environments.prod),
  };
  const systems = doc.systems.map((s) => {
    const runtime: Record<string, string> = {};
    if (s.runtime.dev !== null && s.runtime.dev !== undefined) runtime.dev = s.runtime.dev;
    if (s.runtime.prod !== null && s.runtime.prod !== undefined) runtime.prod = s.runtime.prod;
    const row: Record<string, unknown> = {
      id: s.id,
      name: s.name,
      kind: s.kind,
      layer: s.layer,
      env: s.env,
      runtime,
    };
    if (s.owner !== null) row.owner = s.owner;
    row.pointers = s.pointers;
    if (s.docs.length > 0) row.docs = s.docs;
    if (s.why !== null) row.why = s.why;
    row.source = serializeSource(s.source);
    return row;
  });
  const connections = doc.connections.map((c: Connection) => {
    const row: Record<string, unknown> = { from: c.from, to: c.to };
    if (c.via !== null) row.via = c.via;
    row.env = c.env;
    row.source = serializeSource(c.source);
    return row;
  });
  const ordered = { environments, systems, connections };
  return YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
}
