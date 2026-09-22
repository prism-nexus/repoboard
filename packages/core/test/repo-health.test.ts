/**
 * RCB-112 A: the dashboard's pure half — pure, no I/O (this module is `packages/core`;
 * `purity.test.ts` enforces the import allowlist).
 */
import { describe, expect, it } from 'vitest';
import {
  byWho,
  type CommitRow,
  type GateRecord,
  latestChecks,
  parseCommitLog,
  parseGateLedger,
  perDay,
} from '../src/repo-health.js';

const REC = (over: Partial<GateRecord> = {}): GateRecord => ({
  at: '2026-09-22T10:00:00Z',
  sha: 'abc1234',
  as: 'builder',
  tests: null,
  typecheck: null,
  lint: null,
  build: null,
  note: null,
  ...over,
});

describe('parseGateLedger (RCB-112 A)', () => {
  it('parses well-formed JSONL, skips blank lines', () => {
    const text = [
      JSON.stringify(REC({ typecheck: 0 })),
      '',
      JSON.stringify(REC({ lint: 1, tests: { files: 3, passed: 10, skipped: 1, failed: 0 } })),
      '',
    ].join('\n');
    const { records, errors } = parseGateLedger(text);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[1]?.tests).toEqual({ files: 3, passed: 10, skipped: 1, failed: 0 });
  });

  it('a bad line is an error ("line N: why"), never a throw, and does not stop the rest', () => {
    const text = [
      JSON.stringify(REC({ typecheck: 0 })),
      'not json at all',
      JSON.stringify({ at: '2026-09-22T10:00:00Z', as: 'builder', sha: 5 }), // sha wrong type
      JSON.stringify({ sha: null, as: 'builder' }), // missing "at"
      JSON.stringify(REC({ build: 1 })),
    ].join('\n');
    const { records, errors } = parseGateLedger(text);
    expect(records).toHaveLength(2);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe('line 2: not valid JSON');
    expect(errors[1]).toMatch(/^line 3: "sha"/);
    expect(errors[2]).toMatch(/^line 4: "at"/);
  });

  it('empty text: no records, no errors', () => {
    expect(parseGateLedger('')).toEqual({ records: [], errors: [] });
  });
});

describe('latestChecks (RCB-112 A)', () => {
  it(
    'CONTROL: an older passing tests line after a newer failing one — the failing one wins, ' +
      'in EITHER file order (order by `at`, never file position)',
    () => {
      const older = REC({
        at: '2026-09-22T09:00:00Z',
        tests: { files: 10, passed: 100, skipped: 0, failed: 0 },
      });
      const newer = REC({
        at: '2026-09-22T11:00:00Z',
        tests: { files: 10, passed: 90, skipped: 0, failed: 10 },
      });

      const fileOrderA = latestChecks([older, newer]);
      expect(fileOrderA.tests?.ok).toBe(false);
      expect(fileOrderA.tests?.at).toBe(newer.at);

      const fileOrderB = latestChecks([newer, older]);
      expect(fileOrderB.tests?.ok).toBe(false);
      expect(fileOrderB.tests?.at).toBe(newer.at);
    },
  );

  it('per check independently: each of tests/typecheck/lint/build picks its OWN newest non-null', () => {
    const records = [
      REC({ at: '2026-09-22T08:00:00Z', typecheck: 0 }),
      REC({ at: '2026-09-22T09:00:00Z', lint: 1 }),
      REC({ at: '2026-09-22T10:00:00Z', typecheck: 1 }),
      REC({ at: '2026-09-22T07:00:00Z', build: 0 }),
    ];
    const checks = latestChecks(records);
    expect(checks.typecheck).toMatchObject({
      ok: false,
      value: 'exit 1',
      at: '2026-09-22T10:00:00Z',
    });
    expect(checks.lint).toMatchObject({ ok: false, value: 'exit 1', at: '2026-09-22T09:00:00Z' });
    expect(checks.build).toMatchObject({ ok: true, value: 'exit 0', at: '2026-09-22T07:00:00Z' });
    expect(checks.tests).toBeNull();
  });

  it('no records at all: every check null', () => {
    expect(latestChecks([])).toEqual({ tests: null, typecheck: null, lint: null, build: null });
  });

  it('a null failed count is NOT treated as a pass', () => {
    const records = [REC({ tests: { files: 5, passed: 5, skipped: 0, failed: null } })];
    const checks = latestChecks(records);
    expect(checks.tests?.ok).toBe(false);
    expect(checks.tests?.value).toBe('5 passed · 0 skipped · 5 files');
  });
});

const RS = '\x1e';
const US = '\x1f';
const GS = '\x1d';

function fmt(sha: string, at: string, author: string, subject: string, trailers = ''): string {
  return `${sha}${US}${at}${US}${author}${US}${subject}${US}${trailers}${RS}\n`;
}

describe('parseCommitLog (RCB-112 A)', () => {
  it('parses the %h/%cI/%an/%s/(trailers) format, newest-first order preserved', () => {
    const out =
      fmt(
        'abc123',
        '2026-09-22T11:00:00Z',
        'Matt Jahn',
        'a fix',
        'Claude Sonnet 5 <noreply@anthropic.com>',
      ) + fmt('def456', '2026-09-22T10:00:00Z', 'Matt Jahn', 'a feature');
    const rows = parseCommitLog(out);
    expect(rows).toEqual([
      {
        sha: 'abc123',
        at: '2026-09-22T11:00:00Z',
        author: 'Matt Jahn',
        agent: 'Claude Sonnet 5',
        subject: 'a fix',
      },
      {
        sha: 'def456',
        at: '2026-09-22T10:00:00Z',
        author: 'Matt Jahn',
        agent: null,
        subject: 'a feature',
      },
    ]);
  });

  it('multiple Co-Authored-By trailers: agent is the FIRST one, email stripped', () => {
    const out = fmt(
      'abc123',
      '2026-09-22T11:00:00Z',
      'Matt Jahn',
      'subject',
      `Claude Opus 4 <noreply@anthropic.com>${GS}Someone Else <x@y.com>`,
    );
    expect(parseCommitLog(out)[0]?.agent).toBe('Claude Opus 4');
  });

  it('a trailer with no email passes through as-is', () => {
    const out = fmt('abc123', '2026-09-22T11:00:00Z', 'Matt Jahn', 'subject', 'a bare name');
    expect(parseCommitLog(out)[0]?.agent).toBe('a bare name');
  });

  it('empty output: no rows, no throw', () => {
    expect(parseCommitLog('')).toEqual([]);
  });

  it('a short/malformed record is skipped, not thrown', () => {
    const out = `only${US}three${US}fields${RS}\n${fmt('abc123', '2026-09-22T11:00:00Z', 'Matt Jahn', 's')}`;
    expect(parseCommitLog(out)).toHaveLength(1);
  });
});

describe('perDay (RCB-112 A)', () => {
  it('14 UTC dates oldest-first ending today, zeros included for a day with no commit', () => {
    const now = new Date('2026-09-22T18:00:00Z');
    const ats = ['2026-09-22T05:00:00Z', '2026-09-22T20:00:00Z', '2026-09-20T00:30:00Z'];
    const days = perDay(ats, now, 14);
    expect(days).toHaveLength(14);
    expect(days[0]?.date).toBe('2026-09-09');
    expect(days[13]?.date).toBe('2026-09-22');
    expect(days.find((d) => d.date === '2026-09-22')?.count).toBe(2);
    expect(days.find((d) => d.date === '2026-09-20')?.count).toBe(1);
    expect(days.find((d) => d.date === '2026-09-21')?.count).toBe(0);
  });

  it('an unparsable timestamp is dropped, not thrown', () => {
    const now = new Date('2026-09-22T18:00:00Z');
    const days = perDay(['not-a-date'], now, 3);
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(0);
  });
});

describe('byWho (RCB-112 A)', () => {
  it('keys by agent ?? author, sorted by count desc then name asc', () => {
    const row = (author: string, agent: string | null): CommitRow => ({
      sha: 'x',
      at: '2026-09-22T00:00:00Z',
      author,
      agent,
      subject: 's',
    });
    const rows = [
      row('Matt Jahn', 'Claude Sonnet 5'),
      row('Matt Jahn', 'Claude Sonnet 5'),
      row('Matt Jahn', null),
      row('Someone', null),
      row('Another', null),
    ];
    expect(byWho(rows)).toEqual([
      { who: 'Claude Sonnet 5', count: 2 },
      { who: 'Another', count: 1 },
      { who: 'Matt Jahn', count: 1 },
      { who: 'Someone', count: 1 },
    ]);
  });

  it('empty input: empty output', () => {
    expect(byWho([])).toEqual([]);
  });
});
