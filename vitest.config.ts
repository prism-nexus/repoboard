import { defineConfig } from 'vitest/config';

// One root config; each package is a vitest project so `pnpm test` runs them all.
export default defineConfig({
  test: {
    projects: ['packages/*'],
    // RCB-113: the gate's coverage run. Off unless `--coverage` is passed, which only `pnpm test`
    // does — the same single pass, not a second run. One report, json-summary only (the cheapest
    // reporter), at the fixed path the server reads (`coverage/coverage-summary.json`,
    // gitignored). `include` lists every package's source so a file no test loads reads 0%,
    // not absent. A targeted run never writes it, so the report is always a whole-suite one.
    coverage: {
      provider: 'v8',
      reporter: ['json-summary'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.{ts,tsx}'],
    },
  },
});
