/**
 * RCB-110 (owner decision A): the server half of "does a system have test coverage" — gather the
 * tree (`listRepoFiles`), pick out the test files (core's `isTestFile`), read each one and
 * resolve its relative imports (the scanner's own `findImportSpecifiers`/`resolveImport`, the
 * same regex scan `scanRepo` uses for the import-edge graph), then hand the pure match to core's
 * `testsForPointers`. Reads ONLY test files, never the whole tree — a system's pointers can be
 * anywhere, but what has to be read to answer is bounded by how many test files exist.
 *
 * RCB-113 (source B, beside that static count): `pnpm test`'s own coverage report — per pointer,
 * % lines actually covered. The report itself is read once per corpus (`loadCoverageReport`,
 * folded into `TestCorpus`); the mtimes that decide whether it is STALE for one system's pointers
 * are stat'd lazily, only for the files that system's pointers count (`statCountedFiles`), so
 * answering for one system never pays for stat-ing the whole tree.
 */
import { stat } from 'node:fs/promises';
import {
  COVERAGE_REPORT_PATH,
  type CoverageReport,
  coverageForPointers,
  isTestFile,
  parseCoverageSummary,
  type SystemCoverage,
  type SystemTests,
  type TestFileInput,
  testsForPointers,
} from '@repoboard/core';
import { readRepoText, resolveRepoPath } from './refs.js';
import { findImportSpecifiers, listRepoFiles, resolveImport } from './scanner.js';

/** RCB-112: the tree-read half of `systemTests`, pulled out so a caller answering for MANY
 * systems (the repo dashboard's coverage band) reads every test file in the repo exactly ONCE,
 * not once per system. `known` is every repo-relative path (`listRepoFiles`); `testFiles` is only
 * the subset that `isTestFile` selected, each with its text and the repo-relative paths its
 * relative imports already resolved to.
 *
 * RCB-113: `coverage` is the parsed gate report, loaded here too — once per corpus, same as
 * `testFiles` — `null` when there is none (see `loadCoverageReport`, which never throws). */
export interface TestCorpus {
  testFiles: TestFileInput[];
  known: ReadonlySet<string>;
  coverage: CoverageReport | null;
}

/**
 * RCB-113: read + parse `coverage/coverage-summary.json` (vitest's `json-summary` reporter) at
 * `root`. `null` for a missing file, an unreadable one, or one `parseCoverageSummary` rejects (bad
 * JSON or the wrong shape) — never a throw: the report is optional, not load-bearing, exactly like
 * every other band in `repo-health.ts` degrading to its null state.
 */
export async function loadCoverageReport(root: string): Promise<CoverageReport | null> {
  const guarded = await resolveRepoPath(root, COVERAGE_REPORT_PATH);
  if (!guarded.ok) return null;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(guarded.path)).mtimeMs;
  } catch {
    return null;
  }
  const read = await readRepoText(guarded.path, COVERAGE_REPORT_PATH);
  if (!read.ok) return null;
  const files = parseCoverageSummary(read.text, root);
  if (files === null) return null;
  return { path: COVERAGE_REPORT_PATH, mtimeMs, files };
}

export async function loadTestCorpus(root: string): Promise<TestCorpus> {
  const files = await listRepoFiles(root);
  const known = new Set(files);
  const testPaths = files.filter(isTestFile);

  const testFiles: TestFileInput[] = [];
  for (const path of testPaths) {
    const guarded = await resolveRepoPath(root, path);
    if (!guarded.ok) continue; // never throws (brief): a guard failure contributes nothing
    const read = await readRepoText(guarded.path, path);
    if (!read.ok) continue;
    const imports = findImportSpecifiers(read.text)
      .map((spec) => resolveImport(path, spec, known))
      .filter((p): p is string => p !== null);
    testFiles.push({ path, imports, text: read.text });
  }

  const coverage = await loadCoverageReport(root);
  return { testFiles, known, coverage };
}

/** RCB-113: the repo-relative files whose mtime could make `report` stale for THESE pointers —
 * exactly what `coverageForPointers` will count (a file pointer's own file, or every report entry
 * under a directory pointer) — so nothing is stat'd that the answer does not depend on. A file
 * the report named but that is gone from disk since (or that a guard refuses) contributes no
 * mtime, not a false "fresh": `coverageForPointers` only calls a counted file stale when it HAS a
 * newer mtime for it. */
async function statCountedFiles(
  root: string,
  pointers: readonly string[],
  report: CoverageReport | null,
): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  if (!report) return mtimes;
  const candidates = new Set<string>();
  for (const pointer of pointers) {
    if (report.files.has(pointer)) candidates.add(pointer);
    const prefix = `${pointer}/`;
    for (const f of report.files.keys()) {
      if (f.startsWith(prefix)) candidates.add(f);
    }
  }
  await Promise.all(
    [...candidates].map(async (rel) => {
      const guarded = await resolveRepoPath(root, rel);
      if (!guarded.ok) return;
      try {
        mtimes.set(rel, (await stat(guarded.path)).mtimeMs);
      } catch {
        // gone since the report ran — no signal either way, never a fabricated one
      }
    }),
  );
  return mtimes;
}

/** `corpus`, when given, is used as-is (RCB-112: the dashboard loads it once for every system);
 * omitted, this reads the tree itself — unchanged from before RCB-112.
 *
 * RCB-113: `measured` (core's `SystemCoverage`) rides beside the static fields, computed from the
 * SAME corpus's report. HTTP `/api/systems/:id/tests`, MCP `get_system`, and `systems show --json`
 * all return whatever this returns, unchanged — `measured` reaches them for free. */
export async function systemTests(
  root: string,
  pointers: readonly string[],
  corpus?: TestCorpus,
): Promise<SystemTests & { measured: SystemCoverage }> {
  if (pointers.length === 0) {
    const tests = testsForPointers([], [], new Set());
    // No pointers → no files to measure, but `source` must still name the real report (or its
    // absence) — never claim "no report" when one exists.
    const report = corpus ? corpus.coverage : await loadCoverageReport(root);
    const measured = coverageForPointers([], report, new Map(), new Set());
    return { ...tests, measured };
  }
  const { testFiles, known, coverage } = corpus ?? (await loadTestCorpus(root));
  const tests = testsForPointers(pointers, testFiles, known);
  const fileMtimes = await statCountedFiles(root, pointers, coverage);
  const measured = coverageForPointers(pointers, coverage, fileMtimes, known);
  return { ...tests, measured };
}
