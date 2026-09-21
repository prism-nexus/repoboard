/**
 * K5 / RCB-30 — @repoboard/core must ship built JS and types, not TypeScript source.
 *
 * The workspace deliberately resolves `@repoboard/core` from `./src/index.ts` (vitest, tsc and
 * tsup all depend on that, and `pnpm test` on a clean clone must work with no build step), so the
 * published shape lives in `publishConfig`, which pnpm rewrites into the packed manifest.
 *
 * Manifest assertions run always. Anything that inspects the built artifact skips with a message
 * when `packages/core/dist` is absent — but see the `publishConfig` path test: once `dist` exists,
 * a `publishConfig` path the build does not emit is a failure, not a skip. That is the control.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(HERE, '..', '..', 'core');
const CORE_DIST = join(CORE_ROOT, 'dist');

interface CoreManifest {
  private?: boolean;
  files?: string[];
  main?: string;
  types?: string;
  exports?: unknown;
  publishConfig?: {
    main?: string;
    types?: string;
    exports?: Record<string, { types?: string; default?: string }>;
  };
}

const manifest: CoreManifest = JSON.parse(
  readFileSync(join(CORE_ROOT, 'package.json'), 'utf8'),
) as CoreManifest;

/** Every `./dist/...` path the published manifest would name, deduplicated. */
function publishedPaths(m: CoreManifest): string[] {
  const pc = m.publishConfig ?? {};
  const out: string[] = [];
  if (pc.main) out.push(pc.main);
  if (pc.types) out.push(pc.types);
  for (const entry of Object.values(pc.exports ?? {})) {
    if (entry.types) out.push(entry.types);
    if (entry.default) out.push(entry.default);
  }
  return [...new Set(out)];
}

const SKIP_NOTE =
  'packages/core/dist is absent — run `pnpm --filter @repoboard/core build` to exercise this';

describe('@repoboard/core packaging (K5)', () => {
  it('keeps the workspace resolving core from source, so a clean clone needs no build', () => {
    expect(manifest.main).toBe('./src/index.ts');
    expect(manifest.types).toBe('./src/index.ts');
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
  });

  it('carries the published shape in publishConfig, pointing at ./dist', () => {
    const pc = manifest.publishConfig;
    expect(pc).toBeDefined();
    expect(pc?.main).toBe('./dist/index.js');
    expect(pc?.types).toBe('./dist/index.d.ts');
    // `types` must come first in the "." condition or TypeScript can miss the declarations.
    expect(Object.keys(pc?.exports?.['.'] ?? {})).toEqual(['types', 'default']);
    expect(pc?.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });

  it('ships only dist and stays private until the owner decides to publish (plan O4)', () => {
    expect(manifest.files).toEqual(['dist']);
    expect(manifest.private).toBe(true);
    for (const p of publishedPaths(manifest)) {
      expect(p.startsWith('./dist/'), `publishConfig path outside dist/: ${p}`).toBe(true);
    }
  });

  it('emits dist/index.js and dist/index.d.ts', (ctx) => {
    if (!existsSync(CORE_DIST)) return ctx.skip(SKIP_NOTE);
    expect(existsSync(join(CORE_DIST, 'index.js'))).toBe(true);
    expect(existsSync(join(CORE_DIST, 'index.d.ts'))).toBe(true);
  });

  it('emits every path publishConfig names', (ctx) => {
    if (!existsSync(CORE_DIST)) return ctx.skip(SKIP_NOTE);
    const paths = publishedPaths(manifest);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !existsSync(resolve(CORE_ROOT, p)));
    expect(
      missing,
      `publishConfig names files the build does not emit: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('imports on plain Node — no bundler, no ts resolution, from a cwd outside the repo', (ctx) => {
    if (!existsSync(join(CORE_DIST, 'index.js'))) return ctx.skip(SKIP_NOTE);
    const url = pathToFileURL(join(CORE_DIST, 'index.js')).href;
    const script = `
      const m = await import(${JSON.stringify(url)});
      const wanted = ['parseCard', 'serializeCard', 'moveCard', 'createCard'];
      process.stdout.write(JSON.stringify(wanted.map((k) => [k, typeof m[k]])));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(),
      encoding: 'utf8',
      // A stray NODE_OPTIONS (ts loader, register hook) would make this prove nothing.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(JSON.parse(out)).toEqual([
      ['parseCard', 'function'],
      ['serializeCard', 'function'],
      ['moveCard', 'function'],
      ['createCard', 'function'],
    ]);
  });

  it('emits declarations that are real .d.ts, not a re-export of src', (ctx) => {
    if (!existsSync(join(CORE_DIST, 'index.d.ts'))) return ctx.skip(SKIP_NOTE);
    const dts = readFileSync(join(CORE_DIST, 'index.d.ts'), 'utf8');
    expect(dts).toMatch(/declare function parseCard|export declare|export \{/);
    expect(dts).not.toContain('../src/');
  });
});
