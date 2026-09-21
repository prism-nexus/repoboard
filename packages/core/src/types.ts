/**
 * Shared domain types for repoboard. Everything here is plain data — no classes, no I/O.
 * File formats: BUILD-PLAN §2. Wire contract: §3. Repo snapshot: §4.
 */

export type Priority = 'high' | 'medium' | 'low';

/**
 * RCB-67: how much work a card is. **S** = one builder turn (≤ 2 h) · **M** = half a day, brief +
 * tests · **L** = investigation first, days · **XL** = plan-sized.
 */
export type Size = 'S' | 'M' | 'L' | 'XL';

/** One lettered choice on a `decision:` block. Letters are free short strings, unique per card. */
export interface DecisionOption {
  letter: string;
  text: string;
}

/**
 * P8.1 (O10): a decision lives ON THE CARD, not in a separate file. `chosen !== null ||
 * decidedAt !== null` means DECIDED; neither set means NEEDS OWNER (`needsDecision`/`isDecided`
 * in `decisions.ts`). `options` may be empty for a yes/no or free-text question, in which case
 * the owner answers with `words` only.
 */
export interface Decision {
  question: string;
  /**
   * RCB-52: an owner WORK item in the same queue. Absent = a question. A task has no options and
   * is closed by `decide` with neither letter nor words.
   */
  kind?: 'task';
  options: DecisionOption[];
  askedBy: string;
  askedAt: string;
  /**
   * O11: the column the card was in when asked, when `ask` moved it into a `decision: true`
   * column. `null` when the board has no such column (status did not change). `decide` moves the
   * card back here; if the column no longer exists, it stays and the log says so.
   */
  returnTo: string | null;
  chosen: string | null;
  words: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  [key: string]: unknown;
}

/**
 * A card = the YAML frontmatter of `.repoboard/cards/<id>.md` plus its markdown body.
 * Unknown frontmatter keys are kept (index signature) and written back on serialize.
 * `body` is everything after the closing `---` line, byte-for-byte.
 */
export interface Card {
  id: string;
  title: string;
  status: string;
  created: string;
  updated: string;
  assignee?: string;
  priority?: Priority;
  /** RCB-67: how much work this card is. S = one builder turn (≤ 2 h) · M = half a day, brief +
   * tests · L = investigation first, days · XL = plan-sized. */
  size?: Size;
  labels?: string[];
  files?: string[];
  /** K7: pointers into repo files, rendered live (`refs.ts`). */
  refs?: string[];
  /** RCB-68: this card's id, when this card is a STEP of that phase card (`phases.ts`). */
  parent?: string;
  /** RCB-68: a free short label (e.g. `PH.3`), sorted naturally, marking which step this is. */
  phase?: string;
  /** RCB-68: what blocks this card — a card id (clears when that card is done/decided) or a
   * free-text sentence (cleared only by hand). See `phases.ts`'s `gateState`/`blockedReason`. */
  gate?: string;
  /** P8.1: an open or answered decision. `ask`/`decide` in `decisions.ts` are the only writers. */
  decision?: Decision;
  body: string;
  [key: string]: unknown;
}

/**
 * P8.2: one held lock on a named resource in `.repoboard/leases.yml`. `until` absent means "held
 * until released" — never renews itself, never expires. A lease with `until` in the past is
 * STALE (`leases.ts`'s `staleLeases`/liveness checks), reported as such and never silently
 * dropped: the holder may have died, and a human decides whether to `--force` past it.
 */
export interface Lease {
  resource: string;
  holder: string;
  since: string;
  until?: string;
  note?: string;
  [key: string]: unknown;
}

/** P8.2: a named time window during which `resource` is claimed, in `.repoboard/leases.yml`. */
export interface Window {
  resource: string;
  start: string;
  end: string;
  name: string;
  [key: string]: unknown;
}

/**
 * P8.2: the whole of `.repoboard/leases.yml`. An absent file means `{leases: [], windows: []}` —
 * no leases, no windows (the store supplies this default; core never invents a file).
 */
export interface LeasesDoc {
  leases: Lease[];
  windows: Window[];
  [key: string]: unknown;
}

/**
 * RCB-42: one entry in the top bar's "other running boards" link group — a repo's display name
 * and the URL to open it in a new tab. `url` must be http(s) (enforced by `SiblingSchema` /
 * `isSiblingUrl`, which `serve --sibling` re-uses so the two entry points agree on the rule).
 */
export interface Sibling {
  name: string;
  url: string;
}

export interface Column {
  id: string;
  title?: string;
  /** Cards here count as "in progress" for presence (D8). */
  active?: boolean;
  /** Soft work-in-progress limit; exceeding it is a warning, never a block. */
  wip?: number;
  /** Terminal column (confetti lives here, D9). */
  done?: boolean;
  /** P8.1/O11: `ask` moves a card here (recording `decision.returnTo`); `decide` moves it back. */
  decision?: boolean;
  [key: string]: unknown;
}

export interface BoardConfig {
  /** RCB-41: optional display name for the top bar / tab title. Absent means "the folder name"
   * — resolved by `boardDisplayName`, never defaulted here. */
  name?: string;
  /** RCB-42: other running boards, shown as plain links in the top bar. Optional; absent or
   * empty means none. Merged server-side with any `serve --sibling` flags (core
   * `mergeSiblings`) — the web never merges, it only renders what the server sends. */
  siblings?: Sibling[];
  prefix: string;
  activeWindowMinutes: number;
  /** P8.6 (fpj convergence): an ADDITIONAL directory of daily `<YYYY-MM-DD>.md` log files that
   * `repoboard check` reads alongside `.repoboard/log/` — `repoboard log` never writes here, so
   * a repo whose seats already keep their own daily log (fpj's `docs/log/`) can be seen by
   * `check` without a second copy. Relative to the REPO ROOT, e.g. `docs/log`. Absent means
   * today's behaviour, byte-identical; a configured path that does not exist reads as empty,
   * never an error. */
  logDir?: string;
  /** P8.4: `repoboard cost`'s budget for the root `CLAUDE.md`, in bytes. A CLI `--budget` flag
   * wins over this; absent here AND on the flag means `DEFAULT_CLAUDE_MD_BUDGET_BYTES` (cost.ts). */
  claudeMdBudgetBytes?: number;
  columns: Column[];
  [key: string]: unknown;
}

/**
 * One line of `.repoboard/events.jsonl` (§2). `move` is written by every surface that changes
 * `status`; `update` (from === to) and `create` (from === null) are written by the store so
 * the ticker sees every mutation (K2). P8.1: `ask`/`decide` (from === to, like `update`) are
 * written by `askDecision`/`decide` in `decisions.ts`; `letter` is present only on a `decide`
 * event that carried a lettered choice. P8.2: `lease`/`window` events are about a `leases.yml`
 * resource, not a card — `cardId` is `null` and `resource` names it instead; `from`/`to` carry
 * the holder change (`from` the previous holder or `null`, `to` the new holder or `"released"`)
 * for `lease`, and `to` the window's name for `window` (`leases.ts`).
 * P8.5: `archive` is one event per card moved to `.repoboard/archive/` -- `from` the
 * column it left, `to` the literal string `"archive"` (there is no column by that name).
 * RCB-56: `columns` is one event per `store.setColumns` call (CLI `columns set`, MCP
 * `set_columns`, HTTP `PATCH /api/board`, the web ColumnEditor) — `cardId` is `null` and
 * `resource` is absent (it is not about a card or a leases.yml resource); `from` is the
 * previous column ids joined by `,`, `to` the new ones, same order as `board.yml`.
 * RCB-70: `note` is written by `addNote` (`notes.ts`) — `from === to === card.status` like
 * `update`, since a note never changes status.
 */
export interface Event {
  ts: string;
  actor: string;
  type:
    | 'move'
    | 'update'
    | 'create'
    | 'ask'
    | 'decide'
    | 'lease'
    | 'window'
    | 'archive'
    | 'columns'
    | 'note';
  cardId: string | null;
  /** P8.2: present on `lease`/`window` events, absent on card events. */
  resource?: string;
  from: string | null;
  to: string;
  letter?: string;
}

/** Verbatim from BUILD-PLAN §4. The server produces it; the web renders it. */
export type RepoSnapshot = {
  root: string;
  scannedAt: string;
  files: {
    path: string;
    bytes: number;
    lines: number | null; // null when not counted (binary, >2 MB) — K3
    lang: string;
    commits30d: number;
    commits90d: number;
    lastCommitAt: string | null;
  }[];
  edges: { from: string; to: string }[]; // import graph, JS/TS only in P4
  languages: Record<string, number>; // bytes per lang
  head: { branch: string; sha: string } | null;
};
