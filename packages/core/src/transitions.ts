import { findColumn } from './board.js';
import { isDecided, PrioritySchema, SizeSchema } from './card.js';
import { appendLogLine, formatLogLine } from './log.js';
import { toIso } from './time.js';
import type { BoardConfig, Card, Event, Priority, Size } from './types.js';

export interface MoveOptions {
  actor: string;
  now: Date;
  config: BoardConfig;
  /**
   * Cards currently in each column, NOT counting the card being moved.
   * When present, moving into a column at or over its `wip` yields a warning.
   * When omitted, no WIP check happens.
   */
  columnCounts?: Record<string, number>;
}

export type MoveResult =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string };

/**
 * The one function every surface funnels a status change through (§0.4).
 * Pure: returns a new card; the caller writes it.
 */
export function moveCard(card: Card, toStatus: string, opts: MoveOptions): MoveResult {
  const column = findColumn(opts.config, toStatus);
  if (!column) {
    const known = opts.config.columns.map((c) => c.id).join(', ');
    return { ok: false, error: `unknown column "${toStatus}" (columns: ${known})` };
  }
  const from = card.status;
  const warnings: string[] = [];
  if (from === toStatus) {
    warnings.push(`card ${card.id} is already in "${toStatus}"`);
  } else {
    // RCB-69 (owner 2026-09-19 20:1xZ): a decided card does not go back into a `decision: true`
    // column looking undecided (FPJ-28), and a never-asked card entering one is worth a nudge.
    // This is the one path every surface funnels a status change through, so the guard lives
    // here and nowhere else.
    if (column.decision === true) {
      if (isDecided(card)) {
        const letter = card.decision?.chosen ?? '—';
        const decidedBy = card.decision?.decidedBy ?? 'unknown';
        const decidedAt = card.decision?.decidedAt ?? 'unknown';
        return {
          ok: false,
          error:
            `card ${card.id} was decided ${letter} by ${decidedBy} at ${decidedAt} — a decided ` +
            `card does not go back to "${column.id}"; ask a new question: repoboard card ask ` +
            `${card.id} "<question>" [--option ...] | --task`,
        };
      }
      if (!card.decision) {
        warnings.push(
          `card ${card.id} moved into "${column.id}" with no open ask — start the discussion: ` +
            `repoboard card ask ${card.id} "<question>" [--option ...] | --task`,
        );
      }
    }
    if (opts.columnCounts && column.wip !== undefined) {
      const current = opts.columnCounts[toStatus] ?? 0;
      if (current + 1 > column.wip) {
        warnings.push(
          `WIP limit exceeded: "${toStatus}" allows ${column.wip}, would have ${current + 1}`,
        );
      }
    }
  }
  const ts = toIso(opts.now);
  const event: Event = { ts, actor: opts.actor, type: 'move', cardId: card.id, from, to: toStatus };
  const next: Card = {
    ...card,
    status: toStatus,
    updated: ts,
    body: appendLogLine(card.body, formatLogLine(ts, opts.actor, `moved ${from} → ${toStatus}`)),
  };
  return { ok: true, card: next, event, warnings };
}

export interface CreateCardInput {
  title: string;
  status?: string;
  assignee?: string;
  priority?: Priority;
  size?: Size;
  labels?: string[];
  files?: string[];
  refs?: string[];
  /** RCB-68: makes this card a STEP of the card named here. */
  parent?: string;
  /** RCB-68: a free short label (e.g. `PH.3`) marking which step this is. */
  phase?: string;
  /** RCB-68: a card id or a free-text sentence naming what blocks this card. */
  gate?: string;
  body?: string;
}

export interface CreateCardOptions {
  /** Ids of every existing card (any prefix); used to allocate `<prefix>-<max+1>`. */
  existingIds: string[];
  now: Date;
  config: BoardConfig;
}

/** Next id for the config's prefix: max existing `<prefix>-<n>` plus one, starting at 1 (D3). */
export function allocateCardId(existingIds: string[], prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m?.[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CreateResult = { ok: true; card: Card } | { ok: false; error: string };

/**
 * Build a new Card. Status defaults to the first column. An unknown status or a config with
 * no columns is a result, not a throw, like `moveCard` (K4). Pure; the caller writes it.
 */
export function createCard(input: CreateCardInput, opts: CreateCardOptions): CreateResult {
  const first = opts.config.columns[0];
  if (!first) return { ok: false, error: 'board config has no columns' };
  const status = input.status ?? first.id;
  if (!findColumn(opts.config, status)) {
    const known = opts.config.columns.map((c) => c.id).join(', ');
    return { ok: false, error: `unknown column "${status}" (columns: ${known})` };
  }
  if (input.title.length === 0) return { ok: false, error: 'title must not be empty' };
  const phaseFieldError = checkPhaseFieldsNotEmpty({
    parent: input.parent,
    phase: input.phase,
    gate: input.gate,
  });
  if (phaseFieldError) return { ok: false, error: phaseFieldError };
  const id = allocateCardId(opts.existingIds, opts.config.prefix);
  // RCB-68: the id is allocated above so a self-referential `parent` (impossible to know before
  // allocation) is still caught here, before anything is written.
  if (input.parent === id) return { ok: false, error: 'a card cannot be its own parent' };
  const ts = toIso(opts.now);
  const card: Card = {
    id,
    title: input.title,
    status,
    created: ts,
    updated: ts,
    body: input.body ?? '',
  };
  if (input.assignee !== undefined) card.assignee = input.assignee;
  if (input.priority !== undefined) card.priority = input.priority;
  if (input.size !== undefined) card.size = input.size;
  if (input.labels !== undefined) card.labels = [...input.labels];
  if (input.files !== undefined) card.files = [...input.files];
  if (input.refs !== undefined) card.refs = [...input.refs];
  if (input.parent !== undefined) card.parent = input.parent;
  if (input.phase !== undefined) card.phase = input.phase;
  if (input.gate !== undefined) card.gate = input.gate;
  return { ok: true, card };
}

/**
 * RCB-68: `parent`/`phase`/`gate` refuse an empty or whitespace-only value — a `--clear` sends
 * `null`, not `""`, so an empty string here is always a caller mistake, not an intent to clear.
 * Shared by `createCard` (all three `undefined | string`) and `updateCard` (all three
 * `undefined | null | string`, `null` skipped — it means clear, not set).
 */
function checkPhaseFieldsNotEmpty(fields: {
  parent?: string | null;
  phase?: string | null;
  gate?: string | null;
}): string | null {
  for (const key of ['parent', 'phase', 'gate'] as const) {
    const value = fields[key];
    if (value !== undefined && value !== null && value.trim().length === 0) {
      return `${key} must not be empty`;
    }
  }
  return null;
}

/** Fields `updateCard` may change. Status changes go through `moveCard`. */
export interface CardPatch {
  title?: string;
  assignee?: string | null;
  priority?: Priority | null;
  size?: Size | null;
  labels?: string[] | null;
  files?: string[] | null;
  refs?: string[] | null;
  /** RCB-68: `null` clears it, like `assignee`. */
  parent?: string | null;
  /** RCB-68: `null` clears it, like `assignee`. */
  phase?: string | null;
  /** RCB-68: `null` clears it, like `assignee`. */
  gate?: string | null;
  /** Replaces the whole body. The update's own log line is appended afterwards. */
  body?: string;
}

export interface UpdateOptions {
  actor: string;
  now: Date;
}

export type UpdateResult = { ok: true; card: Card } | { ok: false; error: string };

const PATCH_KEYS = [
  'title',
  'assignee',
  'priority',
  'size',
  'labels',
  'files',
  'refs',
  'parent',
  'phase',
  'gate',
  'body',
] as const;

/**
 * Change non-status fields. `null` clears an optional field. Sets `updated` and appends a
 * `## Log` line naming the changed fields. Pure; the caller writes the result.
 */
export function updateCard(card: Card, patch: CardPatch, opts: UpdateOptions): UpdateResult {
  if ('status' in patch) {
    return { ok: false, error: 'updateCard cannot change status; use moveCard' };
  }
  if (patch.title !== undefined && patch.title.length === 0) {
    return { ok: false, error: 'title must not be empty' };
  }
  if (patch.priority !== undefined && patch.priority !== null) {
    const p = PrioritySchema.safeParse(patch.priority);
    if (!p.success) return { ok: false, error: `priority: ${p.error.issues[0]?.message}` };
  }
  if (patch.size !== undefined && patch.size !== null) {
    const s = SizeSchema.safeParse(patch.size);
    if (!s.success) return { ok: false, error: `size: ${s.error.issues[0]?.message}` };
  }
  const phaseFieldError = checkPhaseFieldsNotEmpty({
    parent: patch.parent,
    phase: patch.phase,
    gate: patch.gate,
  });
  if (phaseFieldError) return { ok: false, error: phaseFieldError };
  if (patch.parent !== undefined && patch.parent === card.id) {
    return { ok: false, error: 'a card cannot be its own parent' };
  }
  const changed = PATCH_KEYS.filter((k) => patch[k] !== undefined);
  if (changed.length === 0) {
    return { ok: false, error: 'patch is empty' };
  }
  const next: Card = { ...card };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  applyOptional(next, 'assignee', patch.assignee);
  applyOptional(next, 'priority', patch.priority);
  applyOptional(next, 'size', patch.size);
  applyOptional(next, 'labels', patch.labels === null ? null : patch.labels?.slice());
  applyOptional(next, 'files', patch.files === null ? null : patch.files?.slice());
  applyOptional(next, 'refs', patch.refs === null ? null : patch.refs?.slice());
  applyOptional(next, 'parent', patch.parent);
  applyOptional(next, 'phase', patch.phase);
  applyOptional(next, 'gate', patch.gate);
  const ts = toIso(opts.now);
  next.updated = ts;
  next.body = appendLogLine(
    next.body,
    formatLogLine(ts, opts.actor, `updated ${changed.join(', ')}`),
  );
  return { ok: true, card: next };
}

type OptionalCardKey =
  | 'assignee'
  | 'priority'
  | 'size'
  | 'labels'
  | 'files'
  | 'refs'
  | 'parent'
  | 'phase'
  | 'gate';

/** `undefined` = leave alone, `null` = clear, anything else = set. */
function applyOptional<K extends OptionalCardKey>(
  card: Card,
  key: K,
  value: Card[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete card[key];
  else card[key] = value;
}
