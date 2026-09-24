import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyDetected,
  type Candidates,
  detectCompose,
  detectDockerfile,
  detectDrizzleConfig,
  detectEnvExample,
  detectPackageJson,
  detectPrismaSchema,
  detectViteConfig,
  detectWorkflow,
  detectWrangler,
  emptyCandidates,
  formatDetectReport,
  mergeCandidates,
  parseSystems,
  type SystemEnv,
  type SystemRow,
  type SystemsDoc,
  serializeSystems,
  staleDetected,
  toSystemId,
  workspaceGlobs,
} from '../src/index.js';

function detectFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/detect/${name}`, import.meta.url)), 'utf8');
}

function systemsFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/systems/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('systems detect (RCB-96)', () => {
  // -----------------------------------------------------------------------------------------
  // toSystemId
  // -----------------------------------------------------------------------------------------
  describe('toSystemId', () => {
    it('strips a leading @scope/, lowercases, collapses non [a-z0-9] runs to one -, trims', () => {
      expect(toSystemId('@hono/node-server')).toBe('node-server');
      expect(toSystemId('My Cool App!!')).toBe('my-cool-app');
      expect(toSystemId('detect-fixture-worker')).toBe('detect-fixture-worker');
      expect(toSystemId('')).toBe('unnamed');
      expect(toSystemId('---')).toBe('unnamed');
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectPackageJson
  // -----------------------------------------------------------------------------------------
  describe('detectPackageJson', () => {
    it('vite+react deps -> client/client', () => {
      const c = detectPackageJson('apps/web/package.json', detectFixture('package-web.json'));
      expect(c).toEqual({
        systems: [
          {
            id: 'detect-fixture-web',
            name: 'detect-fixture-web',
            kind: 'client',
            layer: 'client',
            env: ['dev', 'prod'],
            runtime: { dev: 'vite', prod: null },
            pointers: ['apps/web/package.json'],
            detected: 'apps/web/package.json',
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });

    it('hono+wrangler deps -> service/app', () => {
      const c = detectPackageJson('apps/api/package.json', detectFixture('package-api.json'));
      expect(c).toEqual({
        systems: [
          {
            id: 'detect-fixture-api',
            name: 'detect-fixture-api',
            kind: 'service',
            layer: 'app',
            env: ['dev', 'prod'],
            runtime: { dev: 'wrangler dev', prod: 'wrangler deploy' },
            pointers: ['apps/api/package.json'],
            detected: 'apps/api/package.json',
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // workspaceGlobs
  // -----------------------------------------------------------------------------------------
  describe('workspaceGlobs', () => {
    const rootPkg = detectFixture('package-root.json');

    it('reads pnpm-workspace.yaml packages: when given, dedups, drops ! entries', () => {
      const pnpmYaml = 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "!apps/archived"\n';
      expect(workspaceGlobs(rootPkg, pnpmYaml)).toEqual(['packages/*', 'apps/*']);
    });

    it('falls back to package.json workspaces when pnpm-workspace.yaml is null', () => {
      expect(workspaceGlobs(rootPkg, null)).toEqual(['packages/*', 'apps/*']);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectWrangler — jsonc, toml, equivalence, comment/URL survival, unknown TOML line
  // -----------------------------------------------------------------------------------------
  describe('detectWrangler', () => {
    const expectedJsonc = (rel: string): Candidates => ({
      systems: [
        {
          id: 'detect-fixture-worker',
          name: 'detect-fixture-worker',
          kind: 'worker',
          layer: 'edge',
          env: ['dev', 'prod'],
          runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
          pointers: [rel],
          detected: rel,
        },
        {
          id: 'hyperdrive',
          name: 'HYPERDRIVE',
          kind: 'db',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: `${rel}@hyperdrive`,
        },
        {
          id: 'cache',
          name: 'CACHE',
          kind: 'cache',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: `${rel}@kv_namespaces`,
        },
        {
          id: 'detect-fixture-queue',
          name: 'detect-fixture-queue',
          kind: 'queue',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: `${rel}@queues.producers`,
        },
        {
          id: 'detect-fixture-queue',
          name: 'detect-fixture-queue',
          kind: 'queue',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: `${rel}@queues.consumers`,
        },
        {
          id: 'stripe',
          name: 'STRIPE',
          kind: 'external',
          layer: 'external',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: `${rel}@STRIPE_API_KEY`,
        },
      ],
      connections: [
        {
          from: 'detect-fixture-worker',
          to: 'hyperdrive',
          via: 'hyperdrive binding HYPERDRIVE',
          env: ['dev', 'prod'],
          detected: `${rel}@hyperdrive`,
        },
        {
          from: 'detect-fixture-worker',
          to: 'cache',
          via: 'kv_namespaces binding CACHE',
          env: ['dev', 'prod'],
          detected: `${rel}@kv_namespaces`,
        },
        {
          from: 'detect-fixture-worker',
          to: 'detect-fixture-queue',
          via: 'queues.producers binding QUEUE_PRODUCER',
          env: ['dev', 'prod'],
          detected: `${rel}@queues.producers`,
        },
        {
          from: 'detect-fixture-queue',
          to: 'detect-fixture-worker',
          via: 'queues.consumers binding detect-fixture-queue',
          env: ['dev', 'prod'],
          detected: `${rel}@queues.consumers`,
        },
        {
          from: 'detect-fixture-worker',
          to: 'stripe',
          via: 'STRIPE_API_KEY',
          env: ['dev', 'prod'],
          detected: `${rel}@STRIPE_API_KEY`,
        },
      ],
      hints: [],
      unclassified: [],
    });

    it('jsonc: hyperdrive, kv, queues, vars — exact candidates; comments and a URL survive', () => {
      const c = detectWrangler('apps/api/wrangler.jsonc', detectFixture('wrangler.jsonc'));
      expect(c).toEqual(expectedJsonc('apps/api/wrangler.jsonc'));
    });

    // Inline, not a fixture file: `pnpm biome check --write` reformats checked-in .jsonc to
    // strict JSON (no trailing commas), which would silently erase what this case exercises.
    // A string literal's contents are inert to that reformatting.
    it('jsonc: a string-aware scanner strips trailing commas before JSON.parse', () => {
      const rel = 'apps/api/wrangler-trailing-comma.jsonc';
      const text = [
        '{',
        '  "name": "trailing-comma-worker",',
        '  "vars": {',
        '    "STRIPE_API_KEY": "sk_test_xxx",',
        '  },',
        '}',
        '',
      ].join('\n');
      const c = detectWrangler(rel, text);
      expect(c.unclassified).toEqual([]);
      expect(c.systems.map((s) => s.id)).toEqual(['trailing-comma-worker', 'stripe']);
    });

    it('toml: identical candidates to jsonc (modulo the file extension)', () => {
      const jsonc = detectWrangler('apps/api/wrangler.jsonc', detectFixture('wrangler.jsonc'));
      const toml = detectWrangler('apps/api/wrangler.toml', detectFixture('wrangler.toml'));
      const normalized = JSON.parse(
        JSON.stringify(jsonc).replaceAll('wrangler.jsonc', 'wrangler.toml'),
      );
      expect(normalized).toEqual(toml);
      expect(toml).toEqual(expectedJsonc('apps/api/wrangler.toml'));
    });

    it('toml: an unrecognized line becomes unclassified, never a throw', () => {
      const rel = 'apps/api/wrangler-bad-line.toml';
      const c = detectWrangler(rel, detectFixture('wrangler-bad-line.toml'));
      expect(c).toEqual({
        systems: [
          {
            id: 'detect-fixture-worker',
            name: 'detect-fixture-worker',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
            pointers: [rel],
            detected: rel,
          },
        ],
        connections: [],
        hints: [],
        unclassified: [{ file: rel, what: `${rel}:3: not understood` }],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectCompose
  // -----------------------------------------------------------------------------------------
  describe('detectCompose', () => {
    it('postgres (with ports), redis (no ports), an app (build + depends_on)', () => {
      const c = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      expect(c).toEqual({
        systems: [
          {
            id: 'postgres',
            name: 'postgres',
            kind: 'db',
            layer: 'data',
            env: ['dev'],
            runtime: { dev: 'postgres:16 :5433', prod: null },
            pointers: ['docker-compose.yml'],
            detected: 'docker-compose.yml@postgres',
          },
          {
            id: 'redis',
            name: 'redis',
            kind: 'cache',
            layer: 'data',
            env: ['dev'],
            runtime: { dev: 'redis:7', prod: null },
            pointers: ['docker-compose.yml'],
            detected: 'docker-compose.yml@redis',
          },
          {
            id: 'app',
            name: 'app',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: { dev: 'build .', prod: null },
            pointers: ['docker-compose.yml'],
            detected: 'docker-compose.yml@app',
          },
        ],
        connections: [
          {
            from: 'app',
            to: 'postgres',
            via: 'depends_on',
            env: ['dev'],
            detected: 'docker-compose.yml@app',
          },
          {
            from: 'app',
            to: 'redis',
            via: 'depends_on',
            env: ['dev'],
            detected: 'docker-compose.yml@app',
          },
        ],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectDockerfile
  // -----------------------------------------------------------------------------------------
  describe('detectDockerfile', () => {
    it('no system, one runtime hint for the containing dir', () => {
      const c = detectDockerfile('apps/api/Dockerfile', detectFixture('Dockerfile'));
      expect(c).toEqual({
        systems: [],
        connections: [],
        hints: [{ dir: 'apps/api', env: 'prod', value: 'docker node:20-slim' }],
        unclassified: [],
      } satisfies Candidates);
    });

    it('no FROM -> unclassified, never a throw', () => {
      const c = detectDockerfile('apps/api/Dockerfile', 'WORKDIR /app\n');
      expect(c).toEqual({
        systems: [],
        connections: [],
        hints: [],
        unclassified: [
          { file: 'apps/api/Dockerfile', what: 'apps/api/Dockerfile: no FROM instruction' },
        ],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectWorkflow
  // -----------------------------------------------------------------------------------------
  describe('detectWorkflow', () => {
    it('one ci system; wrangler deploy and drizzle-kit migrate run lines become connections', () => {
      const rel = '.github/workflows/ci.yml';
      const c = detectWorkflow(rel, detectFixture('ci.yml'));
      expect(c).toEqual({
        systems: [
          {
            id: 'deploy',
            name: 'deploy',
            kind: 'ci',
            layer: 'ops',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: rel,
          },
        ],
        connections: [
          { from: 'deploy', to: '@db', via: 'migrate', env: ['dev', 'prod'], detected: rel },
          {
            from: 'deploy',
            to: '@worker',
            via: 'wrangler deploy',
            env: ['dev', 'prod'],
            detected: rel,
          },
        ],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectEnvExample
  // -----------------------------------------------------------------------------------------
  describe('detectEnvExample', () => {
    it('*_API_KEY/*_ACCESS_TOKEN -> external; *_URL -> unclassified; others ignored', () => {
      const rel = '.env.example';
      const c = detectEnvExample(rel, detectFixture('.env.example'));
      expect(c).toEqual({
        systems: [
          {
            id: 'stripe',
            name: 'STRIPE',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: `${rel}@STRIPE_API_KEY`,
          },
          {
            id: 'github',
            name: 'GITHUB',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: `${rel}@GITHUB_ACCESS_TOKEN`,
          },
        ],
        connections: [],
        hints: [],
        unclassified: [{ file: rel, what: `${rel}: DATABASE_URL — a URL, not a system` }],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectViteConfig
  // -----------------------------------------------------------------------------------------
  describe('detectViteConfig', () => {
    it('port: N -> a dev runtime hint', () => {
      const c = detectViteConfig('apps/web/vite.config.ts', detectFixture('vite.config.ts'));
      expect(c).toEqual({
        systems: [],
        connections: [],
        hints: [{ dir: 'apps/web', env: 'dev', value: 'vite dev :5174' }],
        unclassified: [],
      } satisfies Candidates);
    });

    it('no port -> no output', () => {
      const c = detectViteConfig('apps/web/vite.config.ts', 'export default {};\n');
      expect(c).toEqual(emptyCandidates());
    });
  });

  // -----------------------------------------------------------------------------------------
  // detectDrizzleConfig / detectPrismaSchema
  // -----------------------------------------------------------------------------------------
  describe('detectDrizzleConfig', () => {
    it('dialect: "postgresql" -> the postgres db system', () => {
      const rel = 'apps/api/drizzle.config.ts';
      const c = detectDrizzleConfig(rel, detectFixture('drizzle.config.ts'));
      expect(c).toEqual({
        systems: [
          {
            id: 'postgres',
            name: 'postgres',
            kind: 'db',
            layer: 'data',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: rel,
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  describe('detectPrismaSchema', () => {
    it('provider = "postgresql" inside datasource (not the generator block) -> postgres', () => {
      const rel = 'apps/api/schema.prisma';
      const c = detectPrismaSchema(rel, detectFixture('schema.prisma'));
      expect(c).toEqual({
        systems: [
          {
            id: 'postgres',
            name: 'postgres',
            kind: 'db',
            layer: 'data',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: rel,
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  // -----------------------------------------------------------------------------------------
  // mergeCandidates
  // -----------------------------------------------------------------------------------------
  describe('mergeCandidates', () => {
    it('dedups systems by id, first wins, pointers unioned in order', () => {
      const a: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'shared',
            name: 'Shared A',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: { dev: 'a', prod: null },
            pointers: ['fileA'],
            detected: 'detA',
          },
        ],
      };
      const b: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'shared',
            name: 'Shared B',
            kind: 'db',
            layer: 'data',
            env: ['prod'],
            runtime: { dev: null, prod: 'b' },
            pointers: ['fileB'],
            detected: 'detB',
          },
        ],
      };
      const merged = mergeCandidates([a, b]);
      expect(merged.systems).toEqual([
        {
          id: 'shared',
          name: 'Shared A',
          kind: 'service',
          layer: 'app',
          env: ['dev'],
          runtime: { dev: 'a', prod: null },
          pointers: ['fileA', 'fileB'],
          detected: 'detA',
        },
      ]);
    });

    it('resolves @worker to the one worker system', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'wk1',
            name: 'wk1',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd1',
          },
          {
            id: 'ci',
            name: 'ci',
            kind: 'ci',
            layer: 'ops',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd2',
          },
        ],
        connections: [
          {
            from: 'ci',
            to: '@worker',
            via: 'wrangler deploy',
            env: ['dev', 'prod'],
            detected: 'ci.yml',
          },
        ],
      };
      const merged = mergeCandidates([c]);
      expect(merged.connections).toEqual([
        { from: 'ci', to: 'wk1', via: 'wrangler deploy', env: ['dev', 'prod'], detected: 'ci.yml' },
      ]);
      expect(merged.unclassified).toEqual([]);
    });

    it('zero worker systems -> the connection becomes unclassified', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'ci',
            name: 'ci',
            kind: 'ci',
            layer: 'ops',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd2',
          },
        ],
        connections: [
          {
            from: 'ci',
            to: '@worker',
            via: 'wrangler deploy',
            env: ['dev', 'prod'],
            detected: 'ci.yml',
          },
        ],
      };
      const merged = mergeCandidates([c]);
      expect(merged.connections).toEqual([]);
      expect(merged.unclassified).toEqual([
        { file: 'ci.yml', what: 'ci.yml: no unique worker system to connect to' },
      ]);
    });

    it('two worker systems -> ambiguous, the connection becomes unclassified', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'ci',
            name: 'ci',
            kind: 'ci',
            layer: 'ops',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd2',
          },
          {
            id: 'wk1',
            name: 'wk1',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd3',
          },
          {
            id: 'wk2',
            name: 'wk2',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'd4',
          },
        ],
        connections: [
          {
            from: 'ci',
            to: '@worker',
            via: 'wrangler deploy',
            env: ['dev', 'prod'],
            detected: 'ci.yml',
          },
        ],
      };
      const merged = mergeCandidates([c]);
      expect(merged.connections).toEqual([]);
      expect(merged.unclassified).toEqual([
        { file: 'ci.yml', what: 'ci.yml: no unique worker system to connect to' },
      ]);
    });

    it('attaches a hint to the system whose pointers include <dir>/package.json', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'api',
            name: 'api',
            kind: 'service',
            layer: 'app',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['apps/api/package.json'],
            detected: 'd',
          },
        ],
        hints: [{ dir: 'apps/api', env: 'dev', value: 'docker node:20-slim' }],
      };
      const merged = mergeCandidates([c]);
      expect(merged.systems[0]?.runtime).toEqual({ dev: 'docker node:20-slim', prod: null });
    });

    it('a hint never overwrites an already-set runtime env', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'api',
            name: 'api',
            kind: 'service',
            layer: 'app',
            env: ['dev', 'prod'],
            runtime: { dev: 'existing value', prod: null },
            pointers: ['apps/api/package.json'],
            detected: 'd',
          },
        ],
        hints: [{ dir: 'apps/api', env: 'dev', value: 'docker node:20-slim' }],
      };
      const merged = mergeCandidates([c]);
      expect(merged.systems[0]?.runtime).toEqual({ dev: 'existing value', prod: null });
    });

    it('an unmatched hint becomes unclassified', () => {
      const c: Candidates = {
        ...emptyCandidates(),
        hints: [{ dir: 'apps/nowhere', env: 'dev', value: 'docker node:20-slim' }],
      };
      const merged = mergeCandidates([c]);
      expect(merged.unclassified).toEqual([
        {
          file: 'apps/nowhere',
          what: 'docker node:20-slim: no system at "apps/nowhere/package.json" to attach to',
        },
      ]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // applyDetected / staleDetected — on the RCB-95 two-env.yml fixture
  // -----------------------------------------------------------------------------------------
  describe('applyDetected', () => {
    const twoEnvDoc = () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('two-env.yml fixture failed to parse');
      return result.doc;
    };
    const AT = '2026-09-22T05:00:00Z';

    const candidates = (): Candidates => ({
      ...emptyCandidates(),
      systems: [
        {
          id: 'web',
          name: 'marketing site v2',
          kind: 'client',
          layer: 'client',
          env: ['dev', 'prod'],
          runtime: { dev: 'vite', prod: 'static' },
          pointers: ['apps/web/src'],
          detected: 'package.json',
        },
        {
          id: 'gateway',
          name: 'edge gateway v2',
          kind: 'worker',
          layer: 'edge',
          env: ['dev', 'prod'],
          runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
          pointers: ['apps/gateway/src/index.ts', 'apps/gateway/wrangler.jsonc'],
          detected: 'wrangler.jsonc@v2',
        },
        {
          id: 'new-service',
          name: 'new service',
          kind: 'service',
          layer: 'app',
          env: ['dev'],
          runtime: { dev: 'node server', prod: null },
          pointers: ['apps/new-service/src'],
          detected: 'package.json@new-service',
        },
      ],
    });

    it('skips the hand row (web), updates the detected row (gateway, owner kept), adds the new row', () => {
      const result = applyDetected(twoEnvDoc(), candidates(), AT);
      expect(result.added).toEqual(['new-service']);
      expect(result.updated).toEqual(['gateway']);
      expect(result.skipped).toEqual(['web']);

      const web = result.doc.systems.find((s) => s.id === 'web');
      expect(web).toEqual({
        id: 'web',
        name: 'marketing site',
        kind: 'client',
        layer: 'client',
        env: ['dev', 'prod'],
        runtime: { dev: 'vite dev', prod: 'static hosting' },
        owner: null,
        pointers: ['apps/web/src'],
        docs: [],
        why: null,
        source: { hand: 'owner', at: '2026-09-22T00:00:00Z' },
      });

      const gateway = result.doc.systems.find((s) => s.id === 'gateway');
      expect(gateway).toEqual({
        id: 'gateway',
        name: 'edge gateway v2',
        kind: 'worker',
        layer: 'edge',
        env: ['dev', 'prod'],
        runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
        owner: 'backend',
        pointers: ['apps/gateway/src/index.ts', 'apps/gateway/wrangler.jsonc'],
        docs: ['docs/BUILD-PLAN.md#§3'],
        why: null,
        source: { detected: 'wrangler.jsonc@v2', at: AT },
      });

      const newService = result.doc.systems.find((s) => s.id === 'new-service');
      expect(newService).toEqual({
        id: 'new-service',
        name: 'new service',
        kind: 'service',
        layer: 'app',
        env: ['dev'],
        runtime: { dev: 'node server', prod: null },
        owner: null,
        pointers: ['apps/new-service/src'],
        docs: [],
        why: null,
        source: { detected: 'package.json@new-service', at: AT },
      });
    });

    it('never removes a row; environments untouched', () => {
      const before = twoEnvDoc();
      const result = applyDetected(before, candidates(), AT);
      expect(result.doc.systems.length).toBeGreaterThanOrEqual(before.systems.length);
      expect(result.doc.environments).toEqual(before.environments);
    });

    it('applying the same candidates twice is idempotent (byte-identical serializeSystems)', () => {
      const first = applyDetected(twoEnvDoc(), candidates(), AT);
      const second = applyDetected(first.doc, candidates(), AT);
      expect(serializeSystems(second.doc)).toEqual(serializeSystems(first.doc));
    });
  });

  describe('applyDetected — K15 drops a none environment', () => {
    const K15_AT = '2026-09-24T00:00:00Z';

    const noneProdDoc = (systems: SystemRow[] = []): SystemsDoc => ({
      environments: { dev: { note: 'local dev' }, prod: { none: 'no prod by design' } },
      systems,
      connections: [],
    });

    const bothNotesDoc = (systems: SystemRow[] = []): SystemsDoc => ({
      environments: { dev: { note: 'local dev' }, prod: { note: 'Cloudflare Workers' } },
      systems,
      connections: [],
    });

    const svcCandidate = (env: SystemEnv[]): Candidates => ({
      ...emptyCandidates(),
      systems: [
        {
          id: 'svc',
          name: 'service',
          kind: 'service',
          layer: 'app',
          env,
          runtime: { dev: 'node server', prod: null },
          pointers: ['apps/svc/src'],
          detected: 'package.json@svc',
        },
      ],
    });

    it('add branch: prod none drops prod, [dev, prod] candidate → added row env [dev]', () => {
      const result = applyDetected(noneProdDoc(), svcCandidate(['dev', 'prod']), K15_AT);
      expect(result.added).toEqual(['svc']);
      const row = result.doc.systems.find((s) => s.id === 'svc');
      expect(row?.env).toEqual(['dev']);
    });

    it('update branch: prod none drops prod on an existing detected row', () => {
      const existing: SystemRow = {
        id: 'svc',
        name: 'service v1',
        kind: 'service',
        layer: 'app',
        env: ['dev', 'prod'],
        runtime: { dev: 'node server', prod: 'node server' },
        owner: null,
        pointers: ['apps/svc/src'],
        docs: [],
        why: null,
        source: { detected: 'package.json@svc', at: '2026-09-01T00:00:00Z' },
      };
      const result = applyDetected(noneProdDoc([existing]), svcCandidate(['dev', 'prod']), K15_AT);
      expect(result.updated).toEqual(['svc']);
      const row = result.doc.systems.find((s) => s.id === 'svc');
      expect(row?.env).toEqual(['dev']);
    });

    it('both envs have notes: env unchanged [dev, prod] (no over-filtering)', () => {
      const result = applyDetected(bothNotesDoc(), svcCandidate(['dev', 'prod']), K15_AT);
      const row = result.doc.systems.find((s) => s.id === 'svc');
      expect(row?.env).toEqual(['dev', 'prod']);
    });

    it('inert rule: candidate [prod] only with prod none keeps env [prod]', () => {
      const result = applyDetected(noneProdDoc(), svcCandidate(['prod']), K15_AT);
      const row = result.doc.systems.find((s) => s.id === 'svc');
      expect(row?.env).toEqual(['prod']);
    });

    it('connection add branch: prod none drops prod, [dev, prod] candidate → added connection env [dev]', () => {
      const connCandidate: Candidates = {
        ...emptyCandidates(),
        connections: [
          {
            from: 'cli',
            to: 'svc',
            via: 'child process',
            env: ['dev', 'prod'],
            detected: 'package.json@svc',
          },
        ],
      };
      const result = applyDetected(noneProdDoc(), connCandidate, K15_AT);
      expect(result.added).toEqual(['cli→svc']);
      const conn = result.doc.connections.find((c) => c.from === 'cli' && c.to === 'svc');
      expect(conn?.env).toEqual(['dev']);
    });
  });

  describe('staleDetected', () => {
    it('lists detected systems missing from the new candidates, in doc order', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      expect(staleDetected(result.doc, emptyCandidates())).toEqual([
        'gateway',
        'worker-jobs',
        'postgres',
      ]);

      const stillThere: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'gateway',
            name: 'edge gateway',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [],
            detected: 'wrangler.jsonc',
          },
        ],
      };
      expect(staleDetected(result.doc, stillThere)).toEqual(['worker-jobs', 'postgres']);
    });
  });

  // -----------------------------------------------------------------------------------------
  // serializeSystems — round-trip and omission of null/empty keys
  // -----------------------------------------------------------------------------------------
  describe('serializeSystems', () => {
    it.each(['two-env.yml', 'none-prod.yml'])('round-trips %s through parseSystems', (name) => {
      const result = parseSystems(systemsFixture(name));
      if (!result.ok) throw new Error(`${name} fixture failed to parse`);
      const text = serializeSystems(result.doc);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(result.doc);
    });

    it('omits null owner/why/via, empty docs, and null runtime keys rather than writing them', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      const text = serializeSystems(result.doc);
      expect(text).not.toContain('owner: null');
      expect(text).not.toContain('why: null');
      expect(text).not.toContain('via: null');
      expect(text).not.toContain('dev: null');
      expect(text).not.toContain('prod: null');
      expect(text).not.toContain('docs: []');
    });
  });

  // -----------------------------------------------------------------------------------------
  // formatDetectReport — smoke test (not byte-pinned by the brief)
  // -----------------------------------------------------------------------------------------
  describe('formatDetectReport', () => {
    it('prints a header row, connection lines, unclassified lines, and a summary line', () => {
      const c = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      const report = formatDetectReport(c, {
        added: ['postgres', 'redis', 'app'],
        updated: [],
        skipped: [],
      });
      expect(report).toContain('ID');
      expect(report).toContain('KIND');
      expect(report).toContain('connections: app→postgres (depends_on)');
      expect(report).toContain(
        '3 systems, 2 connections, 0 unclassified — 3 to add, 0 to update, 0 hand rows kept',
      );
    });
  });
});
