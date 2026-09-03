import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTable, run } from '../src/cli.js';
import { cardText, makeTempDir, makeTempRcb, NOW } from './helpers.js';

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

async function rcb(cwd: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    cwd,
    stdout,
    stderr,
    env: { RCB_ACTOR: 'test-actor' },
    now: () => NOW,
  });
  return { code, out: stdout.text, err: stderr.text };
}

async function freshRepo(cards: Record<string, string> = {}): Promise<string> {
  const repo = await makeTempRcb(cards);
  dirs.push(repo.root);
  return repo.root;
}

describe('rcb init', () => {
  it('creates board.yml and RCB-1 Welcome, and refuses to run twice', async () => {
    const root = await makeTempDir('rcb-cli-');
    dirs.push(root);
    const first = await rcb(root, 'init');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/initialised .* with RCB-1 "Welcome"/);
    expect(await readFile(join(root, '.rcb', 'board.yml'), 'utf8')).toContain('prefix: RCB');
    const card = await readFile(join(root, '.rcb', 'cards', 'RCB-1.md'), 'utf8');
    expect(card).toContain('id: RCB-1');
    expect(card).toContain('title: Welcome');
    expect(card).toContain('status: backlog');

    const second = await rcb(root, 'init');
    expect(second.code).toBe(1);
    expect(second.err).toMatch(/already exists/);
    expect(await readdir(join(root, '.rcb', 'cards'))).toEqual(['RCB-1.md']);
  });
});

describe('rcb card', () => {
  it('add allocates the next id and honours flags', async () => {
    const root = await freshRepo({ 'RCB-3.md': cardText('RCB-3', 'todo') });
    const res = await rcb(
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
    expect(res.out).toBe('created RCB-4 (doing) Do the thing\n');
    const text = await readFile(join(root, '.rcb', 'cards', 'RCB-4.md'), 'utf8');
    expect(text).toContain('assignee: claude/a');
    expect(text).toContain('priority: high');
    expect(text).toMatch(/labels:\n\s+- web\n\s+- viz/);
    const log = await readFile(join(root, '.rcb', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ type: 'create', actor: 'someone' });
  });

  it('add rejects a bad priority, a bad status, and a missing title with exit 1', async () => {
    const root = await freshRepo();
    expect((await rcb(root, 'card', 'add', 'x', '--priority', 'urgent')).code).toBe(1);
    const badStatus = await rcb(root, 'card', 'add', 'x', '--status', 'nowhere');
    expect(badStatus.code).toBe(1);
    expect(badStatus.err).toMatch(/unknown column "nowhere"/);
    expect((await rcb(root, 'card', 'add')).code).toBe(1);
    expect((await rcb(root, 'card', 'add', 'x', '--bogus')).code).toBe(1);
  });

  it('move writes the file, appends an event, and uses RCB_ACTOR by default', async () => {
    const root = await freshRepo({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const res = await rcb(root, 'card', 'move', 'RCB-1', 'doing');
    expect(res.code).toBe(0);
    expect(res.out).toBe('moved RCB-1 todo → doing\n');
    const text = await readFile(join(root, '.rcb', 'cards', 'RCB-1.md'), 'utf8');
    expect(text).toContain('status: doing');
    expect(text).toContain('test-actor — moved todo → doing');
    const log = await readFile(join(root, '.rcb', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      actor: 'test-actor',
      from: 'todo',
      to: 'doing',
    });

    expect((await rcb(root, 'card', 'move', 'RCB-1', 'nope')).code).toBe(1);
    expect((await rcb(root, 'card', 'move', 'RCB-9', 'done')).code).toBe(1);
    expect((await rcb(root, 'card', 'move', 'RCB-1')).code).toBe(1);
  });

  it('list prints a table (filterable) and --json for agents', async () => {
    const root = await freshRepo({
      'RCB-1.md': cardText('RCB-1', 'todo', { title: 'First', assignee: 'a' }),
      'RCB-2.md': cardText('RCB-2', 'done', { title: 'Second' }),
      'RCB-10.md': cardText('RCB-10', 'todo', { title: 'Tenth' }),
    });
    const all = await rcb(root, 'card', 'list');
    expect(all.code).toBe(0);
    expect(all.out.split('\n')).toEqual([
      'ID      STATUS  ASSIGNEE  TITLE',
      'RCB-1   todo    a         First',
      'RCB-2   done    -         Second',
      'RCB-10  todo    -         Tenth',
      '',
    ]);
    const todo = await rcb(root, 'card', 'list', '--status', 'todo');
    expect(todo.out).not.toContain('Second');
    const asJson = await rcb(root, 'card', 'list', '--json');
    const parsed = JSON.parse(asJson.out) as { id: string }[];
    expect(parsed.map((c) => c.id)).toEqual(['RCB-1', 'RCB-2', 'RCB-10']);
  });

  it('list reports invalid files on stderr without failing', async () => {
    const root = await freshRepo({ 'RCB-1.md': cardText('RCB-1', 'todo'), 'RCB-2.md': 'bad' });
    const res = await rcb(root, 'card', 'list');
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/invalid: .*RCB-2\.md/);
  });

  it('show prints the file verbatim', async () => {
    const text = cardText('RCB-1', 'todo', { body: '\nHello body.\n' });
    const root = await freshRepo({ 'RCB-1.md': text });
    const res = await rcb(root, 'card', 'show', 'RCB-1');
    expect(res.code).toBe(0);
    expect(res.out).toBe(text);
    expect((await rcb(root, 'card', 'show', 'RCB-7')).code).toBe(1);
  });

  it('finds .rcb from a subdirectory', async () => {
    const root = await freshRepo({ 'RCB-1.md': cardText('RCB-1', 'todo') });
    const sub = join(root, 'deep', 'er');
    await import('node:fs/promises').then((fs) => fs.mkdir(sub, { recursive: true }));
    const res = await rcb(sub, 'card', 'list', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toHaveLength(1);
  });

  it('fails with exit 1 and one line when there is no .rcb', async () => {
    const root = await makeTempDir('rcb-none-');
    dirs.push(root);
    const res = await rcb(root, 'card', 'list');
    expect(res.code).toBe(1);
    expect(res.err.trim().split('\n')).toHaveLength(1);
    expect(res.err).toMatch(/no \.rcb directory found/);
  });
});

describe('rcb help and errors', () => {
  it('--help exits 0, no args exits 1 with help, unknown command exits 1', async () => {
    const root = await freshRepo();
    const help = await rcb(root, '--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('rcb card move');
    expect((await rcb(root)).code).toBe(1);
    const unknown = await rcb(root, 'frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown command "frobnicate"/);
    expect((await rcb(root, 'card', 'nope')).code).toBe(1);
    expect((await rcb(root, '--version')).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe('rcb serve', () => {
  it('starts on the given port, prints the URL, serves /api/board, stops on abort', async () => {
    const root = await freshRepo({ 'RCB-1.md': cardText('RCB-1', 'todo') });
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
    expect(board.cards[0]?.id).toBe('RCB-1');

    // An external edit while serving is reflected on the next GET.
    const path = join(root, '.rcb', 'cards', 'RCB-1.md');
    await writeFile(path, cardText('RCB-1', 'done'));
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
    const res = await rcb(root, 'serve', '--port', 'abc');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--port/);
  });
});

describe('formatTable', () => {
  it('renders an empty board as just the header', () => {
    expect(formatTable([])).toBe('ID  STATUS  ASSIGNEE  TITLE');
  });
});
