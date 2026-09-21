import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import {
  AVATAR_COLORS,
  AVATAR_EMOJI,
  avatarFor,
  computeBoardSummary,
  isActive,
} from '../src/presence.js';
import { sampleCard } from './helpers.js';

const config = defaultBoardConfig();
const now = new Date('2026-09-02T23:00:00Z');

describe('isActive (D8)', () => {
  it('active column + updated within the window', () => {
    expect(
      isActive(sampleCard({ status: 'doing', updated: '2026-09-02T22:31:00Z' }), config, now),
    ).toBe(true);
  });
  it('the decide column (O11) is not active by default: a badge, not a work-in-progress state', () => {
    expect(
      isActive(sampleCard({ status: 'decide', updated: '2026-09-02T22:59:00Z' }), config, now),
    ).toBe(false);
  });
  it('active column but stale', () => {
    expect(
      isActive(sampleCard({ status: 'doing', updated: '2026-09-02T22:29:59Z' }), config, now),
    ).toBe(false);
  });
  it('fresh but in a non-active column, or an unknown column', () => {
    expect(
      isActive(sampleCard({ status: 'todo', updated: '2026-09-02T22:59:00Z' }), config, now),
    ).toBe(false);
    expect(
      isActive(sampleCard({ status: 'ghost', updated: '2026-09-02T22:59:00Z' }), config, now),
    ).toBe(false);
  });
  it('future updated (clock skew) counts as active; unparseable does not', () => {
    expect(
      isActive(sampleCard({ status: 'doing', updated: '2026-09-02T23:05:00Z' }), config, now),
    ).toBe(true);
    expect(isActive(sampleCard({ status: 'doing', updated: 'never' }), config, now)).toBe(false);
  });
  it('honors a custom window', () => {
    const wide = { ...config, activeWindowMinutes: 120 };
    expect(
      isActive(sampleCard({ status: 'doing', updated: '2026-09-02T21:30:00Z' }), wide, now),
    ).toBe(true);
  });
});

describe('avatarFor', () => {
  it('is deterministic across calls and returns curated values', () => {
    const names = [
      'claude/web-agent',
      'claude/server-agent',
      'matt',
      '',
      'a',
      'b',
      'ab',
      'ba',
      'アリス',
    ];
    for (const n of names) {
      const first = avatarFor(n);
      for (let i = 0; i < 5; i++) expect(avatarFor(n)).toEqual(first);
      expect(AVATAR_EMOJI).toContain(first.emoji);
      expect(AVATAR_COLORS).toContain(first.color);
      expect(first.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('pins a few known outputs so a hash change is noticed', () => {
    expect(avatarFor('claude/web-agent')).toEqual(avatarFor('claude/web-agent'));
    expect(avatarFor('a')).not.toEqual(avatarFor('b'));
    // Snapshot of current mapping; update deliberately if the hash or lists change.
    expect(avatarFor('claude/web-agent')).toMatchInlineSnapshot(`
      {
        "color": "#9a6324",
        "emoji": "🍓",
      }
    `);
  });

  it('spreads 200 distinct names over most of the emoji and all colors', () => {
    const emoji = new Set<string>();
    const colors = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const a = avatarFor(`agent-${i}`);
      emoji.add(a.emoji);
      colors.add(a.color);
    }
    expect(emoji.size).toBeGreaterThanOrEqual(30);
    expect(colors.size).toBe(AVATAR_COLORS.length);
  });

  it('curated lists have the promised sizes and no duplicates', () => {
    expect(AVATAR_EMOJI.length).toBe(40);
    expect(new Set(AVATAR_EMOJI).size).toBe(40);
    expect(AVATAR_COLORS.length).toBe(12);
    expect(new Set(AVATAR_COLORS).size).toBe(12);
  });
});

describe('computeBoardSummary', () => {
  it('counts every configured column, lists active cards, reports WIP breaches', () => {
    const cards = [
      sampleCard({ id: 'RB-1', status: 'doing', updated: '2026-09-02T22:50:00Z' }),
      sampleCard({ id: 'RB-2', status: 'doing', updated: '2026-09-02T22:50:00Z' }),
      sampleCard({ id: 'RB-3', status: 'doing', updated: '2026-09-02T20:00:00Z' }),
      sampleCard({ id: 'RB-4', status: 'doing', updated: '2026-09-02T20:00:00Z' }),
      sampleCard({ id: 'RB-5', status: 'decide', updated: '2026-09-02T22:59:00Z' }),
      sampleCard({ id: 'RB-6', status: 'todo', updated: '2026-09-02T22:59:00Z' }),
      sampleCard({ id: 'RB-7', status: 'mystery', updated: '2026-09-02T22:59:00Z' }),
    ];
    const s = computeBoardSummary(cards, config, now);
    expect(s.perColumn).toEqual({
      backlog: 0,
      decide: 1,
      todo: 1,
      doing: 4,
      done: 0,
      mystery: 1,
    });
    // `decide` is not an `active` column by default (O11): RB-5 counts, but not as active.
    expect(s.active.map((c) => c.id)).toEqual(['RB-1', 'RB-2']);
    expect(s.wipBreaches).toEqual([{ column: 'doing', count: 4, wip: 3 }]);
  });

  it('empty board: zeros, nothing active, no breaches, no open decisions', () => {
    expect(computeBoardSummary([], config, now)).toEqual({
      perColumn: { backlog: 0, decide: 0, todo: 0, doing: 0, done: 0 },
      active: [],
      wipBreaches: [],
      needsDecision: 0,
      needsDecisionByColumn: {},
    });
  });

  it('exactly at the WIP limit is not a breach', () => {
    const cards = [1, 2, 3].map((n) => sampleCard({ id: `RB-${n}`, status: 'doing' }));
    expect(computeBoardSummary(cards, config, now).wipBreaches).toEqual([]);
  });

  it('needsDecision: totals and per-column counts only OPEN decisions (P8.1)', () => {
    const open = {
      question: 'q',
      options: [],
      askedBy: 'a',
      askedAt: '2026-09-02T22:00:00Z',
      returnTo: 'todo',
      chosen: null,
      words: null,
      decidedBy: null,
      decidedAt: null,
    };
    const decided = { ...open, chosen: 'A', decidedBy: 'a', decidedAt: '2026-09-02T22:10:00Z' };
    const cards = [
      sampleCard({ id: 'RB-1', status: 'decide', decision: open }),
      sampleCard({ id: 'RB-2', status: 'decide', decision: decided }),
      sampleCard({ id: 'RB-3', status: 'todo', decision: open }),
      sampleCard({ id: 'RB-4', status: 'todo' }),
    ];
    const s = computeBoardSummary(cards, config, now);
    expect(s.needsDecision).toBe(2);
    expect(s.needsDecisionByColumn).toEqual({ decide: 1, todo: 1 });
  });
});
