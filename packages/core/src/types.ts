/**
 * Shared domain types for rcb. Everything here is plain data — no classes, no I/O.
 * File formats: BUILD-PLAN §2. Wire contract: §3. Repo snapshot: §4.
 */

export type Priority = 'high' | 'medium' | 'low';

/**
 * A card = the YAML frontmatter of `.rcb/cards/<id>.md` plus its markdown body.
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
  [key: string]: unknown;
}

export interface BoardConfig {
  prefix: string;
  activeWindowMinutes: number;
  columns: Column[];
  [key: string]: unknown;
}

/**
 * One line of `.rcb/events.jsonl` (§2). `move` is written by every surface that changes
 * `status`; `update` (from === to) and `create` (from === null) are written by the store so
 * the ticker sees every mutation (K2).
 */
export interface Event {
  ts: string;
  actor: string;
  type: 'move' | 'update' | 'create';
  cardId: string;
  from: string | null;
  to: string;
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
