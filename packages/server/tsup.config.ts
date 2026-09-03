import { defineConfig } from 'tsup';

// @rcb/core ships TypeScript source only (its package.json exports ./src/index.ts), so the
// runnable CLI bundles core in. yaml/zod (core's deps) stay external and are listed as our own
// dependencies. `clean` is off because the web build lands in dist/web (BUILD-PLAN §6).
export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  // No splitting: cli.ts's "am I the main module" check compares import.meta.url with argv[1],
  // which only works when its code lives in dist/cli.js itself, not in a shared chunk.
  splitting: false,
  sourcemap: true,
  dts: false,
  clean: false,
  noExternal: ['@rcb/core'],
  external: ['chokidar', 'ws', 'yaml', 'zod'],
});
