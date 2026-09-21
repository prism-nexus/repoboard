/**
 * P8.5: `repoboard archive` — move `done` cards older than a cutoff to `.repoboard/archive/`,
 * byte-identical, `git mv` when tracked else `rename`. Store-level and CLI-level coverage; HTTP
 * and MCP have their own thin wiring tests alongside sync-issues in `sync-issues.test.ts`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultBoardConfig, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { openStore } from '../src/store.js';
import { cardText, makeTempDir, makeTempRepoboard, makeTempRepoNoBoard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
  const code = await run(argv, { cwd, stdout, stderr, env: {}, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

const OLD_UPDATED = '2026-08-01T00:00:00Z'; // well before NOW (2026-09-02T22:41:10Z) - 14d
const RECENT_UPDATED = '2026-09-02T00:00:00Z'; // within 14d of NOW

function doneCard(id: string, updated = OLD_UPDATED): string {
  return cardText(id, 'done', {}).replace('updated: 2026-09-02T22:00:00Z', `updated: ${updated}`);
}

describe('store: selectArchivable / archiveCards', () => {
  it('selects only done cards older than the cutoff', async () => {
    const repo = await makeTempRepoboard({
      'RB-1.md': doneCard('RB-1', OLD_UPDATED),
      'RB-2.md': doneCard('RB-2', RECENT_UPDATED),
      'RB-3.md': cardText('RB-3', 'doing'),
    });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    const cutoff = new Date(NOW.getTime() - 14 * 86_400_000);
    expect(store.selectArchivable(cutoff)).toEqual(['RB-1']);
  });

  it('moves the file byte-identical via rename (no git), removes it from list(), appends one archive event', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': doneCard('RB-1') });
    cleanups.push(repo.cleanup);
    const before = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    const beforeHash = sha256(before);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    const res = await store.archiveCards(['RB-1'], 'claude/test');
    if (!res.ok) throw new Error(res.error);
    expect(res.archived).toEqual(['RB-1']);
    expect(res.method['RB-1']).toBe('rename');

    expect(store.get('RB-1')).toBeUndefined();
    expect(store.list().map((c) => c.id)).not.toContain('RB-1');

    const archivedPath = join(repo.root, '.repoboard', 'archive', 'RB-1.md');
    const after = await readFile(archivedPath, 'utf8');
    expect(sha256(after)).toBe(beforeHash);
    // the original location is gone
    await expect(stat(join(repo.cardsDir, 'RB-1.md'))).rejects.toThrow();

    const events = store.events().filter((e) => e.type === 'archive');
    expect(events).toEqual([
      {
        ts: expect.any(String),
        actor: 'claude/test',
        type: 'archive',
        cardId: 'RB-1',
        from: 'done',
        to: 'archive',
      },
    ]);
  });

  it('moves the file byte-identical via git mv when the repo is git and the file is tracked', async () => {
    const root = await makeTempDir('repoboard-archive-git-');
    dirs.push(root);
    await mkdir(join(root, '.repoboard', 'cards'), { recursive: true });
    await writeFile(join(root, '.repoboard', 'cards', 'RB-1.md'), doneCard('RB-1'));
    await writeFile(join(root, '.repoboard', 'board.yml'), serializeBoard(defaultBoardConfig()));
    await git(root, 'init', '-q');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'init');

    const before = await readFile(join(root, '.repoboard', 'cards', 'RB-1.md'), 'utf8');
    const beforeHash = sha256(before);

    const store = await openStore(root, { watch: false, now: () => NOW });
    const res = await store.archiveCards(['RB-1'], 'claude/test');
    if (!res.ok) throw new Error(res.error);
    expect(res.method['RB-1']).toBe('git');

    const after = await readFile(join(root, '.repoboard', 'archive', 'RB-1.md'), 'utf8');
    expect(sha256(after)).toBe(beforeHash);

    const status = await git(root, 'status', '--short');
    expect(status).toMatch(
      /^R {2}\.repoboard\/cards\/RB-1\.md -> \.repoboard\/archive\/RB-1\.md$/m,
    );
  });

  it('map-only: refuses (readOnly)', async () => {
    const noboard = await makeTempRepoNoBoard({});
    dirs.push(noboard.root);
    const store = await openStore(noboard.root, { watch: false, now: () => NOW });
    const res = await store.archiveCards(['RB-1'], 'claude/test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.readOnly).toBe(true);
  });
});

describe('store: closeSynced', () => {
  it('moves to the done column with the synced log line, refuses if already done', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'doing') });
    cleanups.push(repo.cleanup);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    const res = await store.closeSynced('RB-1', 'README.md', 'claude/sync');
    if (!res.ok) throw new Error(res.error);
    expect(res.card.status).toBe('done');
    expect(res.card.body).toContain('synced: entry closed in README.md');

    const again = await store.closeSynced('RB-1', 'README.md', 'claude/sync');
    expect(again.ok).toBe(false);
  });
});

describe('CLI: repoboard archive', () => {
  it('--dry-run lists ids and writes nothing', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': doneCard('RB-1') });
    cleanups.push(repo.cleanup);
    const before = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    const res = await repoboard(repo.root, 'archive', '--dry-run');
    expect(res.code).toBe(0);
    expect(res.out).toContain('would archive 1: RB-1');
    const after = await readFile(join(repo.cardsDir, 'RB-1.md'), 'utf8');
    expect(after).toBe(before);
    await expect(stat(join(repo.root, '.repoboard', 'archive', 'RB-1.md'))).rejects.toThrow();
  });

  it('a real run archives, and `card show` on the archived id says where it went', async () => {
    const repo = await makeTempRepoboard({
      'RB-1.md': doneCard('RB-1'),
      'RB-2.md': doneCard('RB-2', RECENT_UPDATED),
    });
    cleanups.push(repo.cleanup);
    const res = await repoboard(repo.root, 'archive');
    expect(res.code).toBe(0);
    expect(res.out).toContain('archived 1: RB-1');

    const list = await repoboard(repo.root, 'card', 'list');
    expect(list.out).not.toContain('RB-1');
    expect(list.out).toContain('RB-2');

    const show = await repoboard(repo.root, 'card', 'show', 'RB-1');
    expect(show.code).toBe(0);
    expect(show.out.trim()).toBe('archived: .repoboard/archive/RB-1.md');
  });

  it('--older-than accepts hours/minutes and nothing-to-archive is reported cleanly', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': doneCard('RB-1', RECENT_UPDATED) });
    cleanups.push(repo.cleanup);
    const res = await repoboard(repo.root, 'archive', '--older-than', '1000h');
    expect(res.code).toBe(0);
    expect(res.out).toContain('archived 0');
  });
});
