/**
 * P5.1 MCP server (BUILD-PLAN D4: three agent surfaces, one core). Every tool calls the same
 * `CardStore` the CLI and HTTP use, which calls @repoboard/core — one code path. Transport is stdio,
 * so while `repoboard mcp` runs, stdout belongs to the protocol and warnings go to stderr.
 *
 * Tool descriptions are written for an agent that has never seen this board: they say what a
 * card is, that `status` is a column id, and that `list_cards` is the cheap first call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type BoardConfig,
  blockedReason,
  type Card,
  type CardPatch,
  type Column,
  computeBoardSummary,
  isStale,
  type Lease,
  needsDecision,
  renderState,
  resolveOlderThan,
  type StateSectionName,
  type Window,
} from '@repoboard/core';
import { z } from 'zod';
import { applySyncPlan, computeSyncPlan } from './issues.js';
import { resolveCardRefs, resolveRefSpec } from './refs.js';
import { type CardStore, openStore } from './store.js';
import { systemTests } from './systems-tests.js';
import { VERSION } from './version.js';

export const MCP_TOOL_NAMES = [
  'list_cards',
  'get_card',
  'create_card',
  'move_card',
  'update_card',
  'append_log',
  'add_note',
  'board_summary',
  'set_columns',
  'ask_owner',
  'record_decision',
  'take_lease',
  'release_lease',
  'list_leases',
  'add_window',
  'check_window',
  'get_state',
  'set_state_section',
  'append_repo_log',
  'check',
  'cost',
  'list_systems',
  'get_system',
  'archive_cards',
  'sync_issues',
] as const;

export interface McpServerOptions {
  store: CardStore;
  /** Used when a tool call carries no `actor`: `$REPOBOARD_ACTOR`, then `mcp` (see `serveMcp`). */
  defaultActor: string;
  /** Clock, for tests. */
  now?: () => Date;
}

/** The compact row `list_cards` returns: everything but the body. Absent scalars are null. */
export interface CardRow {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  size: string | null;
  labels: string[];
  files: string[];
  /** RCB-68: this card is a STEP of that phase card, or null. */
  parent: string | null;
  /** RCB-68: the free short label (e.g. `PH.3`) marking which step, or null. */
  phase: string | null;
  /** RCB-68: the raw `gate:` value (a card id or a sentence), or null. */
  gate: string | null;
  /** RCB-68: `blockedReason` against THIS board — null when not blocked. */
  blocked: string | null;
  updated: string;
}

/** Every list surface (CLI `--json`, MCP `list_cards`) formats rows here: one JSON object per
 * line inside a JSON array. Still valid JSON; one `grep` finds a card; measured half the bytes of
 * 2-space pretty printing on this repo's 27 cards (K6). */
export function formatRows(rows: readonly unknown[]): string {
  if (rows.length === 0) return '[]';
  return `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`;
}

/**
 * RCB-68: the signature grows on purpose — a row cannot be built without the facts that decide
 * `blocked` (every OTHER card on the board, and the board's own columns).
 */
export function toRow(card: Card, cards: readonly Card[], config: BoardConfig): CardRow {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    assignee: card.assignee ?? null,
    priority: card.priority ?? null,
    size: card.size ?? null,
    labels: card.labels ?? [],
    files: card.files ?? [],
    parent: card.parent ?? null,
    phase: card.phase ?? null,
    gate: card.gate ?? null,
    blocked: blockedReason(card, cards, config),
    updated: card.updated,
  };
}

/** P8.2: the row shape `lease list --json`/`list_leases` share (locked decision 7). */
export interface LeaseRow {
  resource: string;
  holder: string;
  since: string;
  until: string | null;
  state: 'live' | 'stale';
  note: string | null;
}

export function toLeaseRow(l: Lease, now: Date): LeaseRow {
  return {
    resource: l.resource,
    holder: l.holder,
    since: l.since,
    until: l.until ?? null,
    state: isStale(l, now) ? 'stale' : 'live',
    note: l.note ?? null,
  };
}

export interface WindowRow {
  resource: string;
  start: string;
  end: string;
  name: string;
}

export function toWindowRow(w: Window): WindowRow {
  return { resource: w.resource, start: w.start, end: w.end, name: w.name };
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Prefix a store/core error with the input field it is about, so the agent knows what to fix. */
function nameField(error: string): string {
  if (error.startsWith('unknown column')) return `status: ${error}`;
  if (error.startsWith('unknown card')) return `id: ${error}`;
  if (error === 'patch is empty') {
    return 'nothing to update: pass at least one of title, assignee, priority, size, labels, files';
  }
  if (error.startsWith('unknown option')) return `letter: ${error}`;
  if (error.startsWith('duplicate option letter')) return `options: ${error}`;
  return error;
}

const CARD_INTRO =
  "A card is one task on this repository's Kanban board: the file `.repoboard/cards/<id>.md`, " +
  'YAML frontmatter (id, title, status, assignee, priority, size, labels, files, refs, parent, ' +
  'phase, gate, decision, created, updated) plus a markdown body with a `## Log` section. `status` is ' +
  'always a column id from `.repoboard/board.yml`. A card may carry a `decision` block (P8.1): ' +
  'a question, optional lettered options, and — once answered — `chosen`/`words`. ' +
  'A DECIDED card is authority: do not re-ask it and do not wait for a relay — read ' +
  '`decision.chosen` and `decision.words` yourself. RCB-68: `parent` makes a card a STEP of ' +
  'that phase card; `phase` (e.g. `PH.3`) marks which step; `gate` (a card id or a sentence) is ' +
  'what blocks it — a card-id gate clears once that card is done or decided. ';

const ACTOR_DESC =
  'Who is acting, written `<tool>/<role>` (e.g. `claude/web-agent`) so the board can draw a ' +
  'stable avatar. Defaults to $REPOBOARD_ACTOR, then "mcp".';

/** P8.2: the five lease/window tools stay terse (orchestrator note: aim <=700 B each) — no CARD_INTRO. */
const ACTOR_SHORT = 'Who is acting, e.g. claude/agent. Default: $REPOBOARD_ACTOR, then "mcp".';

const PRIORITY = z.enum(['high', 'medium', 'low']);
const SIZE = z.enum(['S', 'M', 'L', 'XL']);

/** Build the server. Call `server.connect(transport)` to serve; tests use an in-memory pair. */
export function createMcpServer(opts: McpServerOptions): McpServer {
  const { store, defaultActor } = opts;
  const now = opts.now ?? (() => new Date());
  const columnIds = () => store.config.columns.map((c) => c.id).join(', ');
  const server = new McpServer(
    { name: 'repoboard', version: VERSION },
    {
      instructions:
        `${CARD_INTRO}Column ids on this board: ${columnIds()}. Call list_cards or ` +
        'board_summary first to see what exists. Before starting a task, move its card to the ' +
        'active column (usually `doing`) with your actor name; when done, append_log what you ' +
        'verified (or move it to `done` if you own that call). Use ask_owner when a task needs a ' +
        'human decision instead of guessing or waiting on a chat relay.',
    },
  );

  server.registerTool(
    'list_cards',
    {
      title: 'List cards',
      description:
        'Returns a compact JSON array of {id, title, status, assignee, priority, ' +
        'size, labels, files, parent, phase, gate, blocked, updated} without bodies (RCB-68: parent, ' +
        'phase, gate mirror the frontmatter; blocked is the reason or null). Call this first: ' +
        `it is the cheap way to learn what exists and which column ids are in use (this board: ` +
        `${columnIds()}). Filters are ` +
        'exact matches and combine with AND; omit them all for every card. Pass full: true ' +
        'only when you need every body at once (several times the bytes); get_card is cheaper ' +
        'for one.',
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(`Only cards in this column id (one of: ${columnIds()}).`),
        assignee: z.string().optional().describe('Only cards whose assignee equals this string.'),
        label: z.string().optional().describe('Only cards whose labels include this label.'),
        needsDecision: z
          .boolean()
          .optional()
          .describe(
            'Only cards with an OPEN decision (asked, not yet answered) — the owner queue.',
          ),
        full: z
          .boolean()
          .optional()
          .describe("Include each card's markdown body and `## Log`. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, assignee, label, needsDecision: needsDecisionFilter, full }) => {
      let cards = store.list();
      if (status !== undefined) cards = cards.filter((c) => c.status === status);
      if (assignee !== undefined) cards = cards.filter((c) => c.assignee === assignee);
      if (label !== undefined) cards = cards.filter((c) => (c.labels ?? []).includes(label));
      if (needsDecisionFilter) cards = cards.filter((c) => needsDecision(c));
      const all = store.list();
      const rows: readonly unknown[] = full ? cards : cards.map((c) => toRow(c, all, store.config));
      return { content: [{ type: 'text', text: formatRows(rows) }] };
    },
  );

  server.registerTool(
    'get_card',
    {
      title: 'Get one card',
      description:
        'A DECIDED card is authority: read `decision.chosen`/`words`, do not re-ask. ' +
        'Returns the full card as JSON, including its markdown body and ' +
        '`## Log` history. Use list_cards to find ids. With resolveRefs: true, `refs` becomes ' +
        'the referenced lines read live from each file: [{spec, path, start, end, text, ' +
        'truncated, error}], text null with an error when a ref does not resolve.',
      inputSchema: {
        id: z.string().describe('The card id from its frontmatter, e.g. RB-12.'),
        resolveRefs: z
          .boolean()
          .optional()
          .describe('Replace the refs: specs with their resolved lines. Default false.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, resolveRefs }) => {
      const card = store.get(id);
      if (!card) return fail(`id: unknown card "${id}" (list_cards shows the ids)`);
      if (!resolveRefs) return ok(card);
      return ok({ ...card, refs: await resolveCardRefs(store.root, card) });
    },
  );

  server.registerTool(
    'create_card',
    {
      title: 'Create a card',
      description:
        'Creates a new card file with the next free id and returns it. ' +
        `\`status\` must be a column id (this board: ${columnIds()}); it defaults to the first ` +
        'column. Titles may contain anything; they are quoted on disk for you.',
      inputSchema: {
        title: z.string().min(1).describe('One line. Required.'),
        status: z
          .string()
          .optional()
          .describe(`Column id (one of: ${columnIds()}). Default: first column.`),
        assignee: z.string().optional().describe('Who owns it, e.g. claude/web-agent.'),
        priority: PRIORITY.optional(),
        size: SIZE.optional().describe(
          'S ≤2h · M half a day · L days, investigate first · XL plan-sized',
        ),
        labels: z.array(z.string()).optional(),
        files: z.array(z.string()).optional().describe('Repo-relative paths the task touches.'),
        refs: z
          .array(z.string())
          .optional()
          .describe(
            'Pointers the board renders live: path#Heading, path@Token, path:L10-L20, or path. ' +
              'Point at where a note lives instead of pasting it into the body.',
          ),
        body: z
          .string()
          .optional()
          .describe('Markdown description. A `## Log` section is added on first log line.'),
        parent: z.string().optional().describe('RCB-68: makes this card a STEP of that card.'),
        phase: z.string().optional().describe('RCB-68: free short label, e.g. PH.3.'),
        gate: z
          .string()
          .optional()
          .describe('RCB-68: a card id or a sentence naming what blocks this card.'),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ actor, ...input }) => {
      const res = await store.create(input, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok(res.card);
    },
  );

  server.registerTool(
    'move_card',
    {
      title: 'Move a card to a column',
      description:
        '`status` is a column id from board.yml (see list_cards). ' +
        `Sets the card's status to another column id (this board: ${columnIds()}), ` +
        'bumps `updated`, appends a `## Log` line and records an event. Returns {card, warnings}. ' +
        "Exceeding a column's WIP limit is reported as a warning in the result, never refused; " +
        'moving to the column the card is already in is also just a warning.',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        status: z.string().describe(`Destination column id (one of: ${columnIds()}).`),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, status, actor }) => {
      const res = await store.move(id, status, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok({ card: res.card, warnings: res.warnings });
    },
  );

  server.registerTool(
    'update_card',
    {
      title: 'Update card fields',
      description:
        'Changes title, assignee, priority, size, labels, files, refs, parent, phase ' +
        'and/or gate, bumps `updated` and appends a `## Log` line naming the changed fields. ' +
        'Pass null to clear an optional field. Not for status (use move_card) or the body (use ' +
        'append_log).',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        title: z.string().min(1).optional(),
        assignee: z.string().nullable().optional().describe('null clears it.'),
        priority: PRIORITY.nullable().optional().describe('null clears it.'),
        size: SIZE.nullable().optional().describe('null clears it.'),
        labels: z
          .array(z.string())
          .nullable()
          .optional()
          .describe('Replaces the list; null clears it.'),
        files: z
          .array(z.string())
          .nullable()
          .optional()
          .describe('Replaces the list; null clears it.'),
        refs: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            'Replaces the refs: list (path#Heading, path@Token, path:L10-L20, path); null clears it.',
          ),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe('RCB-68: makes this card a STEP of that card; null clears it.'),
        phase: z
          .string()
          .nullable()
          .optional()
          .describe('RCB-68: free short label, e.g. PH.3; null clears it.'),
        gate: z
          .string()
          .nullable()
          .optional()
          .describe(
            'RCB-68: a card id or a sentence naming what blocks this card; null clears it.',
          ),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, actor, ...fields }) => {
      const patch: CardPatch = {};
      if (fields.title !== undefined) patch.title = fields.title;
      if (fields.assignee !== undefined) patch.assignee = fields.assignee;
      if (fields.priority !== undefined) patch.priority = fields.priority;
      if (fields.size !== undefined) patch.size = fields.size;
      if (fields.labels !== undefined) patch.labels = fields.labels;
      if (fields.files !== undefined) patch.files = fields.files;
      if (fields.refs !== undefined) patch.refs = fields.refs;
      if (fields.parent !== undefined) patch.parent = fields.parent;
      if (fields.phase !== undefined) patch.phase = fields.phase;
      if (fields.gate !== undefined) patch.gate = fields.gate;
      const res = await store.update(id, patch, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok(res.card);
    },
  );

  server.registerTool(
    'append_log',
    {
      title: 'Append a log line to a card',
      description:
        `Appends one bullet \`- <timestamp> <actor> — <text>\` under the card's ` +
        '`## Log` heading (created if missing) and bumps `updated`. Use it to say what you did ' +
        'or verified. Text is kept to one line.',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        text: z.string().min(1).describe('What happened, one line.'),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, text, actor }) => {
      const res = await store.appendLog(id, text, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok(res.card);
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a durable note to a card',
      description:
        `Appends one bullet \`- <timestamp> <actor> — <text>\` under the card's ` +
        '`## Notes` heading (created before `## Log` if missing) and bumps `updated`. Newlines ' +
        'in `text` are kept, as continuation lines under the same bullet. Writes no `## Log` ' +
        'line. Use it for a durable remark meant to stay on the card — a decision rationale, an ' +
        "owner's instruction — where append_log is for what you DID.",
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        text: z.string().min(1).describe('The remark, one or more lines.'),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, text, actor }) => {
      const res = await store.addNote(id, text, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok(res.card);
    },
  );

  server.registerTool(
    'ask_owner',
    {
      title: 'Ask the owner a decision, on the card',
      description:
        `Opens a \`decision\` block on a card: a question and optional lettered ` +
        'options. The owner answers from the dashboard (or `record_decision`) — do not wait on a ' +
        'chat relay; poll `get_card`/`list_cards` and read `decision.chosen`/`decision.words` when ' +
        'it is DECIDED (`chosen !== null || decidedAt !== null`). If the board has a column with ' +
        '`decision: true`, the card MOVES there (recording where it came from) and moves back ' +
        'when `record_decision` answers it; a board with no such column just shows a badge. ' +
        'Asking again on a card with an OPEN decision is refused — pass `replace: true` to ' +
        'withdraw it and ask a new one; asking again on a DECIDED card simply replaces it.',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        question: z.string().min(1),
        options: z
          .array(z.object({ letter: z.string().min(1), text: z.string() }))
          .optional()
          .describe(
            'Lettered choices, e.g. [{letter:"A",text:"ship now"}]. Omit for a yes/no or ' +
              'free-text question — the owner then answers with words only.',
          ),
        replace: z.boolean().optional().describe('Withdraw an already-open decision and re-ask.'),
        kind: z
          .literal('task')
          .optional()
          .describe(
            'An owner WORK item, same queue; no options; closed by record_decision with ' +
              'neither letter nor words.',
          ),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, question, options, replace, kind, actor }) => {
      const res = await store.ask(id, { question, options, replace, kind }, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok({ card: res.card, warnings: res.warnings });
    },
  );

  server.registerTool(
    'record_decision',
    {
      title: "Record the owner's answer to an open decision",
      description:
        `Answers the card's open \`decision\`: a \`letter\` naming one of its ` +
        'options, `words` (verbatim), or both — at least one is required. Refuses an unknown ' +
        'letter (names the valid ones) and refuses when nothing is open. Moves the card back to ' +
        'where `ask_owner` moved it from, if anywhere. On an owner task (RCB-52), neither a ' +
        'letter nor words is required — a bare call closes it.',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        letter: z.string().optional().describe('One of the decision’s option letters.'),
        words: z.string().optional().describe('The verbatim answer, kept as written.'),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, letter, words, actor }) => {
      const res = await store.decide(id, { letter, words }, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok({ card: res.card, warnings: res.warnings });
    },
  );

  server.registerTool(
    'board_summary',
    {
      title: 'Board summary',
      description:
        'Returns the columns (id, title, active, wip, done, count), the active ' +
        'cards (in an `active` column and updated within activeWindowMinutes), WIP breaches, ' +
        'and any card files that failed to parse. No arguments.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const config = store.config;
      const summary = computeBoardSummary(store.list(), config, now());
      const columns = config.columns.map((c) => ({
        id: c.id,
        title: c.title ?? c.id,
        active: c.active ?? false,
        wip: c.wip ?? null,
        done: c.done ?? false,
        count: summary.perColumn[c.id] ?? 0,
      }));
      const configured = new Set(config.columns.map((c) => c.id));
      const unknownStatuses = Object.entries(summary.perColumn)
        .filter(([id]) => !configured.has(id))
        .map(([status, count]) => ({ status, count }));
      return ok({
        prefix: config.prefix,
        activeWindowMinutes: config.activeWindowMinutes,
        columns,
        unknownStatuses,
        active: summary.active.map((c) => toRow(c, store.list(), config)),
        wipBreaches: summary.wipBreaches,
        invalid: store.invalid,
      });
    },
  );

  server.registerTool(
    'set_columns',
    {
      title: 'Replace the whole column list',
      description:
        `Replaces the board's ENTIRE column list in board.yml — a replace, not a merge, the ` +
        'same contract as HTTP PATCH /api/board and the web ColumnEditor (RCB-34): every column ' +
        'not included is dropped. Each column is {id, title?, active?, wip?, done?, decision?}; ' +
        'this tool does NOT validate that shape itself — the store re-parses board.yml through ' +
        'the same schema a hand edit would get, and refuses (naming the problem: empty list, ' +
        'duplicate id, etc.) with nothing written. Cards already on disk are never touched; one ' +
        'left in a column you removed still shows, marked "not in board.yml". Current columns: ' +
        `${columnIds()}.`,
      inputSchema: {
        columns: z
          .array(z.record(z.string(), z.unknown()))
          .describe('The WHOLE new column list, in order.'),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ columns, actor }) => {
      // The store's own `parseBoard` is the validator (see the tool description above) — this
      // cast does not duplicate the column schema, it only satisfies `setColumns`'s TS signature.
      const res = await store.setColumns(columns as Column[], actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok({ config: res.config });
    },
  );

  server.registerTool(
    'take_lease',
    {
      title: 'Take a lease on a resource',
      description:
        'Take/renew a lease on `resource`. Refuses a live lease held by another (names holder, ' +
        'until) unless force; same holder renews, replacing until/note (omit to clear).',
      inputSchema: {
        resource: z.string().min(1),
        until: z.string().optional().describe('ISO-8601; omit for until-released.'),
        note: z.string().optional(),
        force: z.boolean().optional(),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ resource, until, note, force, actor }) => {
      const res = await store.takeLease({ resource, until, note, force }, actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok({ doc: res.doc, warnings: res.warnings });
    },
  );

  server.registerTool(
    'release_lease',
    {
      title: 'Release a lease',
      description:
        "Release a lease on a resource. Refuses on another holder's lease, naming them, unless force.",
      inputSchema: {
        resource: z.string().min(1),
        force: z.boolean().optional(),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ resource, force, actor }) => {
      const res = await store.releaseLease({ resource, force }, actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok({ doc: res.doc, warnings: res.warnings });
    },
  );

  server.registerTool(
    'list_leases',
    {
      title: 'List leases and windows',
      description:
        'Every held lease and time window in .repoboard/leases.yml: leases as ' +
        '[{resource, holder, since, until, state: live|stale, note}], windows as ' +
        '[{resource, start, end, name}]. Cheap; call before take_lease.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const doc = store.leases();
      return ok({
        leases: doc.leases.map((l) => toLeaseRow(l, now())),
        windows: doc.windows.map(toWindowRow),
      });
    },
  );

  server.registerTool(
    'add_window',
    {
      title: 'Add a time window on a resource',
      description:
        'Reserve `resource` for a named window (`end` after `start`, both ISO-8601), e.g. a ' +
        'scheduled sweep. No overlap check.',
      inputSchema: {
        resource: z.string().min(1),
        start: z.string(),
        end: z.string(),
        name: z.string().min(1),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ resource, start, end, name, actor }) => {
      const res = await store.addWindow({ resource, start, end, name }, actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok({ doc: res.doc, warnings: res.warnings });
    },
  );

  server.registerTool(
    'check_window',
    {
      title: 'Is a resource clear right now?',
      description:
        'Call check_window before starting any long-running shared-resource job such as a test ' +
        'suite; exit/clear false means DO NOT start. Returns {clear:true} or {clear:false, ' +
        'reasons} naming a window covering `at` (default now), a live lease on resource, or both.',
      inputSchema: {
        resource: z.string().min(1),
        at: z.string().optional().describe('ISO-8601. Defaults to now.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ resource, at }) =>
      ok(store.checkResource(resource, at !== undefined ? new Date(at) : undefined)),
  );

  server.registerTool(
    'get_state',
    {
      title: 'Get STATE.md, rendered',
      description:
        "The repo's one-page STATE.md: {stamp, actor, sections: {live, lastLandings, seats}, " +
        'ownerQueue: [{id, question, options}], text}. OWNER QUEUE is generated fresh from cards ' +
        'that need a decision — never trust stale text from a prior read.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const doc = store.state();
      if (!doc) return ok({ stamp: null, actor: null, sections: null, ownerQueue: [], text: null });
      const openCards = store.list().filter((c) => needsDecision(c));
      const ownerQueue = openCards.map((c) => ({
        id: c.id,
        question: c.decision?.question ?? '',
        options: c.decision?.options ?? [],
      }));
      const text = renderState(doc.sections, openCards, {
        now: new Date(Date.parse(doc.stamp)),
        actor: doc.actor,
      });
      return ok({ stamp: doc.stamp, actor: doc.actor, sections: doc.sections, ownerQueue, text });
    },
  );

  server.registerTool(
    'set_state_section',
    {
      title: 'Replace one STATE.md section',
      description:
        'Replace LIVE, LAST-LANDINGS or SEATS and restamp; the other sections and OWNER QUEUE ' +
        '(generated, never stored) are untouched. Scaffolds a fresh STATE.md if none exists.',
      inputSchema: {
        section: z.enum(['LIVE', 'LAST-LANDINGS', 'SEATS']),
        body: z.string().min(1),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ section, body, actor }) => {
      const key: StateSectionName =
        section === 'LIVE' ? 'live' : section === 'LAST-LANDINGS' ? 'lastLandings' : 'seats';
      const res = await store.setStateSection(key, body, actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok(res.doc);
    },
  );

  server.registerTool(
    'append_repo_log',
    {
      title: "Append one block to today's log",
      description:
        "Append `text` under a `##### <SEAT> <ts>: <title>` heading to today's log — " +
        'board.yml logDir when set, else .repoboard/local/log/, else .repoboard/log/ ' +
        '(creates the file if this is the first entry). Append-only — there is no rewrite.',
      inputSchema: {
        seat: z.string().min(1).describe('Who is writing, e.g. claude/p8-3.'),
        text: z.string().min(1),
        title: z.string().optional().describe('Defaults to the first line of text.'),
      },
    },
    async ({ seat, text, title }) => {
      const res = await store.appendRepoLog(seat, text, title);
      if (!res.ok) return fail(res.error);
      return ok({ date: res.date, block: res.block });
    },
  );

  server.registerTool(
    'check',
    {
      title: 'Health check: STATE, leases, decisions',
      description:
        'Call before starting and before stopping (locked practice). Returns {findings, ' +
        'exitCode}: stale-state, active-without-lease (warning, strict-only), stale-lease, ' +
        'needs-ask (warning, strict-only — no open ask), cost-over-budget, systems-invalid ' +
        '(error), systems-stale (warning), needs-decision (info). Empty findings means ok.',
      inputSchema: {
        strict: z.boolean().optional().describe('Also block on warning-grade findings.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ strict }) => ok(await store.check(strict ?? false)),
  );

  server.registerTool(
    'cost',
    {
      title: 'Cold-context cost',
      description:
        'Bytes/≈tokens of what a cold agent loads: CLAUDE.md + variants, AGENTS.md + variants, ' +
        'backticked paths CLAUDE.md names that exist, and MCP server names (not schema bytes). ' +
        'over:true when CLAUDE.md exceeds budget (default 8192, or board.yml claudeMdBudgetBytes).',
      inputSchema: {
        budget: z.number().int().positive().optional().describe('Override the budget, in bytes.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ budget }) => ok(await store.cost(budget)),
  );

  server.registerTool(
    'list_systems',
    {
      title: 'List systems',
      description:
        "RCB-97 (plan §3.3): `.repoboard/systems.yml`'s inventory. Returns {exists, errors, " +
        'environments, systems: [{id, kind, layer, env, runtime}], connections}. exists:false ' +
        'means no systems.yml yet (repoboard systems detect proposes one); errors non-empty ' +
        'means the file failed to parse (systems/connections empty then). Use get_system for ' +
        "one system's full row plus resolved pointers.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => {
      const { doc, errors, exists } = store.systems();
      return ok({
        exists,
        errors,
        environments: doc?.environments ?? null,
        systems: (doc?.systems ?? []).map((s) => ({
          id: s.id,
          kind: s.kind,
          layer: s.layer,
          env: s.env,
          runtime: s.runtime,
        })),
        connections: doc?.connections ?? [],
      });
    },
  );

  server.registerTool(
    'get_system',
    {
      title: 'Get one system',
      description:
        "RCB-97 (plan §3.3): one system's full row from .repoboard/systems.yml, every " +
        'connection touching it, and its pointers resolved live (same engine as get_card ' +
        'resolveRefs: [{spec, path, start, end, text, truncated, error}]). Use list_systems to ' +
        'find ids. tests: the test files that import or name each pointer (static, live; null ' +
        'when a pointer is not a source file).',
      inputSchema: {
        id: z.string().describe('The system id, e.g. gateway (list_systems shows the ids).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const { doc } = store.systems();
      const system = doc?.systems.find((s) => s.id === id);
      if (!doc || !system) return fail(`id: unknown system "${id}" (list_systems shows the ids)`);
      const connections = doc.connections.filter((c) => c.from === id || c.to === id);
      const pointers = await Promise.all(system.pointers.map((p) => resolveRefSpec(store.root, p)));
      const tests = await systemTests(store.root, system.pointers);
      return ok({ system, connections, pointers, tests });
    },
  );

  server.registerTool(
    'archive_cards',
    {
      title: 'Archive old done cards',
      description:
        'Move every card in a done column whose `updated` is older than olderThan (default ' +
        '14d; also accepts 2h/90m or an ISO-8601 datetime) to .repoboard/archive/ — git mv when ' +
        'tracked, else a rename; the file is never rewritten. dryRun:true (default false) lists ' +
        'the ids and writes nothing. Archived cards no longer appear in list_cards; get_card on ' +
        'an archived id fails, naming the archive path.',
      inputSchema: {
        olderThan: z
          .string()
          .optional()
          .describe('Duration (14d, 2h, 90m) or ISO-8601 cutoff. Default 14d.'),
        dryRun: z.boolean().optional().describe('List ids only; write nothing. Default false.'),
        actor: z.string().optional().describe(ACTOR_SHORT),
      },
    },
    async ({ olderThan, dryRun, actor }) => {
      const older = resolveOlderThan(olderThan ?? '14d', now());
      if (!older.ok) return fail(older.error);
      const ids = store.selectArchivable(older.cutoff);
      if (dryRun) return ok({ dryRun: true, ids });
      if (ids.length === 0) return ok({ dryRun: false, archived: [] });
      const res = await store.archiveCards(ids, actor ?? defaultActor);
      if (!res.ok) return fail(res.error);
      return ok({ dryRun: false, archived: res.archived });
    },
  );

  server.registerTool(
    'sync_issues',
    {
      title: 'Sync cards from a README-style K-list',
      description:
        `Reads \`path\` (repo-relative; ".." and absolute paths refused) and the ` +
        'section under the first heading whose text starts with `heading` — the same heading ' +
        'rule the board uses for `refs:`. An item is a list item whose FIRST LINE begins at ' +
        'column 0 with `- **K<n>` (open) or `- ~~**K<n>` (struck = closed); nothing else is an ' +
        'item. Creates a card (labels: [label], refs: [`path@K<n>`]) for every open item with no ' +
        'card yet; moves a struck or vanished item’s card to the done column. Idempotent by ref ' +
        '— a second call creates and moves nothing. NEVER writes `path`. dryRun:true (default ' +
        'false) reports the plan and writes nothing — the only mode to call against a repo you ' +
        'do not own.',
      inputSchema: {
        path: z.string().min(1).describe('Repo-relative markdown file, e.g. README.md.'),
        heading: z.string().min(1).describe('Heading text, e.g. "Known issues".'),
        status: z.string().optional().describe('Column new cards are created in. Default todo.'),
        label: z.string().optional().describe('Label on created cards. Default issue.'),
        dryRun: z.boolean().optional().describe('Report the plan only; write nothing.'),
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ path, heading, status, label, dryRun, actor }) => {
      const input = { path, heading, status: status ?? 'todo', label: label ?? 'issue' };
      const outcome = await computeSyncPlan(store, input);
      if (!outcome.ok) return fail(outcome.error);
      const { plan, malformed } = outcome;
      if (dryRun) {
        return ok({
          dryRun: true,
          create: plan.create,
          close: plan.close,
          malformed,
          unchanged: plan.unchanged,
        });
      }
      const applied = await applySyncPlan(store, input, plan, actor ?? defaultActor);
      return ok({
        dryRun: false,
        created: applied.created,
        closed: applied.closed,
        malformed,
        errors: applied.errors,
      });
    },
  );

  return server;
}

export interface ServeMcpOptions {
  /** Directory containing `.repoboard/`. */
  root: string;
  defaultActor: string;
  now?: () => Date;
  /** Stops the server (tests); otherwise it runs until stdin closes. */
  signal?: AbortSignal;
  /** Store warnings (a bad board.yml, watcher errors). Never stdout. */
  warn?: (message: string) => void;
}

/** `repoboard mcp`: serve over stdio until stdin closes. Watches `.repoboard/` so direct edits are seen. */
export async function serveMcp(opts: ServeMcpOptions): Promise<void> {
  const store = await openStore(opts.root, { watch: true, now: opts.now });
  if (opts.warn) store.on('warning', opts.warn);
  const server = createMcpServer({ store, defaultActor: opts.defaultActor, now: opts.now });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((done) => {
    server.server.onclose = () => done();
  });
  // The SDK transport does not close itself when stdin ends, and the watcher would keep the
  // process alive; a client that closes our stdin is done with us.
  const onStdinEnd = () => void server.close();
  process.stdin.once('end', onStdinEnd);
  try {
    await server.connect(transport);
    if (opts.signal) {
      const stop = () => void server.close();
      if (opts.signal.aborted) stop();
      else opts.signal.addEventListener('abort', stop, { once: true });
    }
    await closed;
  } finally {
    process.stdin.off('end', onStdinEnd);
    await store.close();
  }
}
