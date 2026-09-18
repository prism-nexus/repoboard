/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/log/YYYY-MM-DD.md` — append-only, one block per seat
 * per call, newest last. `appendLogBlock` is the only writer core exposes; there is no rewrite.
 */
import { describe, expect, it } from 'vitest';
import {
  appendLogBlock,
  type DatedLogBlocks,
  dailyLogHeader,
  formatLogBlock,
  type LogBlock,
  lastBlockFor,
  parseLogBlocks,
} from '../src/repolog.js';

describe('dailyLogHeader', () => {
  it('is the line 1 shape', () => {
    expect(dailyLogHeader('2026-09-17')).toBe('# Log — 2026-09-17');
  });
});

describe('formatLogBlock', () => {
  it('uppercases the seat and uses an explicit title', () => {
    const block = formatLogBlock({
      seat: 'claude/p8-3',
      ts: '2026-09-17T21:00:00Z',
      title: 'landed the thing',
      text: 'Full details here.',
    });
    expect(block).toBe(
      '##### CLAUDE/P8-3 2026-09-17T21:00:00Z: landed the thing\n\nFull details here.',
    );
  });

  it('falls back to the first line of text when no title is given', () => {
    const block = formatLogBlock({
      seat: 'ops',
      ts: '2026-09-17T21:00:00Z',
      text: 'First line summary.\nMore detail below.',
    });
    expect(block).toBe(
      '##### OPS 2026-09-17T21:00:00Z: First line summary.\n\nFirst line summary.\nMore detail below.',
    );
  });

  it('an empty explicit title also falls back to the first line', () => {
    const block = formatLogBlock({
      seat: 'ops',
      ts: '2026-09-17T21:00:00Z',
      title: '   ',
      text: 'Only line.',
    });
    expect(block).toContain(': Only line.');
  });
});

describe('appendLogBlock: append-only, no rewrite', () => {
  it('a brand-new file (header only) gets the block with no leading blank run', () => {
    const header = `${dailyLogHeader('2026-09-17')}\n\n`;
    const block = formatLogBlock({ seat: 'ops', ts: '2026-09-17T18:00:00Z', text: 'first' });
    const out = appendLogBlock(header, block);
    expect(out).toBe('# Log — 2026-09-17\n\n##### OPS 2026-09-17T18:00:00Z: first\n\nfirst\n');
  });

  it('a second block is separated from the first by exactly one blank line', () => {
    const header = `${dailyLogHeader('2026-09-17')}\n\n`;
    const first = appendLogBlock(
      header,
      formatLogBlock({ seat: 'ops', ts: '2026-09-17T18:00:00Z', text: 'first' }),
    );
    const second = appendLogBlock(
      first,
      formatLogBlock({ seat: 'builder', ts: '2026-09-17T18:30:00Z', text: 'second' }),
    );
    expect(second).toBe(
      [
        '# Log — 2026-09-17',
        '',
        '##### OPS 2026-09-17T18:00:00Z: first',
        '',
        'first',
        '',
        '##### BUILDER 2026-09-17T18:30:00Z: second',
        '',
        'second',
        '',
      ].join('\n'),
    );
  });

  it('trailing whitespace before the append does not accumulate blank lines', () => {
    const messy = '# Log — 2026-09-17\n\n\n\n';
    const out = appendLogBlock(messy, 'BLOCK');
    expect(out).toBe('# Log — 2026-09-17\n\nBLOCK\n');
  });

  it('existing content is never rewritten — only appended after', () => {
    const before = '# Log — 2026-09-17\n\n##### OPS 2026-09-17T18:00:00Z: first\n\nfirst\n';
    const out = appendLogBlock(before, 'NEW BLOCK');
    expect(out.startsWith(before.replace(/\n+$/, ''))).toBe(true);
    expect(out).toContain('NEW BLOCK');
  });
});

describe('parseLogBlocks', () => {
  it('parses a 3-seat day, oldest first, in file order', () => {
    const text = [
      '# Log — 2026-09-17',
      '',
      '##### OPS 2026-09-17T18:00:00Z: armed the fires',
      '',
      'Five waiters set.',
      'Second line.',
      '',
      '##### BUILDER 2026-09-17T18:30:00Z: K117 landed',
      '',
      'Two copy lines shipped.',
      '',
      '##### COORDINATOR 2026-09-17T19:00:00Z: triage',
      '',
      'Nothing urgent.',
      '',
    ].join('\n');
    const blocks = parseLogBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      seat: 'OPS',
      ts: '2026-09-17T18:00:00Z',
      title: 'armed the fires',
      text: 'Five waiters set.\nSecond line.',
    });
    expect(blocks[1]?.seat).toBe('BUILDER');
    expect(blocks[2]).toEqual({
      seat: 'COORDINATOR',
      ts: '2026-09-17T19:00:00Z',
      title: 'triage',
      text: 'Nothing urgent.',
    });
  });

  it('a file with only the header yields no blocks', () => {
    expect(parseLogBlocks('# Log — 2026-09-17\n\n')).toEqual([]);
  });

  it('an empty string yields no blocks', () => {
    expect(parseLogBlocks('')).toEqual([]);
  });

  it('round-trips through appendLogBlock: parse(append(x)) recovers what was appended', () => {
    const header = `${dailyLogHeader('2026-09-17')}\n\n`;
    const block = formatLogBlock({
      seat: 'claude/p8-3',
      ts: '2026-09-17T21:00:00Z',
      title: 'built P8.3',
      text: 'Multi\nline\ntext.',
    });
    const file = appendLogBlock(header, block);
    const blocks = parseLogBlocks(file);
    expect(blocks).toEqual([
      {
        seat: 'CLAUDE/P8-3',
        ts: '2026-09-17T21:00:00Z',
        title: 'built P8.3',
        text: 'Multi\nline\ntext.',
      },
    ]);
  });
});

describe('lastBlockFor', () => {
  function block(seat: string, ts: string, text = seat): LogBlock {
    return { seat: seat.toUpperCase(), ts, title: text, text };
  }

  it('finds the target seat on the middle day, its LAST block that day, not the first', () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-15', blocks: [block('BUILDER', '2026-09-15T10:00:00Z', 'oldest day')] },
      {
        date: '2026-09-16',
        blocks: [
          block('BUILDER', '2026-09-16T10:00:00Z', 'middle first'),
          block('OPS', '2026-09-16T11:00:00Z', 'not builder'),
          block('BUILDER', '2026-09-16T12:00:00Z', 'middle last'),
        ],
      },
      { date: '2026-09-14', blocks: [block('OPS', '2026-09-14T10:00:00Z', 'no builder here')] },
    ];
    const res = lastBlockFor('BUILDER', days);
    expect(res?.date).toBe('2026-09-16');
    expect(res?.block.text).toBe('middle last');
  });

  it("C1: days passed in ASCENDING order still return the newest day's block", () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-14', blocks: [block('BUILDER', '2026-09-14T10:00:00Z', 'oldest')] },
      { date: '2026-09-15', blocks: [block('BUILDER', '2026-09-15T10:00:00Z', 'middle')] },
      { date: '2026-09-16', blocks: [block('BUILDER', '2026-09-16T10:00:00Z', 'newest')] },
    ];
    const res = lastBlockFor('BUILDER', days);
    expect(res?.date).toBe('2026-09-16');
    expect(res?.block.text).toBe('newest');
  });

  it('seat match is case-insensitive: "builder" finds BUILDER', () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-16', blocks: [block('BUILDER', '2026-09-16T10:00:00Z')] },
    ];
    expect(lastBlockFor('builder', days)?.block.seat).toBe('BUILDER');
  });

  it('no match across any day returns null', () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-16', blocks: [block('OPS', '2026-09-16T10:00:00Z')] },
    ];
    expect(lastBlockFor('builder', days)).toBeNull();
  });

  it('a seat that is a prefix of another does not match ("OPS" vs "OPS-2")', () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-16', blocks: [block('OPS-2', '2026-09-16T10:00:00Z')] },
    ];
    expect(lastBlockFor('OPS', days)).toBeNull();
  });

  it('an empty (after trim) seat name is inert: null, never a match', () => {
    const days: DatedLogBlocks[] = [
      { date: '2026-09-16', blocks: [block('OPS', '2026-09-16T10:00:00Z')] },
    ];
    expect(lastBlockFor('   ', days)).toBeNull();
  });
});
