/**
 * RCB-96 B (plan docs/SYSTEMS-FLOW-PLAN.md §3.2): the server I/O shell around core's pure
 * detectors (brief A, `packages/core/src/systems-detect.ts`) — `detectSystems` reads the fixed
 * candidate-file list through `resolveRepoPath`, and `runDetect` dry-runs by default, merging
 * into `.repoboard/systems.yml` with provenance only when `--apply` is given (non-negotiable 5).
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSystems } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolveRefSpec } from '../src/refs.js';
import { detectSystems } from '../src/systems-detect.js';
import { makeTempDir, makeTempRepoboard, NOW, type TempRepo } from './helpers.js';

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

/** Brief §"packages/server/test/systems-detect.test.ts": the rich, two-workspace fixture that
 * exercises every detector at once. */
async function writeFixture(root: string): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2),
  );
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  await mkdir(join(root, 'packages', 'web'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dependencies: { vite: '^5.0.0' } }, null, 2),
  );
  await writeFile(
    join(root, 'packages', 'web', 'vite.config.ts'),
    'export default { server: { port: 5173 } }\n',
  );

  await mkdir(join(root, 'packages', 'api'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: 'api', dependencies: { hono: '^4.0.0' } }, null, 2),
  );
  await writeFile(
    join(root, 'packages', 'api', 'wrangler.jsonc'),
    [
      '{',
      '  // cloudflare worker config',
      '  "name": "worker",',
      '  "hyperdrive": [{ "binding": "HYPERDRIVE", "database_name": "acme_db" }],',
      '  "kv_namespaces": [{ "binding": "CACHE", "id": "abc123" }],',
      '  "vars": {',
      '    "ACME_API_KEY": "xxx",',
      '    "BASE_URL": "https://acme.example.com"',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'packages', 'api', 'Dockerfile'),
    'FROM node:20-alpine\nWORKDIR /app\n',
  );
  await writeFile(
    join(root, 'packages', 'api', 'drizzle.config.ts'),
    "export default { dialect: 'postgresql' }\n",
  );

  await writeFile(
    join(root, 'docker-compose.yml'),
    [
      'services:',
      '  postgres:',
      '    image: postgres:15',
      '    ports:',
      '      - "5432:5432"',
      '  redis:',
      '    image: redis:7',
      '  app:',
      '    build: .',
      '    depends_on:',
      '      - postgres',
      '      - redis',
      '',
    ].join('\n'),
  );

  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(
    join(root, '.github', 'workflows', 'ci.yml'),
    ['name: CI', 'jobs:', '  deploy:', '    steps:', '      - run: wrangler deploy', ''].join('\n'),
  );

  await writeFile(join(root, '.env.example'), 'STRIPE_API_KEY=\nDATABASE_URL=\n');
}

const EXPECTED_FILES = [
  'package.json',
  'packages/api/package.json',
  'packages/web/package.json',
  '.env.example',
  'packages/api/wrangler.jsonc',
  'packages/api/Dockerfile',
  'packages/api/drizzle.config.ts',
  'packages/web/vite.config.ts',
  'docker-compose.yml',
  '.github/workflows/ci.yml',
];

const EXPECTED_IDS = [
  'acme',
  'acme-db',
  'api',
  'app',
  'cache',
  'ci',
  'postgres',
  'redis',
  'stripe',
  'web',
  'worker',
];

async function fixtureRepo(): Promise<TempRepo> {
  const repo = await makeTempRepoboard();
  await writeFixture(repo.root);
  return repo;
}

describe('systems detect (RCB-96)', () => {
  it('detectSystems: fixed file order; candidate ids; runtime hints; external/unclassified; ci→worker resolved', async () => {
    const repo = await fixtureRepo();
    try {
      const { files, candidates } = await detectSystems(repo.root);
      expect(files).toEqual(EXPECTED_FILES);
      expect(candidates.systems.map((s) => s.id).sort()).toEqual(EXPECTED_IDS);

      const api = candidates.systems.find((s) => s.id === 'api');
      expect(api?.runtime.prod).toBe('docker node:20-alpine'); // Dockerfile hint

      const web = candidates.systems.find((s) => s.id === 'web');
      expect(web?.runtime.dev).toBe('vite dev :5173'); // vite.config.ts hint

      expect(candidates.systems.find((s) => s.id === 'acme')).toMatchObject({
        kind: 'external',
        name: 'ACME',
      }); // ACME_API_KEY → acme external

      expect(candidates.unclassified).toContainEqual({
        file: '.env.example',
        what: '.env.example: DATABASE_URL — a URL, not a system',
      });

      expect(candidates.connections).toContainEqual({
        from: 'ci',
        to: 'worker',
        via: 'wrangler deploy',
        env: ['dev', 'prod'],
        detected: '.github/workflows/ci.yml',
      });
    } finally {
      await repo.cleanup();
    }
  });

  // RCB-177: evidence is the LINES a value was read from, not the file (and never a `file@key`
  // no ref can resolve): each located row's `detected` string is also its pointer, and both read
  // back through the real ref resolver to the very lines that hold the value.
  it('RCB-177 detectSystems: located evidence — `file:L<n>` / `file:L<a>-L<b>` as detected AND pointer, and each resolves to the line holding the value', async () => {
    const repo = await fixtureRepo();
    try {
      const { candidates } = await detectSystems(repo.root);
      const row = (id: string) => candidates.systems.find((s) => s.id === id);

      // packages/api/wrangler.jsonc lines: 4 hyperdrive record, 5 kv record, 7 ACME_API_KEY.
      expect(row('acme-db')).toMatchObject({
        detected: 'packages/api/wrangler.jsonc:L4',
        pointers: ['packages/api/wrangler.jsonc:L4'],
      });
      expect(row('cache')).toMatchObject({
        detected: 'packages/api/wrangler.jsonc:L5',
        pointers: ['packages/api/wrangler.jsonc:L5'],
      });
      expect(row('acme')).toMatchObject({
        detected: 'packages/api/wrangler.jsonc:L7',
        pointers: ['packages/api/wrangler.jsonc:L7'],
      });
      // docker-compose.yml: a service is its own indented block.
      expect(row('redis')).toMatchObject({ detected: 'docker-compose.yml:L6-L7' });
      expect(row('app')).toMatchObject({ detected: 'docker-compose.yml:L8-L12' });
      // .env.example line 1; the drizzle dialect line is 1 of its file. `postgres` is proposed by
      // BOTH drizzle (read first: the workspace files come before compose) and compose — first
      // wins for `detected`, and both located ranges are kept as pointers, in that order.
      expect(row('stripe')).toMatchObject({ detected: '.env.example:L1' });
      expect(row('postgres')).toMatchObject({
        detected: 'packages/api/drizzle.config.ts:L1',
        pointers: ['packages/api/drizzle.config.ts:L1', 'docker-compose.yml:L2-L5'],
      });
      // What has no key to locate keeps the file: the worker IS its wrangler.jsonc.
      expect(row('worker')).toMatchObject({
        detected: 'packages/api/wrangler.jsonc',
        pointers: ['packages/api/wrangler.jsonc'],
      });

      // CONTROL (this test): the detector recording `wrangler.jsonc@hyperdrive`, `docker-compose.yml@redis`
      // and the like again fails every `detected` assertion above. The connections carry the same
      // lines as their own pointers.
      expect(candidates.connections).toContainEqual({
        from: 'worker',
        to: 'acme-db',
        via: 'hyperdrive binding HYPERDRIVE',
        env: ['dev', 'prod'],
        detected: 'packages/api/wrangler.jsonc:L4',
        pointers: ['packages/api/wrangler.jsonc:L4'],
      });
      expect(candidates.connections).toContainEqual({
        from: 'app',
        to: 'redis',
        via: 'depends_on',
        env: ['dev'],
        detected: 'docker-compose.yml:L8-L12',
        pointers: ['docker-compose.yml:L8-L12'],
      });

      // Every located pointer resolves, at exactly the lines it names, to text holding the value.
      const wanted: [string, string][] = [
        ['packages/api/wrangler.jsonc:L4', 'acme_db'],
        ['packages/api/wrangler.jsonc:L5', 'CACHE'],
        ['packages/api/wrangler.jsonc:L7', 'ACME_API_KEY'],
        ['docker-compose.yml:L6-L7', 'redis:7'],
        ['docker-compose.yml:L8-L12', 'depends_on'],
        ['.env.example:L1', 'STRIPE_API_KEY'],
        ['packages/api/drizzle.config.ts:L1', 'postgresql'],
      ];
      for (const [spec, holds] of wanted) {
        const r = await resolveRefSpec(repo.root, spec);
        expect({ spec, error: r.error }).toEqual({ spec, error: null });
        expect({ spec, holds: r.text?.includes(holds) }).toEqual({ spec, holds: true });
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('RCB-177 --apply: every `detected` string and every pointer the detector wrote resolves through the ref resolver (0 unresolvable, the `file@key` failure)', async () => {
    const repo = await fixtureRepo();
    try {
      const res = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(res.code).toBe(0);
      const parsed = parseSystems(
        await readFile(join(repo.root, '.repoboard', 'systems.yml'), 'utf8'),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');

      const specs: { where: string; spec: string }[] = [];
      for (const s of parsed.doc.systems) {
        if ('detected' in s.source)
          specs.push({ where: `${s.id} detected`, spec: s.source.detected });
        for (const p of s.pointers) specs.push({ where: `${s.id} pointer`, spec: p });
      }
      for (const c of parsed.doc.connections) {
        const name = `${c.from}→${c.to}`;
        if ('detected' in c.source)
          specs.push({ where: `${name} detected`, spec: c.source.detected });
        for (const p of c.pointers ?? []) specs.push({ where: `${name} pointer`, spec: p });
      }
      // sanity: the run wrote a lot of them, including connection pointers and line ranges.
      expect(specs.length).toBeGreaterThan(20);
      expect(specs.some((x) => x.where.endsWith('pointer') && x.where.includes('→'))).toBe(true);
      expect(specs.some((x) => /:L\d+-L\d+$/.test(x.spec))).toBe(true);

      // CONTROL: a located range that runs past its file (`lineEvidence` adding 1000 to `end`)
      // resolves to "line N is past the end", so this list is non-empty.
      const unresolved: string[] = [];
      for (const { where, spec } of specs) {
        const r = await resolveRefSpec(repo.root, spec);
        if (r.error !== null) unresolved.push(`${where}: ${spec} — ${r.error}`);
      }
      expect(unresolved).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('dry run through the CLI: table + the dry-run line, nothing written', async () => {
    const repo = await fixtureRepo();
    try {
      const before = await readdir(join(repo.root, '.repoboard'));
      const res = await repoboard(repo.root, 'systems', 'detect');
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/ID\s+KIND\s+LAYER\s+ENV\s+FROM/);
      expect(res.out).toContain(
        'dry run — nothing written; --apply merges into .repoboard/systems.yml',
      );
      await expect(stat(join(repo.root, '.repoboard', 'systems.yml'))).rejects.toThrow();
      const after = await readdir(join(repo.root, '.repoboard'));
      expect(after).toEqual(before); // a listing, not `git status`
    } finally {
      await repo.cleanup();
    }
  });

  it('--apply writes systems.yml with provenance on every row; a second --apply is byte-identical', async () => {
    const repo = await fixtureRepo();
    try {
      const path = join(repo.root, '.repoboard', 'systems.yml');
      const res = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(res.code).toBe(0);
      expect(res.out).toMatch(
        /wrote \.repoboard\/systems\.yml \(\d+ added, \d+ updated, \d+ hand rows kept\)/,
      );

      const text1 = await readFile(path, 'utf8');
      const parsed = parseSystems(text1);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.doc.systems.length).toBeGreaterThan(0);
      for (const row of parsed.doc.systems) {
        expect('detected' in row.source).toBe(true);
        if ('detected' in row.source) expect(row.source.at).toBe(NOW.toISOString());
      }
      for (const conn of parsed.doc.connections) {
        expect('detected' in conn.source).toBe(true);
        if ('detected' in conn.source) expect(conn.source.at).toBe(NOW.toISOString());
      }

      const res2 = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(res2.code).toBe(0);
      const text2 = await readFile(path, 'utf8');
      expect(text2).toBe(text1);
    } finally {
      await repo.cleanup();
    }
  });

  it('a hand row wins: owner and source untouched, the rest still get added', async () => {
    const repo = await fixtureRepo();
    try {
      const path = join(repo.root, '.repoboard', 'systems.yml');
      const handDoc = [
        'environments:',
        '  dev: { note: null }',
        '  prod: { note: null }',
        'systems:',
        '  - id: worker',
        '    name: worker',
        '    kind: worker',
        '    layer: edge',
        '    env: [dev, prod]',
        '    owner: keeper',
        '    source: { hand: someone, at: "2026-01-01T00:00:00.000Z" }',
        'connections: []',
        '',
      ].join('\n');
      await writeFile(path, handDoc);

      const res = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(res.code).toBe(0);
      expect(res.out).toContain('hand rows kept');

      const parsed = parseSystems(await readFile(path, 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      const worker = parsed.doc.systems.find((s) => s.id === 'worker');
      expect(worker?.owner).toBe('keeper');
      expect(worker?.source).toEqual({ hand: 'someone', at: '2026-01-01T00:00:00.000Z' });

      const ids = parsed.doc.systems.map((s) => s.id).sort();
      expect(ids).toEqual(EXPECTED_IDS); // worker kept (hand), the rest added around it
    } finally {
      await repo.cleanup();
    }
  });

  it('an invalid existing systems.yml: exit 1, its parse errors on stderr, file byte-identical', async () => {
    const repo = await fixtureRepo();
    try {
      const path = join(repo.root, '.repoboard', 'systems.yml');
      const bad = 'systems:\n  - id: "bad id with spaces"\n'; // no `environments` key: invalid
      await writeFile(path, bad);
      const before = await readFile(path, 'utf8');

      const res = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(res.code).toBe(1);
      expect(res.err.trim().length).toBeGreaterThan(0);

      const after = await readFile(path, 'utf8');
      expect(after).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('--root at a dir with no .repoboard/: dry run ok; --apply refuses and creates nothing', async () => {
    const dir = await makeTempDir('repoboard-systems-noboard-');
    const cwd = await makeTempDir('repoboard-systems-cwd-');
    dirs.push(dir, cwd);
    await writeFixture(dir);
    const dry = await repoboard(cwd, 'systems', 'detect', '--root', dir);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/ID\s+KIND\s+LAYER\s+ENV\s+FROM/);

    const before = (await readdir(dir)).sort();
    const apply = await repoboard(cwd, 'systems', 'detect', '--root', dir, '--apply');
    expect(apply.code).toBe(1);
    expect(apply.err).toContain('not a repoboard repo');
    expect(apply.err).toContain('has no .repoboard/');
    const after = (await readdir(dir)).sort();
    expect(after).toEqual(before);
  });

  it('--json prints DetectRun: keys files, candidates, plan, applied, path, errors', async () => {
    const repo = await fixtureRepo();
    try {
      const res = await repoboard(repo.root, 'systems', 'detect', '--json');
      expect(res.code).toBe(0);
      const data = JSON.parse(res.out) as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(
        ['applied', 'candidates', 'errors', 'files', 'path', 'plan'].sort(),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('RCB-162: a hand-rejected system is skipped by detect — --json plan.rejected names it, the written file never gains it, and the text report says "1 rejected kept out"', async () => {
    const repo = await fixtureRepo();
    try {
      const path = join(repo.root, '.repoboard', 'systems.yml');
      // `stripe` (from `.env.example`'s STRIPE_API_KEY) has no connection candidate touching
      // it anywhere in the fixture, so rejecting it skips exactly ONE candidate — the system
      // itself — making "1 rejected kept out" an exact, not just non-zero, count.
      const rejectingDoc = [
        'environments:',
        '  dev: { note: null }',
        '  prod: { note: null }',
        'systems: []',
        'connections: []',
        'rejected:',
        '  - id: stripe',
        '    why: "already provisioned elsewhere; do not track here"',
        '',
      ].join('\n');
      await writeFile(path, rejectingDoc);

      const dryJson = await repoboard(repo.root, 'systems', 'detect', '--json');
      expect(dryJson.code).toBe(0);
      const data = JSON.parse(dryJson.out) as { plan: { rejected: string[] } };
      expect(data.plan.rejected).toEqual(['stripe']);

      const dryText = await repoboard(repo.root, 'systems', 'detect');
      expect(dryText.code).toBe(0);
      expect(dryText.out).toContain('1 rejected kept out');

      const apply = await repoboard(repo.root, 'systems', 'detect', '--apply');
      expect(apply.code).toBe(0);
      expect(apply.out).toContain('1 rejected kept out');

      const parsed = parseSystems(await readFile(path, 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.doc.systems.some((s) => s.id === 'stripe')).toBe(false);
      expect(parsed.doc.rejected).toEqual([
        { id: 'stripe', why: 'already provisioned elsewhere; do not track here' },
      ]);
      // every OTHER expected id still landed — the rejection is scoped to `stripe` alone.
      const ids = parsed.doc.systems.map((s) => s.id).sort();
      expect(ids).toEqual(EXPECTED_IDS.filter((id) => id !== 'stripe'));
    } finally {
      await repo.cleanup();
    }
  });

  it('a workspace glob of ../outside/* reads no file outside root (resolveRepoPath, not join)', async () => {
    const parent = await makeTempDir('repoboard-systems-parent-');
    dirs.push(parent);
    const root = join(parent, 'root');
    const outsideDir = join(parent, 'outside', 'lib');
    await mkdir(root, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, 'package.json'),
      JSON.stringify({ name: 'outside-lib', dependencies: { hono: '^4' } }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root-pkg', workspaces: ['../outside/*'] }),
    );
    const { files } = await detectSystems(root);
    expect(files.some((f) => f.includes('outside'))).toBe(false);
  });
});
