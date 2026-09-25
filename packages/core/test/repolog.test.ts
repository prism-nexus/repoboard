/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/log/YYYY-MM-DD.md` — append-only, one block per seat
 * per call, newest last. `appendLogBlock` is the only writer core exposes; there is no rewrite.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appendLogBlock,
  type DatedLogBlocks,
  dailyLogHeader,
  filterLogBlocks,
  formatLogBlock,
  type LogBlock,
  lastBlockFor,
  parseLogBlocks,
} from '../src/repolog.js';

const SIBLING_LOG_HEADINGS = fileURLToPath(
  new URL('./fixtures/sibling-log-headings.md', import.meta.url),
);

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

  // RCB-62 (finding 1): the seat token match is now "leading word", not "whole token" — measured
  // against the sibling's real heading shapes (`sibling-log-headings.md`).
  describe('RCB-62: leading-word match for a single-word `wanted`', () => {
    it('`builder` finds a heading whose seat token is `BUILDER (fresh, f87be1)`', () => {
      const days: DatedLogBlocks[] = [
        {
          date: '2026-09-18',
          blocks: [block('BUILDER (fresh, f87be1)', '2026-09-18T20:3xZ', 'research')],
        },
      ];
      const res = lastBlockFor('builder', days);
      expect(res?.block.seat).toBe('BUILDER (FRESH, F87BE1)');
    });

    it(
      'CONTROL (card rule): `coordinator` does NOT match `COORDINATOR/SEARCH` — this is the ' +
        'card\'s "leading word", not "prefix", rule; a prefix rule is a separate, undecided ' +
        'behaviour and must not be introduced here',
      () => {
        const days: DatedLogBlocks[] = [
          { date: '2026-09-17', blocks: [block('COORDINATOR/SEARCH', '2026-09-17T19:4xZ')] },
        ];
        expect(lastBlockFor('coordinator', days)).toBeNull();
      },
    );

    it('a multi-word `wanted` still compares whole-to-whole, as before', () => {
      const days: DatedLogBlocks[] = [
        { date: '2026-09-16', blocks: [block('REPOBOARD BUILDER', '2026-09-16T10:00:00Z')] },
      ];
      expect(lastBlockFor('repoboard builder', days)?.block.seat).toBe('REPOBOARD BUILDER');
      expect(lastBlockFor('builder', days)).toBeNull(); // leading word is "REPOBOARD", not "BUILDER"
    });

    it('a multi-word `wanted` does not match a bare seat token equal to only its last word', () => {
      const days: DatedLogBlocks[] = [
        { date: '2026-09-16', blocks: [block('BUILDER', '2026-09-16T10:00:00Z')] },
      ];
      expect(lastBlockFor('repoboard builder', days)).toBeNull();
    });
  });
});

/**
 * RCB-54: the sibling repo (freshpickedjobs) writes `.repoboard/log/`-shaped files by hand into
 * `board.yml`'s `logDir`, and its real headings do not match the old `<SEAT> <ISO>: ` shape
 * exactly. Fixture copied from its real 2026-09-18 `docs/log/*.md` heading LINES only (bodies
 * replaced with a one-line placeholder) — see `docs/RCB-54-LOGDIR-BRIEF.md`.
 */
describe('parseLogBlocks: sibling log heading shapes (RCB-54)', () => {
  const fixtureText = readFileSync(SIBLING_LOG_HEADINGS, 'utf8');
  const headingLineCount = (fixtureText.match(/^#####/gm) ?? []).length;

  it('parses one block per ##### heading line in the fixture', () => {
    const blocks = parseLogBlocks(fixtureText);
    expect(headingLineCount).toBe(8);
    expect(blocks).toHaveLength(headingLineCount);
  });

  it('the SPACE shape (date and time separated by a space, no "T") parses seat/ts/title', () => {
    const blocks = parseLogBlocks(fixtureText);
    const b = blocks.find((x) => x.seat === 'OPS' && x.ts === '2026-09-16 00:0xZ');
    expect(b?.title.startsWith('K124 + K125 LANDED HOT')).toBe(true);
  });

  it('the (addendum) shape keeps the parenthetical in `ts`, splits at the first ": " after it', () => {
    const blocks = parseLogBlocks(fixtureText);
    const b = blocks.find((x) => x.seat === 'OPS' && x.ts.includes('(addendum)'));
    expect(b?.ts).toBe('2026-09-18 19:5xZ (addendum)');
    expect(b?.title.startsWith('MIGRATION 0023 APPLIED')).toBe(true);
  });

  it('the COORDINATOR/SEARCH seat (a "/" in the seat) is captured whole, not truncated', () => {
    const blocks = parseLogBlocks(fixtureText);
    const b = blocks.find((x) => x.seat === 'COORDINATOR/SEARCH');
    expect(b).toBeDefined();
    expect(b?.title.startsWith('OVERHAUL LETTERS')).toBe(true);
  });

  it('the "BUILDER (fresh, f87be1)" seat (a parenthetical IN the seat) is captured whole', () => {
    const blocks = parseLogBlocks(fixtureText);
    const b = blocks.find((x) => x.seat === 'BUILDER (fresh, f87be1)');
    expect(b).toBeDefined();
    expect(b?.title.startsWith('K101 IDLE-RETENTION RESEARCH')).toBe(true);
  });

  it('the title-with-colon shape (our own ISO ts) stops `ts` at the FIRST ": ", not the one in the title', () => {
    const blocks = parseLogBlocks(fixtureText);
    const b = blocks.find((x) => x.seat === 'COORDINATOR' && x.ts === '2026-09-18T20:23:38Z');
    expect(b).toBeDefined();
    expect(b?.title.startsWith('stand-up')).toBe(true);
  });

  it('CONTROL: the OLD `<SEAT> <ISO>: ` regex parses only 1 of these 8 shapes', () => {
    const OLD_BLOCK_HEADING = /^##### (\S+) (\S+): (.*)$/gm;
    const oldBlocks = [...fixtureText.matchAll(OLD_BLOCK_HEADING)];
    // Every shape with a SPACE in the seat or between date and time fails `\S+`; only the
    // title-with-colon line (no space anywhere before its ISO ts) still matches the old regex.
    expect(oldBlocks).toHaveLength(1);
    expect(oldBlocks[0]?.[1]).toBe('COORDINATOR');
    expect(oldBlocks.length).not.toBe(headingLineCount);
  });
});

/**
 * RCB-132: the ONE filter `log show --seat/--since/--tail` and MCP `get_log`'s matching args
 * share. Order is fixed: seat, then since, then tail.
 */
describe('filterLogBlocks', () => {
  function block(seat: string, ts: string, text = seat): LogBlock {
    return { seat: seat.toUpperCase(), ts, title: text, text };
  }

  const DAY = '2026-09-24';
  // Deliberately NOT alternating strictly OPS/BUILDER/OPS/BUILDER/OPS — the raw LAST block is
  // BUILDER, so a wrong implementation that slices `tail` before filtering `seat` is caught: it
  // would grab a BUILDER block that then matches nothing under seat=OPS (see the order test).
  const blocks: LogBlock[] = [
    block('OPS', '2026-09-24T09:00:00Z', 'ops 09'),
    block('BUILDER', '2026-09-24T10:00:00Z', 'builder 10'),
    block('OPS', '2026-09-24T11:00:00Z', 'ops 11'),
    block('OPS', '2026-09-24T12:00:00Z', 'ops 12'),
    block('BUILDER', '2026-09-24T13:00:00Z', 'builder 13'),
  ];

  it('seat narrows to one seat, same rule as `log show --seat` (uppercased, exact match)', () => {
    const res = filterLogBlocks(blocks, DAY, { seat: 'ops' });
    expect(res).toEqual({ ok: true, blocks: [blocks[0], blocks[2], blocks[3]] });
  });

  it('since (full ISO-8601) keeps blocks whose ts >= since', () => {
    const res = filterLogBlocks(blocks, DAY, { since: '2026-09-24T11:00:00Z' });
    expect(res).toEqual({ ok: true, blocks: [blocks[2], blocks[3], blocks[4]] });
  });

  it('since (HH:MMZ) resolves against `day`, same UTC instant as the equivalent full ISO', () => {
    const short = filterLogBlocks(blocks, DAY, { since: '11:00Z' });
    const full = filterLogBlocks(blocks, DAY, { since: '2026-09-24T11:00:00Z' });
    expect(short).toEqual(full);
    expect(short).toEqual({ ok: true, blocks: [blocks[2], blocks[3], blocks[4]] });
  });

  it('tail n > count returns every remaining block, never an error', () => {
    const res = filterLogBlocks(blocks, DAY, { tail: 999 });
    expect(res).toEqual({ ok: true, blocks });
  });

  it('tail n = 0 returns no blocks', () => {
    const res = filterLogBlocks(blocks, DAY, { tail: 0 });
    expect(res).toEqual({ ok: true, blocks: [] });
  });

  it(
    'composition order is seat, then since, then tail — CONTROL: applying tail to the ' +
      'unfiltered blocks FIRST (the bug this pins against) would keep the raw last block ' +
      '(BUILDER 13:00), and seat=OPS would then find nothing at all',
    () => {
      const res = filterLogBlocks(blocks, DAY, { seat: 'ops', since: '10:30Z', tail: 1 });
      // seat=OPS -> [09,11,12]; since>=10:30 -> [11,12]; tail=1 -> [12].
      expect(res).toEqual({ ok: true, blocks: [blocks[3]] });

      // The control: tail-before-seat would grab the raw last block (BUILDER 13:00, not OPS),
      // which then matches nothing under seat=OPS — a different, and wrong, final answer.
      const wrongOrder = blocks.slice(-1).filter((b) => b.seat === 'OPS');
      expect(wrongOrder).toEqual([]);
      expect(res.ok && res.blocks).not.toEqual(wrongOrder);
    },
  );

  it('a block whose ts fails to parse (RCB-54: a hand-written log) is dropped by --since, never kept on a guess', () => {
    const withBad = [block('OPS', '2026-09-18 0x:xxZ', 'unparseable'), ...blocks];
    const res = filterLogBlocks(withBad, DAY, { since: '00:00Z' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.blocks.some((b) => b.text === 'unparseable')).toBe(false);
  });

  it('a bad --since value is ok:false, naming what was rejected', () => {
    const res = filterLogBlocks(blocks, DAY, { since: 'not-a-time' });
    expect(res).toEqual({
      ok: false,
      error: '"not-a-time" is not a full ISO-8601 datetime or HH:MMZ',
    });
  });

  it('every field absent is inert: the whole day, unfiltered', () => {
    expect(filterLogBlocks(blocks, DAY, {})).toEqual({ ok: true, blocks });
  });
});
