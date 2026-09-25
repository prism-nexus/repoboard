/**
 * RCB-153 slice 1 (W1, W3, W4, W5's `state`/`check` bullets): `board.yml` `repos:` + the
 * workspace aggregation `state`/`check` do at a workspace root. No `card`/`serve`/`mcp` verbs yet
 * (slices 2-3) — those keep today's single-board behaviour untouched.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  defaultBoardConfig,
  initialStateText,
  serializeBoard,
  type WorkspaceRepo,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempDir, makeTempRepoboard, NOW } from './helpers.js';

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

/** `state` needs a STATE.md (it prints the `init --practices` hint otherwise). */
async function writeStateMd(root: string): Promise<void> {
  await writeFile(
    join(root, '.repoboard', 'STATE.md'),
    initialStateText({ now: NOW, actor: 'test' }),
  );
}

/** A fresh member/workspace root: `makeTempRepoboard`'s default board.yml, then overwritten with
 * `prefix` (and, for the workspace root, `repos:`). */
async function boardRoot(prefix: string, repos?: WorkspaceRepo[]) {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  await writeFile(
    join(repo.root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), prefix, repos }),
  );
  await writeStateMd(repo.root);
  return repo.root;
}

/** `card add <title>` then `card ask` it — a card with an OPEN decision, id returned. */
async function addDecideCard(root: string, title: string, question: string): Promise<string> {
  await repoboard(root, 'card', 'add', title);
  const list = JSON.parse((await repoboard(root, 'card', 'list', '--json')).out) as Array<{
    id: string;
  }>;
  const id = list[list.length - 1]?.id;
  if (!id) throw new Error('no card id');
  const res = await repoboard(
    root,
    'card',
    'ask',
    id,
    question,
    '--option',
    'A yes',
    '--option',
    'B no',
  );
  if (res.code !== 0) throw new Error(`card ask failed: ${res.err}`);
  return id;
}

/** Every file under `root`, path (relative to `root`) → mtimeMs. Directories are not listed
 * themselves (only the files they hold), so a directory's own mtime moving (e.g. an entry added
 * elsewhere) never fails an unrelated comparison. */
async function snapshotFiles(root: string): Promise<Record<string, number>> {
  const names = (await readdir(root, { recursive: true })) as string[];
  const out: Record<string, number> = {};
  for (const name of names) {
    const full = join(root, name);
    const st = await stat(full);
    // Directories count too (presence only, -1): the W3 write this guards against is a bare
    // `mkdir` of `.repoboard/local/`, which a files-only listing cannot see.
    out[name] = st.isDirectory() ? -1 : st.mtimeMs;
  }
  return out;
}

/** Build the AA/BB member fixture from RCB-153.md §4: `prefix: AA`/`prefix: BB`, one decide card
 * each, one live lease in AA. Returns the two member roots plus their ids. */
async function makeMembers() {
  const aaRoot = await boardRoot('AA');
  const bbRoot = await boardRoot('BB');
  const aaId = await addDecideCard(aaRoot, 'aa needs a call', 'ship aa?');
  const bbId = await addDecideCard(bbRoot, 'bb needs a call', 'ship bb?');
  const lease = await repoboard(
    aaRoot,
    'lease',
    'take',
    'vitest-lock',
    '--as',
    'claude/aa',
    '--until',
    '+90m',
  );
  if (lease.code !== 0) throw new Error(`lease take failed: ${lease.err}`);
  return { aaRoot, bbRoot, aaId, bbId };
}

async function makeWorkspace(aaRoot: string, bbRoot: string) {
  const wsRoot = await makeTempDir('repoboard-ws-');
  dirs.push(wsRoot);
  // `makeTempRepoboard` writes a fixed default board.yml; the workspace's OWN prefix/repos must
  // be set from the start, so this builds the `.repoboard/` layout by hand instead.
  await mkdir(join(wsRoot, '.repoboard', 'cards'), { recursive: true });
  await writeFile(
    join(wsRoot, '.repoboard', 'board.yml'),
    serializeBoard({
      ...defaultBoardConfig(),
      prefix: 'WS',
      repos: [
        { key: 'aa', root: relative(wsRoot, aaRoot) },
        { key: 'bb', root: relative(wsRoot, bbRoot), writes: 'cards' },
      ],
    }),
  );
  await writeStateMd(wsRoot);
  return wsRoot;
}

describe('repoboard state — workspace aggregation (RCB-153 §4 control 1)', () => {
  it('OWNER QUEUE lists [aa]/[bb] lines, LEASES lists AA’s live lease, both [key]-prefixed', async () => {
    const { aaRoot, bbRoot, aaId, bbId } = await makeMembers();
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);

    const printed = await repoboard(wsRoot, 'state');
    expect(printed.code).toBe(0);
    expect(printed.out).toContain(`[aa] ${aaId} · ship aa? · [A B]`);
    expect(printed.out).toContain(`[bb] ${bbId} · ship bb? · [A B]`);
    expect(printed.out).toContain('[aa] vitest-lock · claude/aa · since');
    // BB has no lease — no `[bb]` line under LEASES.
    const leasesSection = printed.out.split('## LEASES')[1] ?? '';
    expect(leasesSection).not.toContain('[bb]');
  });

  it('--json adds repos: { <key>: { ownerQueue, leases } }', async () => {
    const { aaRoot, bbRoot, aaId, bbId } = await makeMembers();
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);

    const printed = await repoboard(wsRoot, 'state', '--json');
    expect(printed.code).toBe(0);
    const parsed = JSON.parse(printed.out) as {
      repos: Record<
        string,
        { ownerQueue: Array<{ id: string }>; leases: Array<{ resource: string }>; missing?: true }
      >;
    };
    expect(parsed.repos.aa?.ownerQueue).toEqual([
      { id: aaId, question: 'ship aa?', options: expect.any(Array) },
    ]);
    expect(parsed.repos.aa?.leases).toEqual([expect.objectContaining({ resource: 'vitest-lock' })]);
    expect(parsed.repos.bb?.ownerQueue).toEqual([
      { id: bbId, question: 'ship bb?', options: expect.any(Array) },
    ]);
    expect(parsed.repos.bb?.leases).toEqual([]);
    expect(parsed.repos.aa?.missing).toBeUndefined();
  });

  it('a plain board (no repos:) renders with no [key] lines and no repos field at all', async () => {
    const root = await boardRoot('RB');
    await addDecideCard(root, 'plain card', 'ship?');

    const printed = await repoboard(root, 'state');
    expect(printed.code).toBe(0);
    // The `[<key>] ` prefix always starts a line — anchored so this can never coincidentally
    // match an ordinary `[A B]` decision-letters bracket, which is never line-initial.
    expect(printed.out).not.toMatch(/^\[[a-z0-9][a-z0-9-]*\] /m);

    const json = JSON.parse((await repoboard(root, 'state', '--json')).out) as Record<
      string,
      unknown
    >;
    expect(json).not.toHaveProperty('repos');
  });
});

describe('repoboard check/state — read-only members (RCB-153 §4 control 2, state+check only)', () => {
  it('state, then check, leaves both member trees byte-for-byte (mtimes included) unchanged', async () => {
    const { aaRoot, bbRoot } = await makeMembers();
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);

    const beforeAa = await snapshotFiles(aaRoot);
    const beforeBb = await snapshotFiles(bbRoot);

    expect((await repoboard(wsRoot, 'state')).code).toBe(0);
    expect((await repoboard(wsRoot, 'state', '--json')).code).toBe(0);
    expect((await repoboard(wsRoot, 'check')).code).toBe(0);

    expect(await snapshotFiles(aaRoot)).toEqual(beforeAa);
    expect(await snapshotFiles(bbRoot)).toEqual(beforeBb);
  });
});

describe('repoboard check — workspace aggregation (RCB-153 §4 control 5)', () => {
  it('a missing member is workspace-member-missing (error, exit 1); state still renders, key shown (missing)', async () => {
    const aaRoot = await boardRoot('AA');
    const wsRoot = await makeTempDir('repoboard-ws-missing-');
    dirs.push(wsRoot);
    await mkdir(join(wsRoot, '.repoboard', 'cards'), { recursive: true });
    await writeFile(
      join(wsRoot, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        prefix: 'WS',
        repos: [
          { key: 'aa', root: relative(wsRoot, aaRoot) },
          // Never created — `check`'s `workspace-member-missing` fixture.
          { key: 'ghost', root: 'ghost-member' },
        ],
      }),
    );
    await writeStateMd(wsRoot);

    const checked = await repoboard(wsRoot, 'check');
    expect(checked.code).toBe(1);
    expect(checked.out).toContain('workspace-member-missing: [ghost]');

    const printed = await repoboard(wsRoot, 'state');
    expect(printed.code).toBe(0);
    expect(printed.out).toContain('[ghost] (missing)');

    // Control (§4 control 5): the same fixture with the `ghost` entry removed — `check` exits 0.
    await writeFile(
      join(wsRoot, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        prefix: 'WS',
        repos: [{ key: 'aa', root: relative(wsRoot, aaRoot) }],
      }),
    );
    const rechecked = await repoboard(wsRoot, 'check');
    expect(rechecked.code).toBe(0);
    expect(rechecked.out).not.toContain('workspace-member-missing');
  });
});

// ---- RCB-153 slice 2: card verbs across boards (W4, W5) --------------------------------------

/** The id `card list --json`'s LAST row carries — same trick `addDecideCard` uses above. */
async function lastCardId(root: string): Promise<string> {
  const list = JSON.parse((await repoboard(root, 'card', 'list', '--json')).out) as Array<{
    id: string;
  }>;
  const id = list[list.length - 1]?.id;
  if (!id) throw new Error('no card id');
  return id;
}

describe('repoboard card note — write opt-in (RCB-153 §4 control 3)', () => {
  it('a read-only member REFUSES with the exact W5 text (AA untouched); a writable member writes exactly its card file + one events.jsonl line', async () => {
    const { aaRoot, bbRoot, aaId, bbId } = await makeMembers();
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);

    const beforeAa = await snapshotFiles(aaRoot);
    const refused = await repoboard(wsRoot, 'card', 'note', aaId, 'x');
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      `repoboard: member aa is read-only (set writes: cards in board.yml)\n`,
    );
    expect(await snapshotFiles(aaRoot)).toEqual(beforeAa);

    const beforeBb = await snapshotFiles(bbRoot);
    const noted = await repoboard(wsRoot, 'card', 'note', bbId, 'x');
    expect(noted.code).toBe(0);
    const afterBb = await snapshotFiles(bbRoot);
    const allPaths = new Set([...Object.keys(beforeBb), ...Object.keys(afterBb)]);
    const changed = [...allPaths].filter((p) => beforeBb[p] !== afterBb[p]).sort();
    expect(changed).toEqual(
      [join('.repoboard', 'cards', `${bbId}.md`), join('.repoboard', 'events.jsonl')].sort(),
    );
  });
});

describe('repoboard card show — prefix resolution across the workspace (RCB-153 §4 control 4)', () => {
  it('a bare id resolves to the one member whose prefix matches', async () => {
    const { aaRoot, bbRoot, bbId } = await makeMembers();
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);
    const shown = await repoboard(wsRoot, 'card', 'show', bbId);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`id: ${bbId}`);
  });

  it('two members sharing a prefix: a bare id errors naming BOTH keys; <key>:<id> always resolves', async () => {
    const aaRoot = await boardRoot('AA');
    const aa2Root = await boardRoot('AA');
    await repoboard(aaRoot, 'card', 'add', 'aa card');
    await repoboard(aa2Root, 'card', 'add', 'aa2 card');
    const wsRoot = await makeTempDir('repoboard-ws-clash-');
    dirs.push(wsRoot);
    await mkdir(join(wsRoot, '.repoboard', 'cards'), { recursive: true });
    await writeFile(
      join(wsRoot, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        prefix: 'WS',
        repos: [
          { key: 'aa', root: relative(wsRoot, aaRoot) },
          { key: 'aa2', root: relative(wsRoot, aa2Root) },
        ],
      }),
    );
    await writeStateMd(wsRoot);

    const ambiguous = await repoboard(wsRoot, 'card', 'show', 'AA-1');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('aa');
    expect(ambiguous.err).toContain('aa2');

    const viaAa = await repoboard(wsRoot, 'card', 'show', 'aa:AA-1');
    expect(viaAa.code).toBe(0);
    expect(viaAa.out).toContain('aa card');
    const viaAa2 = await repoboard(wsRoot, 'card', 'show', 'aa2:AA-1');
    expect(viaAa2.code).toBe(0);
    expect(viaAa2.out).toContain('aa2 card');
  });

  it('workspace-first (W4): a workspace card wins over a member sharing the workspace’s OWN prefix', async () => {
    const bbRoot = await boardRoot('BB');
    await repoboard(bbRoot, 'card', 'add', 'bb card'); // BB-1, on the member
    const wsRoot = await makeTempDir('repoboard-ws-ownprefix-');
    dirs.push(wsRoot);
    await mkdir(join(wsRoot, '.repoboard', 'cards'), { recursive: true });
    await writeFile(
      join(wsRoot, '.repoboard', 'board.yml'),
      serializeBoard({
        ...defaultBoardConfig(),
        prefix: 'BB', // same prefix as the member below — workspace-first must still win
        repos: [{ key: 'bb', root: relative(wsRoot, bbRoot) }],
      }),
    );
    await writeStateMd(wsRoot);
    const wsCard = await repoboard(wsRoot, 'card', 'add', 'workspace card'); // BB-1, on the workspace
    expect(wsCard.code).toBe(0);

    const shown = await repoboard(wsRoot, 'card', 'show', 'BB-1');
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('workspace card'); // the WORKSPACE's own BB-1, not the member's
  });
});

describe('repoboard card list — gate across boards (RCB-153 §4 control 6)', () => {
  it('a workspace card’s gate: BB-1 is blocked while BB-1 is todo, clear after `card move BB-1 done` through the workspace', async () => {
    const aaRoot = await boardRoot('AA');
    const bbRoot = await boardRoot('BB');
    const addTarget = await repoboard(bbRoot, 'card', 'add', 'bb target', '--status', 'todo');
    expect(addTarget.code).toBe(0);
    const bbId = await lastCardId(bbRoot);

    const wsRoot = await makeWorkspace(aaRoot, bbRoot); // bb carries `writes: cards`
    const wsCard = await repoboard(wsRoot, 'card', 'add', 'ws gated card', '--gate', bbId);
    expect(wsCard.code).toBe(0);

    const before = await repoboard(wsRoot, 'card', 'list');
    expect(before.code).toBe(0);
    expect(before.out).toContain(`blocked on ${bbId} (todo)`);

    const moved = await repoboard(wsRoot, 'card', 'move', bbId, 'done');
    expect(moved.code).toBe(0);

    const after = await repoboard(wsRoot, 'card', 'list');
    expect(after.code).toBe(0);
    expect(after.out).not.toContain('BLOCKED');
    expect(after.out).not.toContain(`blocked on ${bbId}`);
  });

  it('control: gate ZZ-9 (matching no board at all) stays "no such card", workspace or not', async () => {
    const aaRoot = await boardRoot('AA');
    const bbRoot = await boardRoot('BB');
    const wsRoot = await makeWorkspace(aaRoot, bbRoot);
    const wsCard = await repoboard(wsRoot, 'card', 'add', 'gate on unknown', '--gate', 'ZZ-9');
    expect(wsCard.code).toBe(0);
    const listed = await repoboard(wsRoot, 'card', 'list');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('blocked on ZZ-9 (no such card)');
  });
});

describe('repoboard card show — plain board (no repos:) regression', () => {
  it('an unknown id on a plain board never touches resolveCardRef — the error text is byte-identical to before this card', async () => {
    const root = await boardRoot('RB');
    const shown = await repoboard(root, 'card', 'show', 'NOPE-1');
    expect(shown.code).toBe(1);
    expect(shown.err).toBe('repoboard: unknown card "NOPE-1"\n');
  });
});
