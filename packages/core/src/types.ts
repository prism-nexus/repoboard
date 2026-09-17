/**
 * Shared domain types for repoboard. Everything here is plain data — no classes, no I/O.
 * File formats: BUILD-PLAN §2. Wire contract: §3. Repo snapshot: §4.
 */

export type Priority = 'high' | 'medium' | 'low';

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
  labels?: string[];
  files?: string[];
  /** K7: pointers into repo files, rendered live (`refs.ts`). */
  refs?: string[];
  /** P8.1: an open or answered decision. `ask`/`decide` in `decisions.ts` are the only writers. */
  decision?: Decision;
  body: string;
  [key: string]: unknown;
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
  prefix: string;
  activeWindowMinutes: number;
  columns: Column[];
  [key: string]: unknown;
}

/**
 * One line of `.repoboard/events.jsonl` (§2). `move` is written by every surface that changes
 * `status`; `update` (from === to) and `create` (from === null) are written by the store so
 * the ticker sees every mutation (K2). P8.1: `ask`/`decide` (from === to, like `update`) are
 * written by `askDecision`/`decide` in `decisions.ts`; `letter` is present only on a `decide`
 * event that carried a lettered choice.
 */
export interface Event {
  ts: string;
  actor: string;
  type: 'move' | 'update' | 'create' | 'ask' | 'decide';
  cardId: string;
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
