/**
 * RCB-113: the server half of source B — `loadCoverageReport`, `TestCorpus.coverage`, and
 * `systemTests`'s `measured` field — against a real tmp repo (`makeTempRepoNoBoard`, same fixture
 * style `systems-detect.test.ts` and `repo-health.test.ts` use). RCB-110's static half already has
 * its own coverage via `systems-dogfood.test.ts`/the HTTP and MCP tests; this file is only the new
 * coverage-report half.
 */
import { writeFile as fsWriteFile, mkdir, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { COVERAGE_REPORT_PATH } from '@repoboard/core';
import { describe, expect, it } from 'vitest';
import { loadCoverageReport, loadTestCorpus, systemTests } from '../src/systems-tests.js';
import { makeTempRepoNoBoard } from './helpers.js';

/** `coverage/` does not exist in a fresh fixture repo — create the parent before writing. */
async function writeFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, text);
}

/** A minimal vitest `json-summary` report: absolute keys under `root`, one `lines` stat each —
 * everything `parseCoverageSummary` reads, nothing it ignores. */
function summary(
  root: string,
  entries: Record<string, { total: number; covered: number }>,
): string {
  const body: Record<string, unknown> = {
    total: { lines: { total: 0, covered: 0, skipped: 0, pct: 100 } },
  };
  for (const [rel, { total, covered }] of Object.entries(entries)) {
    body[join(root, rel)] = { lines: { total, covered, skipped: 0, pct: (covered / total) * 100 } };
  }
  return JSON.stringify(body);
}

describe('loadCoverageReport (RCB-113)', () => {
  it('no coverage/coverage-summary.json at all: null, never a throw', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    expect(await loadCoverageReport(repo.root)).toBeNull();
    await repo.cleanup();
  });

  it('bad JSON in the report: null, never a throw', async () => {
    const repo = await makeTempRepoNoBoard({
      'src/a.ts': 'export const a = 1;\n',
      [COVERAGE_REPORT_PATH]: '{not json',
    });
    expect(await loadCoverageReport(repo.root)).toBeNull();
    await repo.cleanup();
  });

  it('a real report: path is the constant, files map has the parsed entry', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    await writeFile(
      join(repo.root, COVERAGE_REPORT_PATH),
      summary(repo.root, { 'src/a.ts': { total: 10, covered: 9 } }),
    );
    const report = await loadCoverageReport(repo.root);
    expect(report?.path).toBe(COVERAGE_REPORT_PATH);
    expect(report?.files).toEqual(new Map([['src/a.ts', { total: 10, covered: 9 }]]));
    await repo.cleanup();
  });
});

describe('systemTests: measured (RCB-113)', () => {
  it('no report → every pct null with "no coverage report"', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    const result = await systemTests(repo.root, ['src/a.ts']);
    expect(result.measured.pointers).toEqual([
      { pointer: 'src/a.ts', pct: null, reason: 'no coverage report' },
    ]);
    expect(result.measured.pct).toBeNull();
    expect(result.measured.line).toBe('lines: n/a (no coverage report)');
    expect(result.measured.source).toBe(`coverage: no report at ${COVERAGE_REPORT_PATH}`);
    await repo.cleanup();
  });

  it('a written report maps to an exact pct', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    await writeFile(
      join(repo.root, COVERAGE_REPORT_PATH),
      summary(repo.root, { 'src/a.ts': { total: 10, covered: 8 } }),
    );
    const result = await systemTests(repo.root, ['src/a.ts']);
    expect(result.measured.pointers).toEqual([{ pointer: 'src/a.ts', pct: 80, reason: null }]);
    expect(result.measured.line).toBe('lines: 80.0% covered');
    await repo.cleanup();
  });

  it('touching the pointer AFTER the report exists: stale, null pct', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    const reportPath = join(repo.root, COVERAGE_REPORT_PATH);
    await writeFile(reportPath, summary(repo.root, { 'src/a.ts': { total: 10, covered: 8 } }));
    const early = new Date(Date.now() - 60_000);
    const late = new Date();
    await utimes(reportPath, early, early);
    await utimes(join(repo.root, 'src/a.ts'), late, late);

    const result = await systemTests(repo.root, ['src/a.ts']);
    expect(result.measured.pointers).toEqual([
      { pointer: 'src/a.ts', pct: null, reason: 'stale: src/a.ts changed after the report' },
    ]);
    await repo.cleanup();
  });

  it('CONTROL: the file mtime check compares against the REPORT\'s own mtime, not "now" — an old report and an equally old pointer is fresh, not stale', async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    const reportPath = join(repo.root, COVERAGE_REPORT_PATH);
    await writeFile(reportPath, summary(repo.root, { 'src/a.ts': { total: 10, covered: 8 } }));
    const same = new Date(Date.now() - 60_000);
    await utimes(reportPath, same, same);
    await utimes(join(repo.root, 'src/a.ts'), same, same);

    const result = await systemTests(repo.root, ['src/a.ts']);
    expect(result.measured.pointers[0]).toEqual({ pointer: 'src/a.ts', pct: 80, reason: null });
    await repo.cleanup();
  });

  it("CONTROL: systemTests(root, pointers, corpus) uses the corpus's OWN report — no second read", async () => {
    const repo = await makeTempRepoNoBoard({ 'src/a.ts': 'export const a = 1;\n' });
    await writeFile(
      join(repo.root, COVERAGE_REPORT_PATH),
      summary(repo.root, { 'src/a.ts': { total: 4, covered: 2 } }),
    );
    const corpus = await loadTestCorpus(repo.root);
    expect(corpus.coverage?.files).toEqual(new Map([['src/a.ts', { total: 4, covered: 2 }]]));

    const result = await systemTests(repo.root, ['src/a.ts'], corpus);
    expect(result.measured.pointers).toEqual([{ pointer: 'src/a.ts', pct: 50, reason: null }]);
    await repo.cleanup();
  });

  it('a directory pointer sums every report entry under it', async () => {
    const repo = await makeTempRepoNoBoard({
      'src/dir/x.ts': 'export const x = 1;\n',
      'src/dir/y.ts': 'export const y = 1;\n',
    });
    await writeFile(
      join(repo.root, COVERAGE_REPORT_PATH),
      summary(repo.root, {
        'src/dir/x.ts': { total: 10, covered: 5 },
        'src/dir/y.ts': { total: 10, covered: 10 },
      }),
    );
    const result = await systemTests(repo.root, ['src/dir']);
    expect(result.measured.pointers).toEqual([{ pointer: 'src/dir', pct: 75, reason: null }]);
    await repo.cleanup();
  });
});
