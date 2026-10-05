import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  boardDisplayName,
  boardIdentityEnv,
  boardShortName,
  defaultBoardConfig,
  findColumn,
  mergeSiblings,
  parseBoard,
  serializeBoard,
} from '../src/board.js';
import { DEFAULT_IDENTITY_ENV } from '../src/holder.js';

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
    const r = parseBoard('name: "  Acme  "\ncolumns:\n  - id: a\n');
    expect(r).toEqual({
      ok: true,
      config: {
        name: 'Acme',
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
      'siblings:\n  - name: acme\n    url: http://localhost:4243\ncolumns:\n  - id: a\n',
    );
    expect(r).toEqual({
      ok: true,
      config: {
        siblings: [{ name: 'acme', url: 'http://localhost:4243' }],
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
    const r = parseBoard('prefix: RB\nname: Acme\ncolumns:\n  - id: a\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(text.startsWith('name: Acme\nprefix: RB\n')).toBe(true);
    expect(parseBoard(text)).toEqual(r);
  });

  it('RCB-42: serializes `siblings` after `name`, before `prefix`, and round-trips', () => {
    const r = parseBoard(
      'prefix: RB\nname: Acme\nsiblings:\n  - name: acme\n' +
        '    url: http://localhost:4243\ncolumns:\n  - id: a\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(
      text.startsWith(
        'name: Acme\nsiblings:\n  - name: acme\n    url: http://localhost:4243\nprefix: RB\n',
      ),
    ).toBe(true);
    expect(parseBoard(text)).toEqual(r);
  });
});

describe('shortName and seats.identityEnv (RCB-195)', () => {
  const COLS = 'columns:\n  - id: a\n';

  it('an absent shortName and seats stay absent — the parsed config is exactly what it was', () => {
    const r = parseBoard(COLS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('shortName' in r.config).toBe(false);
    expect('seats' in r.config).toBe(false);
    expect(parseBoard('')).toEqual({ ok: true, config: defaultBoardConfig() });
  });

  it('accepts a shortName as written (letters, digits, `_` and `-`, not leading `-`/`_`)', () => {
    for (const name of ['acme', 'rcb-2', 'A_b', '9lives', 'x']) {
      const r = parseBoard(`shortName: ${name}\n${COLS}`);
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.config.shortName, name).toBe(name);
    }
  });

  it('refuses a shortName that could break a seat label', () => {
    for (const bad of [
      '',
      ' acme',
      'acme ',
      'has space',
      '-x',
      '_x',
      'a.b',
      'a*b',
      'a\u00b7b',
      'a:b',
    ]) {
      const r = parseBoard(`shortName: ${JSON.stringify(bad)}\n${COLS}`);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(bad)).toMatch(/shortName/);
    }
    const num = parseBoard(`shortName: 123\n${COLS}`);
    expect(num.ok).toBe(false);
  });

  it('boardShortName is the shortName when set, else the prefix lowercased', () => {
    expect(boardShortName(defaultBoardConfig())).toBe('rb');
    expect(boardShortName({ ...defaultBoardConfig(), prefix: 'RCB' })).toBe('rcb');
    expect(boardShortName({ ...defaultBoardConfig(), prefix: 'RCB', shortName: 'Acme' })).toBe(
      'Acme',
    );
  });

  it('accepts seats.identityEnv in the order written, and boardIdentityEnv returns it', () => {
    const r = parseBoard(`seats:\n  identityEnv:\n    - MY_PANE\n    - ITERM_SESSION_ID\n${COLS}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.seats).toEqual({ identityEnv: ['MY_PANE', 'ITERM_SESSION_ID'] });
    expect(boardIdentityEnv(r.config)).toEqual(['MY_PANE', 'ITERM_SESSION_ID']);
  });

  it('boardIdentityEnv is the default order when there is no override', () => {
    expect(boardIdentityEnv(defaultBoardConfig())).toEqual([...DEFAULT_IDENTITY_ENV]);
    const empty = parseBoard(`seats: {}\n${COLS}`);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(boardIdentityEnv(empty.config)).toEqual([...DEFAULT_IDENTITY_ENV]);
  });

  it('keeps unknown keys under seats (later RCB-194 slices add to it)', () => {
    const r = parseBoard(`seats:\n  identityEnv: [A]\n  future: 1\n${COLS}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.seats).toEqual({ identityEnv: ['A'], future: 1 });
  });

  it('refuses an identityEnv that is empty, not a list, or not env-var names', () => {
    const cases = [
      'seats:\n  identityEnv: []\n',
      'seats:\n  identityEnv: ITERM_SESSION_ID\n',
      'seats:\n  identityEnv: [""]\n',
      'seats:\n  identityEnv: ["BAD NAME"]\n',
      'seats:\n  identityEnv: ["A:B"]\n',
      'seats:\n  identityEnv: ["1ABC"]\n',
      'seats:\n  identityEnv: [1]\n',
      'seats: nope\n',
    ];
    for (const text of cases) {
      const r = parseBoard(text + COLS);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error, text).toMatch(/seats/);
    }
  });

  it('serializes `shortName` after `prefix` and `seats` before `columns`, and round-trips', () => {
    const r = parseBoard(
      `columns:\n  - id: a\nseats:\n  identityEnv:\n    - MY_PANE\nshortName: acme\nprefix: FP\n`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeBoard(r.config);
    expect(text).toBe(
      'prefix: FP\nshortName: acme\nactiveWindowMinutes: 30\nseats:\n  identityEnv:\n    - MY_PANE\n' +
        'columns:\n  - id: a\n',
    );
    expect(parseBoard(text)).toEqual(r);
  });

  it('the default config still serializes to exactly the §2 text', () => {
    expect(serializeBoard(defaultBoardConfig())).toBe(SPEC_BOARD);
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
    const config = { ...defaultBoardConfig(), name: '  Acme  ' };
    expect(boardDisplayName(config, '/repos/some-folder')).toBe('Acme');
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
    expect(mergeSiblings([], [{ name: 'acme', url: 'http://localhost:4243' }])).toEqual([
      { name: 'acme', url: 'http://localhost:4243' },
    ]);
  });

  it('a file-only sibling passes through untouched', () => {
    expect(mergeSiblings([{ name: 'acme', url: 'http://localhost:4243' }], [])).toEqual([
      { name: 'acme', url: 'http://localhost:4243' },
    ]);
  });

  it('the flag wins on a name collision, keeping the file entry\u2019s position', () => {
    const file = [
      { name: 'a', url: 'http://localhost:1' },
      { name: 'acme', url: 'http://localhost:4243' },
    ];
    const flags = [{ name: 'acme', url: 'http://localhost:9999' }];
    expect(mergeSiblings(file, flags)).toEqual([
      { name: 'a', url: 'http://localhost:1' },
      { name: 'acme', url: 'http://localhost:9999' },
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

describe('workspace: key (RCB-184)', () => {
  it("absent: no key in the config, none written back — today's board byte for byte", () => {
    const parsed = parseBoard('prefix: RB\n');
    expect(parsed.ok && parsed.config.workspace).toBeFalsy();
    expect(serializeBoard(defaultBoardConfig())).not.toContain('workspace');
  });

  it('parses, trims, and round-trips with the key kept', () => {
    const parsed = parseBoard('prefix: RB\nworkspace: " ../acme "\n');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.config.workspace).toBe('../acme');
    const text = serializeBoard(parsed.config);
    expect(text).toContain('workspace: ../acme\n');
    const again = parseBoard(text);
    expect(again.ok && again.config.workspace).toBe('../acme');
  });

  it('an empty value is an error naming the key', () => {
    const parsed = parseBoard('prefix: RB\nworkspace: ""\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^workspace: /);
  });
});
