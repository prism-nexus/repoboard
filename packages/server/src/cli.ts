#!/usr/bin/env node
/**
 * P2.1 CLI. `node:util.parseArgs`, no framework. Every card mutation goes through the store,
 * which goes through @repoboard/core. Exit codes: 0 ok · 1 user error (one line) · 2 crash.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type Card,
  type CardPatch,
  type CreateCardInput,
  createCard,
  type DecisionOption,
  defaultBoardConfig,
  needsDecision,
  type Priority,
  resolveTimeSpec,
  serializeBoard,
  serializeCard,
} from '@repoboard/core';
import { type RunningServer, startServer } from './http.js';
import {
  formatRows,
  type LeaseRow,
  serveMcp,
  toLeaseRow,
  toRow,
  toWindowRow,
  type WindowRow,
} from './mcp.js';
import { formatResolvedRefs, resolveCardRefs } from './refs.js';
import { openStore } from './store.js';
import { VERSION } from './version.js';

export { VERSION };

export interface CliIO {
  cwd: string;
  stdout: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  env?: Record<string, string | undefined>;
  /** `serve` stops when this aborts (tests); otherwise on SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** `serve` hands the running server here (tests). */
  onServe?: (server: RunningServer) => void;
  /** Override for `--open`. */
  openUrl?: (url: string) => void;
  /** Clock override. */
  now?: () => Date;
}

/** A mistake by the caller: printed as one line, exit 1. */
export class UserError extends Error {}

const HELP = `repoboard — Remember · Connect · Build

Usage:
  repoboard init                              create .repoboard/ with a default board and a first card
  repoboard card add "<title>" [options]      --status s --assignee a --priority high|medium|low
                                        --label l (repeatable) --file f (repeatable) --ref r (repeatable)
                                        --as actor
  repoboard card move <id> <status> [--as a]  move a card to a column
  repoboard card update <id> [options]        --title t --assignee a --priority high|medium|low
                                        --label l --file f --ref r (repeatable; each one REPLACES
                                        the whole list, it does not append)
                                        --clear assignee|priority|labels|files|refs (repeatable)
                                        --as actor; status changes go through \`card move\`
  repoboard card list [--status s] [--json] [--needs-decision]
                                        list cards; --json is compact (id, title, status,
                                        assignee, priority, labels, files, updated); add --full for bodies;
                                        --needs-decision filters to cards with an open decision
  repoboard card show <id> [--resolve]        print the card file; --resolve appends the lines each
                                        refs: entry points at, read live from the file
  repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace]
                                        open a decision on a card (P8.1); --replace withdraws one
                                        already open. With no options, the owner answers with --words.
  repoboard card decide <id> [<letter>] [--words "<verbatim>"] [--as a]
                                        answer the open decision; a letter, --words, or both
  repoboard lease take <resource> [--as h] [--until ts] [--note n] [--force]
                                        take (or renew) a lease on a named resource; ts is ISO or
                                        +90m / +2h relative to now; omit --until to hold until
                                        released; --force takes it from a live holder
  repoboard lease release <resource> [--as h] [--force]
                                        release a lease you hold; --force releases another holder's
  repoboard lease list [--json]        RESOURCE HOLDER SINCE UNTIL STATE(live|stale) NOTE
  repoboard window add <resource> <start> <end> <name> [--as a]
                                        start/end are ISO or +90m / +2h relative to now
  repoboard window list [--json]
  repoboard window check <resource> [--at ts]
                                        exit 0 "clear <resource>" when nothing blocks it; exit 1
                                        naming what does (a window, a live lease, or both) — this is
                                        what a lock shim calls
  repoboard serve [--root <dir>] [--port 4242] [--open] [--no-fun]
                                        start the dashboard (binds 127.0.0.1); --root serves that
                                        directory as given — a directory with no .repoboard/ opens
                                        map-only, and nothing is ever written into it
  repoboard mcp [--root <dir>]                MCP server over stdio (for Claude Code etc.)
  repoboard --help | --version

Actor for --as defaults to $REPOBOARD_ACTOR, then $USER, then "cli"; for mcp: $REPOBOARD_ACTOR, then "mcp".
`;

const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

type Options = NonNullable<ParseArgsConfig['options']>;

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

/** Walk up from `cwd` to the nearest directory containing `.repoboard/`. */
export async function findRoot(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  for (;;) {
    try {
      if ((await stat(join(dir, '.repoboard'))).isDirectory()) return dir;
    } catch {
      // keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function requireRoot(io: CliIO): Promise<string> {
  const root = await findRoot(io.cwd);
  if (!root)
    throw new UserError(
      `no .repoboard directory found in ${io.cwd} or above (run \`repoboard init\`)`,
    );
  return root;
}

/**
 * P7.1/P7.2: where `serve` opens.
 *
 * `--root` is taken **as given** and never searched upward — board or no board. That is what
 * makes map-only mode an explicit act: a bare `repoboard serve` in some random directory keeps
 * today's meaning (climb to the nearest `.repoboard/`, refuse if there is none) and cannot
 * silently turn into "serve whatever is here". The only difference is that its error now names
 * `--root` as the way to open a project that has no board.
 */
async function serveRoot(rootFlag: string | undefined, io: CliIO): Promise<string> {
  if (rootFlag === undefined) {
    const found = await findRoot(io.cwd);
    if (!found)
      throw new UserError(
        `no .repoboard directory found in ${io.cwd} or above (run \`repoboard init\`, or ` +
          '`repoboard serve --root <dir>` to open a project that has no board)',
      );
    return found;
  }
  const root = resolve(io.cwd, rootFlag);
  const dir = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!dir) throw new UserError(`--root ${root} is not a directory`);
  return root;
}

function actorFrom(flag: string | undefined, io: CliIO): string {
  const env = io.env ?? process.env;
  return flag || env.REPOBOARD_ACTOR || env.USER || 'cli';
}

function priorityFrom(v: string | undefined): Priority | undefined {
  if (v === undefined) return undefined;
  if (!PRIORITIES.has(v)) throw new UserError(`priority must be high, medium or low (got "${v}")`);
  return v as Priority;
}

// ---- commands ---------------------------------------------------------------------------

async function cmdInit(args: string[], io: CliIO): Promise<number> {
  parse(args, {});
  const root = resolve(io.cwd);
  const repoboardDir = join(root, '.repoboard');
  const present = await stat(repoboardDir).then(
    () => true,
    () => false,
  );
  if (present) throw new UserError(`${repoboardDir} already exists; refusing to overwrite`);
  const config = defaultBoardConfig();
  const now = io.now?.() ?? new Date();
  const welcome = createCard(
    {
      title: 'Welcome',
      body: [
        '',
        'This board lives in `.repoboard/`. Every card is a markdown file in `.repoboard/cards/`;',
        'columns are in `.repoboard/board.yml`. Move a card by editing `status:` in its file,',
        'or with `repoboard card move <id> <status>`. Run `repoboard serve` to see the board.',
        '',
      ].join('\n'),
    },
    { existingIds: [], now, config },
  );
  if (!welcome.ok) throw new Error(`init: ${welcome.error}`); // default config: cannot happen
  const card = welcome.card;
  await mkdir(join(repoboardDir, 'cards'), { recursive: true });
  await writeFile(join(repoboardDir, 'board.yml'), serializeBoard(config));
  await writeFile(join(repoboardDir, 'cards', `${card.id}.md`), serializeCard(card));
  io.stdout.write(`initialised ${repoboardDir} with ${card.id} "Welcome"\n`);
  return 0;
}

async function cmdCardAdd(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    status: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    label: { type: 'string', multiple: true },
    file: { type: 'string', multiple: true },
    ref: { type: 'string', multiple: true },
    body: { type: 'string' },
    as: { type: 'string' },
  });
  const title = positionals.join(' ').trim();
  if (!title) throw new UserError('card add needs a title: repoboard card add "<title>"');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const input: CreateCardInput = { title };
  if (values.status !== undefined) input.status = values.status;
  if (values.assignee !== undefined) input.assignee = values.assignee;
  const priority = priorityFrom(values.priority);
  if (priority !== undefined) input.priority = priority;
  if (values.label !== undefined) input.labels = values.label;
  if (values.file !== undefined) input.files = values.file;
  if (values.ref !== undefined) input.refs = values.ref;
  if (values.body !== undefined) input.body = values.body;
  const res = await store.create(input, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  const { card } = res;
  io.stdout.write(`created ${card.id} (${card.status}) ${card.title}\n`);
  return 0;
}

async function cmdCardMove(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { as: { type: 'string' } });
  const [id, status] = positionals;
  if (!id || !status) throw new UserError('usage: repoboard card move <id> <status>');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.move(id, status, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  io.stdout.write(`moved ${id} ${res.event.from} → ${res.event.to}\n`);
  return 0;
}

/**
 * K9 / plan §11 O8. The fields `--clear` may name — exactly the optional ones `updateCard` will
 * take a `null` for (`applyOptional`, core transitions.ts:181). `title` is absent on purpose:
 * core refuses an empty title, so there is no null to send.
 */
const CLEARABLE = ['assignee', 'priority', 'labels', 'files', 'refs'] as const;
type Clearable = (typeof CLEARABLE)[number];

function clearedFields(flags: string[] | undefined): Set<Clearable> {
  const out = new Set<Clearable>();
  for (const f of flags ?? []) {
    if (!(CLEARABLE as readonly string[]).includes(f)) {
      throw new UserError(
        `--clear must name one of ${CLEARABLE.join(', ')} (got "${f}")${
          f === 'title' ? '; a card must have a title, so it cannot be cleared' : ''
        }`,
      );
    }
    out.add(f as Clearable);
  }
  return out;
}

/**
 * `undefined` = leave alone, `null` = clear, a value = set — the same three-way meaning
 * `applyOptional` gives a `CardPatch` field. `--clear x` is how a shell flag says the `null` that
 * MCP and HTTP send as JSON; naming the same field twice is a contradiction, not a precedence rule.
 */
function setOrClear<T>(
  value: T | undefined,
  field: Clearable,
  clear: Set<Clearable>,
): T | null | undefined {
  if (!clear.has(field)) return value;
  if (value !== undefined) {
    throw new UserError(
      `--clear ${field} contradicts the value given for it; pass one or the other`,
    );
  }
  return null;
}

/**
 * K9 / plan §11 O8: the third surface onto `updateCard`, speaking the `CardPatch` semantics MCP
 * `update_card` and `PATCH /api/cards/:id` already speak. A repeatable list flag REPLACES the
 * list (core copies it wholesale, transitions.ts:166-168) — a CLI that appended where the other
 * two replace would be a worse bug than the missing command. Status is not a field here.
 */
async function cmdCardUpdate(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    title: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    label: { type: 'string', multiple: true },
    file: { type: 'string', multiple: true },
    ref: { type: 'string', multiple: true },
    clear: { type: 'string', multiple: true },
    // Declared so a user who tries it gets a pointer instead of `unknown option` — and because
    // this is the ONLY layer that can catch it. Core's `'status' in patch` refusal
    // (transitions.ts:147-149) is unreachable from here: `status` never enters the patch, so
    // without the check below `--status doing --assignee a` exits 0, sets the assignee and drops
    // the status silently. Measured 2026-09-07 by deleting the check and reading the card back.
    status: { type: 'string' },
    as: { type: 'string' },
  });
  if (values.status !== undefined) {
    throw new UserError(
      'card update cannot change status; use `repoboard card move <id> <status>`',
    );
  }
  const [id] = positionals;
  if (!id) throw new UserError('usage: repoboard card update <id> [options] (see --help)');
  const clear = clearedFields(values.clear);
  // Insertion order matches core's PATCH_KEYS (transitions.ts:140), so the fields we print are
  // named in the same order as the `## Log` line core writes for the same update.
  const patch: CardPatch = {};
  if (values.title !== undefined) patch.title = values.title;
  const assignee = setOrClear(values.assignee, 'assignee', clear);
  if (assignee !== undefined) patch.assignee = assignee;
  const priority = setOrClear(priorityFrom(values.priority), 'priority', clear);
  if (priority !== undefined) patch.priority = priority;
  const labels = setOrClear(values.label, 'labels', clear);
  if (labels !== undefined) patch.labels = labels;
  const files = setOrClear(values.file, 'files', clear);
  if (files !== undefined) patch.files = files;
  const refs = setOrClear(values.ref, 'refs', clear);
  if (refs !== undefined) patch.refs = refs;
  const changed = Object.keys(patch);
  if (changed.length === 0) {
    throw new UserError(
      'card update needs at least one of --title, --assignee, --priority, --label, --file, ' +
        '--ref or --clear <field>',
    );
  }
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.update(id, patch, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  io.stdout.write(`updated ${res.card.id} ${changed.join(', ')}\n`);
  return 0;
}

/** "<LETTER> <text>" — the first token is the letter (locked decision 5). */
function parseOptionFlag(raw: string): DecisionOption {
  const i = raw.indexOf(' ');
  const letter = i === -1 ? raw : raw.slice(0, i);
  const text = i === -1 ? '' : raw.slice(i + 1).trim();
  if (!letter || !text) {
    throw new UserError(`--option must be "<LETTER> <text>" (got "${raw}")`);
  }
  return { letter, text };
}

async function cmdCardAsk(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    option: { type: 'string', multiple: true },
    as: { type: 'string' },
    replace: { type: 'boolean', default: false },
  });
  const [id, question] = positionals;
  if (!id || !question) {
    throw new UserError(
      'usage: repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace]',
    );
  }
  const options = (values.option ?? []).map(parseOptionFlag);
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.ask(
    id,
    { question, options, replace: values.replace },
    actorFrom(values.as, io),
  );
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  const n = options.length;
  io.stdout.write(`asked ${id}: ${question} (${n} option${n === 1 ? '' : 's'})\n`);
  return 0;
}

async function cmdCardDecide(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    words: { type: 'string' },
    as: { type: 'string' },
  });
  const [id, letter] = positionals;
  if (!id) {
    throw new UserError('usage: repoboard card decide <id> [<letter>] [--words "<verbatim>"]');
  }
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.decide(id, { letter, words: values.words }, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  const chosen = res.card.decision?.chosen ?? null;
  const words = res.card.decision?.words ?? undefined;
  io.stdout.write(chosen !== null ? `decided ${id} ${chosen}\n` : `decided ${id} — "${words}"\n`);
  return 0;
}

function idNumber(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m?.[1] ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Fixed-width table: id, status, assignee, [decision,] title. The `DECISION` column (a `?` for
 * an open decision) only appears when at least one listed card has one — §7 bytes measurement:
 * a fixture with no open decisions is byte-identical to the table before P8.1.
 */
export function formatTable(cards: Card[]): string {
  const anyDecision = cards.some((c) => needsDecision(c));
  const rows = cards.map((c) => {
    const row = [c.id, c.status, c.assignee ?? '-'];
    if (anyDecision) row.push(needsDecision(c) ? '?' : '');
    row.push(c.title);
    return row;
  });
  const header = anyDecision
    ? ['ID', 'STATUS', 'ASSIGNEE', 'DECISION', 'TITLE']
    : ['ID', 'STATUS', 'ASSIGNEE', 'TITLE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

async function cmdCardList(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    status: { type: 'string' },
    json: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'needs-decision': { type: 'boolean', default: false },
  });
  if (values.full && !values.json) throw new UserError('--full only applies with --json');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  let cards = store.list();
  if (values.status !== undefined) cards = cards.filter((c) => c.status === values.status);
  if (values['needs-decision']) cards = cards.filter((c) => needsDecision(c));
  cards.sort((a, b) => idNumber(a.id) - idNumber(b.id) || (a.id < b.id ? -1 : 1));
  if (values.json) {
    // Compact rows by default (K6): bodies only with --full. Same shape as MCP list_cards.
    io.stdout.write(`${formatRows(values.full ? cards : cards.map(toRow))}\n`);
    return 0;
  }
  io.stdout.write(`${formatTable(cards)}\n`);
  if (store.invalid.length > 0) {
    const err = io.stderr ?? io.stdout;
    for (const inv of store.invalid) err.write(`invalid: ${inv.path}: ${inv.error}\n`);
  }
  return 0;
}

async function cmdCardShow(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { resolve: { type: 'boolean', default: false } });
  const [id] = positionals;
  if (!id) throw new UserError('usage: repoboard card show <id> [--resolve]');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const card = store.get(id);
  if (!card) throw new UserError(`unknown card "${id}"`);
  io.stdout.write(await readFile(store.filePath(id), 'utf8'));
  if (values.resolve) {
    // K7: each ref as a fenced block headed path:start-end, resolved now from the file.
    const refs = await resolveCardRefs(store.root, card);
    io.stdout.write(refs.length === 0 ? '\n(no refs)\n' : `\n${formatResolvedRefs(refs)}`);
  }
  return 0;
}

// ---- lease / window (P8.2) -----------------------------------------------------------------

/** ISO or `+90m`/`+2h` relative to `now` (locked decision 6); a bad spec is a UserError. */
function resolveTime(spec: string, now: Date): string {
  const r = resolveTimeSpec(spec, now);
  if (!r.ok) throw new UserError(r.error);
  return r.iso;
}

async function cmdLeaseTake(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    as: { type: 'string' },
    until: { type: 'string' },
    note: { type: 'string' },
    force: { type: 'boolean', default: false },
  });
  const [resource] = positionals;
  if (!resource) throw new UserError('usage: repoboard lease take <resource> [options]');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const now = io.now?.() ?? new Date();
  const until = values.until !== undefined ? resolveTime(values.until, now) : undefined;
  const actor = actorFrom(values.as, io);
  const res = await store.takeLease(
    { resource, until, note: values.note, force: values.force },
    actor,
  );
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  io.stdout.write(`took ${resource} as ${actor} until ${until ?? '—'}\n`);
  return 0;
}

async function cmdLeaseRelease(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    as: { type: 'string' },
    force: { type: 'boolean', default: false },
  });
  const [resource] = positionals;
  if (!resource)
    throw new UserError('usage: repoboard lease release <resource> [--as a] [--force]');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.releaseLease({ resource, force: values.force }, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  io.stdout.write(`released ${resource}\n`);
  return 0;
}

export function formatLeaseTable(rows: LeaseRow[]): string {
  const header = ['RESOURCE', 'HOLDER', 'SINCE', 'UNTIL', 'STATE', 'NOTE'];
  const body = rows.map((r) => [
    r.resource,
    r.holder,
    r.since,
    r.until ?? '—',
    r.state,
    r.note ?? '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

async function cmdLeaseList(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean', default: false } });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const now = io.now?.() ?? new Date();
  const rows = store
    .leases()
    .leases.map((l) => toLeaseRow(l, now))
    .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
  if (values.json) {
    io.stdout.write(`${formatRows(rows)}\n`);
    return 0;
  }
  io.stdout.write(`${formatLeaseTable(rows)}\n`);
  return 0;
}

async function cmdWindowAdd(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { as: { type: 'string' } });
  const [resource, startArg, endArg, ...nameParts] = positionals;
  const name = nameParts.join(' ');
  if (!resource || !startArg || !endArg || !name) {
    throw new UserError('usage: repoboard window add <resource> <start> <end> <name>');
  }
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const now = io.now?.() ?? new Date();
  const start = resolveTime(startArg, now);
  const end = resolveTime(endArg, now);
  const res = await store.addWindow({ resource, start, end, name }, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  io.stdout.write(`added window ${name} ${start}–${end} ${resource}\n`);
  return 0;
}

export function formatWindowTable(rows: WindowRow[]): string {
  const header = ['RESOURCE', 'START', 'END', 'NAME'];
  const body = rows.map((r) => [r.resource, r.start, r.end, r.name]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

async function cmdWindowList(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean', default: false } });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const rows = store
    .leases()
    .windows.map(toWindowRow)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (values.json) {
    io.stdout.write(`${formatRows(rows)}\n`);
    return 0;
  }
  io.stdout.write(`${formatWindowTable(rows)}\n`);
  return 0;
}

/**
 * Locked decision 3: exit 0 "clear <resource>" when nothing blocks it; exit 1 naming every
 * reason (one per line) when something does — a window, a live lease, or both. This is the
 * shell-callable contract a lock shim depends on (C1: it must never say "clear" while blocked).
 */
async function cmdWindowCheck(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { at: { type: 'string' } });
  const [resource] = positionals;
  if (!resource) throw new UserError('usage: repoboard window check <resource> [--at ts]');
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const now = io.now?.() ?? new Date();
  const at = values.at !== undefined ? new Date(resolveTime(values.at, now)) : now;
  const res = store.checkResource(resource, at);
  if (res.clear) {
    io.stdout.write(`clear ${resource}\n`);
    return 0;
  }
  for (const reason of res.reasons) io.stdout.write(`${reason}\n`);
  return 1;
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  } catch {
    // Not fatal: the URL is printed anyway.
  }
}

async function cmdServe(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    root: { type: 'string' },
    port: { type: 'string', default: '4242' },
    open: { type: 'boolean', default: false },
    'no-fun': { type: 'boolean', default: false },
  });
  const port = Number.parseInt(values.port ?? '', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UserError(`--port must be 0–65535 (got "${values.port}")`);
  }
  const root = await serveRoot(values.root, io);
  const err = io.stderr ?? io.stdout;
  const store = await openStore(root, { watch: true, now: io.now });
  store.on('warning', (m) => err.write(`warning: ${m}\n`));
  let server: RunningServer;
  try {
    server = await startServer({ store, port, fun: !values['no-fun'] });
  } catch (e) {
    await store.close();
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new UserError(`port ${port} is already in use`);
    throw e;
  }
  io.stdout.write(`repoboard: serving ${root}\n  ${server.url}\n`);
  if (!store.hasBoard) {
    io.stdout.write('  (no .repoboard/ here: map-only, and nothing will be written)\n');
  }
  if (!server.webDir) io.stdout.write('  (web not built: API only, see the page)\n');
  if (values.open) (io.openUrl ?? openInBrowser)(server.url);
  io.onServe?.(server);

  await new Promise<void>((done) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done();
    };
    if (io.signal?.aborted) return stop();
    io.signal?.addEventListener('abort', stop, { once: true });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await server.close();
  await store.close();
  return 0;
}

/**
 * `repoboard mcp [--root <dir>]`: the MCP server on stdin/stdout. Nothing else may write to stdout
 * while it runs (the transport owns it); warnings go to stderr. Returns when stdin closes.
 */
async function cmdMcp(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { root: { type: 'string' } });
  const root = await requireRoot(values.root === undefined ? io : { ...io, cwd: values.root });
  const env = io.env ?? process.env;
  const err = io.stderr ?? process.stderr;
  await serveMcp({
    root,
    defaultActor: env.REPOBOARD_ACTOR || 'mcp',
    now: io.now,
    signal: io.signal,
    warn: (m) => err.write(`repoboard mcp: warning: ${m}\n`),
  });
  return 0;
}

// ---- dispatch ---------------------------------------------------------------------------

export async function run(argv: string[], io: CliIO): Promise<number> {
  const err = io.stderr ?? io.stdout;
  try {
    const [cmd, sub, ...rest] = argv;
    if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
      io.stdout.write(HELP);
      return cmd === undefined ? 1 : 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (cmd === 'init') return await cmdInit(argv.slice(1), io);
    if (cmd === 'serve') return await cmdServe(argv.slice(1), io);
    if (cmd === 'mcp') return await cmdMcp(argv.slice(1), io);
    if (cmd === 'card') {
      if (sub === 'add') return await cmdCardAdd(rest, io);
      if (sub === 'move') return await cmdCardMove(rest, io);
      if (sub === 'update') return await cmdCardUpdate(rest, io);
      if (sub === 'list') return await cmdCardList(rest, io);
      if (sub === 'show') return await cmdCardShow(rest, io);
      if (sub === 'ask') return await cmdCardAsk(rest, io);
      if (sub === 'decide') return await cmdCardDecide(rest, io);
      throw new UserError(
        `unknown card command "${sub ?? ''}" (add, move, update, list, show, ask, decide)`,
      );
    }
    if (cmd === 'lease') {
      if (sub === 'take') return await cmdLeaseTake(rest, io);
      if (sub === 'release') return await cmdLeaseRelease(rest, io);
      if (sub === 'list') return await cmdLeaseList(rest, io);
      throw new UserError(`unknown lease command "${sub ?? ''}" (take, release, list)`);
    }
    if (cmd === 'window') {
      if (sub === 'add') return await cmdWindowAdd(rest, io);
      if (sub === 'list') return await cmdWindowList(rest, io);
      if (sub === 'check') return await cmdWindowCheck(rest, io);
      throw new UserError(`unknown window command "${sub ?? ''}" (add, list, check)`);
    }
    throw new UserError(`unknown command "${cmd}" (try repoboard --help)`);
  } catch (e) {
    if (e instanceof UserError) {
      err.write(`repoboard: ${e.message}\n`);
      return 1;
    }
    err.write(`repoboard: crash: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 2;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
