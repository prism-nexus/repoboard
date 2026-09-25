import * as YAML from 'yaml';
import { z } from 'zod';
import type { BoardConfig, Column, Sibling, WorkspaceRepo } from './types.js';

export const ColumnSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().optional(),
  active: z.boolean().optional(),
  wip: z.number().int().positive().optional(),
  done: z.boolean().optional(),
  /** P8.1/O11: `ask` moves a card into the first such column; `decide` moves it back. */
  decision: z.boolean().optional(),
});

/**
 * The exact default from BUILD-PLAN §2 (O11, 2026-09-17: `review` retired — it took 14 cards and
 * released 0 on its own; `decide` sits before `todo` and IS the owner's queue).
 */
export function defaultBoardConfig(): BoardConfig {
  return {
    prefix: 'RB',
    activeWindowMinutes: 30,
    columns: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'decide', title: 'Needs decision', decision: true },
      { id: 'todo', title: 'To do' },
      { id: 'doing', title: 'Doing', active: true, wip: 3 },
      { id: 'done', title: 'Done', done: true },
    ],
  };
}

/**
 * RCB-42: `siblings:` entries in `board.yml` and `serve --sibling <name>=<url>` flags share this
 * one rule — a top-bar link is a click target, so only `http:`/`https:` is allowed. Refusing
 * everything else (in particular `javascript:` and `file:`) here means neither entry point can
 * produce a link the schema itself would call unsafe.
 */
export function isSiblingUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const SiblingSchema = z.looseObject({
  name: z.string().trim().min(1, 'must not be empty'),
  url: z.string().refine(isSiblingUrl, 'must be an http(s) URL'),
});

/** RCB-153 W1: one `repos:` entry — a workspace member board. `key` is the same shape
 * `assignRepoKeys` (RCB-43) already produces, so it doubles as an `/api/repos/<key>` key. */
export const WorkspaceRepoSchema = z.looseObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must match /^[a-z0-9][a-z0-9-]*$/'),
  root: z.string().trim().min(1, 'must not be empty'),
  writes: z.literal('cards').optional(),
});

export const BoardConfigSchema = z
  .looseObject({
    /**
     * RCB-41: the repo's display name — shown in the top bar and the browser tab title.
     * Optional; absent means "the folder name" (resolved by `boardDisplayName`, not defaulted
     * here, so the file stays honest about what it actually says). Trimmed; whitespace-only is
     * rejected the same as empty.
     */
    name: z.string().trim().min(1, 'must not be empty').optional(),
    /**
     * RCB-42: other running boards, shown as plain top-bar links. Optional; an explicit empty
     * list is allowed and means none — unlike `columns`, there is no "at least one" rule here.
     */
    siblings: z.array(SiblingSchema).optional(),
    prefix: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must start with a letter and contain only [A-Za-z0-9_]')
      .default('RB'),
    activeWindowMinutes: z.number().positive().default(30),
    /** P8.4: `repoboard cost`'s CLAUDE.md budget in bytes. Absent = the CLI's own default. */
    claudeMdBudgetBytes: z.number().int().positive().optional(),
    /** P8.6: an extra daily-log directory `check` reads alongside `.repoboard/log/`, relative to
     * the repo root (e.g. `docs/log`). Absent = today's behaviour, unchanged. */
    logDir: z.string().trim().min(1, 'must not be empty').optional(),
    /** RCB-153 W1: member boards this one coordinates. Absent = not a workspace. */
    repos: z.array(WorkspaceRepoSchema).optional(),
    // An absent `columns` key means "the defaults"; an explicit empty list is an error.
    columns: z
      .array(ColumnSchema)
      .min(1, 'at least one column is required')
      .default(() => defaultBoardConfig().columns),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    ctx.value.columns.forEach((col, i) => {
      if (seen.has(col.id)) {
        ctx.issues.push({
          code: 'custom',
          message: `duplicate column id "${col.id}"`,
          path: ['columns', i, 'id'],
          input: col.id,
        });
      }
      seen.add(col.id);
    });
    const seenKeys = new Set<string>();
    (ctx.value.repos ?? []).forEach((repo, i) => {
      if (seenKeys.has(repo.key)) {
        ctx.issues.push({
          code: 'custom',
          message: `duplicate repos[] key "${repo.key}"`,
          path: ['repos', i, 'key'],
          input: repo.key,
        });
      }
      seenKeys.add(repo.key);
    });
  });

export type BoardParseResult = { ok: true; config: BoardConfig } | { ok: false; error: string };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse `.repoboard/board.yml`. An empty file yields the defaults. Never throws. */
export function parseBoard(text: string): BoardParseResult {
  let data: unknown;
  try {
    data = YAML.parse(text, { schema: 'core' });
  } catch (e) {
    return { ok: false, error: `board.yml is not valid YAML: ${(e as Error).message}` };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'board.yml must be a YAML mapping' };
  }
  const result = BoardConfigSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map(formatIssue).join('; ') };
  }
  return { ok: true, config: result.data };
}

const CONFIG_ORDER = [
  'name',
  'siblings',
  'prefix',
  'repos',
  'activeWindowMinutes',
  'claudeMdBudgetBytes',
  'logDir',
  'columns',
] as const;
const COLUMN_ORDER = ['id', 'title', 'active', 'wip', 'done', 'decision'] as const;
const REPO_ORDER = ['key', 'root', 'writes'] as const;

function orderKeys(
  obj: Record<string, unknown>,
  first: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of first) if (obj[k] !== undefined) out[k] = obj[k];
  for (const [k, v] of Object.entries(obj)) {
    if (!first.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** Serialize a config to `board.yml` text. The default config serializes to exactly §2. */
export function serializeBoard(config: BoardConfig): string {
  const ordered = orderKeys(
    {
      ...config,
      columns: config.columns.map((c: Column) => orderKeys(c, COLUMN_ORDER)),
      repos: config.repos?.map((r: WorkspaceRepo) => orderKeys(r, REPO_ORDER)),
    },
    CONFIG_ORDER,
  );
  return YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
}

/** Find a column by id, or undefined. */
export function findColumn(config: BoardConfig, id: string): Column | undefined {
  return config.columns.find((c) => c.id === id);
}

/**
 * RCB-41: the ONE rule for "what do we call this repo" — the top bar and the browser tab title
 * both call this instead of keeping their own copy. `config?.name` (trimmed, non-empty) wins;
 * otherwise the last path segment of `root`, handling a trailing slash and Windows separators.
 * `config === null` covers a repo served before any snapshot has arrived; a map-only repo (no
 * `.repoboard/`) still carries a config object (the server's default, standing in for one that
 * does not exist — P7.2), which has no `name` either, so it falls through to the folder name the
 * same way.
 */
export function boardDisplayName(config: BoardConfig | null, root: string): string {
  const name = config?.name?.trim();
  if (name) return name;
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/**
 * RCB-42: the ONE merge of `board.yml`'s durable `siblings:` list and `serve --sibling` flags
 * (per-process, additive) — done once here so the server computes it once and the web never
 * merges anything itself. On a name collision the FLAG wins (it overrides board.yml for this
 * running process only; the file is never touched). Order: `fromFile` entries first, in file
 * order (a colliding name keeps its file position but the flag's url); then any flag-only names,
 * in the order they were given on the command line.
 */
export function mergeSiblings(fromFile: Sibling[], fromFlags: Sibling[]): Sibling[] {
  const flagByName = new Map(fromFlags.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const merged = fromFile.map((s) => {
    seen.add(s.name);
    return flagByName.get(s.name) ?? s;
  });
  for (const s of fromFlags) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    merged.push(s);
  }
  return merged;
}
