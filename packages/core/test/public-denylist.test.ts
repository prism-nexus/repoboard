/**
 * RCB-209: `checkFindings`' three public-denylist kinds — `public-denylist-missing` (info),
 * `public-denylist-hit` (error), `public-denylist-invalid` (error) — and the inert cases (null,
 * absent, a present file with no patterns, a missing file with no local git repo). Pure; the
 * `git grep` that produces `hits` is the server's (`public-guard.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import type { CheckInput, Finding } from '../src/state.js';
import { checkFindings, exitCodeForFindings, initialStateText, parseState } from '../src/state.js';

const NOW = new Date('2026-09-30T12:00:00Z');

function base(): CheckInput {
  const parsed = parseState(initialStateText({ now: NOW, actor: 'claude/ops' }));
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    state: parsed.doc,
    logs: [],
    cards: [],
    config: defaultBoardConfig(),
    leases: { leases: [], windows: [] },
    now: NOW,
  };
}

const LOCAL_REPO = { isRepo: true, hasRemote: true, dirty: false, ahead: 0, remoteAck: false };
const DENYLIST = '.repoboard/local/public-denylist.txt';

function publicKinds(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.kind.startsWith('public-denylist-'));
}

describe('checkFindings: public denylist (RCB-209)', () => {
  it('null and absent are inert — no finding of any public-denylist kind', () => {
    const withNull = checkFindings({ ...base(), local: LOCAL_REPO, publicDenylist: null });
    const withoutField = checkFindings({ ...base(), local: LOCAL_REPO });
    expect(publicKinds(withNull)).toEqual([]);
    expect(publicKinds(withoutField)).toEqual([]);
  });

  it('missing file in a local git repo — one info finding, exit 0 even with --strict', () => {
    const findings = checkFindings({
      ...base(),
      local: LOCAL_REPO,
      publicDenylist: { present: false, hits: [], error: null },
    });
    const got = publicKinds(findings);
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('public-denylist-missing');
    expect(got[0]?.level).toBe('info');
    expect(got[0]?.message).toContain(DENYLIST);
    expect(exitCodeForFindings(findings, true)).toBe(0);
  });

  it('missing file but the local layer is not its own git repo (or there is none) — inert', () => {
    const missing = { present: false, hits: [], error: null };
    const notRepo = { ...LOCAL_REPO, isRepo: false };
    expect(
      publicKinds(checkFindings({ ...base(), local: notRepo, publicDenylist: missing })),
    ).toEqual([]);
    expect(publicKinds(checkFindings({ ...base(), local: null, publicDenylist: missing }))).toEqual(
      [],
    );
    expect(publicKinds(checkFindings({ ...base(), publicDenylist: missing }))).toEqual([]);
  });

  it('present file with no hits and no error (no patterns, or nothing matches) — no finding', () => {
    const findings = checkFindings({
      ...base(),
      local: LOCAL_REPO,
      publicDenylist: { present: true, hits: [], error: null },
    });
    expect(publicKinds(findings)).toEqual([]);
  });

  it('hits — one error finding: N lines, M distinct files, path:line only', () => {
    const findings = checkFindings({
      ...base(),
      local: LOCAL_REPO,
      publicDenylist: {
        present: true,
        hits: [
          { path: 'README.md', line: 3 },
          { path: 'README.md', line: 9 },
          { path: 'docs/a.md', line: 40 },
        ],
        error: null,
      },
    });
    expect(publicKinds(findings)).toEqual([
      {
        kind: 'public-denylist-hit',
        level: 'error',
        message: `public: 3 lines in 2 tracked files match ${DENYLIST} — README.md:3, README.md:9, docs/a.md:40`,
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });

  it('a hit needs no local git repo — the file is what matters, not the layer around it', () => {
    const findings = checkFindings({
      ...base(),
      local: null,
      publicDenylist: { present: true, hits: [{ path: 'a.md', line: 1 }], error: null },
    });
    expect(publicKinds(findings).map((f) => f.kind)).toEqual(['public-denylist-hit']);
  });

  it('exactly 5 hits — all five listed, no "more"', () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ path: `f${i + 1}.md`, line: i + 1 }));
    const [f] = publicKinds(
      checkFindings({
        ...base(),
        local: LOCAL_REPO,
        publicDenylist: { present: true, hits, error: null },
      }),
    );
    expect(f?.message).toBe(
      `public: 5 lines in 5 tracked files match ${DENYLIST} — f1.md:1, f2.md:2, f3.md:3, f4.md:4, f5.md:5`,
    );
  });

  it('7 hits — the first 5 as path:line, then "…+2 more"', () => {
    const hits = Array.from({ length: 7 }, (_, i) => ({ path: `f${i + 1}.md`, line: i + 1 }));
    const [f] = publicKinds(
      checkFindings({
        ...base(),
        local: LOCAL_REPO,
        publicDenylist: { present: true, hits, error: null },
      }),
    );
    expect(f?.level).toBe('error');
    expect(f?.message).toBe(
      `public: 7 lines in 7 tracked files match ${DENYLIST} — f1.md:1, f2.md:2, f3.md:3, f4.md:4, f5.md:5, …+2 more`,
    );
    expect(f?.message).not.toContain('f6.md');
  });

  it('invalid — one error finding carrying git’s message; exit 1', () => {
    const findings = checkFindings({
      ...base(),
      local: LOCAL_REPO,
      publicDenylist: {
        present: true,
        hits: [],
        error: "fatal: -e option, 'ac(me': parentheses not balanced",
      },
    });
    expect(publicKinds(findings)).toEqual([
      {
        kind: 'public-denylist-invalid',
        level: 'error',
        message: `public: ${DENYLIST} could not be matched — fatal: -e option, 'ac(me': parentheses not balanced`,
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });

  it('the finding never carries anything but paths and line numbers', () => {
    // `hits` has no field that could hold matched text; this pins that the message is built from
    // path:line alone — a hit with an odd path still renders only that path and that line.
    const [f] = publicKinds(
      checkFindings({
        ...base(),
        local: LOCAL_REPO,
        publicDenylist: { present: true, hits: [{ path: 'x y/z:w.md', line: 12 }], error: null },
      }),
    );
    expect(f?.message).toBe(`public: 1 lines in 1 tracked files match ${DENYLIST} — x y/z:w.md:12`);
  });
});
