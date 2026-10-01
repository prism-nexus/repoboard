/**
 * RCB-96 A (plan docs/SYSTEMS-FLOW-PLAN.md §3.2): pure detectors that propose `systems.yml`
 * candidates from source-file text, a pure merge that never overwrites a hand row and stamps
 * provenance, and a pure serializer. Core has NO I/O (purity test): every detector here is
 * `(rel, text) => Candidates`; the server shell (brief B) reads files on disk, expands
 * `workspaceGlobs`, and calls these. A missing answer is `null`; what cannot be classified is
 * listed under `unclassified`, never guessed (CLAUDE.md conventions).
 */
import * as YAML from 'yaml';
import { parseRef, splitLines } from './refs.js';
import type {
  Connection,
  Environment,
  Rejection,
  Source,
  SystemEnv,
  SystemKind,
  SystemLayer,
  SystemRow,
  SystemStatus,
  SystemsDoc,
} from './systems.js';

// ---------------------------------------------------------------------------------------------
// Types (brief §"packages/core/src/systems-detect.ts")
// ---------------------------------------------------------------------------------------------

export type DetectedSystem = Pick<
  SystemRow,
  'id' | 'name' | 'kind' | 'layer' | 'env' | 'runtime' | 'pointers'
> & { detected: string; status?: SystemStatus; why?: string };

export interface DetectedConnection {
  from: string;
  to: string;
  via: string | null;
  env: SystemEnv[];
  detected: string;
  /** RCB-177: the source lines that show this connection (`rel:L12-L16`), as the connection's
   * `pointers`. Absent (never a whole-file guess) when the detector could not locate them. */
  pointers?: string[];
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
// RCB-177: line-accurate evidence. A detector that reads `hyperdrive[0].binding` out of a 200-line
// `wrangler.jsonc` used to record `detected: "wrangler.jsonc@hyperdrive"` and a whole-file pointer,
// so a reader landed on line 1. `locateEvidence` finds the LINES a value was read from; a detector
// records `rel:L12-L16` when it can and keeps the old `rel@key` (and the whole-file pointer) when
// it cannot: a line is found or absent, never guessed.
// ---------------------------------------------------------------------------------------------

/** A 1-based inclusive line range of a source file: the `:L<start>-L<end>` a ref names. */
export interface LineRange {
  start: number;
  end: number;
}

/** A widened range longer than this is no longer an evidence excerpt: `locateEvidence` answers
 * with the one line it found instead. */
export const EVIDENCE_MAX_LINES = 40;

/** How `locateEvidence` reads a file. `json`: JSON/JSONC, by brackets (string- and comment-aware).
 * `yaml`: mappings, by indentation. `toml`: `[table]` / `[[array.table]]` headers. `text`: any
 * other file, one line. */
export type EvidenceFormat = 'json' | 'yaml' | 'toml' | 'text';

/** `rel:L<n>` for a one-line range, `rel:L<a>-L<b>` otherwise (the `path:L10-L20` ref grammar). */
export function lineEvidence(rel: string, range: LineRange): string {
  return range.start === range.end
    ? `${rel}:L${range.start}`
    : `${rel}:L${range.start}-L${range.end}`;
}

const TOKEN_CHAR = /[A-Za-z0-9_-]/;

/** Column of the first occurrence of `needle` in `line` as a WHOLE token (no `[A-Za-z0-9_-]` on
 * either side), or -1. `queue` matches `"queue"` and a bare `queue:`, not `queues` or `db-queue`;
 * a quoted needle needs no case of its own, because the quote is the boundary. */
function tokenColumn(line: string, needle: string, start = 0): number {
  if (needle === '') return -1;
  let from = start;
  for (;;) {
    const at = line.indexOf(needle, from);
    if (at === -1) return -1;
    const before = at === 0 ? '' : line.charAt(at - 1);
    const after = line.charAt(at + needle.length);
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return at;
    from = at + 1;
  }
}

/** Column of `value` in a `field` written as `"field": "value"`, `field: value` or `field = "value"`
 * on this line, or -1: the value must be the one the key is set to, not any other mention of it
 * (`"dead_letter_queue": "jobs-dlq"` is not where the queue named `jobs-dlq` is declared). */
function fieldValueColumn(line: string, field: string, value: string): number {
  let from = 0;
  for (;;) {
    const at = tokenColumn(line, field, from);
    if (at === -1) return -1;
    let rest = line.slice(at + field.length);
    if (rest.startsWith('"') || rest.startsWith("'")) rest = rest.slice(1);
    const sep = /^\s*[:=]\s*["']?/.exec(rest)?.[0];
    if (sep !== undefined && rest.startsWith(value, sep.length)) {
      if (!TOKEN_CHAR.test(rest.charAt(sep.length + value.length))) {
        return line.length - rest.length + sep.length;
      }
    }
    from = at + 1;
  }
}

/** Per line: is it ONLY a comment (`//`, `#`, or inside or around a block comment)? Such a line
 * is never evidence: a token named in a comment is not the value the detector parsed. */
function commentLines(lines: readonly string[]): boolean[] {
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {
        inBlock = false;
        return t.endsWith('*/');
      }
      return true;
    }
    if (t.startsWith('//') || t.startsWith('#')) return true;
    if (t.startsWith('/*')) {
      if (t.includes('*/', 2)) return t.endsWith('*/');
      inBlock = true;
      return true;
    }
    return false;
  });
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

interface BracketPair {
  kind: '{' | '[';
  /** The kind of the pair this one sits directly in; `null` for the outermost. */
  parent: '{' | '[' | null;
  /** 1 for the outermost pair. */
  depth: number;
  openLine: number;
  openCol: number;
  closeLine: number;
  closeCol: number;
}

/** Every `{}`/`[]` pair of JSON/JSONC text, string- and comment-aware (a bracket inside `"..."`
 * or a comment is not one). `[]` (no extents at all) when the brackets do not balance: a file
 * that cannot be read yields single lines, never a guessed extent. */
function bracketPairs(lines: readonly string[]): BracketPair[] {
  const pairs: BracketPair[] = [];
  const stack: { kind: '{' | '['; line: number; col: number }[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const c = line.charAt(j);
      if (inBlock) {
        if (c === '*' && line.charAt(j + 1) === '/') {
          inBlock = false;
          j++;
        }
        continue;
      }
      if (quote !== null) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '/' && line.charAt(j + 1) === '/') break;
      if (c === '/' && line.charAt(j + 1) === '*') {
        inBlock = true;
        j++;
        continue;
      }
      if (c === '{' || c === '[') {
        stack.push({ kind: c, line: i + 1, col: j });
        continue;
      }
      if (c === '}' || c === ']') {
        const open = stack.pop();
        if (open === undefined || (open.kind === '{') !== (c === '}')) return [];
        pairs.push({
          kind: open.kind,
          parent: stack[stack.length - 1]?.kind ?? null,
          depth: stack.length + 1,
          openLine: open.line,
          openCol: open.col,
          closeLine: i + 1,
          closeCol: j,
        });
      }
    }
  }
  return stack.length === 0 ? pairs : [];
}

/** The innermost pair strictly around (line, col), or `null`. */
function innermost(pairs: readonly BracketPair[], line: number, col: number): BracketPair | null {
  let best: BracketPair | null = null;
  for (const p of pairs) {
    const afterOpen = line > p.openLine || (line === p.openLine && col > p.openCol);
    const beforeClose = line < p.closeLine || (line === p.closeLine && col < p.closeCol);
    if (afterOpen && beforeClose && (best === null || p.depth > best.depth)) best = p;
  }
  return best;
}

/** A located token: the line it is on, and the lines it stands for (not yet size-capped, because
 * a chain searches INSIDE the extent of the token before it). */
interface Hit {
  line: number;
  extent: LineRange;
}

/** Column of chain token `t` on `line`, or -1: the token as a whole word — or, for the LAST
 * token of a chain given a `field`, that word as the value of `field`. */
type ColumnOf = (line: string, t: number) => number;

/** JSON: what a token at (line, col) stands for. (a) A bracket its line OPENS after the token and
 * does not close on that line (`"hyperdrive": [`) stands for everything to its closer. (b) Else a
 * token inside an OBJECT THAT IS AN ARRAY ELEMENT (a binding record) stands for that record.
 * (c) Else just its line: a scalar `"KEY": "v"` of a `vars` map is one line, however big the map. */
function jsonExtent(pairs: readonly BracketPair[], line: number, col: number): LineRange {
  let opened: BracketPair | null = null;
  for (const p of pairs) {
    if (p.openLine !== line || p.openCol <= col || p.closeLine <= line) continue;
    if (opened === null || p.openCol < opened.openCol) opened = p;
  }
  if (opened !== null) return { start: line, end: opened.closeLine };
  const around = innermost(pairs, line, col);
  if (around !== null && around.kind === '{' && around.parent === '[') {
    return { start: around.openLine, end: around.closeLine };
  }
  return { start: line, end: line };
}

/** `json`: every token but the last must be a DIRECT child key of the one before it (of the root
 * object, for the first), so a `hyperdrive` under `env.production` is never taken for the
 * top-level one; the last is searched anywhere inside the extent of the one before it. */
function locateJson(
  lines: readonly string[],
  comment: readonly boolean[],
  count: number,
  columnOf: ColumnOf,
): Hit | null {
  const pairs = bracketPairs(lines);
  let region: LineRange = { start: 1, end: lines.length };
  let hit: Hit | null = null;
  for (let t = 0; t < count; t++) {
    hit = null;
    for (let i = region.start - 1; i <= region.end - 1; i++) {
      if (comment[i]) continue;
      const col = columnOf(lines[i] ?? '', t);
      if (col === -1) continue;
      if (t < count - 1) {
        const around = innermost(pairs, i + 1, col);
        if (around === null || around.kind !== '{' || around.depth !== t + 1) continue;
      }
      hit = { line: i + 1, extent: jsonExtent(pairs, i + 1, col) };
      break;
    }
    if (hit === null) return null;
    region = hit.extent;
  }
  return hit;
}

/** YAML: does `line` open the mapping key `key` (bare or quoted, then `:` and a space or the end)? */
function isYamlKey(line: string, key: string): boolean {
  const t = line.trimStart();
  const quote = t.charAt(0);
  const quoted =
    (quote === '"' || quote === "'") && t.startsWith(key, 1) && t.charAt(1 + key.length) === quote;
  const rest = quoted ? t.slice(key.length + 2) : t.startsWith(key) ? t.slice(key.length) : null;
  if (rest === null || !rest.startsWith(':')) return false;
  return rest.length === 1 || /\s/.test(rest.charAt(1));
}

/** `yaml`: every token is a mapping key and a direct child of the one before it (the indent of
 * its parent block's first line); a key stands for its indented block. */
function locateYaml(
  lines: readonly string[],
  comment: readonly boolean[],
  tokens: readonly string[],
): Hit | null {
  let first = 0;
  let last = lines.length - 1;
  let hit: Hit | null = null;
  for (const token of tokens) {
    hit = null;
    let childIndent = -1;
    for (let i = first; i <= last; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '' || comment[i]) continue;
      if (childIndent === -1) childIndent = leadingSpaces(line);
      if (leadingSpaces(line) !== childIndent || !isYamlKey(line, token)) continue;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? '';
        if (next.trim() === '' || comment[j]) continue;
        if (leadingSpaces(next) <= childIndent) break;
        end = j;
      }
      hit = { line: i + 1, extent: { start: i + 1, end: end + 1 } };
      break;
    }
    if (hit === null) return null;
    first = hit.line;
    last = hit.extent.end - 1;
  }
  return hit;
}

const TOML_HEADER = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

/** `toml`: every token but the last names the table (`['queues','producers']` is
 * `[queues.producers]` or `[[queues.producers]]`); the last is searched only between such a header
 * and the next header, for each header of that name in turn (an array of tables repeats its
 * header). A lone token is searched over the whole file. */
function locateToml(
  lines: readonly string[],
  comment: readonly boolean[],
  tokens: readonly string[],
  columnOf: ColumnOf,
): Hit | null {
  const last = tokens.length - 1;
  const table = tokens.slice(0, last).join('.');
  if (table === '') return locateText(lines, comment, 1, (line) => columnOf(line, 0));
  const headerAt = (i: number): string | null =>
    comment[i] ? null : (TOML_HEADER.exec((lines[i] ?? '').trim())?.[1] ?? null);
  for (let h = 0; h < lines.length; h++) {
    if (headerAt(h) !== table) continue;
    for (let i = h + 1; i < lines.length; i++) {
      if (headerAt(i) !== null) break;
      if (!comment[i] && columnOf(lines[i] ?? '', last) !== -1) {
        return { line: i + 1, extent: { start: i + 1, end: i + 1 } };
      }
    }
  }
  return null;
}

/** `text`: each token is searched from the line the one before it was found on, to the end. */
function locateText(
  lines: readonly string[],
  comment: readonly boolean[],
  count: number,
  columnOf: ColumnOf,
): Hit | null {
  let from = 0;
  let hit: Hit | null = null;
  for (let t = 0; t < count; t++) {
    hit = null;
    for (let i = from; i < lines.length; i++) {
      if (comment[i] || columnOf(lines[i] ?? '', t) === -1) continue;
      hit = { line: i + 1, extent: { start: i + 1, end: i + 1 } };
      break;
    }
    if (hit === null) return null;
    from = hit.line - 1;
  }
  return hit;
}

/**
 * The 1-based [start,end] lines where `chain` is written in `text`, or `null` when any link is not
 * found. `chain` is a token, or the tokens of a path read left to right: each is searched only
 * inside the one before it, so `['queues', 'producers', 'jobs']` finds the `"jobs"` INSIDE
 * `"producers"` inside `"queues"`, never an earlier `"jobs"` under `"consumers"`.
 *
 * A token matches as a whole word, bare or quoted (`jobs`, `"jobs"`, `'jobs'`), on the first line
 * that has it; a line that is only a comment never matches. With `field`, the LAST token must be
 * the value that `field` is set to on the line (`"queue": "jobs"`), not any other mention of it
 * (`"dead_letter_queue": "jobs"`); `yaml` ignores `field`. The range is that one line, WIDENED
 * by `format` (default `text`, which never widens): `json` to the bracket pair the line opens or
 * the array-element object it sits in, `yaml` to the key's indented block. A widened range longer
 * than `EVIDENCE_MAX_LINES` is the one line instead. The per-format rules are on the `locate*`
 * functions above.
 */
export function locateEvidence(
  text: string,
  chain: string | readonly string[],
  opts: { format?: EvidenceFormat; field?: string } = {},
): LineRange | null {
  const tokens = typeof chain === 'string' ? [chain] : chain;
  if (tokens.length === 0) return null;
  const lines = splitLines(text);
  const comment = commentLines(lines);
  const format = opts.format ?? 'text';
  const { field } = opts;
  const columnOf: ColumnOf = (line, t) => {
    const token = tokens[t] ?? '';
    return field !== undefined && t === tokens.length - 1
      ? fieldValueColumn(line, field, token)
      : tokenColumn(line, token);
  };
  const hit =
    format === 'json'
      ? locateJson(lines, comment, tokens.length, columnOf)
      : format === 'yaml'
        ? locateYaml(lines, comment, tokens)
        : format === 'toml'
          ? locateToml(lines, comment, tokens, columnOf)
          : locateText(lines, comment, tokens.length, columnOf);
  if (hit === null) return null;
  const size = hit.extent.end - hit.extent.start + 1;
  return size <= EVIDENCE_MAX_LINES ? hit.extent : { start: hit.line, end: hit.line };
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

/** RCB-161 slice 3 (plan §3.2): a package with no bin/client/server signal is proposed as a
 * `planned` `external` system, never silently dropped to unclassified, when its name looks like
 * one of these known third-party integrations or it lives under an `integrations/` directory. */
export const KNOWN_INTEGRATIONS = [
  'shopify',
  'qbo',
  'quickbooks',
  'stripe',
  'resend',
  'sendgrid',
  'postmark',
  'mailgun',
  'twilio',
  'plaid',
  'square',
  'paypal',
  'xero',
  'hubspot',
  'salesforce',
  'slack',
] as const;

function isKnownIntegrationToken(token: string): boolean {
  return (KNOWN_INTEGRATIONS as readonly string[]).includes(token);
}

/** Signal text for the no-signal branch of `detectPackageJson`, or `null` when nothing about
 * `id`/`rel` looks integration-shaped. Name wins over directory when both match (brief). */
function integrationSignal(id: string, rel: string): string | null {
  const token = id.split('-').find(isKnownIntegrationToken);
  if (token !== undefined) return `name matches "${token}"`;
  const dirSegments = dirnameOf(rel).split('/');
  if (dirSegments.includes('integrations')) return 'under integrations/';
  return null;
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
    const signal = integrationSignal(base.id, rel);
    if (signal === null) {
      return withUnclassified(rel, `${rel}: package "${name}" — no bin, client, or server signal`);
    }
    return {
      ...emptyCandidates(),
      systems: [
        {
          ...base,
          kind: 'external',
          layer: 'external',
          status: 'planned',
          why: `package "${name}" looks like an integration (${signal}) but has no bin, client, or server signal — proposed as planned`,
        },
      ],
    };
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

/** RCB-177: the `detected` string and pointers for something read from `text` — the located
 * lines (`rel:L12-L16`) as both, or, when not found, the old `fallback` (`rel@key`) and NO
 * connection pointer; a system then keeps its whole-file pointer, as before. `connectionPointers`
 * is a function so every connection gets ITS OWN array: two rows sharing one array serialize as a
 * YAML anchor/alias (`&a1` / `*a1`), which does not survive a re-read byte-for-byte. */
function evidenceFor(
  rel: string,
  at: LineRange | null,
  fallback: string,
): {
  detected: string;
  systemPointers: string[];
  connectionPointers: () => { pointers?: string[] };
} {
  if (at === null) {
    return { detected: fallback, systemPointers: [rel], connectionPointers: () => ({}) };
  }
  const detected = lineEvidence(rel, at);
  return {
    detected,
    systemPointers: [detected],
    connectionPointers: () => ({ pointers: [detected] }),
  };
}

function buildWranglerCandidates(
  rel: string,
  cfg: Record<string, unknown>,
  text: string,
  format: EvidenceFormat,
): Candidates {
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
      // RCB-177: the binding's own lines — `["queues","producers","<queue name>"]` finds that
      // name inside `producers`, not an earlier one under `consumers`.
      const ev = evidenceFor(
        rel,
        locateEvidence(text, [...path, idValue], { format, field: idField }),
        `${rel}@${key}`,
      );
      systems.push({
        id,
        name: idValue,
        kind,
        layer,
        env,
        runtime: { dev: null, prod: null },
        pointers: ev.systemPointers,
        detected: ev.detected,
      });
      const via = `${key} binding ${bindingValue}`;
      const [from, to] = isConsumer ? [id, workerId] : [workerId, id];
      connections.push({ from, to, via, env, detected: ev.detected, ...ev.connectionPointers() });
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
      const ev = evidenceFor(rel, locateEvidence(text, ['vars', k], { format }), `${rel}@${k}`);
      systems.push({
        id,
        name: stem,
        kind: 'external',
        layer: 'external',
        env,
        runtime: { dev: null, prod: null },
        pointers: ev.systemPointers,
        detected: ev.detected,
      });
      connections.push({
        from: workerId,
        to: id,
        via: k,
        env,
        detected: ev.detected,
        ...ev.connectionPointers(),
      });
    }
  }

  return { systems, connections, hints: [], unclassified };
}

export function detectWrangler(rel: string, text: string): Candidates {
  if (rel.endsWith('.toml')) {
    const { data, unclassified: parseUnclassified } = parseTomlSubset(rel, text);
    const built = buildWranglerCandidates(rel, data, text, 'toml');
    return { ...built, unclassified: [...parseUnclassified, ...built.unclassified] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (e) {
    return withUnclassified(rel, `${rel}: ${(e as Error).message}`);
  }
  return buildWranglerCandidates(rel, parsed as Record<string, unknown>, text, 'json');
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
    // RCB-177: the service's own block (`  db:` down to its last indented line).
    const ev = evidenceFor(
      rel,
      locateEvidence(text, ['services', name], { format: 'yaml' }),
      `${rel}@${name}`,
    );
    systems.push({
      id,
      name,
      kind,
      layer,
      env,
      runtime: { dev: runtimeDev, prod: null },
      pointers: ev.systemPointers,
      detected: ev.detected,
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
            detected: ev.detected,
            ...ev.connectionPointers(),
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
          detected: ev.detected,
          ...ev.connectionPointers(),
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
  const rawLines = text.split('\n');
  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = (rawLines[idx] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_.]+)=(.*)$/);
    if (!m || m[1] === undefined) continue;
    const key = m[1];
    const secretMatch = key.match(/^(.+)_(API_KEY|API_TOKEN|SECRET_KEY|ACCESS_TOKEN)$/);
    if (secretMatch?.[1] !== undefined) {
      const stem = secretMatch[1];
      // RCB-177: the `KEY=` line itself (this loop is already on it — no search, no guess).
      const at = lineEvidence(rel, { start: idx + 1, end: idx + 1 });
      systems.push({
        id: toSystemId(stem),
        name: stem,
        kind: 'external',
        layer: 'external',
        env,
        runtime: { dev: null, prod: null },
        pointers: [at],
        detected: at,
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

/** 1-based line of character offset `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function dbSystemFromDialect(rel: string, dialect: string, line: number): Candidates {
  let id: string | null = null;
  if (dialect === 'postgresql' || dialect === 'postgres') id = 'postgres';
  else if (dialect === 'mysql') id = 'mysql';
  else if (dialect === 'sqlite' || dialect === 'libsql') id = 'sqlite';
  if (!id) return withUnclassified(rel, `${rel}: unknown dialect "${dialect}"`);
  // RCB-177: the `dialect`/`provider` line the value was read from, not the whole config file.
  const at = lineEvidence(rel, { start: line, end: line });
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
        pointers: [at],
        detected: at,
      },
    ],
  };
}

export function detectDrizzleConfig(rel: string, text: string): Candidates {
  const m = /dialect\s*:\s*['"](\w+)['"]/.exec(text);
  if (!m || m[1] === undefined) return withUnclassified(rel, `${rel}: no "dialect" found`);
  return dbSystemFromDialect(rel, m[1], lineAt(text, m.index));
}

export function detectPrismaSchema(rel: string, text: string): Candidates {
  const dsBlock = /datasource\s+\w+\s*{([^}]*)}/.exec(text);
  const scope = dsBlock?.[1] ?? text;
  const m = /provider\s*=\s*"(\w+)"/.exec(scope);
  if (!m || m[1] === undefined)
    return withUnclassified(rel, `${rel}: no "provider" found in datasource`);
  // The block body starts right after its `{`, one character before the closing `}` it ends on.
  const scopeStart = dsBlock ? dsBlock.index + dsBlock[0].length - 1 - scope.length : 0;
  return dbSystemFromDialect(rel, m[1], lineAt(text, scopeStart + m.index));
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
    // RCB-161 slice 3: a later part's status/why (e.g. the package.json row) fill the kept
    // system's ONLY where the kept one (first wins) has none — an env-example row detected
    // first never loses to a later duplicate, but it also never carries a status of its own.
    const status = existing.status ?? s.status;
    const why = existing.why ?? s.why;
    systemById.set(s.id, { ...existing, pointers, status, why });
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

/** RCB-173: the row a candidate means. A detector knows only (from,to) — it never has an `id` —
 * and `parseSystems` guarantees a pair is unique unless every row of it carries its own `id`. So a
 * candidate matches the pair's id-less row, else (every row of the pair has an id) the pair's
 * first: never `-1` for a pair that exists, so `applyDetected` cannot add a second, id-less row
 * that would make the next parse fail. */
function findConnection(connections: readonly Connection[], from: string, to: string): number {
  const idless = connections.findIndex((c) => c.from === from && c.to === to && c.id === undefined);
  return idless !== -1 ? idless : connections.findIndex((c) => c.from === from && c.to === to);
}

/** RCB-173: the hand-written `id`/`label`/`pointers` of a connection an update keeps — only the
 * keys it actually has (no `label: undefined`), so `serializeSystems` never writes an empty one. */
function connectionExtras(c: Connection): Pick<Connection, 'id' | 'label' | 'pointers'> {
  return {
    ...(c.id !== undefined ? { id: c.id } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.pointers !== undefined && c.pointers.length > 0 ? { pointers: c.pointers } : {}),
  };
}

/** RCB-177: the pointers of an UPDATED detected connection. A detector's fresh `:L` range
 * replaces the stale one it wrote last run — the file moved, and a range that no longer shows the
 * binding is worse than none — and every OTHER pointer (a hand-added `path@Token`, `path#Heading`,
 * a pointer to another file) is kept. A `:L` range in a file the candidate does not point at is
 * kept too. A candidate with no pointers (unlocated) changes nothing. */
function mergeDetectedPointers(
  existing: readonly string[] | undefined,
  fresh: readonly string[] | undefined,
): string[] | undefined {
  if (fresh === undefined || fresh.length === 0)
    return existing === undefined ? undefined : [...existing];
  const freshFiles = new Set<string>();
  for (const spec of fresh) {
    const parsed = parseRef(spec);
    if (parsed.ok) freshFiles.add(parsed.ref.path);
  }
  const kept = (existing ?? []).filter((spec) => {
    const parsed = parseRef(spec);
    return !(parsed.ok && parsed.ref.kind === 'lines' && freshFiles.has(parsed.ref.path));
  });
  return [...kept, ...fresh.filter((spec) => !kept.includes(spec))];
}

export function applyDetected(
  doc: SystemsDoc,
  c: Candidates,
  at: string,
): {
  doc: SystemsDoc;
  added: string[];
  updated: string[];
  skipped: string[];
  rejected: string[];
} {
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];

  // RCB-162: a member board's hand review turned these down; `doc.rejected` is the record of
  // "no" that `systems.yml` had nowhere to keep before this card. A rejected system id blocks
  // BOTH that system candidate AND any connection candidate touching it (from OR to) — a
  // connection to a system the owner rejected is not a connection worth adding either.
  const rejectedSystemIds = new Set(doc.rejected.flatMap((r) => ('id' in r ? [r.id] : [])));
  // Narrows on `'to' in r`, not `'from' in r`: the purity scanner's specifier regex
  // (packages/core/test/purity.test.ts) treats a bare `from` immediately followed by a quote as
  // an import specifier, and `'from' in r` reads exactly that way.
  const rejectedPairs = new Set(
    doc.rejected.flatMap((r) => ('to' in r ? [`${r.from}→${r.to}`] : [])),
  );

  const systems = [...doc.systems];
  for (const cand of c.systems) {
    if (rejectedSystemIds.has(cand.id)) {
      rejected.push(cand.id);
      continue;
    }
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
        why: cand.why ?? null,
        // RCB-161 slice 1: a newly-detected row's unblockers are always [] — an unblocker only
        // ever comes from a hand edit, never from a detector. RCB-161 slice 3: its STATUS,
        // though, may be a detector's own proposal (e.g. `detectPackageJson`'s "planned"
        // integration guess) — `cand.status ?? 'live'`, live for every detector but that one.
        status: cand.status ?? 'live',
        unblockedBy: [],
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
      // RCB-161 slice 3: `why` fills from the candidate only where the row has none yet — an
      // owner's own why note is never overwritten by a detector's guess.
      why: existing.why ?? cand.why ?? null,
      // RCB-161 slice 1: an updated detected row KEEPS the hand-set status/unblockers — a
      // re-detect must never silently clear an owner's "planned, waiting on RCB-9" note.
      status: existing.status,
      unblockedBy: existing.unblockedBy,
      source: { detected: cand.detected, at },
    };
    updated.push(cand.id);
  }

  const connections = [...doc.connections];
  for (const cand of c.connections) {
    const key = `${cand.from}→${cand.to}`;
    if (
      rejectedPairs.has(key) ||
      rejectedSystemIds.has(cand.from) ||
      rejectedSystemIds.has(cand.to)
    ) {
      rejected.push(key);
      continue;
    }
    const idx = findConnection(connections, cand.from, cand.to);
    if (idx === -1) {
      connections.push({
        from: cand.from,
        to: cand.to,
        via: cand.via,
        env: filterNoneEnvs(doc, cand.env),
        ...(cand.pointers !== undefined && cand.pointers.length > 0
          ? { pointers: [...cand.pointers] }
          : {}),
        status: 'live',
        unblockedBy: [],
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
    const pointers = mergeDetectedPointers(existing.pointers, cand.pointers);
    connections[idx] = {
      from: cand.from,
      to: cand.to,
      // RCB-173: an updated detected row KEEPS the hand-added id/label/pointers, the same rule as
      // status/unblockedBy below — a re-detect must never erase what an owner wrote on it.
      ...connectionExtras(existing),
      // RCB-177: ...except that the candidate's fresh `:L` range replaces the stale one.
      ...(pointers !== undefined && pointers.length > 0 ? { pointers } : {}),
      via: cand.via,
      env: filterNoneEnvs(doc, cand.env),
      status: existing.status,
      unblockedBy: existing.unblockedBy,
      source: { detected: cand.detected, at },
    };
    updated.push(key);
  }

  return {
    // RCB-162: the doc's own `rejected` list is the owner's record, never mutated by a detect
    // run — only a hand edit to systems.yml changes it.
    // RCB-180: `paths` is the same — hand-written walk-throughs, carried through untouched (and
    // absent stays absent: no `paths: undefined` key).
    doc: {
      environments: doc.environments,
      systems,
      connections,
      rejected: doc.rejected,
      ...(doc.paths !== undefined ? { paths: doc.paths } : {}),
    },
    added,
    updated,
    skipped,
    rejected,
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
  plan: { added: string[]; updated: string[]; skipped: string[]; rejected?: string[] },
): string {
  // RCB-161 slice 3: STATUS is added ONLY when some candidate carries one (a detector's own
  // "planned" guess) — with none, this report stays byte-identical to before this card.
  const showStatus = c.systems.some((s) => s.status !== undefined);
  const headers = showStatus
    ? ['ID', 'KIND', 'LAYER', 'ENV', 'STATUS', 'FROM']
    : ['ID', 'KIND', 'LAYER', 'ENV', 'FROM'];
  const rows = c.systems.map((s) =>
    showStatus
      ? [s.id, s.kind, s.layer, s.env.join(','), s.status ?? 'live', s.detected]
      : [s.id, s.kind, s.layer, s.env.join(','), s.detected],
  );
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
  // RCB-162: byte-identical to before this card when nothing was rejected (no candidate touched
  // a rejected row) — the suffix appears only when there is something to report.
  const rejectedCount = plan.rejected?.length ?? 0;
  const rejectedSuffix = rejectedCount > 0 ? `, ${rejectedCount} rejected kept out` : '';
  lines.push(
    `${c.systems.length} systems, ${c.connections.length} connections, ${c.unclassified.length} unclassified — ${plan.added.length} to add, ${plan.updated.length} to update, ${plan.skipped.length} hand rows kept${rejectedSuffix}`,
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

/** RCB-162: key order `id`/`from`,`to` then `why` (brief §"packages/core/src/systems.ts"). */
function serializeRejection(r: Rejection): Record<string, unknown> {
  if ('id' in r) return { id: r.id, why: r.why };
  return { from: r.from, to: r.to, why: r.why };
}

/** `YAML.stringify(ordered, { schema: 'core', lineWidth: 0 })`, key order `environments ->
 * systems -> connections -> paths -> rejected` (RCB-162: `rejected` only when non-empty; RCB-180:
 * `paths` likewise), row keys in §3.1 order; omits `owner`/`why`/`via` when null, `docs` when
 * empty, a `runtime` key when null (`parseSystems` normalises them back). Round-trips. */
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
    // RCB-161 slice 1: `status`/`unblocked_by` write only when they diverge from the absent-key
    // default (live/[]) — an old fixture with neither field round-trips byte-identical.
    if (s.status !== 'live') row.status = s.status;
    if (s.unblockedBy.length > 0) row.unblocked_by = s.unblockedBy;
    row.source = serializeSource(s.source);
    return row;
  });
  const connections = doc.connections.map((c: Connection) => {
    const row: Record<string, unknown> = { from: c.from, to: c.to };
    // RCB-173: `id`/`label`/`pointers` write only when present (pointers: non-empty) — an old
    // file with none of them round-trips byte-identical, and no empty key is ever written.
    if (c.id !== undefined) row.id = c.id;
    if (c.label !== undefined) row.label = c.label;
    if (c.via !== null) row.via = c.via;
    row.env = c.env;
    if (c.pointers !== undefined && c.pointers.length > 0) row.pointers = c.pointers;
    if (c.status !== 'live') row.status = c.status;
    if (c.unblockedBy.length > 0) row.unblocked_by = c.unblockedBy;
    row.source = serializeSource(c.source);
    return row;
  });
  // RCB-162: `rejected:` written only when non-empty and always after `connections` — an old
  // file with no `rejected` key round-trips byte-identical (no key added when the list is empty).
  const ordered: Record<string, unknown> = { environments, systems, connections };
  // RCB-180: `paths:` sits between `connections` and `rejected`, written only when non-empty, its
  // keys in `name`, `hops`, `source` order — a file without one round-trips byte-identical.
  if (doc.paths !== undefined && doc.paths.length > 0) {
    ordered.paths = doc.paths.map((p) => ({
      name: p.name,
      hops: p.hops,
      source: serializeSource(p.source),
    }));
  }
  if (doc.rejected.length > 0) {
    ordered.rejected = doc.rejected.map(serializeRejection);
  }
  return YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
}
