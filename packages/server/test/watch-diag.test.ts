/** RCB-157: `createWatchDiag`/`watchDiagFromEnv` (unit) and the store-watcher integration they
 * exist for — a recorder, opt-in only through `REPOBOARD_WATCH_DIAG=1`. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Card } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/store.js';
import {
  createWatchDiag,
  getWatchDiag,
  setWatchDiag,
  watchDiagFromEnv,
} from '../src/watch-diag.js';
import { cardText, makeTempRepoboard, waitForEvent } from './helpers.js';

describe('watchDiagFromEnv', () => {
  it('is inert (null) unless the flag is exactly "1"', () => {
    expect(watchDiagFromEnv({})).toBeNull();
    expect(watchDiagFromEnv({ REPOBOARD_WATCH_DIAG: '0' })).toBeNull();
    expect(watchDiagFromEnv({ REPOBOARD_WATCH_DIAG: 'true' })).toBeNull();
  });

  it('returns a recorder when the flag is "1"', () => {
    const d = watchDiagFromEnv({ REPOBOARD_WATCH_DIAG: '1' });
    expect(d).not.toBeNull();
  });
});

describe('createWatchDiag: cap and per-root isolation', () => {
  it('past the cap, rows() keeps the newest entries and drops the oldest', () => {
    const d = createWatchDiag(3);
    for (let i = 1; i <= 5; i++) d.record('a', 'k', i);
    const rows = d.rows('a');
    expect(rows.map((r) => r[2])).toEqual([3, 4, 5]);
  });

  it("dump(root) omits another root's rows", () => {
    const d = createWatchDiag();
    d.record('a', 'only-a');
    d.record('b', 'only-b');
    const dumped = d.dump('a');
    expect(dumped).toContain('only-a');
    expect(dumped).not.toContain('only-b');
  });

  it('dump(root) starts with the RB157 DIAG header', () => {
    const d = createWatchDiag();
    d.record('a', 'k', 1);
    const [header, row] = d.dump('a').split('\n');
    expect(header).toMatch(/^RB157 DIAG root=a node=v[\d.]+ rows=1 now=\d+$/);
    expect(JSON.parse(row ?? '')).toEqual([expect.any(Number), 'k', 1]);
  });
});

describe('RCB-157 integration: the store watcher records its own lifecycle', () => {
  const opened: Array<{ close(): Promise<void> }> = [];
  const repos: Array<{ cleanup(): Promise<void> }> = [];

  afterEach(async () => {
    setWatchDiag(null);
    await Promise.all(opened.splice(0).map((s) => s.close()));
    await Promise.all(repos.splice(0).map((r) => r.cleanup()));
  });

  it('records ready, all, enq, run, and refresh for a hand-edited card', async () => {
    const diag = createWatchDiag();
    setWatchDiag(diag);
    expect(getWatchDiag()).toBe(diag);

    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    repos.push(repo);
    const store = await openStore(repo.root, { watch: true });
    opened.push(store);

    const seen = waitForEvent<Card>(store, 'card', (c) => c.status === 'doing');
    await writeFile(join(repo.cardsDir, 'RB-1.md'), cardText('RB-1', 'doing'));
    await seen;

    const kinds = new Set(diag.rows(store.root).map((r) => r[1]));
    expect(kinds.has('ready')).toBe(true);
    expect(kinds.has('all')).toBe(true);
    expect(kinds.has('enq')).toBe(true);
    expect(kinds.has('run')).toBe(true);
    expect(kinds.has('refresh')).toBe(true);
    // 'raw' is platform-dependent (chokidar backend) — deliberately not asserted here.
  });
});
