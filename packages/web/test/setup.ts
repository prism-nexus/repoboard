import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// No `globals`, so testing-library cannot register its own afterEach cleanup.
afterEach(cleanup);

// RCB-120: `StatePanel` persists open rows in localStorage key `repoboard.panelRows`. Under CI's
// jsdom that key carries across test files (and tests within a file), so a row left open by one
// test starts the next one already open/closed depending on load order —
// `log-timeline.test.tsx` tests 2 and 4 failed on CI this way. Clear it before every test, once,
// for every web test file, rather than in each test that happens to notice. try/catch: some
// test envs have no real storage.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no localStorage in this environment — nothing to clear
  }
});
