/**
 * RCB-184 slice 1: a member board reads its home board's seats, read-only. A member's
 * `board.yml` carries `workspace: ../acme` (the home's root); `seat list` then shows the home's
 * OWN seats after the member's, `[acme] coordinator`, read live from the home's STATE.md and
 * `seats.yml`; `check` judges the link (`seat-copy`, `seat-home-unreadable`,
 * `seat-home-not-member`) and `stale-state` stops counting the home's log blocks.
 *
 * Every board is a fixture under `os.tmpdir()`: `acme` (the home, whose `repos:` lists `demo`) and
 * `demo` (the member). Nothing outside the directory a test created is read or written, and the
 * home tree is hashed before and after to prove the read wrote nothing. The clock is fixed.
 *
 * CONTROLS (run by the seat, not part of the suite): (1) in `readHome` return `null` — every
 * keyed test fails, every key-absent test still passes; (2) in `newestMomentOf` ignore nothing
 * (drop the `isHomeBlock` skip) — the stale-state test fails; (3) make it ignore EVERY block
 * (`continue` unconditionally) — the "own block still stale" test fails (the other direction);
 * (4) make `home.load(false)` a `load(true)` — the byte-identical test fails or hangs on a watcher.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  appendLogBlock,
  dailyLogHeader,
  defaultBoardConfig,
  type Finding,
  formatHolder,
  formatLogBlock,
  initialStateText,
  type SeatHolder,
  type SeatListRow,
  serializeBoard,
  serializeLeases,
  setStateSection,
} from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { processStartTime } from '../src/holder.js';
import { localDir } from '../src/local.js';

/** The fixture clock: after every stamp and block below. */
const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = '2026-10-05';
const BARE_ENV: Record<string, string> = { REPOBOARD_ACTOR: 'test-actor' };
const PANE = 'A7B2A3F2-1B2D-4E5F-8A9B-0C1D2E3F4A5B';

const HOME_KINDS: readonly Finding['kind'][] = [
  'seat-copy',
  'seat-home-unreadable',
  'seat-home-not-member',
];

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

async function cli(root: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, { cwd: root, stdout, stderr, env: BARE_ENV, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

/** `.repoboard/STATE.md` with `seats` as its SEATS section, stamped `at`. */
async function writeState(root: string, seats: string, at: string): Promise<void> {
  const opts = { now: new Date(at), actor: 'test-actor' };
  const made = setStateSection(initialStateText(opts), 'seats', seats, opts);
  if (!made.ok) throw new Error(made.error);
  await writeFile(join(root, '.repoboard', 'STATE.md'), made.text, 'utf8');
}

async function writeBoard(root: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.repoboard', 'cards'), { recursive: true });
  await writeFile(
    join(root, '.repoboard', 'board.yml'),
    serializeBoard({ ...defaultBoardConfig(), ...config }),
    'utf8',
  );
}

/** A daily log file under `.repoboard/log/` holding one block per entry, in the shape `repoboard log` writes. */
async function writeLog(
  root: string,
  blocks: readonly { seat: string; ts: string; repo: string }[],
): Promise<void> {
  let text = `${dailyLogHeader(DAY)}\n`;
  for (const b of blocks) {
    text = appendLogBlock(text, formatLogBlock({ ...b, title: 'note', text: 'x' }));
  }
  await mkdir(join(root, '.repoboard', 'log'), { recursive: true });
  await writeFile(join(root, '.repoboard', 'log', `${DAY}.md`), text, 'utf8');
}

/** The member's SEATS: its own seat, a stale COPY of the home's coordinator, a third board's seat. */
const DEMO_SEATS = [
  '- **[demo] builder: UP 2026-10-05 09:00Z.** building',
  '- **[acme] coordinator: DOWN 2026-10-04 09:00Z.** stale copy',
  '  in-flight: none',
  '  owes: none',
  '- **[other] scout: UP 2026-10-05 09:30Z.** reading',
].join('\n');

/** The home's SEATS: its coordinator (UP), a bare seat, and a bullet it keeps for the member. */
const ACME_SEATS = [
  '- **[acme] coordinator: UP 2026-10-05 11:00Z · A7B2 · acme coordinator.** coordinating',
  '- **ops: DOWN 2026-10-05 10:00Z.** done',
  '  in-flight: none',
  '  owes: none',
  "- **[demo] builder: UP 2026-10-05 08:00Z.** the member's seat, noted here",
].join('\n');

interface Fixture {
  base: string;
  acme: string;
  demo: string;
}

interface FixtureOptions {
  /** The member's `workspace:` text; `null` = the key is absent. */
  workspace: string | null;
  /** The home's `repos:`; `'relative'` lists `../demo`, `'absolute'` the absolute path, `'none'` omits `repos:`. */
  homeRepos?: 'relative' | 'absolute' | 'none';
  /** Write the home at all (false: `workspace:` names a path that is not there). */
  homeExists?: boolean;
  demoSeats?: string;
  demoLog?: readonly { seat: string; ts: string; repo: string }[];
}

async function fixture(opts: FixtureOptions): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'repoboard-home-'));
  dirs.push(base);
  const acme = join(base, 'acme');
  const demo = join(base, 'demo');
  const homeRepos = opts.homeRepos ?? 'relative';
  if (opts.homeExists !== false) {
    await writeBoard(acme, {
      name: 'acme',
      ...(homeRepos === 'none'
        ? {}
        : { repos: [{ key: 'demo', root: homeRepos === 'relative' ? '../demo' : demo }] }),
    });
    await writeState(acme, ACME_SEATS, '2026-10-05T11:30:00Z');
  }
  await writeBoard(demo, {
    name: 'demo',
    ...(opts.workspace === null ? {} : { workspace: opts.workspace }),
  });
  await writeState(demo, opts.demoSeats ?? DEMO_SEATS, '2026-10-05T10:00:00Z');
  if (opts.demoLog !== undefined) await writeLog(demo, opts.demoLog);
  return { base, acme, demo };
}

async function rows(root: string): Promise<SeatListRow[]> {
  const res = await cli(root, 'seat', 'list', '--json');
  expect(res.code).toBe(0);
  return JSON.parse(res.out) as SeatListRow[];
}

async function check(root: string): Promise<{ code: number; findings: Finding[]; err: string }> {
  const res = await cli(root, 'check', '--json');
  return { code: res.code, findings: JSON.parse(res.out) as Finding[], err: res.err };
}

const kinds = (findings: readonly Finding[], among: readonly string[]): string[] =>
  findings.filter((f) => among.includes(f.kind)).map((f) => f.kind);

/** Every file and directory under `root` as `path|mtimeMs|sha1` — any create, write, touch or delete changes it. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const st = await stat(path);
      const rel = relative(root, path);
      if (st.isDirectory()) {
        out.push(`${rel}/|${st.mtimeMs}`);
        await walk(path);
      } else {
        const sha = createHash('sha1')
          .update(await readFile(path))
          .digest('hex');
        out.push(`${rel}|${st.mtimeMs}|${sha}`);
      }
    }
  }
  await walk(root);
  return out;
}

describe('seat list reads the home board (RCB-184)', () => {
  it("shows the home's own seats after the member's, named [acme] <seat>, UP from the home", async () => {
    const fx = await fixture({ workspace: '../acme' });
    const list = await rows(fx.demo);
    // own rows first (the stale [acme] copy is hidden), then the home's OWN bullets — not the
    // `[demo] builder` bullet the home keeps for the member.
    expect(list.map((r) => [r.name, r.status])).toEqual([
      ['builder', 'UP'],
      ['scout', 'UP'],
      ['[acme] coordinator', 'UP'],
      ['[acme] ops', 'DOWN'],
    ]);
    const coordinator = list.find((r) => r.name === '[acme] coordinator');
    expect(coordinator?.stamp).toBe('2026-10-05 11:00Z');
    expect(coordinator?.label).toBe('A7B2 · acme coordinator');

    const text = await cli(fx.demo, 'seat', 'list');
    expect(text.code).toBe(0);
    expect(text.err).toBe('');
    expect(text.out).toMatch(/^\[acme\] coordinator\s+UP\s+2026-10-05 11:00Z/m);
    expect(text.out).not.toMatch(/^coordinator\s/m);
  });

  it("the home's holders ride along: PANE and LIVE come from the HOME's seats.yml", async () => {
    const fx = await fixture({ workspace: '../acme' });
    await mkdir(localDir(fx.acme), { recursive: true });
    const holder: SeatHolder = {
      pane: PANE,
      session: null,
      start: await processStartTime(process.pid),
      host: hostname(),
      pid: process.pid,
    };
    await writeFile(
      join(localDir(fx.acme), 'seats.yml'),
      serializeLeases({
        leases: [
          {
            resource: 'seat:coordinator',
            holder: formatHolder(holder),
            since: '2026-10-05T08:00:00Z',
          },
        ],
        windows: [],
      }),
      'utf8',
    );
    const coordinator = (await rows(fx.demo)).find((r) => r.name === '[acme] coordinator');
    expect(coordinator?.tag).toBe('A7B2');
    expect(coordinator?.live).toEqual({ state: 'alive' });
    // and the member's own rows joined nothing from the home's file
    expect((await rows(fx.demo)).find((r) => r.name === 'builder')?.tag).toBeNull();
  });

  it('a seats.yml the home cannot read is a stderr warning naming workspace:, the rows still print', async () => {
    const fx = await fixture({ workspace: '../acme' });
    await mkdir(localDir(fx.acme), { recursive: true });
    await writeFile(join(localDir(fx.acme), 'seats.yml'), 'leases: [unclosed', 'utf8');
    const res = await cli(fx.demo, 'seat', 'list', '--json');
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/^warning: workspace: \.\.\/acme: /);
    const list = JSON.parse(res.out) as SeatListRow[];
    expect(list.map((r) => r.name)).toContain('[acme] coordinator');
    expect(list.find((r) => r.name === '[acme] coordinator')?.tag).toBeNull();
  });

  it('a [acme] coordinator copy in the member is hidden from the list, and check says seat-copy', async () => {
    const fx = await fixture({ workspace: '../acme' });
    expect((await rows(fx.demo)).filter((r) => r.name === 'coordinator')).toEqual([]);
    const { findings } = await check(fx.demo);
    const copies = findings.filter((f) => f.kind === 'seat-copy');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.level).toBe('warning');
    expect(copies[0]?.message).toContain('SEATS bullet 2 ([acme] coordinator)');
    expect(copies[0]?.message).toContain("delete it; the home's bullet is read live");
    expect(kinds(findings, HOME_KINDS)).toEqual(['seat-copy']);
  });

  it('the same copy WITHOUT the key is an ordinary row, and check says none of the three kinds', async () => {
    const fx = await fixture({ workspace: null });
    const list = await rows(fx.demo);
    expect(list.map((r) => [r.name, r.status])).toEqual([
      ['builder', 'UP'],
      ['coordinator', 'DOWN'],
      ['scout', 'UP'],
    ]);
    const { findings } = await check(fx.demo);
    expect(kinds(findings, HOME_KINDS)).toEqual([]);
  });
});

describe('stale-state and the home blocks (RCB-184)', () => {
  // demo's STATE stamp is 10:00Z; the blocks are 11:00Z.
  const homeBlock = { seat: 'coordinator', ts: '2026-10-05T11:00:00Z', repo: 'acme' };
  const ownBlock = { seat: 'builder', ts: '2026-10-05T11:00:00Z', repo: 'demo' };

  it("a [acme] coordinator block newer than the member's stamp is not stale with the key", async () => {
    const fx = await fixture({ workspace: '../acme', demoLog: [homeBlock] });
    const { findings } = await check(fx.demo);
    expect(findings.map((f) => f.kind)).not.toContain('stale-state');
  });

  it('the SAME block without the key is stale-state (the control, in the direction we fear)', async () => {
    const fx = await fixture({ workspace: null, demoLog: [homeBlock] });
    const { code, findings } = await check(fx.demo);
    expect(findings.map((f) => f.kind)).toContain('stale-state');
    expect(code).toBe(1);
  });

  it("the member's OWN newer block is still stale with the key — only the home's are ignored", async () => {
    const fx = await fixture({ workspace: '../acme', demoLog: [homeBlock, ownBlock] });
    const { code, findings } = await check(fx.demo);
    expect(findings.map((f) => f.kind)).toContain('stale-state');
    expect(code).toBe(1);
  });

  it('with the home unreadable its name is unknown, so nothing is ignored (and the finding says why)', async () => {
    const fx = await fixture({ workspace: '../missing', demoLog: [homeBlock] });
    const { findings } = await check(fx.demo);
    expect(findings.map((f) => f.kind)).toContain('stale-state');
    expect(findings.map((f) => f.kind)).toContain('seat-home-unreadable');
  });
});

describe('an unreadable or one-sided home (RCB-184)', () => {
  it('a home that is not there: seat-home-unreadable names the path; own rows still list; exit 0', async () => {
    const fx = await fixture({ workspace: '../missing', homeExists: false });
    const res = await cli(fx.demo, 'seat', 'list', '--json');
    expect(res.code).toBe(0);
    expect(res.err).toBe(
      'warning: workspace: ../missing: no .repoboard/ there — its seats are not listed\n',
    );
    const list = JSON.parse(res.out) as SeatListRow[];
    // the copy cannot be judged a copy (the home's name is unknown), so it stays an own row
    expect(list.map((r) => r.name)).toEqual(['builder', 'coordinator', 'scout']);

    const { findings } = await check(fx.demo);
    const unreadable = findings.filter((f) => f.kind === 'seat-home-unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.level).toBe('warning');
    expect(unreadable[0]?.message).toContain('workspace: ../missing');
    expect(kinds(findings, HOME_KINDS)).toEqual(['seat-home-unreadable']);
  });

  it('a home with no STATE.md, or a board.yml that does not parse, is unreadable too — never an empty list', async () => {
    const noState = await fixture({ workspace: '../acme' });
    await rm(join(noState.acme, '.repoboard', 'STATE.md'));
    const a = await cli(noState.demo, 'seat', 'list');
    expect(a.err).toContain('workspace: ../acme: .repoboard/STATE.md: not found');
    expect(a.out).not.toContain('[acme]');

    const badBoard = await fixture({ workspace: '../acme' });
    await writeFile(join(badBoard.acme, '.repoboard', 'board.yml'), 'columns: []\n', 'utf8');
    const b = await cli(badBoard.demo, 'seat', 'list');
    expect(b.code).toBe(0);
    expect(b.err).toContain('workspace: ../acme: .repoboard/board.yml: ');
    expect(b.out).not.toContain('[acme]');
    const { findings } = await check(badBoard.demo);
    expect(kinds(findings, HOME_KINDS)).toEqual(['seat-home-unreadable']);
  });

  it('a home whose repos: does not list this repo: seat-home-not-member (its seats still list)', async () => {
    const fx = await fixture({ workspace: '../acme', homeRepos: 'none' });
    const { findings } = await check(fx.demo);
    const notMember = findings.filter((f) => f.kind === 'seat-home-not-member');
    expect(notMember).toHaveLength(1);
    expect(notMember[0]?.level).toBe('warning');
    expect(notMember[0]?.message).toContain('home board acme (workspace: ../acme)');
    expect((await rows(fx.demo)).map((r) => r.name)).toContain('[acme] coordinator');
  });

  it('a home that lists this repo by an ABSOLUTE root is a member too, and so is a relative one', async () => {
    for (const homeRepos of ['relative', 'absolute'] as const) {
      const fx = await fixture({ workspace: '../acme', homeRepos });
      const { findings } = await check(fx.demo);
      expect(kinds(findings, HOME_KINDS)).toEqual(['seat-copy']);
    }
  });

  it('a home that lists a DIFFERENT repo is not-member', async () => {
    const fx = await fixture({ workspace: '../acme' });
    await writeBoard(fx.acme, {
      name: 'acme',
      repos: [{ key: 'elsewhere', root: '../elsewhere' }],
    });
    const { findings } = await check(fx.demo);
    expect(kinds(findings, HOME_KINDS)).toEqual(['seat-copy', 'seat-home-not-member']);
  });
});

describe('the home is only ever read (RCB-184)', () => {
  it('the home tree is byte-identical after seat list and check, with a local layer, cards, logs and seats.yml', async () => {
    const fx = await fixture({ workspace: '../acme' });
    // everything a home may carry: a local layer with its own seats.yml, a log, a card, leases.
    await mkdir(join(localDir(fx.acme), 'log'), { recursive: true });
    await writeFile(
      join(localDir(fx.acme), 'seats.yml'),
      serializeLeases({ leases: [], windows: [] }),
      'utf8',
    );
    await writeFile(join(localDir(fx.acme), 'RIG.md'), '# rig\n', 'utf8');
    await writeLog(fx.acme, [{ seat: 'coordinator', ts: '2026-10-05T11:00:00Z', repo: 'acme' }]);
    await writeFile(join(fx.acme, '.repoboard', 'leases.yml'), 'leases: []\nwindows: []\n', 'utf8');
    await writeFile(
      join(fx.acme, '.repoboard', 'cards', 'RB-1.md'),
      [
        '---',
        'id: RB-1',
        'title: "A card"',
        'status: todo',
        'created: 2026-10-05T08:00:00Z',
        'updated: 2026-10-05T08:00:00Z',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
      'utf8',
    );

    const before = await snapshot(fx.acme);
    // not vacuous: the fixture is a real tree, and the snapshot sees a change when there is one
    expect(before.length).toBeGreaterThanOrEqual(10);

    expect((await cli(fx.demo, 'seat', 'list')).code).toBe(0);
    expect((await cli(fx.demo, 'seat', 'list', '--json')).code).toBe(0);
    await check(fx.demo);
    expect((await cli(fx.demo, 'check')).out).toContain('seat-copy');
    expect((await cli(fx.demo, 'seat', 'list')).out).toContain('[acme] coordinator');

    expect(await snapshot(fx.acme)).toEqual(before);

    // the snapshot catches a one-byte write and a new file (so equality above means something)
    await writeFile(
      join(fx.acme, '.repoboard', 'leases.yml'),
      'leases: []\nwindows: [ ]\n',
      'utf8',
    );
    expect(await snapshot(fx.acme)).not.toEqual(before);
  });

  it('a home that is missing is not created by looking for it', async () => {
    const fx = await fixture({ workspace: '../missing', homeExists: false });
    await cli(fx.demo, 'seat', 'list');
    await check(fx.demo);
    expect(await readdir(fx.base)).toEqual(['demo']);
  });
});

describe('key absent: nothing changes (RCB-184)', () => {
  it('seat list and check on a board with no workspace: key are what they were — the home beside it is never looked at', async () => {
    const withHomeBeside = await fixture({ workspace: null });
    const alone = await fixture({ workspace: null });
    await rm(alone.acme, { recursive: true, force: true });

    for (const argv of [
      ['seat', 'list'],
      ['seat', 'list', '--json'],
      ['check'],
      ['check', '--json'],
    ]) {
      const a = await cli(withHomeBeside.demo, ...argv);
      const b = await cli(alone.demo, ...argv);
      expect(a).toEqual(b);
    }
    const { findings } = await check(withHomeBeside.demo);
    expect(kinds(findings, HOME_KINDS)).toEqual([]);
  });
});
