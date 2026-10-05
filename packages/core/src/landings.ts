/**
 * RCB-217: what landed, read from git instead of typed into STATE.md. Pure, I/O-free (§0.5): the
 * server reads `git log` (`repo-health.ts`'s `LOG_FORMAT`, parsed by `parseCommitLog`) and hands the
 * rows in; this file decides which commits are landings and how they group. A commit is a landing
 * when its SUBJECT starts with a card id of this board's prefix — `RCB-217: …` or `RCB-217 …`. A
 * subject that merely mentions a card (`cards: RCB-1 filed`), names it without a `:`/space after
 * the number (`RCB-217,`), or carries another board's prefix is not one. The web joins each row's
 * title and column from the live cards; this file never sees a card.
 */
import type { CommitRow } from './repo-health.js';

/** One landing commit as the Board receives it: the short sha, committer time (ISO, as git wrote
 * it), author name and the whole subject line. */
export interface LandingCommit {
  sha: string;
  at: string;
  author: string;
  subject: string;
}

/** Every landing commit of one card, newest first. */
export interface LandingRow {
  cardId: string;
  commits: LandingCommit[];
}

/**
 * Snapshot `landings` and `{type:"landings"}`. `web` is the GitHub https base `GET /api/git` reports
 * (`null` when there is none — a commit link is then not offered, never guessed); `source` says how
 * the rows were read, so a number on screen can be traced to a command.
 */
export interface LandingsPayload {
  rows: LandingRow[];
  web: string | null;
  source: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A time that does not parse sorts as the oldest: it is never promoted to "newest" by accident. */
function commitMs(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * RCB-217: `rows` (git commits, any order) → the cards they landed, as `LandingRow[]`. A commit is a
 * landing when its subject matches `^<prefix>-\d+` followed by `:` or a space; `prefix` is matched
 * literally and case-sensitively (card ids are). Commits are grouped by card id, newest first (by
 * committer time; equal or unparseable times keep their input order, so git's own order decides),
 * and the groups are ordered by their newest commit, so the card that landed last is first. No
 * landing among `rows` — or a `prefix` that is empty, which names no card — is `[]`.
 */
export function landingsFromCommits(rows: readonly CommitRow[], prefix: string): LandingRow[] {
  if (prefix.length === 0) return [];
  const subject = new RegExp(`^(${escapeRegExp(prefix)}-\\d+)[: ]`);
  const landings = rows.flatMap((row, order) => {
    const cardId = subject.exec(row.subject)?.[1];
    return cardId === undefined ? [] : [{ cardId, order, ms: commitMs(row.at), row }];
  });
  landings.sort((a, b) => (a.ms === b.ms ? a.order - b.order : b.ms > a.ms ? 1 : -1));
  const groups = new Map<string, LandingCommit[]>();
  for (const { cardId, row } of landings) {
    const commit: LandingCommit = {
      sha: row.sha,
      at: row.at,
      author: row.author,
      subject: row.subject,
    };
    const group = groups.get(cardId);
    if (group === undefined) groups.set(cardId, [commit]);
    else group.push(commit);
  }
  return [...groups].map(([cardId, commits]) => ({ cardId, commits }));
}
