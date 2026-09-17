/** P8.5: `selectArchivable` (the pure "which cards qualify" rule) and `resolveOlderThan`. */
import { describe, expect, it } from 'vitest';
import { resolveOlderThan, selectArchivable } from '../src/archive.js';
import { defaultBoardConfig } from '../src/board.js';

const config = defaultBoardConfig(); // done: true is the last column, id "done"
const NOW = new Date('2026-09-17T00:00:00Z');
const CUTOFF = new Date('2026-09-03T00:00:00Z'); // 14d before NOW

describe('selectArchivable', () => {
  it('selects only done cards updated strictly before the cutoff', () => {
    const cards = [
      { id: 'RB-1', status: 'done', updated: '2026-09-01T00:00:00Z' }, // before cutoff: archivable
      { id: 'RB-2', status: 'done', updated: '2026-09-10T00:00:00Z' }, // after cutoff: not yet
      { id: 'RB-3', status: 'doing', updated: '2026-08-01T00:00:00Z' }, // not done: never
    ];
    expect(selectArchivable(cards, config, CUTOFF)).toEqual(['RB-1']);
  });

  it('boundary: updated === cutoff STAYS (not archived)', () => {
    const cards = [{ id: 'RB-4', status: 'done', updated: CUTOFF.toISOString() }];
    expect(selectArchivable(cards, config, CUTOFF)).toEqual([]);
  });

  it('boundary: updated one millisecond before the cutoff is archivable', () => {
    const justBefore = new Date(CUTOFF.getTime() - 1).toISOString();
    const cards = [{ id: 'RB-5', status: 'done', updated: justBefore }];
    expect(selectArchivable(cards, config, CUTOFF)).toEqual(['RB-5']);
  });

  it('a board with no done: true column archives nothing', () => {
    const noDone = { ...config, columns: config.columns.filter((c) => c.done !== true) };
    const cards = [{ id: 'RB-6', status: 'done', updated: '2026-01-01T00:00:00Z' }];
    expect(selectArchivable(cards, noDone, CUTOFF)).toEqual([]);
  });
});

describe('resolveOlderThan', () => {
  it('14d is 14 days before now', () => {
    const r = resolveOlderThan('14d', NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.cutoff.toISOString()).toBe(CUTOFF.toISOString());
  });

  it('Nh and Nm are hours/minutes before now', () => {
    const h = resolveOlderThan('2h', NOW);
    if (!h.ok) throw new Error(h.error);
    expect(h.cutoff.toISOString()).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    const m = resolveOlderThan('90m', NOW);
    if (!m.ok) throw new Error(m.error);
    expect(m.cutoff.toISOString()).toBe(new Date(NOW.getTime() - 90 * 60_000).toISOString());
  });

  it('an ISO-8601 datetime is taken as the cutoff itself, not relative to now', () => {
    const r = resolveOlderThan('2026-01-01T00:00:00Z', NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.cutoff.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects garbage', () => {
    expect(resolveOlderThan('soon', NOW).ok).toBe(false);
  });
});
