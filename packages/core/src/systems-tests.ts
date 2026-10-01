/**
 * RCB-110 (owner decision A): "does a system have test coverage" answered statically — for each
 * of a system's `pointers`, the test files that import or name it, derived live from the tree the
 * same way backlinks are (no I/O here; the server gathers the tree, this module only classifies
 * and matches strings). 0 bytes added to systems.yml: nothing here is stored.
 *
 * Pure, no I/O, no dates. `known` is the full set of repo-relative paths the server already
 * listed (`listRepoFiles`); `testFiles` is only the subset that `isTestFile` selected, each with
 * its text and the repo-relative paths its relative imports already resolved to.
 */
import { refPath } from './refs.js';

const CODE_EXT: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
]);

/** Last dot in the basename; `''` for an extension-less name or a dotfile like `.env` (dot at 0). */
function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isCodePath(path: string): boolean {
  return CODE_EXT.has(extOf(path));
}

const TEST_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_SEGMENTS: ReadonlySet<string> = new Set(['test', 'tests', '__tests__']);

export function isTestFile(path: string): boolean {
  if (!isCodePath(path)) return false;
  if (TEST_SUFFIX.test(path)) return true;
  return path.split('/').some((seg) => TEST_SEGMENTS.has(seg));
}

/** One test file, already read: `imports` are the repo-relative paths its relative specifiers
 * resolved to (the server's `resolveImport`, already run) — this module never resolves a spec. */
export interface TestFileInput {
  path: string;
  imports: readonly string[];
  text: string;
}

export interface PointerTests {
  pointer: string;
  tests: string[] | null;
  reason: string | null;
}

export interface SystemTests {
  pointers: PointerTests[];
  files: number | null;
  source: string;
  line: string;
}

export const SYSTEM_TESTS_SOURCE =
  'static: test files (*.test.*, *.spec.*, test/ tests/ __tests__/) that import or name the pointer, read live from the tree';

type PointerKind = 'file' | 'dir' | 'unknown';

/** `path` is the file a pointer names (`refPath`, RCB-208 — a ranged pointer's span is dropped):
 * a file if `known` has it exactly, a directory if some known path starts with `path + '/'`, else
 * unknown. */
function pointerKind(path: string, known: ReadonlySet<string>): PointerKind {
  if (known.has(path)) return 'file';
  const prefix = `${path}/`;
  for (const p of known) {
    if (p.startsWith(prefix)) return 'dir';
  }
  return 'unknown';
}

/** Every test file (other than the pointer's own file) that imports the pointer's path (or, for a
 * directory pointer, something under it) or names it in its text — sorted, deduped by path. */
function matchingTests(path: string, testFiles: readonly TestFileInput[]): string[] {
  const prefix = `${path}/`;
  const matched = new Set<string>();
  for (const t of testFiles) {
    if (t.path === path) continue;
    const hit = t.imports.some((i) => i === path || i.startsWith(prefix)) || t.text.includes(path);
    if (hit) matched.add(t.path);
  }
  return [...matched].sort();
}

/**
 * The one guarantee: a pointer's `tests` is `null` (never `[]`) exactly when there is no
 * well-formed answer — the pointer does not parse, is not in the tree, or names a file that is
 * not source (a non-code pointer named by a test's text still reports `null` here; that leak is
 * what the CONTROL test in `systems-tests.test.ts` pins). `[]` is a real answer: source found, no
 * tests. RCB-208: a pointer is any ref spec (`path:L10-L20`, `path@Token`, `path#Heading`) and is
 * answered for its whole file via `refPath`; `pointer` in the result stays the spec as written.
 */
export function testsForPointers(
  pointers: readonly string[],
  testFiles: readonly TestFileInput[],
  known: ReadonlySet<string>,
): SystemTests {
  const results: PointerTests[] = [];
  const nonNull: string[][] = [];

  for (const pointer of pointers) {
    const path = refPath(pointer);
    if (path === null) {
      results.push({ pointer, tests: null, reason: 'invalid pointer' });
      continue;
    }
    const kind = pointerKind(path, known);
    if (kind === 'unknown') {
      results.push({ pointer, tests: null, reason: 'not found' });
      continue;
    }
    if (kind === 'file' && !isCodePath(path)) {
      results.push({ pointer, tests: null, reason: 'not a source file' });
      continue;
    }
    const tests = matchingTests(path, testFiles);
    results.push({ pointer, tests, reason: null });
    nonNull.push(tests);
  }

  const allNull = pointers.length === 0 || results.every((r) => r.tests === null);
  let files: number | null = null;
  if (!allNull) {
    const union = new Set<string>();
    for (const list of nonNull) for (const t of list) union.add(t);
    files = union.size;
  }

  const line =
    files === null
      ? 'tests: n/a (no source pointers)'
      : files === 0
        ? 'tests: none found'
        : `tests: ${files} file${files === 1 ? '' : 's'}`;

  return { pointers: results, files, source: SYSTEM_TESTS_SOURCE, line };
}
