/**
 * RCB-113 (source B beside RCB-110's static count): "does a system have test coverage" answered
 * from `pnpm test`'s own coverage report — `coverage/coverage-summary.json` (vitest's
 * `json-summary` reporter), per pointer, % lines actually covered. Pure, no I/O, no dates: the
 * server reads and stats the report and the pointer's files, this module only parses the JSON
 * and does the arithmetic. Never stored in systems.yml, exactly like RCB-110's static count.
 *
 * The one guarantee: never a number without a fresh report entry behind it. A file the report
 * never saw, a directory with nothing in the report under it, or a file that changed since the
 * report ran — every one of those is `null` with a reason, not a stale or invented percentage.
 */
import { isCodePath } from './systems-tests.js';

export const COVERAGE_REPORT_PATH = 'coverage/coverage-summary.json';

/** The `reason` prefix of a pointer whose counted file changed after the report ran. */
const STALE_PREFIX = 'stale: ';

/** One report entry's line counts — everything else vitest's json-summary carries (statements,
 * functions, branches, `pct`) is ignored; this module only ever answers about LINES. */
export interface CoverageFile {
  covered: number;
  total: number;
}

/** `loadCoverageReport` (server): the parsed report plus its own provenance — `path` is
 * repo-relative (always `COVERAGE_REPORT_PATH`, carried through so `coverageForPointers` never
 * has to import the constant twice), `mtimeMs` is the file's own mtime, the one everything in
 * `pointers[].reason` is measured "stale" against. */
export interface CoverageReport {
  path: string;
  mtimeMs: number;
  files: Map<string, CoverageFile>;
}

/**
 * `text` is the raw `coverage-summary.json`; `root` is the repo root the keys are absolute paths
 * under. Returns `null` for bad JSON, a non-object top level, or any per-file entry that is not
 * `{lines: {total: number, covered: number, …}}` — one malformed entry voids the whole report
 * (CLAUDE.md: a missing answer is `null`, never a plausible number built on a guess about the
 * rest of a corrupt file). The `total` key (the report's own grand-total row) and any key that
 * does not fall under `root` are silently dropped, not treated as malformed — both are expected,
 * unremarkable shapes of a real report. A key becomes repo-relative by stripping `root + '/'`,
 * compared CASE-INSENSITIVELY (macOS: `/Users/x/Projects` vs `/Users/x/projects` can both name the
 * same tree), keeping the key's own casing for the remainder.
 */
export function parseCoverageSummary(text: string, root: string): Map<string, CoverageFile> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const prefix = `${root}/`;
  const prefixLower = prefix.toLowerCase();
  const result = new Map<string, CoverageFile>();

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'total') continue; // the report's own grand-total row, not a file — dropped
    const lines = (value as { lines?: unknown } | null)?.lines;
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof lines !== 'object' ||
      lines === null
    ) {
      return null; // an entry that isn't a per-file record: the report is the wrong shape
    }
    const { total, covered } = lines as { total?: unknown; covered?: unknown };
    if (typeof total !== 'number' || typeof covered !== 'number') return null;
    if (!key.toLowerCase().startsWith(prefixLower)) continue; // outside root — dropped
    result.set(key.slice(prefix.length), { total, covered });
  }
  return result;
}

export interface PointerCoverage {
  pointer: string;
  pct: number | null;
  reason: string | null;
}

export interface SystemCoverage {
  pointers: PointerCoverage[];
  pct: number | null;
  source: string;
  line: string;
}

type PointerKind = 'file' | 'dir' | 'unknown';

/** Mirrors `systems-tests.ts`'s own `pointerKind` (not exported there): a pointer is used verbatim
 * (a systems.yml pointer is a plain path) — a file if `known` has it exactly, a directory if some
 * known path starts with `pointer + '/'`, else unknown. Duplicated rather than reaching across
 * modules for one small predicate that has no I/O either side of it. */
function pointerKind(pointer: string, known: ReadonlySet<string>): PointerKind {
  if (known.has(pointer)) return 'file';
  const prefix = `${pointer}/`;
  for (const p of known) {
    if (p.startsWith(prefix)) return 'dir';
  }
  return 'unknown';
}

/** The report entries this pointer would count: itself (a file pointer) or every entry the
 * report has under it (a directory pointer) — sorted, so "the first stale file" below is
 * deterministic. A pointer the report never saw at all returns `[]`. */
function countedFiles(pointer: string, kind: PointerKind, report: CoverageReport): string[] {
  if (kind === 'file') return report.files.has(pointer) ? [pointer] : [];
  const prefix = `${pointer}/`;
  const files: string[] = [];
  for (const f of report.files.keys()) {
    if (f.startsWith(prefix)) files.push(f);
  }
  return files.sort();
}

interface PointerResult {
  pointer: string;
  pct: number | null;
  reason: string | null;
  files: (CoverageFile & { path: string })[];
}

function nullResult(pointer: string, reason: string): PointerResult {
  return { pointer, pct: null, reason, files: [] };
}

function pctOf(covered: number, total: number): number {
  return Math.round((covered / total) * 1000) / 10;
}

/** One pointer's answer, in the priority order the brief fixes: no report at all beats every
 * other reason (there is nothing to measure against); then whether the pointer resolves in the
 * tree; then whether it is source; then whether the report saw it; then whether it is stale;
 * then the one arithmetic edge case (a file with 0 counted lines — division by zero is not a
 * plausible 0%, it is `null`). */
function coverageForPointer(
  pointer: string,
  report: CoverageReport | null,
  fileMtimes: ReadonlyMap<string, number>,
  known: ReadonlySet<string>,
): PointerResult {
  if (report === null) return nullResult(pointer, 'no coverage report');

  const kind = pointerKind(pointer, known);
  if (kind === 'unknown') return nullResult(pointer, 'not found');
  if (kind === 'file' && !isCodePath(pointer)) return nullResult(pointer, 'not a source file');

  const files = countedFiles(pointer, kind, report);
  if (files.length === 0) return nullResult(pointer, 'not in report');

  for (const f of files) {
    const mtime = fileMtimes.get(f);
    if (mtime !== undefined && mtime > report.mtimeMs) {
      return nullResult(pointer, `${STALE_PREFIX}${f} changed after the report`);
    }
  }

  let covered = 0;
  let total = 0;
  const detail: (CoverageFile & { path: string })[] = [];
  for (const f of files) {
    const entry = report.files.get(f);
    if (!entry) continue; // countedFiles only names keys report.files has; guard only
    covered += entry.covered;
    total += entry.total;
    detail.push({ path: f, covered: entry.covered, total: entry.total });
  }
  if (total === 0) return nullResult(pointer, 'no lines');

  return { pointer, pct: pctOf(covered, total), reason: null, files: detail };
}

/**
 * `report` is `null` exactly when there is no usable coverage report (missing, unreadable, bad
 * JSON — the server's `loadCoverageReport` never throws, it returns `null`). `fileMtimes` holds
 * every repo-relative path the caller already stat'd, mapped to its mtime — the server stats only
 * the files a pointer counts, so this function trusts whatever it is given without re-deriving
 * "which files matter" a second time. `known` is the same full repo-relative path set RCB-110
 * uses.
 *
 * The system's `pct` sums covered/total over every non-null pointer's counted files, DEDUPED by
 * path first (two pointers naming the same file, or a directory pointer overlapping a file
 * pointer, must not double-count it) — `null` when no pointer produced a number. `line` is
 * `lines: N.N% covered`, or `lines: n/a (<first reason>)` using the first pointer that has one.
 * `source` names the report's own path and mtime, or, when there is none, `COVERAGE_REPORT_PATH`
 * itself so the caller still knows where a report would have to appear.
 */
export function coverageForPointers(
  pointers: readonly string[],
  report: CoverageReport | null,
  fileMtimes: ReadonlyMap<string, number>,
  known: ReadonlySet<string>,
): SystemCoverage {
  const results = pointers.map((p) => coverageForPointer(p, report, fileMtimes, known));

  const dedup = new Map<string, CoverageFile>();
  for (const r of results) {
    if (r.pct === null) continue;
    for (const f of r.files) {
      if (!dedup.has(f.path)) dedup.set(f.path, { covered: f.covered, total: f.total });
    }
  }

  let pct: number | null = null;
  if (dedup.size > 0) {
    let covered = 0;
    let total = 0;
    for (const f of dedup.values()) {
      covered += f.covered;
      total += f.total;
    }
    pct = total === 0 ? null : pctOf(covered, total);
  }

  // A stale pointer voids the system number: a % over only the fresh pointers would silently
  // describe less of the system than it claims to (the one guarantee, at the system level).
  const stale = results.find((r) => r.reason?.startsWith(STALE_PREFIX) === true);
  if (stale) pct = null;
  const firstReason = stale?.reason ?? results.find((r) => r.reason !== null)?.reason ?? null;
  const line =
    pct !== null
      ? `lines: ${pct.toFixed(1)}% covered`
      : `lines: n/a (${firstReason ?? 'no source pointers'})`;

  const source =
    report === null
      ? `coverage: no report at ${COVERAGE_REPORT_PATH}`
      : `coverage: ${report.path} @ ${new Date(report.mtimeMs).toISOString()}`;

  return {
    pointers: results.map(({ pointer, pct: p, reason }) => ({ pointer, pct: p, reason })),
    pct,
    source,
    line,
  };
}
