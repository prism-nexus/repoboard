import { defineConfig } from 'vitest/config';

// One root config; each package is a vitest project so `pnpm test` runs them all.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
