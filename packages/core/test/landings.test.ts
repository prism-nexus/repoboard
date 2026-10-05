/**
 * RCB-217: `landings.ts` — which git commits are landings (a subject that STARTS with a card id of
 * this board's prefix), and how they group. Pure: rows in, rows out.
 *
 * CONTROLS (run by the seat, not part of the suite) — each perturbation is applied to
 * `packages/core/src/landings.ts`, read back, typechecked, and must turn the named test red:
 *  - subject regex `^(PREFIX-\d+)[: ]` -> `(PREFIX-\d+)[: ]` (unanchored): the "subject rule" test
 *    and the `cards: RCB-1 filed` test fail (the mention becomes a landing).
 *  - `[: ]` -> `[: ,]`: the "no separator" assertions in the subject-rule test fail (`RCB-220,`).
 *  - drop the `landings.sort(...)` line: "oldest-first input" and "offset times" fail; the
 *    git-order grouping test still passes (its input is already newest first) — that is why both exist.
 *  - sort by `a.at < b.at` as STRINGS: "offset times" fails (`-07:00` sorts before `Z` by text).
 *  - order the groups by `cardId` instead of by their newest commit: "grouping" fails.
 *  - drop the `prefix.length === 0` guard: "an empty prefix" fails (every `-<n>: …` subject lands).
 *  - drop `escapeRegExp`: "prefix is literal" fails (`R.B` matches `RxB-1: …`).
 */
import { describe, expect, it } from 'vitest';
import { landingsFromCommits } from '../src/landings.js';
import type { CommitRow } from '../src/repo-health.js';

function row(sha: string, at: string, subject: string, author = 'Ada'): CommitRow {
  return { sha, at, author, agent: null, subject };
}

const ids = (rows: readonly CommitRow[], prefix = 'RCB') =>
  landingsFromCommits(rows, prefix).map((r) => r.cardId);

describe('landingsFromCommits: which commits are landings', () => {
  it('a subject is a landing when it STARTS with <PREFIX>-<n> followed by ":" or a space', () => {
    const rows = [
      row('a1', '2026-10-05T10:00:00Z', 'RCB-217: seat events'),
      row('a2', '2026-10-05T09:00:00Z', 'RCB-218 web side'),
      row('a3', '2026-10-05T08:00:00Z', 'RCB-2170: a four-digit id is one id'),
      // none of these is a landing:
      row('n1', '2026-10-05T07:00:00Z', 'RCB-219'), // nothing after the number
      row('n2', '2026-10-05T06:00:00Z', 'RCB-220, RCB-221: two cards'), // "," follows the number
      row('n3', '2026-10-05T05:00:00Z', 'RCB-22x: not a number'),
      row('n4', '2026-10-05T04:00:00Z', 'OTHER-5: another board'),
      row('n5', '2026-10-05T03:00:00Z', 'rcb-7: ids are upper case'),
      row('n6', '2026-10-05T02:00:00Z', ' RCB-8: a leading space'),
      row('n7', '2026-10-05T01:00:00Z', 'RCB-: no number'),
    ];
    expect(ids(rows)).toEqual(['RCB-217', 'RCB-218', 'RCB-2170']);
  });

  it('`cards: RCB-1 filed` is NOT a landing — a card named later in the subject is a mention', () => {
    expect(ids([row('c1', '2026-10-05T10:00:00Z', 'cards: RCB-1 filed')])).toEqual([]);
    expect(ids([row('c2', '2026-10-05T10:00:00Z', 'cards: RCB-215 note — late writer')])).toEqual(
      [],
    );
    expect(ids([row('c3', '2026-10-05T10:00:00Z', 'Closes RCB-4: via a merge')])).toEqual([]);
  });

  it('the prefix is matched literally, never as a pattern', () => {
    const rows = [
      row('p1', '2026-10-05T10:00:00Z', 'RxB-1: a different prefix'),
      row('p2', '2026-10-05T09:00:00Z', 'R.B-2: the real one'),
    ];
    expect(ids(rows, 'R.B')).toEqual(['R.B-2']);
  });

  it('an empty prefix names no card: no rows, not every "-<n>: …" subject', () => {
    expect(ids([row('e1', '2026-10-05T10:00:00Z', '-1: odd subject')], '')).toEqual([]);
  });

  it('no commits, or no landing among them, is [] (never null, never a placeholder row)', () => {
    expect(landingsFromCommits([], 'RCB')).toEqual([]);
    expect(ids([row('x1', '2026-10-05T10:00:00Z', 'tidy the readme')])).toEqual([]);
  });
});

describe('landingsFromCommits: grouping and order', () => {
  it('groups by card id, commits newest first, groups ordered by their newest commit', () => {
    // git's own order: newest first.
    const rows = [
      row('s5', '2026-10-05T15:00:00Z', 'RCB-2: second slice', 'Bo'),
      row('s4', '2026-10-05T14:00:00Z', 'RCB-1: follow-up'),
      row('s3', '2026-10-05T13:00:00Z', 'RCB-2: first slice', 'Bo'),
      row('s2', '2026-10-05T12:00:00Z', 'cards: RCB-9 filed'),
      row('s1', '2026-10-05T11:00:00Z', 'RCB-3: other card'),
      row('s0', '2026-10-05T10:00:00Z', 'RCB-1: the start'),
    ];
    expect(landingsFromCommits(rows, 'RCB')).toEqual([
      {
        cardId: 'RCB-2',
        commits: [
          { sha: 's5', at: '2026-10-05T15:00:00Z', author: 'Bo', subject: 'RCB-2: second slice' },
          { sha: 's3', at: '2026-10-05T13:00:00Z', author: 'Bo', subject: 'RCB-2: first slice' },
        ],
      },
      {
        cardId: 'RCB-1',
        commits: [
          { sha: 's4', at: '2026-10-05T14:00:00Z', author: 'Ada', subject: 'RCB-1: follow-up' },
          { sha: 's0', at: '2026-10-05T10:00:00Z', author: 'Ada', subject: 'RCB-1: the start' },
        ],
      },
      {
        cardId: 'RCB-3',
        commits: [
          { sha: 's1', at: '2026-10-05T11:00:00Z', author: 'Ada', subject: 'RCB-3: other card' },
        ],
      },
    ]);
  });

  it('a commit carries exactly sha, at, author and subject — not the agent trailer', () => {
    const [group] = landingsFromCommits(
      [
        {
          sha: 'q1',
          at: '2026-10-05T10:00:00Z',
          author: 'Ada',
          agent: 'Claude',
          subject: 'RCB-1: x',
        },
      ],
      'RCB',
    );
    expect(Object.keys(group?.commits[0] ?? {}).sort()).toEqual(['at', 'author', 'sha', 'subject']);
  });

  it('oldest-first input gives the same answer: newest is decided by time, not by position', () => {
    const newestFirst = [
      row('t3', '2026-10-05T15:00:00Z', 'RCB-2: c'),
      row('t2', '2026-10-05T14:00:00Z', 'RCB-1: b'),
      row('t1', '2026-10-05T13:00:00Z', 'RCB-2: a'),
    ];
    const oldestFirst = [...newestFirst].reverse();
    expect(landingsFromCommits(oldestFirst, 'RCB')).toEqual(
      landingsFromCommits(newestFirst, 'RCB'),
    );
    expect(ids(oldestFirst)).toEqual(['RCB-2', 'RCB-1']);
  });

  it('times with different UTC offsets are compared as instants, not as text', () => {
    // 10:00-07:00 is 17:00Z — LATER than 16:00Z, though "…T10…" sorts before "…T16…" as a string.
    const rows = [
      row('o1', '2026-10-05T16:00:00Z', 'RCB-1: utc'),
      row('o2', '2026-10-05T10:00:00-07:00', 'RCB-2: pacific'),
    ];
    expect(ids(rows)).toEqual(['RCB-2', 'RCB-1']);
  });

  it('equal or unparseable times keep git order; an unparseable time is never the newest', () => {
    const rows = [
      row('k1', '2026-10-05T10:00:00Z', 'RCB-1: first'),
      row('k2', '2026-10-05T10:00:00Z', 'RCB-2: same instant'),
      row('k3', 'not a date', 'RCB-3: no time'),
    ];
    expect(ids(rows)).toEqual(['RCB-1', 'RCB-2', 'RCB-3']);
    expect(ids([...rows].reverse())).toEqual(['RCB-2', 'RCB-1', 'RCB-3']);
  });
});
