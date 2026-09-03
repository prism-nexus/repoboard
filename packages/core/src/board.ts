import * as YAML from 'yaml';
import { z } from 'zod';
import type { BoardConfig, Column } from './types.js';

export const ColumnSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().optional(),
  active: z.boolean().optional(),
  wip: z.number().int().positive().optional(),
  done: z.boolean().optional(),
});

/** The exact default from BUILD-PLAN §2. */
export function defaultBoardConfig(): BoardConfig {
  return {
    prefix: 'RB',
    activeWindowMinutes: 30,
    columns: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'todo', title: 'To do' },
      { id: 'doing', title: 'Doing', active: true, wip: 3 },
      { id: 'review', title: 'Review', active: true },
      { id: 'done', title: 'Done', done: true },
    ],
  };
}

export const BoardConfigSchema = z
  .looseObject({
    prefix: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must start with a letter and contain only [A-Za-z0-9_]')
      .default('RB'),
    activeWindowMinutes: z.number().positive().default(30),
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

const CONFIG_ORDER = ['prefix', 'activeWindowMinutes', 'columns'] as const;
const COLUMN_ORDER = ['id', 'title', 'active', 'wip', 'done'] as const;

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
    { ...config, columns: config.columns.map((c: Column) => orderKeys(c, COLUMN_ORDER)) },
    CONFIG_ORDER,
  );
  return YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
}

/** Find a column by id, or undefined. */
export function findColumn(config: BoardConfig, id: string): Column | undefined {
  return config.columns.find((c) => c.id === id);
}
