/**
 * RCB-110 A: `isCodePath`/`isTestFile` classification, then `testsForPointers`'s matching rules —
 * pure, no I/O (this module is `packages/core`; `purity.test.ts` enforces the import allowlist).
 */
import { describe, expect, it } from 'vitest';
import {
  isCodePath,
  isTestFile,
  SYSTEM_TESTS_SOURCE,
  type TestFileInput,
  testsForPointers,
} from '../src/systems-tests.js';

describe('isTestFile (RCB-110)', () => {
  it('positives: *.test.*, *.spec.*, and a test/tests/__tests__ segment', () => {
    expect(isTestFile('packages/core/test/x.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('__tests__/b.js')).toBe(true);
    expect(isTestFile('tests/c.mjs')).toBe(true);
  });

  it('negatives: a near-miss name, a non-code extension, and a non-code file in a test/ dir', () => {
    expect(isTestFile('src/testing.ts')).toBe(false);
    expect(isTestFile('src/latest.ts')).toBe(false);
    expect(isTestFile('docs/test/readme.md')).toBe(false);
    expect(isTestFile('test/fixture.yml')).toBe(false);
  });

  it('isCodePath: the eight extensions, and nothing else', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']) {
      expect(isCodePath(`x.${ext}`)).toBe(true);
    }
    expect(isCodePath('x.md')).toBe(false);
    expect(isCodePath('x.yml')).toBe(false);
    expect(isCodePath('.env')).toBe(false);
  });
});

const t = (path: string, imports: readonly string[], text: string): TestFileInput => ({
  path,
  imports,
  text,
});

describe('testsForPointers (RCB-110)', () => {
  it('file pointer matched by an import', () => {
    const known = new Set(['src/api/index.ts', 'test/api.test.ts']);
    const testFiles = [
      t('test/api.test.ts', ['src/api/index.ts'], "import '../src/api/index.js';"),
    ];
    const result = testsForPointers(['src/api/index.ts'], testFiles, known);
    expect(result.pointers).toEqual([
      { pointer: 'src/api/index.ts', tests: ['test/api.test.ts'], reason: null },
    ]);
    expect(result.files).toBe(1);
    expect(result.line).toBe('tests: 1 file');
    expect(result.source).toBe(SYSTEM_TESTS_SOURCE);
  });

  it('matched by name only — text contains the path, no import', () => {
    const known = new Set(['src/util.ts', 'test/util.spec.ts']);
    const testFiles = [t('test/util.spec.ts', [], '// exercises src/util.ts directly')];
    const result = testsForPointers(['src/util.ts'], testFiles, known);
    expect(result.pointers[0]).toEqual({
      pointer: 'src/util.ts',
      tests: ['test/util.spec.ts'],
      reason: null,
    });
  });

  it('directory pointer matched by an import under it', () => {
    // `known` holds only FILE paths (the real file listing never contains a bare directory
    // entry) — a directory pointer is recognized only because some known path starts with
    // `pointer + '/'`.
    const known = new Set(['apps/web/src/index.ts', 'test/web.test.ts']);
    const testFiles = [t('test/web.test.ts', ['apps/web/src/index.ts'], 'no direct mention')];
    const result = testsForPointers(['apps/web/src'], testFiles, known);
    expect(result.pointers[0]).toEqual({
      pointer: 'apps/web/src',
      tests: ['test/web.test.ts'],
      reason: null,
    });
  });

  it('a test that imports a sibling and never names the pointer is NOT matched', () => {
    const known = new Set(['src/other.ts', 'src/sibling.ts', 'test/sibling.test.ts']);
    const testFiles = [
      t('test/sibling.test.ts', ['src/sibling.ts'], 'no mention of the other file'),
    ];
    const result = testsForPointers(['src/other.ts'], testFiles, known);
    expect(result.pointers[0]).toEqual({ pointer: 'src/other.ts', tests: [], reason: null });
    expect(result.files).toBe(0);
    expect(result.line).toBe('tests: none found');
  });

  it('CONTROL: a non-code pointer named by a test is still null + "not a source file"', () => {
    const known = new Set(['.github/workflows/ci.yml', 'test/ci.test.ts']);
    const testFiles = [
      t('test/ci.test.ts', [], 'checks that .github/workflows/ci.yml exists and is valid'),
    ];
    const result = testsForPointers(['.github/workflows/ci.yml'], testFiles, known);
    expect(result.pointers[0]).toEqual({
      pointer: '.github/workflows/ci.yml',
      tests: null,
      reason: 'not a source file',
    });
    // name-matching leaking into non-code pointers would report a match here; it must not.
    expect(result.files).toBeNull();
    expect(result.line).toBe('tests: n/a (no source pointers)');
  });

  it('unknown pointer: not found', () => {
    const result = testsForPointers(['src/missing.ts'], [], new Set());
    expect(result.pointers[0]).toEqual({
      pointer: 'src/missing.ts',
      tests: null,
      reason: 'not found',
    });
  });

  it('empty pointers: files null, the n/a line, empty pointers array', () => {
    const result = testsForPointers([], [], new Set());
    expect(result).toEqual({
      pointers: [],
      files: null,
      source: SYSTEM_TESTS_SOURCE,
      line: 'tests: n/a (no source pointers)',
    });
  });

  it('CONTROL: two pointers sharing one test — files is 1, not 2 (union, not sum)', () => {
    const known = new Set(['src/a.ts', 'src/b.ts', 'test/both.test.ts']);
    const testFiles = [t('test/both.test.ts', ['src/a.ts', 'src/b.ts'], '')];
    const result = testsForPointers(['src/a.ts', 'src/b.ts'], testFiles, known);
    expect(result.pointers[0]?.tests).toEqual(['test/both.test.ts']);
    expect(result.pointers[1]?.tests).toEqual(['test/both.test.ts']);
    expect(result.files).toBe(1);
    expect(result.line).toBe('tests: 1 file');
  });

  it('output sorted and deduped', () => {
    const known = new Set(['src/x.ts', 'test/z.test.ts', 'test/a.test.ts', 'test/m.test.ts']);
    // z.test.ts and a.test.ts both hit (one by import, one by name); m.test.ts hits by BOTH
    // (import and name) and must appear once, not twice.
    const testFiles = [
      t('test/z.test.ts', ['src/x.ts'], 'unrelated'),
      t('test/a.test.ts', [], 'names src/x.ts in a comment'),
      t('test/m.test.ts', ['src/x.ts'], 'also names src/x.ts'),
    ];
    const result = testsForPointers(['src/x.ts'], testFiles, known);
    expect(result.pointers[0]?.tests).toEqual([
      'test/a.test.ts',
      'test/m.test.ts',
      'test/z.test.ts',
    ]);
    expect(result.files).toBe(3);
  });
});
