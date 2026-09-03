import type { Card } from '../src/types.js';

export const NOW = new Date('2026-09-02T22:41:10Z');

export function sampleCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'RCB-12',
    title: 'Treemap view of the repo',
    status: 'doing',
    assignee: 'claude/web-agent',
    priority: 'high',
    labels: ['web', 'viz'],
    files: ['packages/web/src/views/Treemap.tsx'],
    created: '2026-09-02T22:00:00Z',
    updated: '2026-09-02T22:41:10Z',
    body: '\nDescription in markdown.\n\n## Log\n- 2026-09-02T22:41Z claude/web-agent — moved to doing\n',
    ...overrides,
  };
}

/** Tiny seeded PRNG (mulberry32) so the round-trip "property" test is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
