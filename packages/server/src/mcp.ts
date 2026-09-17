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
  type Card,
  type CardPatch,
  computeBoardSummary,
  isStale,
  type Lease,
  needsDecision,
  type Window,
} from '@repoboard/core';
import { z } from 'zod';
import { resolveCardRefs } from './refs.js';
import { type CardStore, openStore } from './store.js';
import { VERSION } from './version.js';

export const MCP_TOOL_NAMES = [
  'list_cards',
  'get_card',
  'create_card',
  'move_card',
  'update_card',
  'append_log',
  'board_summary',
  'ask_owner',
  'record_decision',
  'take_lease',
  'release_lease',
  'list_leases',
  'add_window',
  'check_window',
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
  labels: string[];
  files: string[];
  updated: string;
}

/** Every list surface (CLI `--json`, MCP `list_cards`) formats rows here: one JSON object per
 * line inside a JSON array. Still valid JSON; one `grep` finds a card; measured half the bytes of
 * 2-space pretty printing on this repo's 27 cards (K6). */
export function formatRows(rows: readonly unknown[]): string {
  if (rows.length === 0) return '[]';
  return `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`;
}

export function toRow(card: Card): CardRow {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    assignee: card.assignee ?? null,
    priority: card.priority ?? null,
    labels: card.labels ?? [],
    files: card.files ?? [],
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
    return 'nothing to update: pass at least one of title, assignee, priority, labels, files';
  }
  if (error.startsWith('unknown option')) return `letter: ${error}`;
  if (error.startsWith('duplicate option letter')) return `options: ${error}`;
  return error;
}

const CARD_INTRO =
  "A card is one task on this repository's Kanban board: the file `.repoboard/cards/<id>.md`, " +
  'YAML frontmatter (id, title, status, assignee, priority, labels, files, refs, decision, ' +
  'created, updated) plus a markdown body with a `## Log` section. `status` is always a column ' +
  'id from `.repoboard/board.yml`. A card may carry a `decision` block (P8.1): a question, ' +
  'optional lettered options, and — once answered — `chosen`/`words`. ' +
  'A DECIDED card is authority: do not re-ask it and do not wait for a relay — read ' +
  '`decision.chosen` and `decision.words` yourself. ';

const ACTOR_DESC =
  'Who is acting, written `<tool>/<role>` (e.g. `claude/web-agent`) so the board can draw a ' +
  'stable avatar. Defaults to $REPOBOARD_ACTOR, then "mcp".';

/** P8.2: the five lease/window tools stay terse (orchestrator note: aim <=700 B each) — no CARD_INTRO. */
const ACTOR_SHORT = 'Who is acting, e.g. claude/agent. Default: $REPOBOARD_ACTOR, then "mcp".';

const PRIORITY = z.enum(['high', 'medium', 'low']);

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
        `${CARD_INTRO}Returns a compact JSON array of {id, title, status, assignee, priority, ` +
        'labels, files, updated} without bodies. Call this first: it is the cheap way to learn ' +
        `what exists and which column ids are in use (this board: ${columnIds()}). Filters are ` +
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
      const rows: readonly unknown[] = full ? cards : cards.map(toRow);
      return { content: [{ type: 'text', text: formatRows(rows) }] };
    },
  );

  server.registerTool(
    'get_card',
    {
      title: 'Get one card',
      description:
        `${CARD_INTRO}Returns the full card as JSON, including its markdown body and ` +
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
        `${CARD_INTRO}Creates a new card file with the next free id and returns it. ` +
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
        `${CARD_INTRO}Sets the card's status to another column id (this board: ${columnIds()}), ` +
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
        `${CARD_INTRO}Changes title, assignee, priority, labels, files and/or refs, bumps ` +
        '`updated` and appends a `## Log` line naming the changed fields. Pass null to clear an ' +
        'optional field. Not for status (use move_card) or the body (use append_log).',
      inputSchema: {
        id: z.string().describe('Card id, e.g. RB-12.'),
        title: z.string().min(1).optional(),
        assignee: z.string().nullable().optional().describe('null clears it.'),
        priority: PRIORITY.nullable().optional().describe('null clears it.'),
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
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, actor, ...fields }) => {
      const patch: CardPatch = {};
      if (fields.title !== undefined) patch.title = fields.title;
      if (fields.assignee !== undefined) patch.assignee = fields.assignee;
      if (fields.priority !== undefined) patch.priority = fields.priority;
      if (fields.labels !== undefined) patch.labels = fields.labels;
      if (fields.files !== undefined) patch.files = fields.files;
      if (fields.refs !== undefined) patch.refs = fields.refs;
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
        `${CARD_INTRO}Appends one bullet \`- <timestamp> <actor> — <text>\` under the card's ` +
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
    'ask_owner',
    {
      title: 'Ask the owner a decision, on the card',
      description:
        `${CARD_INTRO}Opens a \`decision\` block on a card: a question and optional lettered ` +
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
        actor: z.string().optional().describe(ACTOR_DESC),
      },
    },
    async ({ id, question, options, replace, actor }) => {
      const res = await store.ask(id, { question, options, replace }, actor ?? defaultActor);
      if (!res.ok) return fail(nameField(res.error));
      return ok({ card: res.card, warnings: res.warnings });
    },
  );

  server.registerTool(
    'record_decision',
    {
      title: "Record the owner's answer to an open decision",
      description:
        `${CARD_INTRO}Answers the card's open \`decision\`: a \`letter\` naming one of its ` +
        'options, `words` (verbatim), or both — at least one is required. Refuses an unknown ' +
        'letter (names the valid ones) and refuses when nothing is open. Moves the card back to ' +
        'where `ask_owner` moved it from, if anywhere.',
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
        `${CARD_INTRO}Returns the columns (id, title, active, wip, done, count), the active ` +
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
        active: summary.active.map(toRow),
        wipBreaches: summary.wipBreaches,
        invalid: store.invalid,
      });
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
