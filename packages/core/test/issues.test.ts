/**
 * P8.5: `parseIssueItems`/`planSync`/`closeSyncedCard` — the pure half of `sync-issues`. The
 * fixture below is written BY HAND first (brief's own instruction) and every expected value is
 * computed on paper before the assertions, not read back from a first run of the code.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { closeSyncedCard, type PlanCard, parseIssueItems, planSync } from '../src/issues.js';
import { NOW, sampleCard } from './helpers.js';

// ---- the fixture, hand-annotated -----------------------------------------------------------
// K1  open,   period-form title ("K1. Text**")
// K2  closed, struck ("~~**K2 …~~")
// K3  MALFORMED near-miss ("- ~~- **K3…") — never an item
// —   a plain non-K bullet
// —   an indented "- **K4…" (not column 0) — prose, not an item
// K6  open, plain-form title, no period
const SECTION = [
  '## Known issues',
  '',
  '- **K1. A full sweep of every secret env file** — filed 2026-09-01.',
  '  Continuation detail line, indented, part of K1.',
  '  Closes K5 in the same commit — not a separate item.',
  '- ~~**K2 old bug, now fixed** — closed 2026-09-01~~',
  '- ~~- **K3 — malformed strike, must be skipped',
  '- Not a K item at all, just a plain bullet.',
  '  - **K4 nested under K1, indented, not column 0.',
  '- **K6 Second open item, no period** — extra detail',
  '',
].join('\n');

describe('parseIssueItems', () => {
  it('finds exactly the open/closed items at column 0, skips everything else, reports the malformed strike', () => {
    const res = parseIssueItems(SECTION);
    expect(res.items).toEqual([
      {
        n: 1,
        open: true,
        firstLine: '- **K1. A full sweep of every secret env file** — filed 2026-09-01.',
        title: 'K1 A full sweep of every secret env file',
      },
      {
        n: 2,
        open: false,
        firstLine: '- ~~**K2 old bug, now fixed** — closed 2026-09-01~~',
        title: 'K2 old bug, now fixed',
      },
      {
        n: 6,
        open: true,
        firstLine: '- **K6 Second open item, no period** — extra detail',
        title: 'K6 Second open item, no period',
      },
    ]);
    expect(res.malformed).toEqual(['- ~~- **K3 — malformed strike, must be skipped']);
  });

  it('truncates a title at 100 chars', () => {
    const long = 'x'.repeat(200);
    const res = parseIssueItems(`- **K9 ${long}** — tail`);
    expect(res.items[0]?.title.length).toBe(100);
    expect(res.items[0]?.title.startsWith('K9 ')).toBe(true);
  });

  it('an empty section yields no items and no malformed lines', () => {
    expect(parseIssueItems('')).toEqual({ items: [], malformed: [] });
  });
});

describe('planSync', () => {
  const items = parseIssueItems(SECTION).items; // K1 open, K2 closed, K6 open
  const path = 'README.md';
  const doneColumn = 'done';

  it('plans a create for every open item with no matching card', () => {
    const res = planSync(items, [], { path, status: 'todo', doneColumn });
    expect(res.create).toEqual([
      { n: 1, title: 'K1 A full sweep of every secret env file' },
      { n: 6, title: 'K6 Second open item, no period' },
    ]);
    expect(res.close).toEqual([]);
    expect(res.unchanged).toBe(1); // K2 is closed with no filed card — nothing to close
  });

  it('plans a close for a struck item whose card exists and is not already done', () => {
    const cards: PlanCard[] = [{ id: 'RB-50', status: 'doing', refs: [`${path}@K2`] }];
    const res = planSync(items, cards, { path, status: 'todo', doneColumn });
    expect(res.close).toEqual([{ cardId: 'RB-50', n: 2 }]);
    expect(res.create).toEqual([
      { n: 1, title: 'K1 A full sweep of every secret env file' },
      { n: 6, title: 'K6 Second open item, no period' },
    ]);
  });

  it('closes a VANISHED item (a filed card whose K-number the section no longer lists)', () => {
    const cards: PlanCard[] = [{ id: 'RB-51', status: 'todo', refs: [`${path}@K999`] }];
    const res = planSync(items, cards, { path, status: 'todo', doneColumn });
    expect(res.close).toEqual([{ cardId: 'RB-51', n: 999 }]);
  });

  it('is idempotent: a second run against the post-sync state creates and moves nothing', () => {
    // First run's outcome, modelled directly: K1/K6 now have cards in todo; K2's card moved to done.
    const cards: PlanCard[] = [
      { id: 'RB-1', status: 'todo', refs: [`${path}@K1`] },
      { id: 'RB-2', status: 'done', refs: [`${path}@K2`] },
      { id: 'RB-6', status: 'todo', refs: [`${path}@K6`] },
    ];
    const res = planSync(items, cards, { path, status: 'todo', doneColumn });
    expect(res.create).toEqual([]);
    expect(res.close).toEqual([]);
    expect(res.unchanged).toBe(3);
  });

  it('never inspects any ref for a different path', () => {
    const cards: PlanCard[] = [{ id: 'RB-99', status: 'doing', refs: ['OTHER.md@K1'] }];
    const res = planSync(items, cards, { path, status: 'todo', doneColumn });
    // OTHER.md@K1 must not satisfy README.md's K1 — still planned as a create.
    expect(res.create.some((c) => c.n === 1)).toBe(true);
  });
});

describe('closeSyncedCard', () => {
  const config = defaultBoardConfig();

  it('moves to the done column with a "synced: entry closed in <path>" log line, not the generic move line', () => {
    const card = sampleCard({ status: 'doing', body: '\nBody.\n' });
    const res = closeSyncedCard(card, {
      actor: 'claude/sync',
      now: NOW,
      config,
      path: 'README.md',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.card.status).toBe('done');
    expect(res.card.body).toContain('synced: entry closed in README.md');
    expect(res.card.body).not.toContain('moved doing → done');
    expect(res.event).toEqual({
      ts: expect.any(String),
      actor: 'claude/sync',
      type: 'move',
      cardId: card.id,
      from: 'doing',
      to: 'done',
    });
  });

  it('refuses a card already in the done column', () => {
    const card = sampleCard({ status: 'done' });
    const res = closeSyncedCard(card, {
      actor: 'claude/sync',
      now: NOW,
      config,
      path: 'README.md',
    });
    expect(res.ok).toBe(false);
  });

  it('refuses when the board has no done: true column', () => {
    const noDone = { ...config, columns: config.columns.filter((c) => c.done !== true) };
    const card = sampleCard({ status: 'doing' });
    const res = closeSyncedCard(card, {
      actor: 'claude/sync',
      now: NOW,
      config: noDone,
      path: 'README.md',
    });
    expect(res.ok).toBe(false);
  });
});
