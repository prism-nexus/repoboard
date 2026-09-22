/**
 * RCB-110 (owner decision A): the server half of "does a system have test coverage" — gather the
 * tree (`listRepoFiles`), pick out the test files (core's `isTestFile`), read each one and
 * resolve its relative imports (the scanner's own `findImportSpecifiers`/`resolveImport`, the
 * same regex scan `scanRepo` uses for the import-edge graph), then hand the pure match to core's
 * `testsForPointers`. Reads ONLY test files, never the whole tree — a system's pointers can be
 * anywhere, but what has to be read to answer is bounded by how many test files exist.
 */
import {
  isTestFile,
  type SystemTests,
  type TestFileInput,
  testsForPointers,
} from '@repoboard/core';
import { readRepoText, resolveRepoPath } from './refs.js';
import { findImportSpecifiers, listRepoFiles, resolveImport } from './scanner.js';

export async function systemTests(root: string, pointers: readonly string[]): Promise<SystemTests> {
  if (pointers.length === 0) return testsForPointers([], [], new Set());

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

  return testsForPointers(pointers, testFiles, known);
}
