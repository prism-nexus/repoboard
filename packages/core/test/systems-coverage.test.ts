/**
 * RCB-113 (source B beside RCB-110 A): `parseCoverageSummary`'s JSON→map parsing, then
 * `coverageForPointers`'s matching rules — pure, no I/O (this module is `packages/core`;
 * `purity.test.ts` enforces the import allowlist).
 */
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_REPORT_PATH,
  type CoverageReport,
  coverageForPointers,
  parseCoverageSummary,
} from '../src/systems-coverage.js';

const ROOT = '/Users/x/Projects/repo';

function summaryText(entries: Record<string, { total: number; covered: number }>): string {
  const body: Record<string, unknown> = {
    total: { lines: { total: 999, covered: 999, skipped: 0, pct: 100 } },
  };
  for (const [path, { total, covered }] of Object.entries(entries)) {
    body[path] = { lines: { total, covered, skipped: 0, pct: (covered / total) * 100 } };
  }
  return JSON.stringify(body);
}

describe('parseCoverageSummary (RCB-113)', () => {
  it('bad JSON → null', () => {
    expect(parseCoverageSummary('{not json', ROOT)).toBeNull();
  });

  it('a non-object top level (array, string, null) → null', () => {
    expect(parseCoverageSummary('[]', ROOT)).toBeNull();
    expect(parseCoverageSummary('"x"', ROOT)).toBeNull();
    expect(parseCoverageSummary('null', ROOT)).toBeNull();
  });

  it('an entry with no `lines` object, or non-numeric total/covered, is the wrong shape → null', () => {
    expect(parseCoverageSummary(JSON.stringify({ [`${ROOT}/a.ts`]: {} }), ROOT)).toBeNull();
    expect(
      parseCoverageSummary(
        JSON.stringify({ [`${ROOT}/a.ts`]: { lines: { total: '10', covered: 5 } } }),
        ROOT,
      ),
    ).toBeNull();
  });

  it('maps an absolute key to a repo-relative one, exact covered/total', () => {
    const text = summaryText({ [`${ROOT}/src/a.ts`]: { total: 10, covered: 7 } });
    const map = parseCoverageSummary(text, ROOT);
    expect(map).toEqual(new Map([['src/a.ts', { total: 10, covered: 7 }]]));
  });

  it("the case-insensitive root: a key cased differently than `root` still maps, keeping the key's own casing for the remainder", () => {
    const text = summaryText({ '/Users/X/PROJECTS/repo/src/A.ts': { total: 4, covered: 4 } });
    const map = parseCoverageSummary(text, ROOT);
    expect(map).toEqual(new Map([['src/A.ts', { total: 4, covered: 4 }]]));
  });

  it('`total` and a key outside root are dropped, not treated as malformed', () => {
    const text = JSON.stringify({
      total: { lines: { total: 999, covered: 999, skipped: 0, pct: 100 } },
      [`${ROOT}/src/a.ts`]: { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } },
      '/somewhere/else/b.ts': { lines: { total: 5, covered: 0, skipped: 0, pct: 0 } },
    });
    const map = parseCoverageSummary(text, ROOT);
    expect(map).toEqual(new Map([['src/a.ts', { total: 10, covered: 10 }]]));
  });
});

const known = new Set(['src/a.ts', 'src/b.ts', 'src/dir/x.ts', 'src/dir/y.ts', 'docs/readme.md']);

function report(
  files: Record<string, { total: number; covered: number }>,
  mtimeMs = 1000,
): CoverageReport {
  return { path: COVERAGE_REPORT_PATH, mtimeMs, files: new Map(Object.entries(files)) };
}

describe('coverageForPointers (RCB-113)', () => {
  it('file pointer: exact pct, one decimal', () => {
    const r = report({ 'src/a.ts': { total: 10, covered: 7 } });
    const result = coverageForPointers(['src/a.ts'], r, new Map(), known);
    expect(result.pointers).toEqual([{ pointer: 'src/a.ts', pct: 70, reason: null }]);
    expect(result.pct).toBe(70);
    expect(result.line).toBe('lines: 70.0% covered');
    expect(result.source).toBe(
      `coverage: ${COVERAGE_REPORT_PATH} @ ${new Date(1000).toISOString()}`,
    );
  });

  it('dir pointer: sums every report entry under it', () => {
    const r = report({
      'src/dir/x.ts': { total: 10, covered: 3 },
      'src/dir/y.ts': { total: 20, covered: 20 },
    });
    const result = coverageForPointers(['src/dir'], r, new Map(), known);
    // (3 + 20) / (10 + 20) * 100 = 76.666... -> 76.7
    expect(result.pointers[0]).toEqual({ pointer: 'src/dir', pct: 76.7, reason: null });
    expect(result.pct).toBe(76.7);
  });

  it('report null → every pct null, "no coverage report", regardless of pointer kind', () => {
    const result = coverageForPointers(['src/a.ts', 'src/missing.ts'], null, new Map(), known);
    expect(result.pointers).toEqual([
      { pointer: 'src/a.ts', pct: null, reason: 'no coverage report' },
      { pointer: 'src/missing.ts', pct: null, reason: 'no coverage report' },
    ]);
    expect(result.pct).toBeNull();
    expect(result.line).toBe('lines: n/a (no coverage report)');
    expect(result.source).toBe(`coverage: no report at ${COVERAGE_REPORT_PATH}`);
  });

  it('unknown pointer: not found', () => {
    const r = report({});
    const result = coverageForPointers(['src/nope.ts'], r, new Map(), known);
    expect(result.pointers[0]).toEqual({ pointer: 'src/nope.ts', pct: null, reason: 'not found' });
  });

  it('CONTROL: a non-code known file (docs/readme.md) is "not a source file", never a pct from a name match', () => {
    const r = report({ 'docs/readme.md': { total: 10, covered: 10 } });
    const result = coverageForPointers(['docs/readme.md'], r, new Map(), known);
    expect(result.pointers[0]).toEqual({
      pointer: 'docs/readme.md',
      pct: null,
      reason: 'not a source file',
    });
  });

  it('a known source file the report never saw: not in report', () => {
    const r = report({ 'src/b.ts': { total: 5, covered: 5 } });
    const result = coverageForPointers(['src/a.ts'], r, new Map(), known);
    expect(result.pointers[0]).toEqual({ pointer: 'src/a.ts', pct: null, reason: 'not in report' });
  });

  it('a dir pointer with nothing under it in the report: not in report', () => {
    const r = report({ 'src/a.ts': { total: 5, covered: 5 } });
    const result = coverageForPointers(['src/dir'], r, new Map(), known);
    expect(result.pointers[0]).toEqual({ pointer: 'src/dir', pct: null, reason: 'not in report' });
  });

  it('a counted file mtime newer than the report: stale, names the file, null pct', () => {
    const r = report({ 'src/a.ts': { total: 10, covered: 10 } }, 1000);
    const fileMtimes = new Map([['src/a.ts', 2000]]);
    const result = coverageForPointers(['src/a.ts'], r, fileMtimes, known);
    expect(result.pointers[0]).toEqual({
      pointer: 'src/a.ts',
      pct: null,
      reason: 'stale: src/a.ts changed after the report',
    });
  });

  it('one stale pointer voids the SYSTEM pct, even when another pointer is fresh', () => {
    const r = report(
      { 'src/a.ts': { total: 10, covered: 10 }, 'src/b.ts': { total: 10, covered: 5 } },
      1000,
    );
    const fileMtimes = new Map([
      ['src/a.ts', 500],
      ['src/b.ts', 2000],
    ]);
    const result = coverageForPointers(['src/a.ts', 'src/b.ts'], r, fileMtimes, known);
    expect(result.pointers[0]?.pct).toBe(100); // the fresh pointer keeps its own number
    expect(result.pct).toBeNull();
    expect(result.line).toBe('lines: n/a (stale: src/b.ts changed after the report)');
  });

  it('CONTROL: a file mtime OLDER than (or equal to) the report is not stale', () => {
    const r = report({ 'src/a.ts': { total: 10, covered: 10 } }, 1000);
    const fileMtimes = new Map([['src/a.ts', 1000]]);
    const result = coverageForPointers(['src/a.ts'], r, fileMtimes, known);
    expect(result.pointers[0]?.reason).toBeNull();
    expect(result.pointers[0]?.pct).toBe(100);
  });

  it('a file with 0 counted lines: "no lines", never a fabricated 0%', () => {
    const r = report({ 'src/a.ts': { total: 0, covered: 0 } });
    const result = coverageForPointers(['src/a.ts'], r, new Map(), known);
    expect(result.pointers[0]).toEqual({ pointer: 'src/a.ts', pct: null, reason: 'no lines' });
  });

  it('empty pointers: pct null, the n/a line, empty pointers array', () => {
    const r = report({});
    const result = coverageForPointers([], r, new Map(), known);
    expect(result).toEqual({
      pointers: [],
      pct: null,
      source: `coverage: ${COVERAGE_REPORT_PATH} @ ${new Date(1000).toISOString()}`,
      line: 'lines: n/a (no source pointers)',
    });
  });

  it('CONTROL: two pointers sharing a file are deduped — the shared file is not double-counted', () => {
    // x.ts is 100% covered, y.ts is 0% — chosen so double-counting x.ts would actually shift the
    // system pct (a shared file at the SAME ratio as the rest would hide the bug: see the git
    // history of this test for the version that did).
    const r = report({
      'src/dir/x.ts': { total: 10, covered: 10 },
      'src/dir/y.ts': { total: 10, covered: 0 },
    });
    // pointer 0 names x.ts directly; pointer 1 is the parent dir, which covers x.ts AND y.ts
    const result = coverageForPointers(['src/dir/x.ts', 'src/dir'], r, new Map(), known);
    expect(result.pointers[0]?.pct).toBe(100);
    expect(result.pointers[1]?.pct).toBe(50); // (10 + 0) / (10 + 10)
    // deduped: x.ts (10/10) + y.ts (0/10) once each = 10/20 = 50 — NOT (10+10+0)/(10+10+10) = 66.7,
    // which is what double-counting x.ts via pointer 0 AND pointer 1 would give.
    expect(result.pct).toBe(50);
  });

  it("the system line's first reason is the first pointer with one, in order", () => {
    const r = report({});
    const result = coverageForPointers(['src/missing.ts', 'src/a.ts'], r, new Map(), known);
    expect(result.line).toBe('lines: n/a (not found)');
  });
});
