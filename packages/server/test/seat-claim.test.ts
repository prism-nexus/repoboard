/**
 * RCB-197 (slice B of RCB-194): `seat --up` is a claim, decided INSIDE the seats.yml + STATE.md
 * locks by the store — the CLI no longer decides.
 *
 * Two panes are two live processes: pane A is this process (`process.pid`), pane B its parent
 * (`process.ppid`). One pid is one holder now (`sameHolder`), so two panes that share a pid would be
 * the SAME holder and nothing here would be refused. Every `run` below is handed an explicit `env`
 * (see `seat-holder.test.ts`), and all boards live under `os.tmpdir()`.
 *
 * CONTROL (run by the seat, not part of the suite): put 9e18367's `cli.ts` + `store.ts` back — the
 * CLI then decides on the STATE.md it loaded at open, outside any lock, and the store writes
 * whatever it is handed. (c), (e), (f) and the race (j) must fail (both panes exit 0), and the
 * `--from`/`--pane` flags are unknown to that CLI.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultBoardConfig,
  formatHolder,
  parseHolder,
  parseLeases,
  type SeatHolder,
  serializeBoard,
  serializeLeases,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { localDir } from '../src/local.js';
import { makeTempRepoboard, NOW } from './helpers.js';

/** Two panes whose ids share their first four characters (`A7B2`) and differ after. */
const PANE_A = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';
const PANE_B = 'A7B2B4E1-9F8E-4D7C-A6B5-1234567890AB';
/** A pane that shares nothing with the two above. */
const PANE_C = '0460D7A9-3E1F-4B2C-9D8E-5A6B7C8D9E0F';
const SESSION_A = 'session-a-7f3a9c2e-privacy-marker';
const SESSION_B = 'session-b-51d0e8b4-privacy-marker';
/** The two live pids: this process and its parent. */
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

/** What an iTerm pane running Claude Code exports: the pane, the Claude session, the Claude pid. */
function paneEnv(pane: string, pid: number, session: string): Record<string, string> {
  return {
    REPOBOARD_ACTOR: 'test-actor',
    ITERM_SESSION_ID: `w0t0p0:${pane}`,
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_PID: String(pid),
  };
}

const ENV_A = paneEnv(PANE_A, PID_A, SESSION_A);
const ENV_B = paneEnv(PANE_B, PID_B, SESSION_B);
/** Pane C shares nothing with A or B but pane B's pid, so C and B are ONE holder by pid alone: never let both hold a seat at once. */
const ENV_C = paneEnv(PANE_C, PID_B, 'session-c');

/**
 * No iTerm pane. With `session`, the Claude session id stands in as the pane (`holderIdentity`'s
 * last resort) and changes on `/clear`, so the pid is what keeps the holder the same; without it
 * there is no pane at all.
 */
function noPaneEnv(pid: number, session?: string): Record<string, string> {
  return {
    REPOBOARD_ACTOR: 'test-actor',
    ...(session !== undefined ? { CLAUDE_CODE_SESSION_ID: session } : {}),
    CLAUDE_PID: String(pid),
  };
}

const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };

/** A board named `seatboard` with short name `acme`, with or without a local layer (`local init`). */
async function makeBoard(withLocal: boolean): Promise<string> {
  const repo = await makeTempRepoboard();
  dirs.push(repo.root);
  await writeFile(
    join(repo.root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), name: 'seatboard', shortName: 'acme' }),
  );
  if (withLocal) {
    const init = await cli(repo.root, BARE_ENV, 'local', 'init');
    expect(init.code).toBe(0);
  }
  return repo.root;
}

const seatsFile = (root: string) => join(localDir(root), 'seats.yml');
const localState = (root: string) => join(localDir(root), 'STATE.md');

/** The `seat:` leases in `seats.yml`, parsed the way the store parses them. */
async function readLeases(root: string) {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc.leases;
}

/** The holder recorded for `seat`, parsed back. */
async function holderOf(root: string, seat: string): Promise<SeatHolder> {
  const lease = (await readLeases(root)).find((l) => l.resource === `seat:${seat}`);
  if (lease === undefined) throw new Error(`no lease for ${seat}`);
  return parseHolder(lease.holder);
}

/** Overwrite fields of `seat`'s recorded holder in `seats.yml` — how a test makes a holder dead. */
async function patchHolder(root: string, seat: string, patch: Partial<SeatHolder>): Promise<void> {
  const parsed = parseLeases(await readFile(seatsFile(root), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  const leases = parsed.doc.leases.map((l) =>
    l.resource === `seat:${seat}`
      ? { ...l, holder: formatHolder({ ...parseHolder(l.holder), ...patch }) }
      : l,
  );
  await writeFile(seatsFile(root), serializeLeases({ ...parsed.doc, leases }), 'utf8');
}

/** The first line of `seat`'s bullet in the local STATE.md. */
async function bulletOf(root: string, seat: string): Promise<string> {
  const text = await readFile(localState(root), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('- **') && l.includes(` ${seat}: `));
  if (line === undefined) throw new Error(`no bullet for ${seat} in:\n${text}`);
  return line;
}

interface LoggedBlock {
  seat: string;
  title: string;
  text: string;
}

/** Every log block written today (the fixed `NOW`) — the audit blocks a takeover leaves. */
async function loggedBlocks(root: string): Promise<LoggedBlock[]> {
  const shown = await cli(root, BARE_ENV, 'log', 'show', '--json');
  expect(shown.code).toBe(0);
  return (JSON.parse(shown.out) as { blocks: LoggedBlock[] }).blocks;
}

/** The two files a refusal must leave byte-for-byte alone. */
async function snapshot(root: string): Promise<{ state: string; seats: string }> {
  return {
    state: await readFile(localState(root), 'utf8'),
    seats: await readFile(seatsFile(root), 'utf8'),
  };
}

describe('seat --up is a claim decided inside the locks (RCB-197 slice B)', () => {
  it('(a) a first --up takes the seat: exit 0, lease and label written, no audit block, json says so', async () => {
    const root = await makeBoard(true);
    const up = await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197', '--json');
    expect(up.code).toBe(0);
    const json = JSON.parse(up.out) as Record<string, unknown>;
    expect(json).toMatchObject({ name: 'builder', status: 'UP', released: null, audit: null });
    expect(json.holderLabel).toBe('A7B2 · acme builder');
    expect((await holderOf(root, 'builder')).pane).toBe(PANE_A);
    expect(await loggedBlocks(root)).toEqual([]);
  });

  it('(b) the SAME pane again — a new session after /clear, even a new pid — is the same holder: exit 0, no --force, no audit', async () => {
    const root = await makeBoard(true);
    const first = await cli(
      root,
      paneEnv(PANE_A, PID_A, 'session-one'),
      'seat',
      'builder',
      '--up',
      'a',
    );
    expect(first.code).toBe(0);
    const cleared = await cli(
      root,
      paneEnv(PANE_A, PID_A, 'session-two'),
      'seat',
      'builder',
      '--up',
      'b',
    );
    expect(cleared.code).toBe(0);
    expect((await holderOf(root, 'builder')).session).toBe('session-two');
    // a restarted Claude in the same pane has a new pid: the pane still says it is the same seat
    const restarted = await cli(
      root,
      paneEnv(PANE_A, PID_B, 'session-three'),
      'seat',
      'builder',
      '--up',
      'c',
    );
    expect(restarted.code).toBe(0);
    const holder = await holderOf(root, 'builder');
    expect(holder.session).toBe('session-three');
    expect(holder.pid).toBe(PID_B);
    expect(await bulletOf(root, 'builder')).toMatch(/ · A7B2 · acme builder\.\*\* c$/);
    expect(await loggedBlocks(root)).toEqual([]);
  });

  it('(b2) outside iTerm the pid is the holder: a new session id with the same pid is the same holder, another pid is not', async () => {
    const root = await makeBoard(true);
    expect(
      (await cli(root, noPaneEnv(PID_A, 'session-one'), 'seat', 'builder', '--up', 'a')).code,
    ).toBe(0);
    const cleared = await cli(
      root,
      noPaneEnv(PID_A, 'session-two'),
      'seat',
      'builder',
      '--up',
      'b',
    );
    expect(cleared.code).toBe(0);
    expect(await loggedBlocks(root)).toEqual([]);

    const before = await snapshot(root);
    const other = await cli(root, noPaneEnv(PID_B), 'seat', 'builder', '--up', 'c');
    expect(other.code).toBe(1);
    // the holder's pane is its session id; the caller has none, and the refusal says so
    // rather than inventing a tag
    expect(other.err).toBe(
      'builder is held by SESS · acme builder (UP 2026-09-02 22:41Z); you are (no pane) · acme' +
        ' — if it is dead, re-run with --force (audited in the log)\n',
    );
    expect(await snapshot(root)).toEqual(before);
  });

  it('(c) ANOTHER live pane: exit 1 naming both, STATE.md and seats.yml byte-identical; --force takes it with one audit block', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    const before = await snapshot(root);

    const refused = await cli(root, ENV_B, 'seat', 'builder', '--up', 'me too');
    expect(refused.code).toBe(1);
    // the two panes share their first four characters, so BOTH tags widen — the refusal never
    // shows two panes as the same `A7B2`
    expect(refused.err).toBe(
      'builder is held by A7B2A3 · acme builder (UP 2026-09-02 22:41Z); you are A7B2B4 · acme' +
        ' — if it is dead, re-run with --force (audited in the log)\n',
    );
    expect(refused.out).toBe('');
    expect(await snapshot(root)).toEqual(before);
    expect(await loggedBlocks(root)).toEqual([]);

    const forced = await cli(
      root,
      ENV_B,
      'seat',
      'builder',
      '--up',
      'taking it',
      '--force',
      '--json',
    );
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out)).toMatchObject({
      released: null,
      audit: 'seat --up --force over a live holder',
    });
    const blocks = await loggedBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      seat: 'BUILDER',
      title: 'seat --up --force over a live holder',
      text: 'A7B2A3 · acme builder (UP 2026-09-02 22:41Z) — alive',
    });
    // the log is git-tracked: it names the old holder by label, never by pane, session, pid or host
    const logged = JSON.stringify(blocks);
    for (const secret of [PANE_A, PANE_B, SESSION_A, SESSION_B, 'pid=', 'host=']) {
      expect(logged).not.toContain(secret);
    }
    expect((await holderOf(root, 'builder')).pane).toBe(PANE_B);
    expect((await readLeases(root)).map((l) => l.resource)).toEqual(['seat:builder']);
    expect(await bulletOf(root, 'builder')).toMatch(/ · A7B2 · acme builder\.\*\* taking it$/);
  });

  it('(d) a holder whose process is gone is taken over without --force, and audited: dead: no process', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    await patchHolder(root, 'builder', { pid: 99999999 });

    const taken = await cli(root, ENV_B, 'seat', 'builder', '--up', 'taking over', '--json');
    expect(taken.code).toBe(0);
    expect(JSON.parse(taken.out)).toMatchObject({ audit: 'seat --up over a dead holder' });
    const blocks = await loggedBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      seat: 'BUILDER',
      title: 'seat --up over a dead holder',
      text: 'A7B2A3 · acme builder (UP 2026-09-02 22:41Z) — dead: no process',
    });
    expect((await holderOf(root, 'builder')).pane).toBe(PANE_B);
  });

  it('(d2) a live pid whose start time is not the recorded one is a REUSED pid: dead: pid reused', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    // pid A is this very process — alive — but the lease says it started in 1970
    await patchHolder(root, 'builder', { start: 'Thu Jan  1 00:00:00 1970' });

    const taken = await cli(root, ENV_B, 'seat', 'builder', '--up', 'taking over');
    expect(taken.code).toBe(0);
    const blocks = await loggedBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('A7B2A3 · acme builder (UP 2026-09-02 22:41Z) — dead: pid reused');
  });

  it('(d3) a holder that cannot be measured (another host) is NOT dead: refused naming why; --force takes it, audited', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    await patchHolder(root, 'builder', { host: 'some-other-machine' });
    const before = await snapshot(root);

    const refused = await cli(root, ENV_B, 'seat', 'builder', '--up', 'me too');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('(unknown: other host)');
    expect(await snapshot(root)).toEqual(before);
    expect(await loggedBlocks(root)).toEqual([]);

    const forced = await cli(root, ENV_B, 'seat', 'builder', '--up', 'taking it', '--force');
    expect(forced.code).toBe(0);
    const blocks = await loggedBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ title: 'seat --up --force over a live holder' });
    expect(blocks[0]?.text).toContain('unknown: other host');
  });

  it('(e) a pane that holds builder cannot also take reviewer — with --force too; --from builder moves it in one write', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    const before = await snapshot(root);

    const refusal =
      'seat: A7B2 · acme already holds builder — re-run with --from builder to move it to reviewer' +
      ' (--force does not bypass this)\n';
    const plain = await cli(root, ENV_A, 'seat', 'reviewer', '--up', 'reviewing');
    expect(plain.code).toBe(1);
    expect(plain.err).toBe(refusal);
    const forced = await cli(root, ENV_A, 'seat', 'reviewer', '--up', 'reviewing', '--force');
    expect(forced.code).toBe(1);
    expect(forced.err).toBe(refusal);
    expect(await snapshot(root)).toEqual(before);

    const moved = await cli(
      root,
      ENV_A,
      'seat',
      'reviewer',
      '--up',
      'reviewing',
      '--from',
      'builder',
    );
    expect(moved.code).toBe(0);
    expect(moved.out).toBe(
      'restamped SEATS [seatboard] reviewer: UP 2026-09-02 22:41Z · A7B2 · acme reviewer\n' +
        'restamped SEATS [seatboard] builder: DOWN 2026-09-02 22:41Z (moved to reviewer)\n',
    );
    // builder is DOWN with the stand-down text, its lease is gone, reviewer holds one lease
    expect(await bulletOf(root, 'builder')).toBe(
      '- **[seatboard] builder: DOWN 2026-09-02 22:41Z.** moved to reviewer in the same pane',
    );
    const state = await readFile(localState(root), 'utf8');
    expect(state).toContain('in-flight: see reviewer');
    expect(state).toContain('owes: see reviewer');
    expect(await bulletOf(root, 'reviewer')).toBe(
      '- **[seatboard] reviewer: UP 2026-09-02 22:41Z · A7B2 · acme reviewer.** reviewing',
    );
    expect((await readLeases(root)).map((l) => l.resource)).toEqual(['seat:reviewer']);
    expect((await holderOf(root, 'reviewer')).pane).toBe(PANE_A);
    // a move is not a takeover: nothing was over-written, so nothing is audited
    expect(await loggedBlocks(root)).toEqual([]);
  });

  it('(e2) --from reports itself in --json, matches the seat case-insensitively, and refuses a seat this pane does not hold', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'holding RCB-197')).code).toBe(0);
    expect((await cli(root, ENV_C, 'seat', 'ops', '--up', 'watching')).code).toBe(0);
    const before = await snapshot(root);

    // ops is held, but by ANOTHER pane: not a seat this pane may move
    const notMine = await cli(root, ENV_A, 'seat', 'reviewer', '--up', 'x', '--from', 'ops');
    expect(notMine.code).toBe(1);
    expect(notMine.err).toBe('seat: --from ops is not a seat you hold (you are A7B2 · acme)\n');
    // a seat nobody holds is not one either
    const nobody = await cli(root, ENV_A, 'seat', 'reviewer', '--up', 'x', '--from', 'ghost');
    expect(nobody.code).toBe(1);
    expect(nobody.err).toBe('seat: --from ghost is not a seat you hold (you are A7B2 · acme)\n');
    expect(await snapshot(root)).toEqual(before);

    const moved = await cli(
      root,
      ENV_A,
      'seat',
      'reviewer',
      '--up',
      'x',
      '--from',
      'BUILDER',
      '--json',
    );
    expect(moved.code).toBe(0);
    expect(JSON.parse(moved.out)).toMatchObject({
      name: 'reviewer',
      released: 'builder',
      audit: null,
    });
    expect((await readLeases(root)).map((l) => l.resource).sort()).toEqual([
      'seat:ops',
      'seat:reviewer',
    ]);
  });

  it('(e3) --from on a board with no local layer is refused (no holders are recorded, so there is nothing to move); nothing is written', async () => {
    const root = await makeBoard(false);
    const up = await cli(root, ENV_A, 'seat', 'reviewer', '--up', 'x', '--from', 'builder');
    expect(up.code).toBe(1);
    expect(up.err).toBe('seat: --from needs a local layer (.repoboard/local/)\n');
    expect(existsSync(join(root, '.repoboard', 'STATE.md'))).toBe(false);
    expect(existsSync(localDir(root))).toBe(false);
  });

  it('(f) --pane: the first 4 (or 6) characters of this pane are accepted, any other value is refused before anything is written', async () => {
    const root = await makeBoard(true);
    const ok4 = await cli(root, ENV_A, 'seat', 'builder', '--up', 'a', '--pane', 'a7b2');
    expect(ok4.code).toBe(0);
    const ok6 = await cli(root, ENV_A, 'seat', 'builder', '--up', 'b', '--pane', 'A7B2A3');
    expect(ok6.code).toBe(0);
    const before = await snapshot(root);

    const wrong = await cli(root, ENV_A, 'seat', 'builder', '--up', 'c', '--pane', 'ZZZZ');
    expect(wrong.code).toBe(1);
    // RCB-207: the refusal ends `; you are <label>` — the very label `seat whoami` prints here
    expect(wrong.err).toBe(
      'seat: --pane ZZZZ does not match this pane (A7B2); you are A7B2 · acme builder\n',
    );
    const whoami = await cli(root, ENV_A, 'seat', 'whoami');
    expect(whoami.out).toBe('A7B2 · acme builder\n');
    // the pane that shares only four characters is refused at six
    const sibling = await cli(root, ENV_A, 'seat', 'builder', '--up', 'c', '--pane', 'A7B2B4');
    expect(sibling.code).toBe(1);
    expect(sibling.err).toBe(
      'seat: --pane A7B2B4 does not match this pane (A7B2A3); you are A7B2 · acme builder\n',
    );
    // a pane that holds nothing is told so, with the tag widened beside the live pane that shares it
    const holdsNothing = await cli(root, ENV_B, 'seat', 'ops', '--up', 'c', '--pane', 'ZZZZ');
    expect(holdsNothing.code).toBe(1);
    expect(holdsNothing.err).toBe(
      'seat: --pane ZZZZ does not match this pane (A7B2); you are A7B2B4 · no seat\n',
    );
    const short = await cli(root, ENV_A, 'seat', 'builder', '--up', 'c', '--pane', 'C71');
    expect(short.code).toBe(1);
    expect(short.err).toContain('--pane needs the first 4 (or 6) characters');
    expect(await snapshot(root)).toEqual(before);

    // no pane at all: nothing to assert against
    const paneless = await cli(
      root,
      noPaneEnv(PID_B),
      'seat',
      'ops',
      '--up',
      'a',
      '--pane',
      'A7B2',
    );
    expect(paneless.code).toBe(1);
    expect(paneless.err).toContain('this process has no pane id');
    expect((await readLeases(root)).map((l) => l.resource)).toEqual(['seat:builder']);
  });

  it('(f2) --pane and --from are only valid with --up: a usage error, exit 1, nothing written', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    const before = await snapshot(root);
    const down = 'stood down\nin-flight: none\nowes: none';
    for (const [verb, flag, value] of [
      ['--down', '--pane', 'A7B2'],
      ['--down', '--from', 'builder'],
      ['--update', '--pane', 'A7B2'],
      ['--update', '--from', 'builder'],
    ] as const) {
      const res = await cli(
        root,
        ENV_A,
        'seat',
        'builder',
        verb,
        verb === '--down' ? down : 'x',
        flag,
        value,
      );
      expect(res.code, `${verb} ${flag}`).toBe(1);
      expect(res.err, `${verb} ${flag}`).toContain(`seat: ${flag} is only valid with --up`);
    }
    expect(await snapshot(root)).toEqual(before);
  });

  it('(f3) a flag straight after --up/--down/--update is ONE line naming the order that works, nothing written; the flag-last twin succeeds (RCB-207)', async () => {
    // CONTROL (run by the seat): delete the pre-check loop at the top of `cmdSeat` — `parse` then
    // refuses with "Option '--up' argument is ambiguous." and the seat usage block. Exit code,
    // empty stdout and the untouched snapshot all still hold; the `expect(res.err, …).toBe(line)`
    // on the first case is what fails: that stderr is `repoboard seat: …` plus ~60 usage lines,
    // not the one `repoboard: seat: --up takes its text next: …` line.
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    const before = await snapshot(root);
    const order = (verb: string, tail: string) =>
      `repoboard: seat: ${verb} takes its text next: seat <name> ${verb} "<text>"${tail}\n`;
    for (const [argv, line] of [
      [['--up', '--pane', 'A7B2', 't'], order('--up', ' [--pane <tag>]')],
      [['--down', '--force', 't'], order('--down', '')],
      [['--update', '--force', 't'], order('--update', '')],
    ] as const) {
      const res = await cli(root, ENV_A, 'seat', 'builder', ...argv);
      expect(res.code, argv.join(' ')).toBe(1);
      expect(res.err, argv.join(' ')).toBe(line);
      expect(res.out, argv.join(' ')).toBe('');
    }
    expect(await snapshot(root)).toEqual(before);

    // the twins, flag last, are the same requests in the order that parses
    const down = 'stood down\nin-flight: none\nowes: none';
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 't', '--pane', 'A7B2')).code).toBe(0);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--update', 't', '--force')).code).toBe(0);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--down', down, '--force')).code).toBe(0);
  });

  it('(g) a dead lease widens nothing: pane B is A7B2 beside a dead A7B2A3, and A7B2B4 beside a live one', async () => {
    // CONTROL: drop the `dead` filter in `seatHolderLeases` — the dead lease then widens the tag
    // and the first assertion fails (the second is the live case, which must stay widened).
    const dead = await makeBoard(true);
    expect((await cli(dead, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    await patchHolder(dead, 'builder', { pid: 99999999 });
    const upDead = await cli(dead, ENV_B, 'seat', 'ops', '--up', 'b');
    expect(upDead.code).toBe(0);
    expect(await bulletOf(dead, 'ops')).toMatch(/ · A7B2 · acme ops\.\*\* b$/);

    const live = await makeBoard(true);
    expect((await cli(live, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    const upLive = await cli(live, ENV_B, 'seat', 'ops', '--up', 'b');
    expect(upLive.code).toBe(0);
    expect(await bulletOf(live, 'ops')).toMatch(/ · A7B2B4 · acme ops\.\*\* b$/);
  });

  it('(h) a --down by the HOLDER drops the lease, and the seat is then free', async () => {
    // RCB-198: this used to be "a --down by anyone is never guarded" and ran the --down as pane B.
    // A --down is the holder's now (seat-write.test.ts: another pane is refused unless --force),
    // so pane A — the holder — stands its own seat down.
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    const down = await cli(
      root,
      ENV_A,
      'seat',
      'builder',
      '--down',
      'stood down\nin-flight: none\nowes: none',
      '--json',
    );
    expect(down.code).toBe(0);
    expect(JSON.parse(down.out)).toMatchObject({ status: 'DOWN', released: null, audit: null });
    expect(await readLeases(root)).toEqual([]);
    // and the seat is free: a third pane claims it with no --force and no audit
    expect((await cli(root, ENV_C, 'seat', 'builder', '--up', 'c')).code).toBe(0);
    expect(await loggedBlocks(root)).toEqual([]);
  });

  it('(i) a lease for a seat whose bullet is DOWN (a stale lease) does not block a claim', async () => {
    const root = await makeBoard(true);
    expect((await cli(root, ENV_A, 'seat', 'builder', '--up', 'a')).code).toBe(0);
    const stale = await readFile(seatsFile(root), 'utf8');
    expect(
      (await cli(root, ENV_A, 'seat', 'builder', '--down', 'x\nin-flight: none\nowes: none')).code,
    ).toBe(0);
    // the bullet says DOWN but the lease is back (a seats.yml write that outlived its STATE write)
    await writeFile(seatsFile(root), stale, 'utf8');
    const up = await cli(root, ENV_B, 'seat', 'builder', '--up', 'b');
    expect(up.code).toBe(0);
    expect(await loggedBlocks(root)).toEqual([]);
    expect((await holderOf(root, 'builder')).pane).toBe(PANE_B);
  });

  it('(j) RACE: two panes --up the same seat at the same moment — exactly one wins, ten rounds', async () => {
    // CONTROL: 9e18367's CLI decides on the STATE.md it loaded at open, outside the locks, so both
    // read "no bullet" and both write: some round has two exit 0s and this fails.
    for (let round = 0; round < 10; round++) {
      const root = await makeBoard(true);
      const [a, b] = await Promise.all([
        cli(root, ENV_A, 'seat', 'builder', '--up', 'from A'),
        cli(root, ENV_B, 'seat', 'builder', '--up', 'from B'),
      ]);
      expect([a.code, b.code].sort(), `round ${round}: ${a.err}${b.err}`).toEqual([0, 1]);
      const [winner, loser] = a.code === 0 ? [a, b] : [b, a];
      expect(winner.out, `round ${round}`).toContain('restamped SEATS [seatboard] builder: UP');
      expect(loser.err, `round ${round}`).toContain('builder is held by');
      const leases = await readLeases(root);
      expect(leases, `round ${round}`).toHaveLength(1);
      expect(parseHolder(leases[0]?.holder ?? '').pane, `round ${round}`).toBe(
        a.code === 0 ? PANE_A : PANE_B,
      );
      expect(await loggedBlocks(root), `round ${round}`).toEqual([]);
      // one seat, one bullet: the loser's text is not in the record
      const state = await readFile(localState(root), 'utf8');
      expect(state.split('builder: UP')).toHaveLength(2);
    }
  }, 120_000);
});
