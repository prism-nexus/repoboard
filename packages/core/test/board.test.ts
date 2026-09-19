import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  boardDisplayName,
  defaultBoardConfig,
  findColumn,
  mergeSiblings,
  parseBoard,
  serializeBoard,
} from '../src/board.js';

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

  it('RCB-41: accepts an explicit name, trimmed', () => {
    const r = parseBoard('name: "  Fresh Picked Jobs  "\ncolumns:\n  - id: a\n');
    expect(r).toEqual({
      ok: true,
      config: {
        name: 'Fresh Picked Jobs',
        prefix: 'RB',
        activeWindowMinutes: 30,
        columns: [{ id: 'a' }],
      },
    });
  });

  it('RCB-41: an absent name stays absent (not defaulted to the folder name in the schema)', () => {
    const r = parseBoard('columns:\n  - id: a\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('name' in r.config).toBe(false);
    expect(r.config.name).toBeUndefined();
  });

  it('RCB-41: rejects an empty or whitespace-only name', () => {
    for (const text of ['name: ""\ncolumns:\n  - id: a\n', 'name: "   "\ncolumns:\n  - id: a\n']) {
      const r = parseBoard(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error, text).toMatch(/name/);
    }
  });

  it('RCB-42: accepts a siblings list', () => {
    const r = parseBoard(
      'siblings:\n  - name: fpj\n    url: http://localhost:4243\ncolumns:\n  - id: a\n',
    );
    expect(r).toEqual({
      ok: true,
      config: {
        siblings: [{ name: 'fpj', url: 'http://localhost:4243' }],
        prefix: 'RB',
        activeWindowMinutes: 30,
        columns: [{ id: 'a' }],
      },
    });
  });

  it('RCB-42: an explicit empty siblings list is allowed (means none)', () => {
    const r = parseBoard('siblings: []\ncolumns:\n  - id: a\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.siblings).toEqual([]);
  });

  it('RCB-42: an absent siblings list stays absent', () => {
    const r = parseBoard('columns:\n  - id: a\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('siblings' in r.config).toBe(false);
  });

  it('RCB-42: rejects an empty sibling name', () => {
    const r = parseBoard(
      'siblings:\n  - name: ""\n    url: http://localhost:4243\ncolumns:\n  - id: a\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/siblings\.0\.name/);
  });

  it('RCB-42: rejects a javascript: sibling url', () => {
    const r = parseBoard(
      'siblings:\n  - name: evil\n    url: "javascript:alert(1)"\ncolumns:\n  - id: a\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/siblings\.0\.url/);
  });

  it('RCB-42: rejects a file: sibling url', () => {
    const r = parseBoard(
      'siblings:\n  - name: local\n    url: "file:///etc/passwd"\ncolumns:\n  - id: a\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/siblings\.0\.url/);
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

  it('RCB-41: serializes `name` first, before `prefix`, and round-trips', () => {
    const r = parseBoard('prefix: RB\nname: Fresh Picked Jobs\ncolumns:\n  - id: a\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(text.startsWith('name: Fresh Picked Jobs\nprefix: RB\n')).toBe(true);
    expect(parseBoard(text)).toEqual(r);
  });

  it('RCB-42: serializes `siblings` after `name`, before `prefix`, and round-trips', () => {
    const r = parseBoard(
      'prefix: RB\nname: Fresh Picked Jobs\nsiblings:\n  - name: fpj\n' +
        '    url: http://localhost:4243\ncolumns:\n  - id: a\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(
      text.startsWith(
        'name: Fresh Picked Jobs\nsiblings:\n  - name: fpj\n    url: http://localhost:4243\nprefix: RB\n',
      ),
    ).toBe(true);
    expect(parseBoard(text)).toEqual(r);
  });
});

describe('findColumn', () => {
  it('finds by id or returns undefined', () => {
    expect(findColumn(defaultBoardConfig(), 'doing')?.wip).toBe(3);
    expect(findColumn(defaultBoardConfig(), 'nope')).toBeUndefined();
  });
});

describe('boardDisplayName (RCB-41)', () => {
  it('uses the explicit trimmed name when set', () => {
    const config = { ...defaultBoardConfig(), name: '  Fresh Picked Jobs  ' };
    expect(boardDisplayName(config, '/repos/some-folder')).toBe('Fresh Picked Jobs');
  });

  it('falls back to the last path segment of root when config has no name', () => {
    expect(boardDisplayName(defaultBoardConfig(), '/repos/some-folder')).toBe('some-folder');
  });

  it('falls back to the folder name when config is null (before any snapshot)', () => {
    expect(boardDisplayName(null, '/repos/some-folder')).toBe('some-folder');
  });

  it('handles a trailing slash and Windows separators', () => {
    expect(boardDisplayName(null, '/repos/some-folder/')).toBe('some-folder');
    expect(boardDisplayName(null, 'C:\\repos\\some-folder')).toBe('some-folder');
    expect(boardDisplayName(null, 'C:\\repos\\some-folder\\')).toBe('some-folder');
  });
});

describe('mergeSiblings (RCB-42)', () => {
  it('no file siblings and no flags is empty', () => {
    expect(mergeSiblings([], [])).toEqual([]);
  });

  it('a flag-only sibling passes through untouched', () => {
    expect(mergeSiblings([], [{ name: 'fpj', url: 'http://localhost:4243' }])).toEqual([
      { name: 'fpj', url: 'http://localhost:4243' },
    ]);
  });

  it('a file-only sibling passes through untouched', () => {
    expect(mergeSiblings([{ name: 'fpj', url: 'http://localhost:4243' }], [])).toEqual([
      { name: 'fpj', url: 'http://localhost:4243' },
    ]);
  });

  it('the flag wins on a name collision, keeping the file entry\u2019s position', () => {
    const file = [
      { name: 'a', url: 'http://localhost:1' },
      { name: 'fpj', url: 'http://localhost:4243' },
    ];
    const flags = [{ name: 'fpj', url: 'http://localhost:9999' }];
    expect(mergeSiblings(file, flags)).toEqual([
      { name: 'a', url: 'http://localhost:1' },
      { name: 'fpj', url: 'http://localhost:9999' },
    ]);
  });

  it('orders file entries first, then new flag-only names in flag order', () => {
    const file = [
      { name: 'a', url: 'http://localhost:1' },
      { name: 'b', url: 'http://localhost:2' },
    ];
    const flags = [
      { name: 'c', url: 'http://localhost:3' },
      { name: 'b', url: 'http://localhost:22' },
    ];
    expect(mergeSiblings(file, flags)).toEqual([
      { name: 'a', url: 'http://localhost:1' },
      { name: 'b', url: 'http://localhost:22' },
      { name: 'c', url: 'http://localhost:3' },
    ]);
  });
});

// ---- RCB-56: the README §Config example must be the real default, not a stale one -----------
describe('README.md §Config example', () => {
  it('parses to a config whose columns deep-equal defaultBoardConfig().columns', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const readmePath = join(here, '../../..', 'README.md');
    const readme = await readFile(readmePath, 'utf8');
    const marker = '`.repoboard/board.yml` (plan §2; `init` writes this):';
    const markerIndex = readme.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const afterMarker = readme.slice(markerIndex + marker.length);
    const fenceMatch = /```yaml\n([\s\S]*?)```/.exec(afterMarker);
    expect(fenceMatch).not.toBeNull();
    const yamlText = fenceMatch?.[1] ?? '';
    // Sanity check this is really the fenced block, not an empty match.
    expect(yamlText).toContain('columns:');
    const result = parseBoard(yamlText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.columns).toEqual(defaultBoardConfig().columns);
  });
});
