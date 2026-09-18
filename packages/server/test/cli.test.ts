import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { defaultBoardConfig, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { findRoot, formatTable, run } from '../src/cli.js';
import { cardText, makeTempDir, makeTempRepoboard, makeTempRepoNoBoard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function repoboard(cwd: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    cwd,
    stdout,
    stderr,
    env: { REPOBOARD_ACTOR: 'test-actor' },
    now: () => NOW,
  });
  return { code, out: stdout.text, err: stderr.text };
}

async function freshRepo(cards: Record<string, string> = {}): Promise<string> {
  const repo = await makeTempRepoboard(cards);
  dirs.push(repo.root);
  return repo.root;
}

describe('repoboard init', () => {
  it('creates board.yml and RB-1 Welcome, and refuses to run twice', async () => {
    const root = await makeTempDir('repoboard-cli-');
    dirs.push(root);
    const first = await repoboard(root, 'init');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/initialised .* with RB-1 "Welcome"/);
    expect(await readFile(join(root, '.repoboard', 'board.yml'), 'utf8')).toContain('prefix: RB');
    const card = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(card).toContain('id: RB-1');
    expect(card).toContain('title: Welcome');
    expect(card).toContain('status: backlog');

    const second = await repoboard(root, 'init');
    expect(second.code).toBe(1);
    expect(second.err).toMatch(/already exists/);
    expect(await readdir(join(root, '.repoboard', 'cards'))).toEqual(['RB-1.md']);
  });
});

describe('repoboard card', () => {
  it('add allocates the next id and honours flags', async () => {
    const root = await freshRepo({ 'RB-3.md': cardText('RB-3', 'todo') });
    const res = await repoboard(
      root,
      'card',
      'add',
      'Do the thing',
      '--status',
      'doing',
      '--assignee',
      'claude/a',
      '--priority',
      'high',
      '--label',
      'web',
      '--label',
      'viz',
      '--as',
      'someone',
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe('created RB-4 (doing) Do the thing\n');
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-4.md'), 'utf8');
    expect(text).toContain('assignee: claude/a');
    expect(text).toContain('priority: high');
    expect(text).toMatch(/labels:\n\s+- web\n\s+- viz/);
    const log = await readFile(join(root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ type: 'create', actor: 'someone' });
  });

  it('add rejects a bad priority, a bad status, and a missing title with exit 1', async () => {
    const root = await freshRepo();
    expect((await repoboard(root, 'card', 'add', 'x', '--priority', 'urgent')).code).toBe(1);
    const badStatus = await repoboard(root, 'card', 'add', 'x', '--status', 'nowhere');
    expect(badStatus.code).toBe(1);
    expect(badStatus.err).toMatch(/unknown column "nowhere"/);
    expect((await repoboard(root, 'card', 'add')).code).toBe(1);
    expect((await repoboard(root, 'card', 'add', 'x', '--bogus')).code).toBe(1);
  });

  it('move writes the file, appends an event, and uses REPOBOARD_ACTOR by default', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await repoboard(root, 'card', 'move', 'RB-1', 'doing');
    expect(res.code).toBe(0);
    expect(res.out).toBe('moved RB-1 todo → doing\n');
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('test-actor — moved todo → doing');
    const log = await readFile(join(root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      actor: 'test-actor',
      from: 'todo',
      to: 'doing',
    });

    expect((await repoboard(root, 'card', 'move', 'RB-1', 'nope')).code).toBe(1);
    expect((await repoboard(root, 'card', 'move', 'RB-9', 'done')).code).toBe(1);
    expect((await repoboard(root, 'card', 'move', 'RB-1')).code).toBe(1);
  });

  it('list prints a table (filterable) and --json for agents', async () => {
    const root = await freshRepo({
      'RB-1.md': cardText('RB-1', 'todo', { title: 'First', assignee: 'a' }),
      'RB-2.md': cardText('RB-2', 'done', { title: 'Second' }),
      'RB-10.md': cardText('RB-10', 'todo', { title: 'Tenth' }),
    });
    const all = await repoboard(root, 'card', 'list');
    expect(all.code).toBe(0);
    expect(all.out.split('\n')).toEqual([
      'ID     STATUS  ASSIGNEE  TITLE',
      'RB-1   todo    a         First',
      'RB-2   done    -         Second',
      'RB-10  todo    -         Tenth',
      '',
    ]);
    const todo = await repoboard(root, 'card', 'list', '--status', 'todo');
    expect(todo.out).not.toContain('Second');
    const asJson = await repoboard(root, 'card', 'list', '--json');
    const parsed = JSON.parse(asJson.out) as Record<string, unknown>[];
    expect(parsed.map((c) => c.id)).toEqual(['RB-1', 'RB-2', 'RB-10']);
  });

  it('list --json is compact (no body) unless --full; --full needs --json (K6)', async () => {
    const root = await freshRepo({
      'RB-1.md': cardText('RB-1', 'todo', { title: 'First', assignee: 'a', body: '\nSecret.\n' }),
      'RB-2.md': cardText('RB-2', 'done', { title: 'Second' }),
    });
    const compact = await repoboard(root, 'card', 'list', '--json');
    expect(compact.code).toBe(0);
    const rows = JSON.parse(compact.out) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([
        'id',
        'title',
        'status',
        'assignee',
        'priority',
        'labels',
        'files',
        'updated',
      ]);
      expect(row).not.toHaveProperty('body');
    }
    expect(rows[0]).toEqual({
      id: 'RB-1',
      title: 'First',
      status: 'todo',
      assignee: 'a',
      priority: null,
      labels: [],
      files: [],
      updated: '2026-09-02T22:00:00Z',
    });
    expect(compact.out).not.toContain('Secret');
    // One row per line inside the array: line 2 is exactly the first row.
    expect(compact.out.split('\n')[1]).toBe(`${JSON.stringify(rows[0])},`);

    const full = await repoboard(root, 'card', 'list', '--json', '--full');
    expect(full.code).toBe(0);
    const cards = JSON.parse(full.out) as { id: string; body: string }[];
    expect(cards.map((c) => c.id)).toEqual(['RB-1', 'RB-2']);
    expect(cards[0]?.body).toContain('Secret.');

    const bare = await repoboard(root, 'card', 'list', '--full');
    expect(bare.code).toBe(1);
    expect(bare.err).toMatch(/--full only applies with --json/);
  });

  it('list reports invalid files on stderr without failing', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo'), 'RB-2.md': 'bad' });
    const res = await repoboard(root, 'card', 'list');
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/invalid: .*RB-2\.md/);
  });

  it('show prints the file verbatim', async () => {
    const text = cardText('RB-1', 'todo', { body: '\nHello body.\n' });
    const root = await freshRepo({ 'RB-1.md': text });
    const res = await repoboard(root, 'card', 'show', 'RB-1');
    expect(res.code).toBe(0);
    expect(res.out).toBe(text);
    expect((await repoboard(root, 'card', 'show', 'RB-7')).code).toBe(1);
  });

  it('finds .repoboard from a subdirectory', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const sub = join(root, 'deep', 'er');
    await import('node:fs/promises').then((fs) => fs.mkdir(sub, { recursive: true }));
    const res = await repoboard(sub, 'card', 'list', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toHaveLength(1);
  });

  it('fails with exit 1 and one line when there is no .repoboard', async () => {
    const root = await makeTempDir('repoboard-none-');
    dirs.push(root);
    const res = await repoboard(root, 'card', 'list');
    expect(res.code).toBe(1);
    expect(res.err.trim().split('\n')).toHaveLength(1);
    expect(res.err).toMatch(/no \.repoboard directory found/);
  });
});

describe('repoboard help and errors', () => {
  it('--help exits 0, no args exits 1 with help, unknown command exits 1', async () => {
    const root = await freshRepo();
    const help = await repoboard(root, '--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('repoboard card move');
    expect((await repoboard(root)).code).toBe(1);
    const unknown = await repoboard(root, 'frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown command "frobnicate"/);
    expect((await repoboard(root, 'card', 'nope')).code).toBe(1);
    expect((await repoboard(root, '--version')).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe('repoboard serve', () => {
  it('starts on the given port, prints the URL, serves /api/board, stops on abort', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const stdout = new Sink();
    const ac = new AbortController();
    let url = '';
    const opened: string[] = [];
    const running = run(['serve', '--port', '0', '--no-fun', '--open'], {
      cwd: root,
      stdout,
      signal: ac.signal,
      now: () => NOW,
      openUrl: (u) => opened.push(u),
      onServe: (s) => {
        url = s.url;
      },
    });
    // Wait until the server has been handed to us.
    for (let i = 0; i < 100 && !url; i++) await new Promise((r) => setTimeout(r, 20));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(stdout.text).toContain(url);
    expect(opened).toEqual([url]);
    const board = (await (await fetch(`${url}api/board`)).json()) as {
      config: { fun: boolean };
      cards: { id: string }[];
    };
    expect(board.config.fun).toBe(false);
    expect(board.cards[0]?.id).toBe('RB-1');

    // An external edit while serving is reflected on the next GET.
    const path = join(root, '.repoboard', 'cards', 'RB-1.md');
    await writeFile(path, cardText('RB-1', 'done'));
    let status = '';
    for (let i = 0; i < 50 && status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const b = (await (await fetch(`${url}api/board`)).json()) as { cards: { status: string }[] };
      status = b.cards[0]?.status ?? '';
    }
    expect(status).toBe('done');

    ac.abort();
    expect(await running).toBe(0);
    await expect(fetch(`${url}api/board`)).rejects.toThrow();
  });

  it('rejects a bad port with exit 1', async () => {
    const root = await freshRepo();
    const res = await repoboard(root, 'serve', '--port', 'abc');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--port/);
  });
});

// ---- P7.1 / P7.2: serve --root, and map-only for a repo with no board -------------------------
//
// Every fixture below is a directory this file created under os.tmpdir() and removes again. No
// test here points at a path outside its own fixture, this repo included (CLAUDE.md §1).

interface Serving {
  url: string;
  out: Sink;
  /** Abort the server and return `run`'s exit code. */
  stop(): Promise<number>;
}

/** Start `repoboard serve --port 0 <argv>` from `cwd` and wait until it is listening. */
async function serve(cwd: string, ...argv: string[]): Promise<Serving> {
  const stdout = new Sink();
  const stderr = new Sink();
  const ac = new AbortController();
  const state = { url: '', exited: null as number | null };
  const running = run(['serve', '--port', '0', '--no-fun', ...argv], {
    cwd,
    stdout,
    stderr,
    signal: ac.signal,
    now: () => NOW,
    onServe: (s) => {
      state.url = s.url;
    },
  });
  void running.then((code) => {
    state.exited = code;
  });
  for (let i = 0; i < 250 && !state.url && state.exited === null; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!state.url) {
    throw new Error(`serve never listened (exit ${state.exited}): ${stderr.text}${stdout.text}`);
  }
  return {
    url: state.url,
    out: stdout,
    stop: () => {
      ac.abort();
      return running;
    },
  };
}

interface BoardBody {
  cards: { id: string }[];
  hasBoard: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

describe('repoboard serve --root (P7.1)', () => {
  it('serves the directory given, not the cwd, and resolves a relative path against the cwd', async () => {
    const cwdRepo = await freshRepo({ 'CWD-1.md': cardText('CWD-1', 'todo') });
    const fixture = await makeTempRepoboard({ 'FIX-1.md': cardText('FIX-1', 'doing') });
    dirs.push(fixture.root);

    const abs = await serve(cwdRepo, '--root', fixture.root);
    try {
      const board = await getJson<BoardBody>(`${abs.url}api/board`);
      expect(board.cards.map((c) => c.id)).toEqual(['FIX-1']);
      expect(abs.out.text).toContain(`repoboard: serving ${fixture.root}`);
    } finally {
      expect(await abs.stop()).toBe(0);
    }

    // Relative --root: same fixture, addressed as `<basename>` from its parent.
    const rel = await serve(dirname(fixture.root), '--root', basename(fixture.root));
    try {
      const board = await getJson<BoardBody>(`${rel.url}api/board`);
      expect(board.cards.map((c) => c.id)).toEqual(['FIX-1']);
    } finally {
      expect(await rel.stop()).toBe(0);
    }
  });

  it('never searches upward from --root: a subdirectory of a board repo is map-only', async () => {
    const parent = await freshRepo({ 'PARENT-1.md': cardText('PARENT-1', 'todo') });
    const child = join(parent, 'sub', 'deeper');
    await mkdir(child, { recursive: true });
    await writeFile(join(child, 'a.ts'), 'export const a = 1;\n');

    // Sanity: the cwd path DOES climb, so the two behaviours are genuinely different.
    expect(await findRoot(child)).toBe(parent);

    const s = await serve(parent, '--root', child);
    try {
      const board = await getJson<BoardBody>(`${s.url}api/board`);
      expect(board.hasBoard).toBe(false);
      expect(board.cards).toEqual([]);
      expect(s.out.text).toContain('map-only');
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });

  it('rejects a --root that is not a directory with exit 1', async () => {
    const root = await makeTempDir('repoboard-cli-');
    dirs.push(root);
    await writeFile(join(root, 'afile'), 'x');
    const res = await repoboard(root, 'serve', '--root', join(root, 'afile'));
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/is not a directory/);
  });

  it('without --root the missing-board error names --root as the way in', async () => {
    const root = await makeTempDir('repoboard-cli-');
    dirs.push(root);
    const res = await repoboard(root, 'serve');
    expect(res.code).toBe(1);
    expect(res.err).toContain('no .repoboard directory found');
    expect(res.err).toContain('repoboard serve --root <dir>');
  });
});

interface SiblingBoardBody {
  siblings: { name: string; url: string }[];
  hasBoard: boolean;
}

describe('repoboard serve --sibling (RCB-42)', () => {
  it('rejects a --sibling with no "=", naming the flag', async () => {
    const root = await freshRepo();
    const res = await repoboard(root, 'serve', '--sibling', 'nourl');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--sibling/);
  });

  it('rejects a --sibling whose url is not http(s), naming the flag', async () => {
    const root = await freshRepo();
    const res = await repoboard(root, 'serve', '--sibling', 'evil=javascript:alert(1)');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--sibling/);
  });

  it('parses repeatable --sibling flags and carries them on /api/board with no board.yml siblings', async () => {
    const root = await freshRepo();
    const s = await serve(
      root,
      '--sibling',
      'fpj=http://localhost:4243',
      '--sibling',
      'other=http://localhost:5000',
    );
    try {
      const board = await getJson<SiblingBoardBody>(`${s.url}api/board`);
      expect(board.siblings).toEqual([
        { name: 'fpj', url: 'http://localhost:4243' },
        { name: 'other', url: 'http://localhost:5000' },
      ]);
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });

  it('merges board.yml siblings with --sibling flags; the flag wins on a name collision', async () => {
    const fixture = await makeTempRepoboard();
    dirs.push(fixture.root);
    await writeFile(
      join(fixture.root, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        siblings: [
          { name: 'fpj', url: 'http://localhost:4243' },
          { name: 'stable', url: 'http://localhost:4244' },
        ],
      }),
    );
    const s = await serve(
      fixture.root,
      '--sibling',
      'fpj=http://localhost:9999',
      '--sibling',
      'newcomer=http://localhost:5001',
    );
    try {
      const board = await getJson<SiblingBoardBody>(`${s.url}api/board`);
      // Collision (fpj): the flag wins. Order: file order (fpj, stable) then the new flag name.
      expect(board.siblings).toEqual([
        { name: 'fpj', url: 'http://localhost:9999' },
        { name: 'stable', url: 'http://localhost:4244' },
        { name: 'newcomer', url: 'http://localhost:5001' },
      ]);
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });

  it('map-only root: a --sibling flag still carries, with an empty board.yml side', async () => {
    const fixture = await makeTempRepoNoBoard({ 'a.ts': 'export const a = 1;\n' });
    dirs.push(fixture.root);
    const s = await serve(
      fixture.root,
      '--root',
      fixture.root,
      '--sibling',
      'fpj=http://localhost:4243',
    );
    try {
      const board = await getJson<SiblingBoardBody>(`${s.url}api/board`);
      expect(board.hasBoard).toBe(false);
      expect(board.siblings).toEqual([{ name: 'fpj', url: 'http://localhost:4243' }]);
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });
});

describe('map-only mode is read-only in the target repo (P7.2)', () => {
  it('scans a boardless repo, reports hasBoard:false, and writes nothing into it', async () => {
    const fixture = await makeTempRepoNoBoard({
      'src/index.ts': "import { helper } from './helper.js';\nexport const main = helper;\n",
      'src/helper.ts': 'export const helper = 42;\n',
      'README.md': '# fixture\n',
    });
    dirs.push(fixture.root);
    await git(fixture.root, 'init', '-q');
    await git(fixture.root, 'add', '-A');
    await git(
      fixture.root,
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'user.name=repoboard test',
      'commit',
      '-q',
      '-m',
      'fixture',
    );
    expect(await git(fixture.root, 'status', '--porcelain')).toBe('');
    expect(await fixture.hasRepoboard()).toBe(false);

    const s = await serve(fixture.root, '--root', fixture.root);
    try {
      const board = await getJson<BoardBody>(`${s.url}api/board`);
      expect(board.hasBoard).toBe(false);
      expect(board.cards).toEqual([]);
      const repo = await getJson<{ root: string; files: unknown[] }>(`${s.url}api/repo`);
      expect(repo.files.length).toBeGreaterThan(0);
    } finally {
      expect(await s.stop()).toBe(0);
    }

    // The whole point: a full start / scan / stop cycle left the target untouched.
    expect(await git(fixture.root, 'status', '--porcelain')).toBe('');
    expect(await fixture.hasRepoboard()).toBe(false);
  });

  it('`repoboard init` is the escape hatch and is untouched by the K10 guard', async () => {
    const fixture = await makeTempRepoNoBoard({ 'a.ts': 'export const a = 1;\n' });
    dirs.push(fixture.root);

    // Serving it refuses to create anything (K10)...
    const before = await serve(fixture.root, '--root', fixture.root);
    try {
      const res = await fetch(`${before.url}api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'hole' }),
      });
      expect(res.status).toBe(409);
    } finally {
      expect(await before.stop()).toBe(0);
    }
    expect(await fixture.hasRepoboard()).toBe(false);

    // ...but the user running `repoboard init` themselves still works. cmdInit writes with
    // mkdir/writeFile and never opens the store, so a store-level guard cannot reach it.
    const init = await repoboard(fixture.root, 'init');
    expect(init.code).toBe(0);
    expect(await fixture.hasRepoboard()).toBe(true);

    // And after the restart the brief's copy promises, mutations work normally.
    const after = await serve(fixture.root);
    try {
      const board = await getJson<BoardBody>(`${after.url}api/board`);
      expect(board.hasBoard).toBe(true);
      const res = await fetch(`${after.url}api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'now allowed' }),
      });
      expect(res.status).toBe(201);
    } finally {
      expect(await after.stop()).toBe(0);
    }
  });

  it('an empty but initialised .repoboard/ is hasBoard:true with zero cards', async () => {
    const fixture = await makeTempRepoNoBoard({ 'a.ts': 'export const a = 1;\n' });
    dirs.push(fixture.root);
    await mkdir(join(fixture.root, '.repoboard'), { recursive: true });

    const s = await serve(fixture.root);
    try {
      const board = await getJson<BoardBody>(`${s.url}api/board`);
      expect(board.hasBoard).toBe(true);
      expect(board.cards).toEqual([]);
      expect(s.out.text).not.toContain('map-only');
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });
});

// ---- K9: `card update <id>` (plan §11 O8) -----------------------------------------------------
//
// The CLI is the third surface onto core's `updateCard`; these assert it means the same thing MCP
// `update_card` and `PATCH /api/cards/:id` mean, not something CLI-shaped.

describe('repoboard card update (K9)', () => {
  it('sets assignee on a card that has none — K9’s actual complaint', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const before = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(before).not.toContain('assignee:');

    const res = await repoboard(root, 'card', 'update', 'RB-1', '--assignee', 'claude/cli-agent');
    expect(res.code).toBe(0);
    expect(res.out).toBe('updated RB-1 assignee\n');
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(text).toContain('assignee: claude/cli-agent');
    expect(text).toContain('test-actor — updated assignee');
    const log = await readFile(join(root, '.repoboard', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      type: 'update',
      cardId: 'RB-1',
      actor: 'test-actor',
      from: 'todo',
      to: 'todo',
    });
  });

  it('sets every field it offers, and names them in the log line’s order', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await repoboard(
      root,
      'card',
      'update',
      'RB-1',
      '--title',
      'Renamed',
      '--assignee',
      'claude/a',
      '--priority',
      'high',
      '--label',
      'web',
      '--file',
      'src/a.ts',
      '--ref',
      'README.md#Known issues',
      '--as',
      'someone',
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe('updated RB-1 title, assignee, priority, labels, files, refs\n');
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(text).toContain('title: Renamed');
    expect(text).toContain('assignee: claude/a');
    expect(text).toContain('priority: high');
    expect(text).toContain('labels:\n  - web\n');
    expect(text).toContain('files:\n  - src/a.ts\n');
    expect(text).toContain('refs:\n  - README.md#Known issues\n');
    // The printed field list is the same list, in the same order, as core's `## Log` line.
    expect(text).toContain('someone — updated title, assignee, priority, labels, files, refs');
  });

  it('--clear removes each of the five optional fields', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const filled = await repoboard(
      root,
      'card',
      'update',
      'RB-1',
      '--assignee',
      'a',
      '--priority',
      'low',
      '--label',
      'x',
      '--file',
      'f.ts',
      '--ref',
      'f.ts',
    );
    expect(filled.code).toBe(0);
    const cleared = await repoboard(
      root,
      'card',
      'update',
      'RB-1',
      '--clear',
      'assignee',
      '--clear',
      'priority',
      '--clear',
      'labels',
      '--clear',
      'files',
      '--clear',
      'refs',
    );
    expect(cleared.code).toBe(0);
    // State first, report second: a `--clear` that quietly did nothing must fail here, on the
    // value still being in the file, not merely on the summary line.
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    for (const field of ['assignee:', 'priority:', 'labels:', 'files:', 'refs:']) {
      expect(text).not.toContain(field);
    }
    expect(text).toContain('id: RB-1');
    expect(cleared.out).toBe('updated RB-1 assignee, priority, labels, files, refs\n');
  });

  it('a repeatable flag REPLACES the list rather than appending to it', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    expect(
      (await repoboard(root, 'card', 'update', 'RB-1', '--label', 'old', '--label', 'stale')).code,
    ).toBe(0);
    const seeded = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(seeded).toContain('labels:\n  - old\n  - stale\n');

    const res = await repoboard(root, 'card', 'update', 'RB-1', '--label', 'a', '--label', 'b');
    expect(res.code).toBe(0);
    const text = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(text).toContain('labels:\n  - a\n  - b\n');
    expect(text).not.toContain('- old');
    expect(text).not.toContain('- stale');
  });

  it('refuses --status with a pointer to card move, and leaves the card untouched', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const before = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    // The case that matters first: with a real field alongside it, an unguarded `--status` is
    // silently dropped and the rest of the update succeeds — the CLI never puts `status` into the
    // patch, so core's own refusal (transitions.ts:147) is never reached from here. The whole
    // command must be refused, and the card must be byte-identical afterwards.
    const withField = await repoboard(
      root,
      'card',
      'update',
      'RB-1',
      '--status',
      'doing',
      '--assignee',
      'a',
    );
    expect(await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8')).toBe(before);
    expect(withField.code).toBe(1);
    expect(withField.err).toContain('card update cannot change status');
    expect(withField.err).toContain('repoboard card move');

    const res = await repoboard(root, 'card', 'update', 'RB-1', '--status', 'doing');
    expect(res.code).toBe(1);
    expect(res.err).toContain('card update cannot change status');
    expect(res.err).toContain('repoboard card move');
    expect(await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8')).toBe(before);
  });

  it('refuses an empty patch, an unknown card, a bad priority and a bad --clear field', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const bare = await repoboard(root, 'card', 'update', 'RB-1');
    expect(bare.code).toBe(1);
    expect(bare.err).toMatch(/needs at least one of/);

    expect((await repoboard(root, 'card', 'update')).code).toBe(1);
    const unknown = await repoboard(root, 'card', 'update', 'RB-9', '--assignee', 'a');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown card "RB-9"/);
    expect((await repoboard(root, 'card', 'update', 'RB-1', '--priority', 'urgent')).code).toBe(1);

    const badClear = await repoboard(root, 'card', 'update', 'RB-1', '--clear', 'title');
    expect(badClear.code).toBe(1);
    expect(badClear.err).toMatch(
      /--clear must name one of assignee, priority, labels, files, refs/,
    );
    expect(badClear.err).toMatch(/cannot be cleared/);

    const both = await repoboard(
      root,
      'card',
      'update',
      'RB-1',
      '--assignee',
      'a',
      '--clear',
      'assignee',
    );
    expect(both.code).toBe(1);
    expect(both.err).toMatch(/contradicts/);

    // Every refusal above left the card exactly as it was.
    expect(await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8')).toBe(
      cardText('RB-1', 'todo'),
    );
  });

  it('appears in --help and in the unknown-subcommand list', async () => {
    const root = await freshRepo();
    const help = await repoboard(root, '--help');
    expect(help.out).toContain('repoboard card update <id>');
    expect(help.out).toMatch(/REPLACES/);
    const unknown = await repoboard(root, 'card', 'nope');
    expect(unknown.err).toContain('add, move, update, list, show');
  });

  it('appends exactly one events.jsonl line while `serve` is watching the same repo (K8)', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const eventsPath = join(root, '.repoboard', 'events.jsonl');
    await writeFile(eventsPath, '');
    const s = await serve(root);
    try {
      const countLines = async (): Promise<number> =>
        (await readFile(eventsPath, 'utf8')).split('\n').filter((l) => l.trim()).length;
      const before = await countLines();
      expect(before).toBe(0);

      const res = await repoboard(root, 'card', 'update', 'RB-1', '--assignee', 'claude/x');
      expect(res.code).toBe(0);
      // Give the watcher every chance to add a spurious `actor: "file"` line before counting.
      await new Promise((r) => setTimeout(r, 1500));
      const after = await countLines();
      expect(after - before).toBe(1);
      const [line] = (await readFile(eventsPath, 'utf8')).trim().split('\n');
      expect(JSON.parse(line ?? '{}')).toMatchObject({
        type: 'update',
        cardId: 'RB-1',
        actor: 'test-actor',
      });
    } finally {
      expect(await s.stop()).toBe(0);
    }
  });
});

describe('formatTable', () => {
  it('renders an empty board as just the header', () => {
    expect(formatTable([])).toBe('ID  STATUS  ASSIGNEE  TITLE');
  });
});

describe('repoboard card show --resolve and card add --ref (K7)', () => {
  it('prints the card file, then each ref as a fenced block headed path:start-end', async () => {
    const root = await freshRepo({
      'RB-1.md': cardText('RB-1', 'todo').replace(
        'status: todo\n',
        'status: todo\nrefs:\n  - docs/plan.md#§5 Phases\n  - docs/nope.md\n',
      ),
    });
    await mkdir(join(root, 'docs'));
    await writeFile(
      join(root, 'docs', 'plan.md'),
      '# Plan\n\n## §5 Phases\n- **P6.1** README.\n\n## §6\n',
    );
    const plain = await repoboard(root, 'card', 'show', 'RB-1');
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain('```');
    const r = await repoboard(root, 'card', 'show', 'RB-1', '--resolve');
    expect(r.code).toBe(0);
    expect(r.out.startsWith('---\nid: RB-1\n')).toBe(true);
    expect(r.out).toContain(
      '\ndocs/plan.md:3-5\n```\n## §5 Phases\n- **P6.1** README.\n\n```\n\ndocs/nope.md — unresolved: not found: docs/nope.md\n',
    );
    const none = await repoboard(root, 'card', 'show', 'RB-1', '--resolve');
    expect(none.out).not.toContain('(no refs)');
  });

  it('add --ref writes refs: and show --resolve on a card without refs says so', async () => {
    const root = await freshRepo();
    const added = await repoboard(
      root,
      'card',
      'add',
      'Pointed',
      '--ref',
      'README.md:L1',
      '--ref',
      'docs/x.md#Y',
    );
    expect(added.code).toBe(0);
    const file = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(file).toContain('refs:\n  - README.md:L1\n  - docs/x.md#Y\n');
    const bare = await repoboard(root, 'card', 'add', 'Plain');
    expect(bare.code).toBe(0);
    const shown = await repoboard(root, 'card', 'show', 'RB-2', '--resolve');
    expect(shown.out.endsWith('\n(no refs)\n')).toBe(true);
  });
});

describe('repoboard card ask / decide (P8.1)', () => {
  it('ask moves the card into the default board’s decide column and prints the count', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await repoboard(
      root,
      'card',
      'ask',
      'RB-1',
      'Ship it?',
      '--option',
      'A ship now',
      '--option',
      'B wait',
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe('asked RB-1: Ship it? (2 options)\n');
    const file = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(file).toContain('status: decide');
    expect(file).toContain('returnTo: todo');
    expect(file).toContain('moved todo → decide');
    expect(file).toContain('asked: Ship it? [A|B]');
  });

  it('a bad --option is refused with the "<LETTER> <text>" shape named', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await repoboard(root, 'card', 'ask', 'RB-1', 'q?', '--option', 'no-space');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--option must be "<LETTER> <text>"/);
  });

  it('asking twice without --replace is refused; --replace withdraws and re-asks', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    await repoboard(root, 'card', 'ask', 'RB-1', 'First?');
    const refused = await repoboard(root, 'card', 'ask', 'RB-1', 'Second?');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/already has an open decision: "First\?"/);
    const replaced = await repoboard(root, 'card', 'ask', 'RB-1', 'Second?', '--replace');
    expect(replaced.code).toBe(0);
    const file = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(file).toContain('question withdrawn');
    expect(file).toContain('question: Second?');
  });

  it('decide with a letter moves the card back and prints "decided <id> <letter>"', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'doing') });
    await repoboard(root, 'card', 'ask', 'RB-1', 'Ship?', '--option', 'A yes', '--option', 'B no');
    const res = await repoboard(root, 'card', 'decide', 'RB-1', 'A');
    expect(res.code).toBe(0);
    expect(res.out).toBe('decided RB-1 A\n');
    const file = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    expect(file).toContain('status: doing');
    expect(file).toContain('chosen: A');
    expect(file).toContain('moved decide → doing');
  });

  it('decide with --words only prints "decided <id> — \\"<words>\\""', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    await repoboard(root, 'card', 'ask', 'RB-1', 'Free text?');
    const res = await repoboard(root, 'card', 'decide', 'RB-1', '--words', 'go ahead');
    expect(res.code).toBe(0);
    expect(res.out).toBe('decided RB-1 — "go ahead"\n');
  });

  it('decide refuses an unknown letter, naming the valid ones, and refuses when nothing is open', async () => {
    const root = await freshRepo({ 'RB-1.md': cardText('RB-1', 'todo') });
    const nothingOpen = await repoboard(root, 'card', 'decide', 'RB-1', 'A');
    expect(nothingOpen.code).toBe(1);
    expect(nothingOpen.err).toMatch(/no decision is open on RB-1/);
    await repoboard(root, 'card', 'ask', 'RB-1', 'q?', '--option', 'A yes', '--option', 'B no');
    const bad = await repoboard(root, 'card', 'decide', 'RB-1', 'Z');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/unknown option "Z" \(valid: A, B\)/);
  });

  it('card list --needs-decision filters to open decisions and the table gains a DECISION column', async () => {
    const root = await freshRepo({
      'RB-1.md': cardText('RB-1', 'todo', { title: 'Has a question' }),
      'RB-2.md': cardText('RB-2', 'todo', { title: 'Plain' }),
    });
    await repoboard(root, 'card', 'ask', 'RB-1', 'q?');
    const filtered = await repoboard(root, 'card', 'list', '--needs-decision');
    expect(filtered.code).toBe(0);
    expect(filtered.out.split('\n')).toEqual([
      'ID    STATUS  ASSIGNEE  DECISION  TITLE',
      'RB-1  decide  -         ?         Has a question',
      '',
    ]);
    const all = await repoboard(root, 'card', 'list');
    expect(all.out.split('\n')).toEqual([
      'ID    STATUS  ASSIGNEE  DECISION  TITLE',
      'RB-1  decide  -         ?         Has a question',
      'RB-2  todo    -                   Plain',
      '',
    ]);
  });
});

describe('repoboard lease / window (P8.2)', () => {
  it('lease take writes leases.yml and prints "took <resource> as <holder> until <until|—>"', async () => {
    const root = await freshRepo({});
    const noUntil = await repoboard(root, 'lease', 'take', 'vitest-lock');
    expect(noUntil.code).toBe(0);
    expect(noUntil.out).toBe('took vitest-lock as test-actor until —\n');
    const withUntil = await repoboard(root, 'lease', 'take', 'r2', '--until', '+90m');
    expect(withUntil.code).toBe(0);
    expect(withUntil.out).toBe('took r2 as test-actor until 2026-09-03T00:11:10Z\n');
    const text = await readFile(join(root, '.repoboard', 'leases.yml'), 'utf8');
    expect(text).toContain('resource: vitest-lock');
    expect(text).toContain('resource: r2');
    expect(text).toContain('until: 2026-09-03T00:11:10Z');
  });

  it('a conflicting take is refused (exit 1); --force overrides with a warning', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'lease', 'take', 'r', '--as', 'claude/ops');
    const conflict = await repoboard(root, 'lease', 'take', 'r', '--as', 'claude/fix');
    expect(conflict.code).toBe(1);
    expect(conflict.err).toMatch(/is held by claude\/ops/);
    const forced = await repoboard(root, 'lease', 'take', 'r', '--as', 'claude/fix', '--force');
    expect(forced.code).toBe(0);
    expect(forced.err).toMatch(/warning: forced: took "r" from claude\/ops/);
  });

  it('lease release frees it; a non-holder is refused', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'lease', 'take', 'r', '--as', 'claude/ops');
    const badRelease = await repoboard(root, 'lease', 'release', 'r', '--as', 'claude/fix');
    expect(badRelease.code).toBe(1);
    expect(badRelease.err).toMatch(/is held by claude\/ops/);
    const release = await repoboard(root, 'lease', 'release', 'r', '--as', 'claude/ops');
    expect(release.code).toBe(0);
    expect(release.out).toBe('released r\n');
  });

  it('lease list: table has RESOURCE HOLDER SINCE UNTIL STATE NOTE, --json matches', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'lease', 'take', 'a', '--as', 'claude/ops', '--note', 'cold4 gate');
    await repoboard(
      root,
      'lease',
      'take',
      'b',
      '--as',
      'claude/ops',
      '--until',
      '2026-09-01T00:00:00Z',
    );
    const table = await repoboard(root, 'lease', 'list');
    expect(table.out.split('\n')).toEqual([
      'RESOURCE  HOLDER      SINCE                 UNTIL                 STATE  NOTE',
      'a         claude/ops  2026-09-02T22:41:10Z  —                     live   cold4 gate',
      'b         claude/ops  2026-09-02T22:41:10Z  2026-09-01T00:00:00Z  stale  -',
      '',
    ]);
    const json = await repoboard(root, 'lease', 'list', '--json');
    expect(JSON.parse(json.out)).toEqual([
      {
        resource: 'a',
        holder: 'claude/ops',
        since: '2026-09-02T22:41:10Z',
        until: null,
        state: 'live',
        note: 'cold4 gate',
      },
      {
        resource: 'b',
        holder: 'claude/ops',
        since: '2026-09-02T22:41:10Z',
        until: '2026-09-01T00:00:00Z',
        state: 'stale',
        note: null,
      },
    ]);
  });

  it('window add accepts ISO and relative times, list shows it, --json matches', async () => {
    const root = await freshRepo({});
    const added = await repoboard(
      root,
      'window',
      'add',
      'vitest-lock',
      '2026-09-02T22:50:00Z',
      '+90m',
      'cold4',
      'gate',
    );
    expect(added.code).toBe(0);
    expect(added.out).toBe(
      'added window cold4 gate 2026-09-02T22:50:00Z–2026-09-03T00:11:10Z vitest-lock\n',
    );
    const table = await repoboard(root, 'window', 'list');
    expect(table.out.split('\n')).toEqual([
      'RESOURCE     START                 END                   NAME',
      'vitest-lock  2026-09-02T22:50:00Z  2026-09-03T00:11:10Z  cold4 gate',
      '',
    ]);
    const json = await repoboard(root, 'window', 'list', '--json');
    expect(JSON.parse(json.out)).toEqual([
      {
        resource: 'vitest-lock',
        start: '2026-09-02T22:50:00Z',
        end: '2026-09-03T00:11:10Z',
        name: 'cold4 gate',
      },
    ]);
  });

  it('window add: end before start is refused', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'window', 'add', 'r', '+90m', '+1m', 'backwards');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/end must be after start/);
  });

  describe('window check: the shell-callable exit-code contract (C1)', () => {
    it('exit 0 "clear <resource>" when nothing blocks it', async () => {
      const root = await freshRepo({});
      const res = await repoboard(root, 'window', 'check', 'vitest-lock');
      expect(res.code).toBe(0);
      expect(res.out).toBe('clear vitest-lock\n');
    });

    it('exit 1, naming the window, when inside one', async () => {
      const root = await freshRepo({});
      await repoboard(
        root,
        'window',
        'add',
        'vitest-lock',
        '2026-09-02T22:00:00Z',
        '2026-09-02T23:00:00Z',
        'cold4',
        'gate',
      );
      const res = await repoboard(root, 'window', 'check', 'vitest-lock');
      expect(res.code).toBe(1);
      expect(res.out).toBe(
        'inside cold4 gate 2026-09-02T22:00:00Z–2026-09-02T23:00:00Z vitest-lock\n',
      );
    });

    it('exit 1, naming the holder, when a live lease is held', async () => {
      const root = await freshRepo({});
      await repoboard(
        root,
        'lease',
        'take',
        'vitest-lock',
        '--as',
        'claude/ops',
        '--until',
        '+30m',
      );
      const res = await repoboard(root, 'window', 'check', 'vitest-lock');
      expect(res.code).toBe(1);
      expect(res.out).toBe('held by claude/ops until 2026-09-02T23:11:10Z\n');
    });

    it('a different resource, or --at outside the window, is clear (exit 0)', async () => {
      const root = await freshRepo({});
      await repoboard(
        root,
        'window',
        'add',
        'vitest-lock',
        '2026-09-02T22:00:00Z',
        '2026-09-02T23:00:00Z',
        'gate',
      );
      expect((await repoboard(root, 'window', 'check', 'other')).code).toBe(0);
      const later = await repoboard(
        root,
        'window',
        'check',
        'vitest-lock',
        '--at',
        '2026-09-03T00:00:00Z',
      );
      expect(later.code).toBe(0);
      expect(later.out).toBe('clear vitest-lock\n');
    });
  });
});

// ---- init --practices / state / log / check (P8.3) -----------------------------------------

async function repoboardStdin(cwd: string, stdinText: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    cwd,
    stdout,
    stderr,
    env: { REPOBOARD_ACTOR: 'test-actor' },
    now: () => NOW,
    readStdin: () => Promise.resolve(stdinText),
  });
  return { code, out: stdout.text, err: stderr.text };
}

describe('repoboard init --practices', () => {
  it("scaffolds STATE.md, today's log, leases.yml and NEXT-AGENT-PROMPT.md on a fresh dir", async () => {
    const root = await makeTempDir('repoboard-cli-');
    dirs.push(root);
    const res = await repoboard(root, 'init', '--practices');
    expect(res.code).toBe(0);
    expect(res.out).toContain('created .repoboard/STATE.md');
    expect(res.out).toContain('created .repoboard/log/2026-09-02.md');
    expect(res.out).toContain('created .repoboard/leases.yml');
    expect(res.out).toContain('created NEXT-AGENT-PROMPT.md');
    const state = await readFile(join(root, '.repoboard', 'STATE.md'), 'utf8');
    expect(state).toContain('## OWNER QUEUE');
    const log = await readFile(join(root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(log).toBe('# Log — 2026-09-02\n\n');
    const leases = await readFile(join(root, '.repoboard', 'leases.yml'), 'utf8');
    expect(leases).toContain('leases: []');
    const prompt = await readFile(join(root, 'NEXT-AGENT-PROMPT.md'), 'utf8');
    expect(prompt).toContain('# Next agent — eight lines');
    expect(prompt).toContain('repoboard check');
  });

  it('works on a repo that already has a board, and never overwrites existing files (locked decision 3)', async () => {
    const root = await freshRepo({});
    await writeFile(join(root, '.repoboard', 'STATE.md'), 'hand-written, keep me\n');
    await writeFile(join(root, 'NEXT-AGENT-PROMPT.md'), 'owner-written, keep me\n');
    const res = await repoboard(root, 'init', '--practices');
    expect(res.code).toBe(0);
    expect(res.out).toContain('kept .repoboard/STATE.md');
    expect(res.out).toContain('kept NEXT-AGENT-PROMPT.md');
    expect(res.out).toContain('created .repoboard/leases.yml');
    expect(await readFile(join(root, '.repoboard', 'STATE.md'), 'utf8')).toBe(
      'hand-written, keep me\n',
    );
    expect(await readFile(join(root, 'NEXT-AGENT-PROMPT.md'), 'utf8')).toBe(
      'owner-written, keep me\n',
    );
  });

  it('running it twice is idempotent: the second run keeps everything, byte-identical', async () => {
    const root = await makeTempDir('repoboard-cli-');
    dirs.push(root);
    await repoboard(root, 'init', '--practices');
    const before = {
      state: await readFile(join(root, '.repoboard', 'STATE.md'), 'utf8'),
      log: await readFile(join(root, '.repoboard', 'log', '2026-09-02.md'), 'utf8'),
      leases: await readFile(join(root, '.repoboard', 'leases.yml'), 'utf8'),
      prompt: await readFile(join(root, 'NEXT-AGENT-PROMPT.md'), 'utf8'),
    };
    const res = await repoboard(root, 'init', '--practices');
    expect(res.code).toBe(0);
    expect(
      res.out
        .split('\n')
        .filter(Boolean)
        .every((l) => l.startsWith('kept ')),
    ).toBe(true);
    expect(await readFile(join(root, '.repoboard', 'STATE.md'), 'utf8')).toBe(before.state);
    expect(await readFile(join(root, '.repoboard', 'log', '2026-09-02.md'), 'utf8')).toBe(
      before.log,
    );
    expect(await readFile(join(root, '.repoboard', 'leases.yml'), 'utf8')).toBe(before.leases);
    expect(await readFile(join(root, 'NEXT-AGENT-PROMPT.md'), 'utf8')).toBe(before.prompt);
  });

  it('plain `init` (no --practices) on an existing board still refuses, unchanged behaviour', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'init');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/already exists/);
  });
});

describe('repoboard state', () => {
  it('prints "(no STATE.md …)" before init --practices, then the rendered page after', async () => {
    const root = await freshRepo({});
    const before = await repoboard(root, 'state');
    expect(before.code).toBe(0);
    expect(before.out).toContain('repoboard init --practices');

    await repoboard(root, 'init', '--practices');
    const after = await repoboard(root, 'state');
    expect(after.code).toBe(0);
    expect(after.out).toContain('# STATE');
    expect(after.out).toContain('## OWNER QUEUE');
    expect(after.out).toContain('_(generated from open decisions)_');
  });

  it('--set-section replaces one section and restamps; a positional arg is the body', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'init', '--practices');
    const res = await repoboard(
      root,
      'state',
      '--set-section',
      'LIVE',
      'Tree is dev.',
      '--as',
      'claude/p8-3',
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe('updated STATE.md LIVE\n');
    const printed = await repoboard(root, 'state');
    expect(printed.out).toContain('Tree is dev.');
    expect(printed.out).toContain('by claude/p8-3');
  });

  it('--set-section --stdin reads the body from stdin', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'init', '--practices');
    const res = await repoboardStdin(
      root,
      'multi\nline\nbody',
      'state',
      '--set-section',
      'LAST-LANDINGS',
      '--stdin',
    );
    expect(res.code).toBe(0);
    const printed = await repoboard(root, 'state');
    expect(printed.out).toContain('multi\nline\nbody');
  });

  it('generates OWNER QUEUE from cards that need a decision — one line per card', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'init', '--practices');
    await repoboard(root, 'card', 'add', 'needs a call');
    const list = await repoboard(root, 'card', 'list', '--json');
    const id = (JSON.parse(list.out) as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error('no card id');
    await repoboard(root, 'card', 'ask', id, 'ship now?', '--option', 'A yes', '--option', 'B no');
    const printed = await repoboard(root, 'state');
    expect(printed.out).toContain(`${id} · ship now? · [A B]`);
  });

  it('an unknown --set-section name is a user error', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'init', '--practices');
    const res = await repoboard(root, 'state', '--set-section', 'NOPE', 'x');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/must be one of LIVE, LAST-LANDINGS, SEATS/);
  });
});

describe('repoboard log', () => {
  it('append creates the day file, then appends a second block', async () => {
    const root = await freshRepo({});
    const first = await repoboard(
      root,
      'log',
      '--as',
      'claude/p8-3',
      '--title',
      'kickoff',
      'first entry',
    );
    expect(first.code).toBe(0);
    expect(first.out).toBe('logged 2026-09-02 claude/p8-3\n');
    const shown = await repoboard(root, 'log', 'show');
    expect(shown.out).toContain('##### CLAUDE/P8-3 2026-09-02T22:41:10Z: kickoff');
    expect(shown.out).toContain('first entry');

    await repoboard(root, 'log', '--as', 'ops', 'second entry');
    const shown2 = await repoboard(root, 'log', 'show');
    expect(shown2.out).toContain('##### OPS');
    expect(shown2.out).toContain('second entry');
    // The FIRST block must still be there — an append that rewrote the file with only the new
    // block would still pass every assertion above (C3's own perturbation shape).
    expect(shown2.out).toContain('##### CLAUDE/P8-3');
    expect(shown2.out).toContain('kickoff');
    expect(shown2.out).toContain('first entry');
  });

  it('--stdin reads the text from stdin', async () => {
    const root = await freshRepo({});
    const res = await repoboardStdin(root, 'from stdin', 'log', '--as', 'ops', '--stdin');
    expect(res.code).toBe(0);
    const shown = await repoboard(root, 'log', 'show');
    expect(shown.out).toContain('from stdin');
  });

  it("show --seat filters to one seat's blocks", async () => {
    const root = await freshRepo({});
    await repoboard(root, 'log', '--as', 'ops', 'ops entry');
    await repoboard(root, 'log', '--as', 'builder', 'builder entry');
    const opsOnly = await repoboard(root, 'log', 'show', '--seat', 'ops');
    expect(opsOnly.out).toContain('ops entry');
    expect(opsOnly.out).not.toContain('builder entry');
  });

  it('show with no log for the date says so', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'log', 'show', '--date', '2020-01-01');
    expect(res.code).toBe(0);
    expect(res.out).toContain('no log for that date');
  });

  it('empty text with no --stdin is a user error', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'log', '--as', 'ops');
    expect(res.code).toBe(1);
  });
});

describe('repoboard check', () => {
  it('exit 0 "ok" on a clean fixture', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(0);
    expect(res.out).toBe('ok\n');
  });

  it('exit 1 with one line per finding when something is wrong', async () => {
    const root = await freshRepo({});
    await repoboard(root, 'init', '--practices');
    await repoboard(
      root,
      'lease',
      'take',
      'r',
      '--as',
      'claude/ops',
      '--until',
      '2020-01-01T00:00:00Z',
    );
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(1);
    expect(res.out).toContain('stale-lease: r held by claude/ops');
  });

  it('--json prints a JSON array', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'check', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual([]);
  });

  it('active-without-lease is warning-grade: exit 0 by default, 1 with --strict', async () => {
    const root = await freshRepo({});
    await repoboard(
      root,
      'card',
      'add',
      'working card',
      '--status',
      'doing',
      '--assignee',
      'claude/p8-3',
    );
    const plain = await repoboard(root, 'check');
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('active-without-lease');
    const strict = await repoboard(root, 'check', '--strict');
    expect(strict.code).toBe(1);
  });

  it('picks up cost-over-budget as an error (blocks even without --strict)', async () => {
    const root = await freshRepo({});
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(9000));
    const res = await repoboard(root, 'check');
    expect(res.code).toBe(1);
    expect(res.out).toContain('cost-over-budget: CLAUDE.md 9000 B > budget 8192 B');
  });
});

describe('repoboard cost', () => {
  it('reports an absent CLAUDE.md, exit 0, never OVER', async () => {
    const root = await freshRepo({});
    const res = await repoboard(root, 'cost');
    expect(res.code).toBe(0);
    expect(res.out).toContain('CLAUDE.md — absent');
    expect(res.out).toContain('FILE');
    expect(res.out).toContain('WHY');
  });

  it('table shows bytes, ≈tok, why, total, and the budget verdict; exit 1 when OVER', async () => {
    const root = await freshRepo({});
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(100));
    const ok = await repoboard(root, 'cost', '--budget', '100');
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('CLAUDE.md  100    ≈25   root');
    expect(ok.out).toContain('total  100  ≈25');
    expect(ok.out).toContain('CLAUDE.md 100 of budget 100  OK');

    const over = await repoboard(root, 'cost', '--budget', '99');
    expect(over.code).toBe(1);
    expect(over.out).toContain('CLAUDE.md 100 of budget 99  OVER');
  });

  it('--json prints the whole report as one object', async () => {
    const root = await freshRepo({});
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(50));
    const res = await repoboard(root, 'cost', '--budget', '8192', '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.out) as {
      claudeMdBytes: number;
      over: boolean;
      entries: unknown[];
    };
    expect(report.claudeMdBytes).toBe(50);
    expect(report.over).toBe(false);
    expect(report.entries).toEqual([{ file: 'CLAUDE.md', bytes: 50, why: 'root' }]);
  });

  it("reads the budget from board.yml's claudeMdBudgetBytes when no --budget flag is given", async () => {
    const root = await freshRepo({});
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(100));
    await writeFile(
      join(root, '.repoboard', 'board.yml'),
      'prefix: RB\nactiveWindowMinutes: 30\nclaudeMdBudgetBytes: 50\ncolumns:\n  - id: todo\n',
    );
    const res = await repoboard(root, 'cost');
    expect(res.code).toBe(1);
    expect(res.out).toContain('of budget 50  OVER');
  });

  it('a --budget flag wins over board.yml', async () => {
    const root = await freshRepo({});
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(100));
    await writeFile(
      join(root, '.repoboard', 'board.yml'),
      'prefix: RB\nactiveWindowMinutes: 30\nclaudeMdBudgetBytes: 50\ncolumns:\n  - id: todo\n',
    );
    const res = await repoboard(root, 'cost', '--budget', '1000');
    expect(res.code).toBe(0);
    expect(res.out).toContain('of budget 1000  OK');
  });

  it('--root measures a directory with NO .repoboard/ at all (a plain board is not required)', async () => {
    const dir = await makeTempDir('repoboard-cost-noboard-');
    dirs.push(dir);
    await writeFile(join(dir, 'CLAUDE.md'), 'x'.repeat(10));
    // cwd is unrelated to `dir`, and there is no board anywhere above it or above cwd that
    // could accidentally satisfy `costRoot` — the only path in is --root.
    const res = await repoboard(await makeTempDir('repoboard-cost-cwd-'), 'cost', '--root', dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain('CLAUDE.md  10');
  });

  it('--root on a fixture with no CLAUDE.md at all: absent, not a crash', async () => {
    const repo = await makeTempRepoNoBoard({ 'README.md': 'hello' });
    dirs.push(repo.root);
    const res = await repoboard(await makeTempDir(), 'cost', '--root', repo.root);
    expect(res.code).toBe(0);
    expect(res.out).toContain('CLAUDE.md — absent');
  });

  it('--budget 0 or non-numeric is a user error', async () => {
    const root = await freshRepo({});
    expect((await repoboard(root, 'cost', '--budget', '0')).code).toBe(1);
    expect((await repoboard(root, 'cost', '--budget', 'nope')).code).toBe(1);
  });

  it('the read-only proof: a real run against freshpickedjobs leaves its git status unchanged', async () => {
    const fpjRoot = '/Users/hometown/Projects/Repos/freshpickedjobs';
    const before = await execFileAsync('git', ['-C', fpjRoot, 'status', '--short']);
    const res = await repoboard(await makeTempDir(), 'cost', '--root', fpjRoot);
    expect(res.code).toBe(0);
    const after = await execFileAsync('git', ['-C', fpjRoot, 'status', '--short']);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stdout).toBe('');
  });
});
