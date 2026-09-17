/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/log/YYYY-MM-DD.md` — append-only, one block per seat
 * per call, newest last. `appendLogBlock` is the only writer core exposes; there is no rewrite.
 */
import { describe, expect, it } from 'vitest';
import { appendLogBlock, dailyLogHeader, formatLogBlock, parseLogBlocks } from '../src/repolog.js';

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
