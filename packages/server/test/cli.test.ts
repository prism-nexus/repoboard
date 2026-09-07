import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
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
