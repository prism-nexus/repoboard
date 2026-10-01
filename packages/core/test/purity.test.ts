/**
 * §0.5: packages/core is I/O-free. This test walks every source file and fails on any
 * import of a Node builtin (with or without the `node:` prefix) or any bare package outside
 * the allowlist. Relative imports are fine. The TEST may use node; core src may not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

export const ALLOWED_PACKAGES: ReadonlySet<string> = new Set(['yaml', 'zod']);

/** Hardcoded on purpose: core cannot import `node:module` to ask, and this test must not either. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'sea',
  'sqlite',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'test',
  'test/reporters',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out.sort();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** import x from '…' · import '…' · export … from '…' · import('…') · require('…') */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

export function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const clean = stripComments(source);
  for (const m of clean.matchAll(SPECIFIER)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export function classify(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return 'node builtin (node: prefix)';
  if (NODE_BUILTINS.has(specifier)) return 'node builtin';
  if (/^(bun|deno):/.test(specifier)) return 'runtime builtin';
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  if (ALLOWED_PACKAGES.has(pkg)) return null;
  return `bare package "${pkg}" not in allowlist [${[...ALLOWED_PACKAGES].join(', ')}]`;
}

describe('packages/core is I/O-free (§0.5)', () => {
  const files = walk(SRC_DIR);

  it('walks a non-trivial source tree', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('imports nothing but relative modules and the allowlist', () => {
    const violations: Violation[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        const reason = classify(specifier);
        if (reason) violations.push({ file: relative(SRC_DIR, file), specifier, reason });
      }
    }
    expect(violations).toEqual([]);
  });

  it('classifier sanity: the rules this test enforces', () => {
    expect(classify('./card.js')).toBeNull();
    expect(classify('../types.js')).toBeNull();
    expect(classify('yaml')).toBeNull();
    expect(classify('zod')).toBeNull();
    expect(classify('zod/v4')).toBeNull();
    expect(classify('fs')).toMatch(/node builtin/);
    expect(classify('node:fs')).toMatch(/node builtin/);
    expect(classify('node:anything')).toMatch(/node builtin/);
    expect(classify('fs/promises')).toMatch(/node builtin/);
    expect(classify('chokidar')).toMatch(/not in allowlist/);
    expect(classify('@scope/pkg/sub')).toMatch(/"@scope\/pkg" not in allowlist/);
  });

  it('specifier scanner sees every import form and ignores comments', () => {
    const src = [
      "import a from 'x1';",
      'import { b } from "x2";',
      "import 'x3';",
      "export * from 'x4';",
      "export { c } from 'x5';",
      "const d = await import('x6');",
      "const e = require('x7');",
      "import type { T } from 'x8';",
      "// import 'nope1';",
      "/* import 'nope2'; */",
      "const url = 'http://example.com'; // from 'nope3'",
    ].join('\n');
    expect(specifiersOf(src)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']);
  });
});
