#!/usr/bin/env node
/**
 * P2.1 CLI. `node:util.parseArgs`, no framework. Every card mutation goes through the store,
 * which goes through @repoboard/core. Exit codes: 0 ok · 1 user error (one line) · 2 crash.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type BoardConfig,
  blockedReason,
  type Card,
  type CardPatch,
  type Column,
  type CreateCardInput,
  createCard,
  DEFAULT_CLAUDE_MD_BUDGET_BYTES,
  type DecisionOption,
  dailyLogHeader,
  defaultBoardConfig,
  findSeatLine,
  formatCostTable,
  formatLogBlock,
  initialStateText,
  isOwnerTask,
  isSiblingUrl,
  needsDecision,
  type Priority,
  parseBoard,
  renderSeatBundle,
  renderState,
  resolveOlderThan,
  resolveTimeSpec,
  type Sibling,
  type Size,
  type StateSectionName,
  seatUpConflict,
  serializeBoard,
  serializeCard,
  serializeLeases,
  toIso,
} from '@repoboard/core';
import * as YAML from 'yaml';
import { gatherCost } from './cost.js';
import { distStaleness } from './dist-stale.js';
import { type RunningServer, startServer } from './http.js';
import { applySyncPlan, computeSyncPlan } from './issues.js';
import { hasLocal, localInit, localStatus, localSync, scaffoldIfAbsent } from './local.js';
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
import { assignRepoKeys, hasBoardDir } from './repo-context.js';
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
  /** Reads all of stdin as a UTF-8 string. Defaults to reading `process.stdin`. Tests override it. */
  readStdin?: () => Promise<string>;
}

/** A mistake by the caller: printed as one line, exit 1. */
export class UserError extends Error {}

const HELP = `repoboard — Remember · Connect · Build

Usage:
  repoboard init [--practices]                 create .repoboard/ with a default board and a first card;
                                        --practices also scaffolds STATE.md, today's log,
                                        leases.yml and a root NEXT-AGENT-PROMPT.md if absent —
                                        works on a repo that already has a board too
  repoboard card add "<title>" [options]      --status s --assignee a --priority high|medium|low
                                        --size S|M|L|XL (RCB-67)
                                        --label l (repeatable) --file f (repeatable) --ref r (repeatable)
                                        --parent <id> --phase PH.<n> --gate <id|"sentence"> (RCB-68)
                                        --as actor
  repoboard card move <id> <status> [--as a]  move a card to a column
  repoboard card update <id> [options]        --title t --assignee a --priority high|medium|low
                                        --size S|M|L|XL (RCB-67)
                                        --label l --file f --ref r (repeatable; each one REPLACES
                                        the whole list, it does not append)
                                        --parent <id> --phase PH.<n> --gate <id|"sentence"> (RCB-68)
                                        --clear assignee|priority|size|labels|files|refs|parent|phase|gate
                                        (repeatable)
                                        --as actor; status changes go through \`card move\`
  repoboard card list [--status s] [--json] [--needs-decision] [--size S|M|L|XL]
                                        list cards; --json is compact (id, title, status,
                                        assignee, priority, size, labels, files, parent, phase,
                                        gate, blocked, updated); add --full for bodies;
                                        --size filters to that size (RCB-67);
                                        --needs-decision filters to cards with an open decision;
                                        a BLOCKED column (RCB-68) appears only when a listed card
                                        is blocked on a gate
  repoboard card show <id> [--resolve]        print the card file; --resolve appends the lines each
                                        refs: entry points at, read live from the file; an
                                        archived id prints \`archived: .repoboard/archive/<id>.md\`
  repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace] [--task]
                                        open a decision on a card (P8.1); --replace withdraws one
                                        already open. With no options, the owner answers with --words.
                                        --task files an owner WORK item instead of a question (no
                                        options; the owner closes it with \`card decide <id>\` and
                                        no letter)
  repoboard card decide <id> [<letter>] [--words "<verbatim>"] [--as a]
                                        answer the open decision; a letter, --words, or both
  repoboard card note <id> "<text>" [--as a]
                                        append a dated, attributed remark under \`## Notes\`
                                        (created before \`## Log\` if missing); never writes a
                                        \`## Log\` line
  repoboard columns [--json]           ID TITLE FLAGS COUNT (flags: active, wip:N, done,
                                        decision); --json prints board.yml's raw columns list
  repoboard columns set (--stdin | "<text>") [--as a]
                                        replace the WHOLE column list — YAML or JSON, a bare
                                        list or {columns: [...]}, exactly PATCH /api/board's
                                        contract (RCB-34); a schema error (empty list, duplicate
                                        id) leaves board.yml untouched
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
  repoboard state                              print the rendered STATE.md (OWNER QUEUE generated
                                        fresh from cards that need a decision)
  repoboard state --set-section LIVE|LAST-LANDINGS|SEATS (<text> | --stdin) [--as a]
                                        replace one section's body and restamp
  repoboard log --as <seat> [--title "…"] (<text> | --stdin)
                                        append one block to today's log — board.yml logDir when
                                        set, else .repoboard/local/log/, else .repoboard/log/
  repoboard log show [--date YYYY-MM-DD] [--seat s]
                                        print a day's log (default today), optionally one seat's blocks
  repoboard log --last <seat>           print that seat's newest block, searching back across days
                                        (cold-start: your own seat's last block, then the coordinator's)
  repoboard seat <name> [--json]       the cold-start bundle for one seat: its SEATS line, its last
                                        log block, the coordinator's, its next todo card, the open
                                        decisions — one command instead of the three-file ritual
  repoboard seat <name> --up "<text>" [--force] | --down "<text>"
                                        replace ONLY this seat's own SEATS bullet and restamp
                                        STATE.md; appends the bullet if the seat has none; --up
                                        refuses a second UP inside activeWindowMinutes unless
                                        --force (RCB-87, audited in the log)
  repoboard check [--json] [--strict]  exit 0 "ok" / 1 with one line per finding: stale-state
                                        (also reads board.yml's logDir, P8.6 — an extra daily-log
                                        directory alongside .repoboard/log/, read-only),
                                        active-without-lease (warning; blocks only with --strict),
                                        stale-lease, needs-decision (informational, never fails),
                                        needs-ask (warning; blocks only with --strict — a card in a
                                        decision: true column with no OPEN ask, never asked or
                                        already decided and moved back), gated-steps
                                        (informational, never fails — N cards blocked on a gate,
                                        RCB-68), cost-over-budget (error; see \`repoboard cost\`),
                                        local-unsynced (warning; blocks only with --strict —
                                        uncommitted changes or unpushed commits in
                                        .repoboard/local/), local-no-remote (informational, never
                                        fails — .repoboard/local/ has no origin, RCB-83)
  repoboard local init [--remote <url>]
                                        create .repoboard/local/ — a gitignored, separate git repo
                                        for machine facts (scaffolds RIG.md, adds the exact line
                                        \`.repoboard/local/\` to the root .gitignore, git-inits and
                                        commits); --remote sets (or updates) origin for a private
                                        backup that needs no extra step (RCB-83)
  repoboard local sync [-m "<msg>"]    stage, commit (default message "repoboard local: sync") and
                                        push .repoboard/local/ if it has an origin; "no
                                        .repoboard/local/" when there is none to sync
  repoboard local status                one line: \`local: <n> ahead, dirty|clean, remote|no
                                        remote\`, or the "run repoboard local init" prompt
  repoboard cost [--root <dir>] [--budget <bytes>] [--json]
                                        "cold context": bytes (and ≈tokens at 4 B/token) of what a
                                        cold agent loads — CLAUDE.md/.claude/CLAUDE.md/CLAUDE.local.md
                                        if present, AGENTS.md/docs/AGENTS.md if present, every
                                        repo-relative path CLAUDE.md names in backticks that exists
                                        (first-order only, no recursion, no globs), and the NAMES of
                                        any .mcp.json MCP servers (not their schema bytes — those are
                                        per-harness). Exit 1 when CLAUDE.md exceeds --budget (default
                                        8192, or board.yml's claudeMdBudgetBytes); exit 0 otherwise.
                                        An absent CLAUDE.md is reported, never OVER. --root measures
                                        ANY directory, with or without a .repoboard/ board.
  repoboard archive [--older-than 14d] [--dry-run] [--as actor]
                                        move every \`done\` card whose \`updated\` is older than the
                                        cutoff (duration 14d/2h/90m, or an ISO-8601 datetime) to
                                        .repoboard/archive/ — git mv when tracked, else a rename;
                                        never rewrites the file. --dry-run lists the ids and moves
                                        nothing.
  repoboard sync-issues <path>#<heading> [--status todo] [--label issue] [--dry-run] [--as a]
                                        [--root <dir>]
                                        read a markdown file's section under the first heading
                                        starting with <heading>; create a card (labelled issue,
                                        refs: [<path>@K<n>]) for every open \`- **K<n>\` item with
                                        no card yet, and move a struck or vanished item's card to
                                        the done column. Idempotent by ref; NEVER writes <path>.
                                        --dry-run prints what it would do and writes nothing —
                                        the only mode to run against a repo you do not own.
  repoboard serve [--root <dir>]... [--port 4242] [--open] [--no-fun] [--watch-cap 20000]
                  [--sibling <name>=<url>]...
                                        start the dashboard (binds 127.0.0.1); --root serves that
                                        directory as given — a directory with no .repoboard/ opens
                                        map-only, and nothing is ever written into it. --root is
                                        repeatable (RCB-43): the first is the primary and is opened
                                        (and scanned, if enabled) immediately; every later --root is
                                        just registered — its board opens on first request (map on
                                        demand, K12) — and is listed by GET /api/repos. With no
                                        --root the one root is found by climbing from the cwd, as
                                        before. The repo watcher honours .gitignore (K12); if what
                                        it would watch still exceeds --watch-cap (default 20000
                                        paths), or it hits EMFILE/ENFILE, it turns itself off and
                                        logs one warning — the map keeps working from the last scan,
                                        rescans only on request. --sibling (repeatable; RCB-42) adds
                                        a top-bar link to another running board — an http(s) URL
                                        only; it is merged with board.yml's own siblings: list for
                                        this process only (never written to the file), and on a name
                                        collision the flag wins
  repoboard mcp [--root <dir>]                MCP server over stdio (for Claude Code etc.)
  repoboard --help | --version

Actor for --as defaults to $REPOBOARD_ACTOR, then $USER, then "cli"; for mcp: $REPOBOARD_ACTOR, then "mcp".
Exception: log takes no $USER/"cli" fallback — it needs --as or $REPOBOARD_ACTOR (RCB-71).
`;

const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const SIZES: ReadonlySet<string> = new Set(['S', 'M', 'L', 'XL']);

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

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve_, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve_(data));
    process.stdin.on('error', reject);
  });
}

/** P8.3: `--stdin` on `state --set-section` / `log`. Tests inject `io.readStdin`. */
async function readStdin(io: CliIO): Promise<string> {
  return (io.readStdin ?? defaultReadStdin)();
}

/** P8.3: `state --set-section` accepts the CLI-friendly hyphenated form. */
const SECTION_NAMES: Record<string, StateSectionName> = {
  LIVE: 'live',
  'LAST-LANDINGS': 'lastLandings',
  SEATS: 'seats',
};

function sectionNameFrom(v: string): StateSectionName {
  const key = SECTION_NAMES[v.toUpperCase()];
  if (!key) {
    throw new UserError(`--set-section must be one of LIVE, LAST-LANDINGS, SEATS (got "${v}")`);
  }
  return key;
}

function priorityFrom(v: string | undefined): Priority | undefined {
  if (v === undefined) return undefined;
  if (!PRIORITIES.has(v)) throw new UserError(`priority must be high, medium or low (got "${v}")`);
  return v as Priority;
}

function sizeFrom(v: string | undefined): Size | undefined {
  if (v === undefined) return undefined;
  if (!SIZES.has(v)) throw new UserError(`size must be S, M, L or XL (got "${v}")`);
  return v as Size;
}

// ---- commands ---------------------------------------------------------------------------

/**
 * P8.3 `init --practices`'s eight-line `NEXT-AGENT-PROMPT.md`, adapted from the reference
 * implementation (freshpickedjobs' own, read-only) to this repo's `.repoboard/` paths and
 * command names. Never overwrites (locked decision 3).
 */
function nextAgentPromptText(): string {
  return [
    '# Next agent — three lines',
    '',
    '1. Build once, then `repoboard seat <your seat>` — it prints your SEATS line, your last log',
    "   block, the coordinator's, your next card and the open decisions. That is the cold start.",
    '2. Take the card: `repoboard card move <id> doing --as <seat>`; log as you go',
    '   (`repoboard log --as <seat>`); `repoboard check` before you start and before you stop.',
    '3. Stand down: log block first, then `repoboard seat <seat> --down "<≤3 lines>"` LAST.',
    '',
  ].join('\n');
}

/** P8.3: `repoboard init --practices` — STATE.md, today's log, leases.yml, root NEXT-AGENT-PROMPT.md. */
async function scaffoldPractices(root: string, io: CliIO): Promise<void> {
  const now = io.now?.() ?? new Date();
  const repoboardDir = join(root, '.repoboard');
  const date = toIso(now).slice(0, 10);
  await scaffoldIfAbsent(
    join(repoboardDir, 'STATE.md'),
    initialStateText({ now, actor: 'repoboard init' }),
    io,
    '.repoboard/STATE.md',
  );
  await scaffoldIfAbsent(
    join(repoboardDir, 'log', `${date}.md`),
    `${dailyLogHeader(date)}\n\n`,
    io,
    `.repoboard/log/${date}.md`,
  );
  await scaffoldIfAbsent(
    join(repoboardDir, 'leases.yml'),
    serializeLeases({ leases: [], windows: [] }),
    io,
    '.repoboard/leases.yml',
  );
  await scaffoldIfAbsent(
    join(root, 'NEXT-AGENT-PROMPT.md'),
    nextAgentPromptText(),
    io,
    'NEXT-AGENT-PROMPT.md',
  );
}

async function cmdInit(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { practices: { type: 'boolean', default: false } });
  const root = resolve(io.cwd);
  const repoboardDir = join(root, '.repoboard');
  const present = await stat(repoboardDir).then(
    () => true,
    () => false,
  );
  if (present && !values.practices) {
    throw new UserError(`${repoboardDir} already exists; refusing to overwrite`);
  }
  if (!present) {
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
  }
  if (values.practices) await scaffoldPractices(root, io);
  return 0;
}

async function cmdCardAdd(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    status: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    size: { type: 'string' },
    label: { type: 'string', multiple: true },
    file: { type: 'string', multiple: true },
    ref: { type: 'string', multiple: true },
    parent: { type: 'string' },
    phase: { type: 'string' },
    gate: { type: 'string' },
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
  const size = sizeFrom(values.size);
  if (size !== undefined) input.size = size;
  if (values.label !== undefined) input.labels = values.label;
  if (values.file !== undefined) input.files = values.file;
  if (values.ref !== undefined) input.refs = values.ref;
  if (values.parent !== undefined) input.parent = values.parent;
  if (values.phase !== undefined) input.phase = values.phase;
  if (values.gate !== undefined) input.gate = values.gate;
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
const CLEARABLE = [
  'assignee',
  'priority',
  'size',
  'labels',
  'files',
  'refs',
  'parent',
  'phase',
  'gate',
] as const;
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
    size: { type: 'string' },
    label: { type: 'string', multiple: true },
    file: { type: 'string', multiple: true },
    ref: { type: 'string', multiple: true },
    parent: { type: 'string' },
    phase: { type: 'string' },
    gate: { type: 'string' },
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
  const size = setOrClear(sizeFrom(values.size), 'size', clear);
  if (size !== undefined) patch.size = size;
  const labels = setOrClear(values.label, 'labels', clear);
  if (labels !== undefined) patch.labels = labels;
  const files = setOrClear(values.file, 'files', clear);
  if (files !== undefined) patch.files = files;
  const refs = setOrClear(values.ref, 'refs', clear);
  if (refs !== undefined) patch.refs = refs;
  const parent = setOrClear(values.parent, 'parent', clear);
  if (parent !== undefined) patch.parent = parent;
  const phase = setOrClear(values.phase, 'phase', clear);
  if (phase !== undefined) patch.phase = phase;
  const gate = setOrClear(values.gate, 'gate', clear);
  if (gate !== undefined) patch.gate = gate;
  const changed = Object.keys(patch);
  if (changed.length === 0) {
    throw new UserError(
      'card update needs at least one of --title, --assignee, --priority, --size, --label, ' +
        '--file, --ref, --parent, --phase, --gate or --clear <field>',
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
    task: { type: 'boolean', default: false },
  });
  const [id, question] = positionals;
  if (!id || !question) {
    throw new UserError(
      'usage: repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace] [--task]',
    );
  }
  const options = (values.option ?? []).map(parseOptionFlag);
  const kind = values.task ? ('task' as const) : undefined;
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.ask(
    id,
    { question, options, replace: values.replace, kind },
    actorFrom(values.as, io),
  );
  if (!res.ok) throw new UserError(res.error);
  for (const w of res.warnings) (io.stderr ?? io.stdout).write(`warning: ${w}\n`);
  if (values.task) {
    io.stdout.write(`owner task ${id}: ${question}\n`);
  } else {
    const n = options.length;
    io.stdout.write(`asked ${id}: ${question} (${n} option${n === 1 ? '' : 's'})\n`);
  }
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
  if (isOwnerTask(res.card)) {
    io.stdout.write(words !== undefined ? `done ${id} — "${words}"\n` : `done ${id}\n`);
  } else {
    io.stdout.write(chosen !== null ? `decided ${id} ${chosen}\n` : `decided ${id} — "${words}"\n`);
  }
  return 0;
}

async function cmdCardNote(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    as: { type: 'string' },
  });
  const [id, text] = positionals;
  if (!id || !text) {
    throw new UserError('usage: repoboard card note <id> "<text>" [--as a]');
  }
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.addNote(id, text, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  io.stdout.write(`noted ${id}\n`);
  return 0;
}

function idNumber(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m?.[1] ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Fixed-width table: id, status, assignee, [size,] [decision,] [blocked,] title. The `DECISION`
 * column (a `?` for an open decision) only appears when at least one listed card has one, and
 * likewise the `BLOCKED` column (RCB-68) only appears when at least one listed card is blocked —
 * §7 bytes measurement: a fixture with neither is byte-identical to the table before P8.1/RCB-68.
 * RCB-67: `SIZE` follows the same rule (only when at least one listed card has a size), placed
 * after ASSIGNEE and before DECISION/BLOCKED/TITLE — a fixture with no sized card is
 * byte-identical to the table before RCB-67. `all` is the WHOLE board (not just `cards`, which
 * may be filtered) — like `toRow`, a `blocked` reason needs the facts a gate might point outside
 * the filtered list.
 */
export function formatTable(cards: Card[], all: readonly Card[], config: BoardConfig): string {
  const anySize = cards.some((c) => c.size !== undefined);
  const anyDecision = cards.some((c) => needsDecision(c));
  const anyBlocked = cards.some((c) => blockedReason(c, all, config) !== null);
  const rows = cards.map((c) => {
    const row = [c.id, c.status, c.assignee ?? '-'];
    if (anySize) row.push(c.size ?? '');
    if (anyDecision) row.push(needsDecision(c) ? (isOwnerTask(c) ? '!' : '?') : '');
    if (anyBlocked) row.push(blockedReason(c, all, config) ?? '');
    row.push(c.title);
    return row;
  });
  const header = ['ID', 'STATUS', 'ASSIGNEE'];
  if (anySize) header.push('SIZE');
  if (anyDecision) header.push('DECISION');
  if (anyBlocked) header.push('BLOCKED');
  header.push('TITLE');
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
    size: { type: 'string' },
    json: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    'needs-decision': { type: 'boolean', default: false },
  });
  if (values.full && !values.json) throw new UserError('--full only applies with --json');
  const size = sizeFrom(values.size);
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const all = store.list();
  let cards = all;
  if (values.status !== undefined) cards = cards.filter((c) => c.status === values.status);
  if (size !== undefined) cards = cards.filter((c) => c.size === size);
  if (values['needs-decision']) cards = cards.filter((c) => needsDecision(c));
  cards = cards.slice().sort((a, b) => idNumber(a.id) - idNumber(b.id) || (a.id < b.id ? -1 : 1));
  if (values.json) {
    // Compact rows by default (K6): bodies only with --full. Same shape as MCP list_cards.
    io.stdout.write(
      `${formatRows(values.full ? cards : cards.map((c) => toRow(c, all, store.config)))}\n`,
    );
    return 0;
  }
  io.stdout.write(`${formatTable(cards, all, store.config)}\n`);
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
  if (!card) {
    const archivedPath = join(store.repoboardDir, 'archive', `${id}.md`);
    const isArchived = await stat(archivedPath).then(
      () => true,
      () => false,
    );
    if (isArchived) {
      io.stdout.write(`archived: ${relative(root, archivedPath)}\n`);
      return 0;
    }
    throw new UserError(`unknown card "${id}"`);
  }
  io.stdout.write(await readFile(store.filePath(id), 'utf8'));
  if (values.resolve) {
    // K7: each ref as a fenced block headed path:start-end, resolved now from the file.
    const refs = await resolveCardRefs(store.root, card);
    io.stdout.write(refs.length === 0 ? '\n(no refs)\n' : `\n${formatResolvedRefs(refs)}`);
  }
  return 0;
}

// ---- columns (RCB-56: CLI/MCP surface for RCB-34's PATCH /api/board / ColumnEditor) ----------

interface ColumnRow {
  id: string;
  title: string;
  flags: string;
  count: number;
}

function columnFlags(c: Column): string {
  return [
    c.active ? 'active' : null,
    c.wip !== undefined ? `wip:${c.wip}` : null,
    c.done ? 'done' : null,
    c.decision ? 'decision' : null,
  ]
    .filter((f): f is string => f !== null)
    .join(',');
}

function toColumnRow(c: Column, count: number): ColumnRow {
  return { id: c.id, title: c.title ?? c.id, flags: columnFlags(c), count };
}

export function formatColumnsTable(rows: ColumnRow[]): string {
  const header = ['ID', 'TITLE', 'FLAGS', 'COUNT'];
  const body = rows.map((r) => [r.id, r.title, r.flags, String(r.count)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

async function cmdColumns(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean', default: false } });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  if (values.json) {
    io.stdout.write(`${formatRows(store.config.columns)}\n`);
    return 0;
  }
  const counts: Record<string, number> = {};
  for (const c of store.list()) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const rows = store.config.columns.map((c) => toColumnRow(c, counts[c.id] ?? 0));
  io.stdout.write(`${formatColumnsTable(rows)}\n`);
  return 0;
}

/** The WHOLE new column list — a replace, exactly `PATCH /api/board`'s contract (RCB-34 brief). */
function extractColumns(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object' && 'columns' in data) {
    const columns = (data as { columns: unknown }).columns;
    if (Array.isArray(columns)) return columns;
  }
  throw new UserError(
    'columns set: input must be a YAML/JSON list of columns, or an object with a "columns" key',
  );
}

async function cmdColumnsSet(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    stdin: { type: 'boolean', default: false },
    as: { type: 'string' },
  });
  const [textArg] = positionals;
  if (!values.stdin && textArg === undefined) {
    throw new UserError('usage: repoboard columns set (--stdin | "<text>") [--as a]');
  }
  const raw = values.stdin ? await readStdin(io) : textArg;
  let data: unknown;
  try {
    data = YAML.parse(raw ?? '', { schema: 'core' });
  } catch (e) {
    throw new UserError(`columns set: not valid YAML/JSON: ${(e as Error).message}`);
  }
  const columns = extractColumns(data);
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.setColumns(columns as Column[], actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  io.stdout.write(`updated columns: ${res.config.columns.map((c) => c.id).join(', ')}\n`);
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

// ---- state / log / check (P8.3) ------------------------------------------------------------

async function cmdState(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    'set-section': { type: 'string' },
    stdin: { type: 'boolean', default: false },
    as: { type: 'string' },
  });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  if (values['set-section'] !== undefined) {
    const section = sectionNameFrom(values['set-section']);
    let body: string;
    if (values.stdin) {
      body = await readStdin(io);
    } else {
      body = positionals.join(' ').trim();
      if (!body) {
        throw new UserError('state --set-section needs body text (or --stdin)');
      }
    }
    const res = await store.setStateSection(section, body, actorFrom(values.as, io));
    if (!res.ok) throw new UserError(res.error);
    io.stdout.write(`updated STATE.md ${values['set-section']}\n`);
    return 0;
  }
  const doc = store.state();
  if (!doc) {
    io.stdout.write('(no .repoboard/STATE.md — run `repoboard init --practices`)\n');
    return 0;
  }
  const text = renderState(doc.sections, store.list(), {
    now: new Date(Date.parse(doc.stamp)),
    actor: doc.actor,
  });
  io.stdout.write(text);
  return 0;
}

async function cmdLogAppend(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    as: { type: 'string' },
    title: { type: 'string' },
    stdin: { type: 'boolean', default: false },
  });
  let text: string;
  if (values.stdin) {
    text = await readStdin(io);
  } else {
    text = positionals.join(' ').trim();
    if (!text)
      throw new UserError('usage: repoboard log --as <seat> [--title "…"] (<text> | --stdin)');
  }
  // RCB-71: a log block is found by its seat name, so an unset --as must be refused, not
  // defaulted to $USER/'cli' the way actorFrom does for every other command.
  const env = io.env ?? process.env;
  const seat = values.as || env.REPOBOARD_ACTOR;
  if (!seat)
    throw new UserError(
      'repoboard log needs --as <seat> (or REPOBOARD_ACTOR); a log block is found by its seat name, so $USER is not a seat',
    );
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.appendRepoLog(seat, text, values.title);
  if (!res.ok) throw new UserError(res.error);
  // RCB-83: same rule as `seat --up/--down` — sync .repoboard/local/ after the write, a no-op
  // when there is no local layer.
  if (await hasLocal(root)) {
    const sync = await localSync(root, `${seat}: log`);
    if (sync.pushed === false) {
      (io.stderr ?? io.stdout).write(`warning: local: push failed: ${sync.error}\n`);
    }
  }
  io.stdout.write(`logged ${res.date} ${seat}\n`);
  return 0;
}

async function cmdLogShow(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { date: { type: 'string' }, seat: { type: 'string' } });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const log = await store.log(values.date);
  if (!log) {
    io.stdout.write('(no log for that date)\n');
    return 0;
  }
  if (values.seat !== undefined) {
    const wanted = values.seat.toUpperCase();
    const blocks = log.blocks.filter((b) => b.seat === wanted);
    if (blocks.length === 0) {
      io.stdout.write('(no entries for that seat on that date)\n');
      return 0;
    }
    io.stdout.write(`${blocks.map((b) => formatLogBlock(b)).join('\n\n')}\n`);
    return 0;
  }
  io.stdout.write(log.text);
  return 0;
}

/**
 * RCB-47: `repoboard log --last <seat>` — the cold-start read. Searches back across every
 * `.repoboard/log/*.md` day (not just today), so a seat that stood down yesterday is found with
 * no `--date`. A cold seat with no history is normal, not an error: miss is exit 0.
 */
async function cmdLogLast(args: string[], io: CliIO): Promise<number> {
  const seat = args[0];
  if (seat === undefined || seat.trim().length === 0) {
    throw new UserError('usage: repoboard log --last <seat>');
  }
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const res = await store.lastRepoLogBlock(seat);
  if (!res) {
    io.stdout.write(`(no log block for ${seat})\n`);
    return 0;
  }
  io.stdout.write(`${formatLogBlock(res.block)}\n`);
  return 0;
}

/**
 * RCB-48: `repoboard seat <name>` — the cold-start bundle, one command in place of the
 * three-file ritual (STATE.md → your own last block → the coordinator's → todo cards → open
 * decisions). Exit 0 on any successful read, even when every part is a placeholder — a cold seat
 * on a fresh board is the normal case, not an error.
 */
/**
 * RCB-60: THIS CLI's own monorepo root (not the board's `--root`) — `cli.ts` sits one level under
 * the package dir, same as `http.ts`'s `packageDir()`, so two more `dirname`s up from there is the
 * repo root. Test-only override: `REPOBOARD_SELF_ROOT` (via `CliIO.env`), since a real checkout's
 * own path on disk can't otherwise be faked in a fixture.
 */
function selfRepoRoot(io: CliIO): string {
  const override = (io.env ?? process.env).REPOBOARD_SELF_ROOT;
  if (override) return override;
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

async function cmdSeat(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean', default: false },
    up: { type: 'string' },
    down: { type: 'string' },
    force: { type: 'boolean', default: false },
  });
  const [name] = positionals;
  if (!name)
    throw new UserError(
      'usage: repoboard seat <name> [--json] [--up "<text>" [--force] | --down "<text>"]',
    );
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });

  // RCB-58: a seat restamps ONLY its own SEATS bullet — a write, kept separate from the bundle
  // read below (never printed together) so the permission classifier sees one small write.
  if (values.up !== undefined || values.down !== undefined) {
    if (values.up !== undefined && values.down !== undefined) {
      throw new UserError('seat: --up and --down are exclusive');
    }
    const status: 'UP' | 'DOWN' = values.up !== undefined ? 'UP' : 'DOWN';
    const text = values.up ?? values.down ?? '';
    if (text.trim().length === 0) {
      throw new UserError('seat --up/--down needs the bullet text');
    }

    // RCB-87: --up refuses a second UP inside activeWindowMinutes unless --force. --down is never
    // guarded (the rule only protects against two sessions both believing they hold the seat).
    if (status === 'UP') {
      const now = io.now?.() ?? new Date();
      const seatsSection = store.state()?.sections.seats ?? null;
      const standingLine = seatsSection !== null ? findSeatLine(seatsSection, name) : null;
      const conflict = seatUpConflict(standingLine, now, store.config.activeWindowMinutes);
      if (conflict) {
        const standingBullet = standingLine ?? '';
        if (!values.force) {
          (io.stderr ?? io.stdout).write(
            `seat ${name} is already UP (stamped ${conflict.stamp}, ${conflict.minutesAgo} min ` +
              `ago, window ${store.config.activeWindowMinutes} min):\n` +
              `  ${standingBullet}\n` +
              'another session holds this seat. If it is dead, re-run with --force (audited in the log).\n',
          );
          return 1;
        }
        await store.appendRepoLog(
          name,
          standingBullet,
          'seat --up --force over a standing UP bullet',
        );
      }
    }

    const res = await store.setSeatBullet(name, status, text);
    if (!res.ok) throw new UserError(res.error);
    // RCB-83: keep .repoboard/local/ in step with every SEATS write — a no-op when there is no
    // local layer (`hasLocal` false), so nothing changes for repos without one.
    if (await hasLocal(root)) {
      const sync = await localSync(root, `${name}: seat ${status}`);
      if (sync.pushed === false) {
        (io.stderr ?? io.stdout).write(`warning: local: push failed: ${sync.error}\n`);
      }
    }
    const stamp = `${res.doc.stamp.slice(0, 10)} ${res.doc.stamp.slice(11, 16)}Z`;
    const bullet = findSeatLine(res.doc.sections.seats, name) ?? '';
    if (values.json) {
      io.stdout.write(`${JSON.stringify({ name, status, stamp, bullet }, null, 2)}\n`);
    } else {
      io.stdout.write(`restamped SEATS ${name}: ${status} ${stamp}\n`);
    }
    // RCB-60: printed after, same as the read path below — harmless on a write.
    const staleness = await distStaleness(selfRepoRoot(io));
    if (staleness) (io.stderr ?? io.stdout).write(`warning: ${staleness}\n`);
    return 0;
  }

  const bundle = await store.seatBundle(name);
  if (values.json) {
    io.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } else {
    io.stdout.write(renderSeatBundle(bundle, store.clock));
  }
  // RCB-60: printed after the bundle so a seat's cold-start read is never blocked or reordered.
  const staleness = await distStaleness(selfRepoRoot(io));
  if (staleness) (io.stderr ?? io.stdout).write(`warning: ${staleness}\n`);
  return 0;
}

async function cmdCheck(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    json: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const { findings, exitCode } = await store.check(values.strict);
  if (values.json) {
    io.stdout.write(`${formatRows(findings)}\n`);
    return exitCode;
  }
  if (findings.length === 0) {
    io.stdout.write('ok\n');
    return 0;
  }
  for (const f of findings) io.stdout.write(`${f.message}\n`);
  return exitCode;
}

/**
 * RCB-83: `repoboard local init|sync|status` — the local-only layer, `.repoboard/local/`, a
 * separate gitignored git repo for machine facts (RIG.md) and, once an owner `git mv`s them in,
 * the running record (STATE.md, log/). See `local.ts` for the git mechanics.
 */
async function cmdLocal(sub: string | undefined, args: string[], io: CliIO): Promise<number> {
  const root = await requireRoot(io);
  if (sub === 'init') {
    const { values } = parse(args, { remote: { type: 'string' } });
    await localInit(root, { remote: values.remote, io, now: io.now });
    return 0;
  }
  if (sub === 'sync') {
    const { values } = parse(args, { message: { type: 'string', short: 'm' } });
    const message = values.message ?? 'repoboard local: sync';
    const res = await localSync(root, message);
    if (res.status === 'no-local') {
      io.stdout.write('no .repoboard/local/ — run repoboard local init\n');
      return 0;
    }
    const pushedText =
      res.pushed === true ? ', pushed' : res.pushed === false ? ', push failed' : '';
    io.stdout.write(`local: ${res.status}${pushedText}\n`);
    if (res.pushed === false && res.error) {
      (io.stderr ?? io.stdout).write(`warning: local: push failed: ${res.error}\n`);
    } else if (res.pushed === null && res.error) {
      (io.stderr ?? io.stdout).write(`warning: local: sync failed: ${res.error}\n`);
    }
    return 0;
  }
  if (sub === 'status') {
    const status = await localStatus(root);
    if (!status) {
      io.stdout.write('no .repoboard/local/ — run repoboard local init\n');
      return 0;
    }
    const ahead = status.ahead === null ? '—' : String(status.ahead);
    io.stdout.write(
      `local: ${ahead} ahead, ${status.dirty ? 'dirty' : 'clean'}, ` +
        `${status.hasRemote ? 'remote' : 'no remote'}\n`,
    );
    return 0;
  }
  throw new UserError(`unknown local command "${sub ?? ''}" (init, sync, status)`);
}

/**
 * P8.4 locked decision 6: `--root` measures ANY directory, with or without `.repoboard/` — a
 * `.repoboard/`-less repo (freshpickedjobs, measured read-only) is exactly the motivating case.
 * With no `--root`, climb to the nearest `.repoboard/` like every other command (so a bare
 * `repoboard cost` inside a repoboard-managed repo needs no flag).
 */
async function costRoot(rootFlag: string | undefined, io: CliIO): Promise<string> {
  if (rootFlag === undefined) return requireRoot(io);
  const root = resolve(io.cwd, rootFlag);
  const isDir = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new UserError(`--root ${root} is not a directory`);
  return root;
}

/** CLI flag wins over `board.yml`'s `claudeMdBudgetBytes`, which wins over the built-in default
 * (locked decision 2). `root` may have no `.repoboard/board.yml` at all (costRoot above) — that
 * is not an error here, just "no configured budget". */
async function budgetFor(root: string, flag: string | undefined): Promise<number> {
  if (flag !== undefined) {
    const n = Number.parseInt(flag, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new UserError(`--budget must be a positive integer (got "${flag}")`);
    }
    return n;
  }
  try {
    const text = await readFile(join(root, '.repoboard', 'board.yml'), 'utf8');
    const parsed = parseBoard(text);
    if (parsed.ok && parsed.config.claudeMdBudgetBytes !== undefined) {
      return parsed.config.claudeMdBudgetBytes;
    }
  } catch {
    // no board.yml (or it does not parse) — fall through to the built-in default.
  }
  return DEFAULT_CLAUDE_MD_BUDGET_BYTES;
}

async function cmdCost(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    root: { type: 'string' },
    budget: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const root = await costRoot(values.root, io);
  const budget = await budgetFor(root, values.budget);
  const report = await gatherCost(root, budget);
  if (values.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.over ? 1 : 0;
  }
  io.stdout.write(`${formatCostTable(report)}\n`);
  return report.over ? 1 : 0;
}

// ---- archive / sync-issues (P8.5) -----------------------------------------------------------

async function cmdArchive(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    'older-than': { type: 'string', default: '14d' },
    'dry-run': { type: 'boolean', default: false },
    as: { type: 'string' },
  });
  const root = await requireRoot(io);
  const store = await openStore(root, { watch: false, now: io.now });
  const now = io.now?.() ?? new Date();
  const older = resolveOlderThan(values['older-than'] ?? '14d', now);
  if (!older.ok) throw new UserError(older.error);
  const ids = store.selectArchivable(older.cutoff);
  if (values['dry-run']) {
    io.stdout.write(
      ids.length === 0 ? 'would archive 0\n' : `would archive ${ids.length}: ${ids.join(', ')}\n`,
    );
    return 0;
  }
  if (ids.length === 0) {
    io.stdout.write('archived 0\n');
    return 0;
  }
  const res = await store.archiveCards(ids, actorFrom(values.as, io));
  if (!res.ok) throw new UserError(res.error);
  io.stdout.write(`archived ${res.archived.length}: ${res.archived.join(', ')}\n`);
  return 0;
}

/** `<path>#<heading>` — the first `#` splits the two; both halves are required. */
function splitPathHeading(arg: string): { path: string; heading: string } {
  const i = arg.indexOf('#');
  const path = i === -1 ? arg : arg.slice(0, i);
  const heading = i === -1 ? '' : arg.slice(i + 1);
  if (!path || !heading) {
    throw new UserError('usage: repoboard sync-issues <path>#<heading> [options]');
  }
  return { path, heading };
}

async function cmdSyncIssues(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, {
    status: { type: 'string', default: 'todo' },
    label: { type: 'string', default: 'issue' },
    'dry-run': { type: 'boolean', default: false },
    as: { type: 'string' },
    root: { type: 'string' },
  });
  const [arg] = positionals;
  if (!arg) throw new UserError('usage: repoboard sync-issues <path>#<heading> [options]');
  const { path, heading } = splitPathHeading(arg);
  // K7's own read-only root resolution (`costRoot`): --root measures ANY directory, board or
  // not — the freshpickedjobs measurement (locked decision 6) is exactly this case.
  const root = await costRoot(values.root, io);
  const store = await openStore(root, { watch: false, now: io.now });
  const input = {
    path,
    heading,
    status: values.status ?? 'todo',
    label: values.label ?? 'issue',
  };
  const outcome = await computeSyncPlan(store, input);
  if (!outcome.ok) throw new UserError(outcome.error);
  const { plan, malformed } = outcome;
  for (const line of malformed) io.stdout.write(`skipped: malformed strike: ${line}\n`);
  const createKs = plan.create.map((c) => `K${c.n}`);
  const closeKs = plan.close.map((c) => `K${c.n}`);
  if (values['dry-run']) {
    io.stdout.write(
      `would create ${plan.create.length}, close ${plan.close.length}, ` +
        `malformed ${malformed.length}, unchanged ${plan.unchanged}\n`,
    );
    if (createKs.length > 0) io.stdout.write(`create: ${createKs.join(' ')}\n`);
    if (closeKs.length > 0) io.stdout.write(`close: ${closeKs.join(' ')}\n`);
    return 0;
  }
  const actor = actorFrom(values.as, io);
  const applied = await applySyncPlan(store, input, plan, actor);
  io.stdout.write(
    `created ${applied.created.length}, closed ${applied.closed.length}, ` +
      `malformed ${malformed.length}\n`,
  );
  for (const e of applied.errors) (io.stderr ?? io.stdout).write(`error: ${e}\n`);
  return applied.errors.length > 0 ? 1 : 0;
}

/**
 * RCB-42: `--sibling <name>=<url>` — split on the FIRST `=` (a URL can contain `=` itself, e.g. a
 * query string; a name cannot, by this rule, so the first one is unambiguous). Both halves
 * trimmed and required; the url must pass the same `isSiblingUrl` rule `SiblingSchema` enforces
 * on board.yml's own `siblings:` list, so the two entry points can never disagree.
 */
function parseSiblingFlag(raw: string): Sibling {
  const i = raw.indexOf('=');
  const name = (i === -1 ? raw : raw.slice(0, i)).trim();
  const url = (i === -1 ? '' : raw.slice(i + 1)).trim();
  if (!name || !url) {
    throw new UserError(`--sibling must be "<name>=<url>" (got "${raw}")`);
  }
  if (!isSiblingUrl(url)) {
    throw new UserError(`--sibling url must be an http(s) URL (got "${raw}")`);
  }
  return { name, url };
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
    root: { type: 'string', multiple: true },
    port: { type: 'string', default: '4242' },
    open: { type: 'boolean', default: false },
    'no-fun': { type: 'boolean', default: false },
    'watch-cap': { type: 'string' },
    sibling: { type: 'string', multiple: true },
  });
  const siblingsFlag = (values.sibling ?? []).map(parseSiblingFlag);
  const port = Number.parseInt(values.port ?? '', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UserError(`--port must be 0–65535 (got "${values.port}")`);
  }
  // K12: hard cap on what the repo watcher may hold before it turns itself off (`DEFAULT_WATCH_CAP`,
  // 20,000, when the flag is absent).
  let watchCap: number | undefined;
  if (values['watch-cap'] !== undefined) {
    watchCap = Number.parseInt(values['watch-cap'], 10);
    if (!Number.isInteger(watchCap) || watchCap <= 0) {
      throw new UserError(`--watch-cap must be a positive integer (got "${values['watch-cap']}")`);
    }
  }
  // RCB-43 slice 1: `--root` is repeatable, in order; zero `--root` keeps today's climb-from-cwd
  // (`serveRoot(undefined, io)`). Each given `--root` goes through the same directory check as
  // before — `serveRoot` never searches upward for a `--root` it was actually given.
  const rootFlags = values.root ?? [];
  const roots =
    rootFlags.length > 0
      ? await Promise.all(rootFlags.map((r) => serveRoot(r, io)))
      : [await serveRoot(undefined, io)];
  const primaryRoot = roots[0] as string;
  const err = io.stderr ?? io.stdout;
  const store = await openStore(primaryRoot, { watch: true, now: io.now });
  store.on('warning', (m) => err.write(`warning: ${m}\n`));
  let server: RunningServer;
  try {
    server = await startServer({
      store,
      port,
      fun: !values['no-fun'],
      ...(watchCap !== undefined ? { watchCap } : {}),
      siblingsFlag,
      warn: (m) => err.write(`warning: ${m}\n`),
      roots,
      now: io.now,
    });
  } catch (e) {
    await store.close();
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new UserError(`port ${port} is already in use`);
    throw e;
  }
  io.stdout.write(`repoboard: serving ${primaryRoot}\n  ${server.url}\n`);
  // RCB-43 slice 1: one line per `--root`, primary first and marked — the same key
  // `GET /api/repos` uses, so a line here and an entry there always agree.
  for (const { key, root: r } of assignRepoKeys(roots)) {
    const isPrimary = r === primaryRoot;
    const board = (isPrimary ? store.hasBoard : hasBoardDir(r)) ? 'board' : 'map-only';
    io.stdout.write(`  ${key}  ${r}  (${board})${isPrimary ? '  primary' : ''}\n`);
  }
  io.stdout.write(`  repo watcher: ${server.watchedPaths().length} paths\n`);
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
      if (sub === 'note') return await cmdCardNote(rest, io);
      throw new UserError(
        `unknown card command "${sub ?? ''}" (add, move, update, list, show, ask, decide, note)`,
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
    if (cmd === 'columns') {
      if (sub === 'set') return await cmdColumnsSet(rest, io);
      return await cmdColumns(argv.slice(1), io);
    }
    if (cmd === 'state') return await cmdState(argv.slice(1), io);
    if (cmd === 'log') {
      if (sub === 'show') return await cmdLogShow(rest, io);
      if (sub === '--last') return await cmdLogLast(rest, io);
      return await cmdLogAppend(argv.slice(1), io);
    }
    if (cmd === 'seat') return await cmdSeat(argv.slice(1), io);
    if (cmd === 'check') return await cmdCheck(argv.slice(1), io);
    if (cmd === 'local') return await cmdLocal(sub, rest, io);
    if (cmd === 'cost') return await cmdCost(argv.slice(1), io);
    if (cmd === 'archive') return await cmdArchive(argv.slice(1), io);
    if (cmd === 'sync-issues') return await cmdSyncIssues(argv.slice(1), io);
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
