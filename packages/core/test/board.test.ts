import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, findColumn, parseBoard, serializeBoard } from '../src/board.js';

const SPEC_BOARD = `prefix: RB
activeWindowMinutes: 30
columns:
  - id: backlog
    title: Backlog
  - id: decide
    title: Needs decision
    decision: true
  - id: todo
    title: To do
  - id: doing
    title: Doing
    active: true
    wip: 3
  - id: done
    title: Done
    done: true
`;

describe('defaultBoardConfig', () => {
  it('defaults the prefix to RB (plan §11 O1)', () => {
    expect(defaultBoardConfig().prefix).toBe('RB');
  });

  it('is exactly the §2 default and a fresh object each call (O11: decide, not review)', () => {
    const a = defaultBoardConfig();
    expect(a).toEqual({
      prefix: 'RB',
      activeWindowMinutes: 30,
      columns: [
        { id: 'backlog', title: 'Backlog' },
        { id: 'decide', title: 'Needs decision', decision: true },
        { id: 'todo', title: 'To do' },
        { id: 'doing', title: 'Doing', active: true, wip: 3 },
        { id: 'done', title: 'Done', done: true },
      ],
    });
    expect(defaultBoardConfig()).not.toBe(a);
    expect(defaultBoardConfig().columns).not.toBe(a.columns);
  });
});

describe('parseBoard', () => {
  it('parses the §2 file to exactly the default', () => {
    expect(parseBoard(SPEC_BOARD)).toEqual({ ok: true, config: defaultBoardConfig() });
  });

  it('an empty file or empty mapping yields the defaults (inert, not dangerous)', () => {
    expect(parseBoard('')).toEqual({ ok: true, config: defaultBoardConfig() });
    expect(parseBoard('{}')).toEqual({ ok: true, config: defaultBoardConfig() });
    expect(parseBoard('# just a comment\n')).toEqual({ ok: true, config: defaultBoardConfig() });
  });

  it('fills defaults for prefix and activeWindowMinutes', () => {
    const r = parseBoard('columns:\n  - id: a\n');
    expect(r).toEqual({
      ok: true,
      config: { prefix: 'RB', activeWindowMinutes: 30, columns: [{ id: 'a' }] },
    });
  });

  it('keeps unknown keys on config and columns', () => {
    const r = parseBoard('theme: dark\ncolumns:\n  - id: a\n    color: red\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.theme).toBe('dark');
    expect(r.config.columns[0]?.color).toBe('red');
  });

  it('rejects empty columns, duplicate ids, bad wip, bad prefix, non-mapping, invalid YAML', () => {
    const cases: [string, RegExp][] = [
      ['columns: []', /at least one column/],
      ['columns:\n  - id: a\n  - id: a\n', /duplicate column id "a"/],
      ['columns:\n  - id: a\n    wip: 0\n', /columns\.0\.wip/],
      ['columns:\n  - id: a\n    wip: 1.5\n', /columns\.0\.wip/],
      ['prefix: 9x\n', /prefix/],
      ['prefix: "has space"\n', /prefix/],
      ['activeWindowMinutes: -1\n', /activeWindowMinutes/],
      ['columns:\n  - title: no id\n', /columns\.0\.id/],
      ['- a\n- b\n', /must be a YAML mapping/],
      ['columns: [\n', /not valid YAML/],
    ];
    for (const [text, re] of cases) {
      const r = parseBoard(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error, text).toMatch(re);
    }
  });
});

describe('serializeBoard', () => {
  it('the default serializes to exactly the §2 text', () => {
    expect(serializeBoard(defaultBoardConfig())).toBe(SPEC_BOARD);
  });

  it('round-trips with unknown keys and reorders known keys first', () => {
    const r = parseBoard('columns:\n  - color: red\n    id: a\ntheme: dark\nprefix: X\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(text).toBe(
      'prefix: X\nactiveWindowMinutes: 30\ncolumns:\n  - id: a\n    color: red\ntheme: dark\n',
    );
    expect(parseBoard(text)).toEqual(r);
  });
});

describe('findColumn', () => {
  it('finds by id or returns undefined', () => {
    expect(findColumn(defaultBoardConfig(), 'doing')?.wip).toBe(3);
    expect(findColumn(defaultBoardConfig(), 'nope')).toBeUndefined();
  });
});
