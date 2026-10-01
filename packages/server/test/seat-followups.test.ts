/**
 * RCB-206 slice A: five follow-ups to seat identity (RCB-194), one test group each. Every group
 * names the line whose revert makes it fail — the seat runs those controls.
 *
 *  (a) `seats.yml` that cannot be READ (a directory: EISDIR) is `{ok:false}` from `readSeatsDoc`,
 *      not a throw — `seat whoami` exits 1 naming `cannot read`, the `seat <name>` bundle carries
 *      `holderError` and still prints. Revert: the `return { ok: false, error: ...cannot read... }`
 *      in `readSeatsDoc` back to `throw e`.
 *  (d) `seats.yml` errors name `seats.yml` (not `leases.yml`), and `; nothing was written` is said
 *      by the WRITE callers only — a read (`seat whoami`) does not claim it wrote nothing. Revert:
 *      `parseLeases(existing, 'seats.yml')` back to `parseLeases(existing)`, and/or the suffix moved
 *      back into `readSeatsDoc`.
 *  (b) a claim typed `Builder` finds the lease `seat:builder` — the holder pane re-claims its own
 *      seat with no refusal, and ONE lease remains. Revert: `own`'s `toLowerCase()` comparison, its
 *      twin in `callerHolds`, or `own?.seat ?? req.name` in the UP `seatHolderLeases` call.
 *  (f) `setStateSection` (every section) and `appendArchiveText` are refused from a linked git
 *      worktree, STATE unchanged. Revert: the `await this.refuseLinkedWorktree();` at the top of
 *      each `mutate` body.
 *
 * Two panes are two live processes: pane A is this process (`process.pid`), pane B its parent. Every
 * `cli` call is handed an explicit env — the machine running the suite may itself be an iTerm pane.
 * All boards live under `os.tmpdir()`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { defaultBoardConfig, parseLeases, serializeBoard } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { localDir } from '../src/local.js';
import { openStore } from '../src/store.js';
import { makeTempRepoboard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

const PANE_A = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
const PANE_C = '0460D7A9-3E1F-4B2C-9D8E-5A6B7C8D9E0F';
const SESSION_A = 'session-a-7f3a9c2e-privacy-marker';
const PID_A = process.pid;
const PID_B = process.ppid;

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

/** `env` is ALWAYS explicit — the machine running the suite may itself be an iTerm pane. */
async function cli(root: string, env: Record<string, string>, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd: root, stdout, stderr, env, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

function paneEnv(pane: string, pid: number, session: string): Record<string, string> {
  return {
    REPOBOARD_ACTOR: 'test-actor',
    ITERM_SESSION_ID: `w0t0p0:${pane}`,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PID: String(pid),
  };
}

const ENV_A = paneEnv(PANE_A, PID_A, SESSION_A);
/** Pane C: a different pane in a different process (this one's parent). */
const ENV_C = paneEnv(PANE_C, PID_B, 'session-c');
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

/** A board named `seatboard` with short name `acme` and a local layer (`local init`). */
async function makeLocalBoard(): Promise<string> {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  await writeFile(
    join(repo.root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: 'seatboard', shortName: 'acme' }),
  );
  const init = await cli(repo.root, BARE_ENV, 'local', 'init');
  expect(init.code).toBe(0);
  return repo.root;
}

const seatsFile = (root: string) => join(localDir(root), 'seats.yml');

/** A local-layer board with `builder` UP from pane A (a live holder: this very process). */
async function boardWithBuilderUp(): Promise<string> {
  const root = await makeLocalBoard();
  const up = await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-206');
  expect(up.code, up.err).toBe(0);
  return root;
}

/** The resources (`seat:<name>`) recorded in `seats.yml`, in file order. */
async function leaseResources(root: string): Promise<string[]> {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'), 'seats.yml');
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc.leases.map((l) => l.resource);
}

describe('(a) a seats.yml that cannot be read is data, not a crash (RCB-206)', () => {
  /** `seats.yml` replaced by a DIRECTORY: `readFile` says EISDIR, not ENOENT. */
  async function boardWithSeatsDir(): Promise<string> {
    const root = await boardWithBuilderUp();
    await rm(seatsFile(root), { force: true });
    await mkdir(seatsFile(root));
    return root;
  }

  it('`seat whoami` is exit 1 naming `cannot read` (and the file), stdout empty, no throw', async () => {
    const root = await boardWithSeatsDir();
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(1);
    expect(res.out).toBe('');
    expect(res.err).toMatch(/^seat whoami: .*seats\.yml: cannot read: EISDIR/);
    // a read: it never says it "wrote nothing" (RCB-206 d)
    expect(res.err).not.toContain('nothing was written');
  });

  it('`seat <name>` still prints its bundle: `holder` null, `holderError` says `cannot read`', async () => {
    const root = await boardWithSeatsDir();
    const res = await cli(root, ENV_A, 'seat', 'builder', '--json');
    expect(res.code, res.err).toBe(0);
    const bundle = JSON.parse(res.out) as { holder: unknown; holderError: string };
    expect(bundle.holder).toBeNull();
    expect(bundle.holderError).toContain('cannot read');
    expect(bundle.holderError).toContain('seats.yml');
  });

  it('a write that needs the file is refused with the same text plus `nothing was written`', async () => {
    const root = await boardWithSeatsDir();
    const res = await cli(root, ENV_A, 'seat', 'builder', '--update', 'x');
    expect(res.code).toBe(1);
    expect(res.err).toContain('cannot read: EISDIR');
    expect(res.err).toContain('nothing was written');
  });
});

describe('(d) seats.yml errors name seats.yml; `nothing was written` belongs to the writers (RCB-206)', () => {
  const BAD_YAML = 'leases: [\n';

  it('`seat whoami` over bad YAML: names `seats.yml`, never `leases.yml`, never `nothing was written`', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), BAD_YAML, 'utf8');
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(1);
    expect(res.err).toContain('seats.yml is not valid YAML');
    expect(res.err).not.toContain('leases.yml');
    expect(res.err).not.toContain('nothing was written');
  });

  it('a non-mapping seats.yml says `seats.yml must be a YAML mapping`', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), '- just\n- a list\n', 'utf8');
    const res = await cli(root, ENV_A, 'seat', 'whoami');
    expect(res.code).toBe(1);
    expect(res.err).toContain('seats.yml must be a YAML mapping');
    expect(res.err).not.toContain('leases.yml');
  });

  it('both writers still say `nothing was written` (and `seats.yml`, not `leases.yml`), and write nothing', async () => {
    const root = await boardWithBuilderUp();
    await writeFile(seatsFile(root), BAD_YAML, 'utf8');
    const state = join(localDir(root), 'STATE.md');
    const before = await readFile(state, 'utf8');
    // setSeatBulletHeld (the claim) and withSeatWriteGuard (--update)
    for (const argv of [
      ['seat', 'builder', '--up', 'again'],
      ['seat', 'builder', '--update', 'x'],
    ]) {
      const res = await cli(root, ENV_A, ...argv);
      expect(res.code, argv.join(' ')).toBe(1);
      expect(res.err, argv.join(' ')).toContain('seats.yml is not valid YAML');
      expect(res.err, argv.join(' ')).not.toContain('leases.yml');
      // said once — by the writer, not also by `readSeatsDoc`
      expect(res.err.match(/nothing was written/g), argv.join(' ')).toHaveLength(1);
    }
    expect(await readFile(state, 'utf8')).toBe(before);
    expect(await readFile(seatsFile(root), 'utf8')).toBe(BAD_YAML);
  });
});

describe('(b) a claim typed in another case finds the lease it names (RCB-206)', () => {
  /** Every log block written today — an audit block would mean a takeover, not a re-claim. */
  async function loggedBlocks(root: string): Promise<unknown[]> {
    const shown = await cli(root, BARE_ENV, 'log', 'show', '--json');
    expect(shown.code).toBe(0);
    return (JSON.parse(shown.out) as { blocks: unknown[] }).blocks;
  }

  it('`--up Builder` from the pane that holds `seat:builder` is a same-holder claim: exit 0, no audit, still ONE lease', async () => {
    const root = await boardWithBuilderUp();
    const res = await cli(root, ENV_A, 'seat', 'Builder', '--up', 'again');
    expect(res.code, res.err).toBe(0);
    expect(res.err).not.toContain('already holds');
    expect(await loggedBlocks(root)).toEqual([]);
    // renewed under the lease's own spelling — not a second lease `seat:Builder` beside it
    expect(await leaseResources(root)).toEqual(['seat:builder']);
  });

  it('control: another pane typing `Builder` is still refused — the case-insensitive match names the holder, it does not weaken the refusal', async () => {
    const root = await boardWithBuilderUp();
    const before = await readFile(seatsFile(root), 'utf8');
    const res = await cli(root, ENV_C, 'seat', 'Builder', '--up', 'mine now');
    expect(res.code).toBe(1);
    expect(res.err).toContain('is held by');
    expect(await readFile(seatsFile(root), 'utf8')).toBe(before);
  });
});

// ---- (f) refuse setStateSection / appendArchiveText from a linked worktree -----------------------

/** git's own "where am I" variables, dropped so a fixture repo is never the OUTER repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|PREFIX)$/.test(key),
  ),
);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { env: GIT_ENV },
  );
}

/** Every file (and directory) under `dir` with its text — a change anywhere shows in `toEqual`. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = '';
        await walk(path);
      } else {
        out[relative(dir, path)] = await readFile(path, 'utf8');
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * A git repo whose board is checked in — STATE.md included, seeded with `state --set-section LIVE`
 * so no seat verb is needed — plus a linked worktree of it. STATE.md is committed, so the worktree
 * has it: without the refusal, a write there would SUCCEED, and an exit 1 can only be the refusal.
 */
async function linkedFixture(): Promise<{ main: string; worktree: string }> {
  const main = await realpath(await mkdtemp(join(tmpdir(), 'repoboard-followups-')));
  const worktree = `${main}-wt`;
  dirs.push(main, worktree);
  await git(main, 'init', '-q', '-b', 'main');
  await mkdir(join(main, '.repoboard', 'cards'), { recursive: true });
  await writeFile(
    join(main, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: 'followboard' }),
  );
  const seeded = await cli(main, BARE_ENV, 'state', '--set-section', 'LIVE', 'seeded');
  expect(seeded.code, seeded.err).toBe(0);
  await git(main, 'add', '-A');
  await git(main, 'commit', '-q', '-m', 'board');
  await git(main, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  return { main, worktree };
}

describe('(f) state writes are refused from a linked git worktree (RCB-206)', () => {
  it('`state --set-section LIVE` from the worktree: exit 1 naming the main checkout, the worktree untouched; from the main checkout: exit 0', async () => {
    const f = await linkedFixture();
    const wtRepoboard = join(f.worktree, '.repoboard');
    expect(await readFile(join(wtRepoboard, 'STATE.md'), 'utf8')).toContain('seeded');
    const before = await snapshot(wtRepoboard);

    const res = await cli(f.worktree, BARE_ENV, 'state', '--set-section', 'LIVE', 'forked');
    expect(res.code, res.err).toBe(1);
    expect(res.out).toBe('');
    expect(res.err).toContain('linked git worktree');
    expect(res.err).toContain(`run it from the main checkout: ${f.main}`);
    expect(await snapshot(wtRepoboard)).toEqual(before);

    // control: the same command in the main checkout is fine — the refusal, nothing else, stopped it
    const ok = await cli(f.main, BARE_ENV, 'state', '--set-section', 'LIVE', 'from main');
    expect(ok.code, ok.err).toBe(0);
  });

  it('store level: setStateSection refuses for EVERY section (SEATS too, even with force) and appendArchiveText refuses; nothing is written, no archive file made', async () => {
    const f = await linkedFixture();
    const wtRepoboard = join(f.worktree, '.repoboard');
    const before = await snapshot(wtRepoboard);
    const store = await openStore(f.worktree, { watch: false, now: () => NOW });

    for (const section of ['live', 'lastLandings', 'seats'] as const) {
      const res = await store.setStateSection(section, 'forked', 'builder', { force: true });
      expect(res.ok, section).toBe(false);
      if (res.ok) continue;
      expect(res.error, section).toContain(`run it from the main checkout: ${f.main}`);
    }
    const archived = await store.appendArchiveText(
      'archive/landings.md',
      'builder',
      'an old landing',
      'LAST LANDINGS archived',
    );
    expect(archived.ok).toBe(false);
    if (!archived.ok) {
      expect(archived.error).toContain(`run it from the main checkout: ${f.main}`);
    }

    expect(existsSync(join(f.worktree, 'archive'))).toBe(false);
    expect(await snapshot(wtRepoboard)).toEqual(before);
  });

  it('control: the same appendArchiveText from the main checkout writes the archive file', async () => {
    const f = await linkedFixture();
    const store = await openStore(f.main, { watch: false, now: () => NOW });
    const res = await store.appendArchiveText(
      'archive/landings.md',
      'builder',
      'an old landing',
      'LAST LANDINGS archived',
    );
    expect(res.ok).toBe(true);
    expect(await readFile(join(f.main, 'archive', 'landings.md'), 'utf8')).toContain(
      'an old landing',
    );
  });
});
