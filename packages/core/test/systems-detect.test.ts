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
  emptySystemsDoc,
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
import { resolveRefText } from '../src/refs.js';
import { EVIDENCE_MAX_LINES, lineEvidence, locateEvidence } from '../src/systems-detect.js';

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
  // detectPackageJson — RCB-161 slice 3: no-signal packages proposed as planned integrations
  // -----------------------------------------------------------------------------------------
  describe('detectPackageJson — RCB-161 slice 3: integration-shaped no-signal packages', () => {
    it('@globex/shopify under packages/integrations/, no deps -> external planned, why names shopify', () => {
      const rel = 'packages/integrations/shopify/package.json';
      const c = detectPackageJson(rel, JSON.stringify({ name: '@globex/shopify' }));
      expect(c).toEqual({
        systems: [
          {
            id: 'shopify',
            name: '@globex/shopify',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [rel],
            detected: rel,
            status: 'planned',
            why:
              'package "@globex/shopify" looks like an integration (name matches "shopify") but ' +
              'has no bin, client, or server signal — proposed as planned',
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });

    it('@acme/stripe-client elsewhere -> planned by name (dash token "stripe")', () => {
      const rel = 'packages/misc/package.json';
      const c = detectPackageJson(rel, JSON.stringify({ name: '@acme/stripe-client' }));
      expect(c.systems).toEqual([
        {
          id: 'stripe-client',
          name: '@acme/stripe-client',
          kind: 'external',
          layer: 'external',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: rel,
          status: 'planned',
          why:
            'package "@acme/stripe-client" looks like an integration (name matches "stripe") ' +
            'but has no bin, client, or server signal — proposed as planned',
        },
      ]);
      expect(c.unclassified).toEqual([]);
    });

    it('@x/widgets under packages/integrations/ -> planned, why "under integrations/"', () => {
      const rel = 'packages/integrations/widgets/package.json';
      const c = detectPackageJson(rel, JSON.stringify({ name: '@x/widgets' }));
      expect(c.systems).toEqual([
        {
          id: 'widgets',
          name: '@x/widgets',
          kind: 'external',
          layer: 'external',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [rel],
          detected: rel,
          status: 'planned',
          why:
            'package "@x/widgets" looks like an integration (under integrations/) but has no ' +
            'bin, client, or server signal — proposed as planned',
        },
      ]);
    });

    it("@x/widgets elsewhere -> unclassified, today's text unchanged", () => {
      const rel = 'packages/misc/package.json';
      const c = detectPackageJson(rel, JSON.stringify({ name: '@x/widgets' }));
      expect(c).toEqual({
        systems: [],
        connections: [],
        hints: [],
        unclassified: [
          { file: rel, what: `${rel}: package "@x/widgets" — no bin, client, or server signal` },
        ],
      } satisfies Candidates);
    });

    it('a shopify-named package WITH hono stays service, no status (a runtime signal wins)', () => {
      const rel = 'packages/integrations/shopify/package.json';
      const c = detectPackageJson(
        rel,
        JSON.stringify({ name: '@globex/shopify', dependencies: { hono: '^4.0.0' } }),
      );
      expect(c).toEqual({
        systems: [
          {
            id: 'shopify',
            name: '@globex/shopify',
            kind: 'service',
            layer: 'app',
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
    /** RCB-177: where each thing is written in the fixture, per format — `rel:L<n>` (or a range) as
     * both `detected` and the pointer; the worker row keeps the whole file. */
    interface FixtureLines {
      hyperdrive: string;
      kv: string;
      producer: string;
      consumer: string;
      stripe: string;
    }
    const linesOf = (rel: string, f: Record<keyof FixtureLines, string>): FixtureLines => ({
      hyperdrive: `${rel}:${f.hyperdrive}`,
      kv: `${rel}:${f.kv}`,
      producer: `${rel}:${f.producer}`,
      consumer: `${rel}:${f.consumer}`,
      stripe: `${rel}:${f.stripe}`,
    });
    // `wrangler.jsonc`: the hyperdrive record is lines 10-14; kv/producer/consumer are one-line arrays.
    const JSONC_LINES = {
      hyperdrive: 'L10-L14',
      kv: 'L16',
      producer: 'L18',
      consumer: 'L19',
      stripe: 'L7',
    };
    // `wrangler.toml`: TOML never widens — the `binding =` / `queue =` / `KEY =` line itself.
    const TOML_LINES = {
      hyperdrive: 'L9',
      kv: 'L14',
      producer: 'L19',
      consumer: 'L22',
      stripe: 'L6',
    };
    const expectedJsonc = (rel: string, at: FixtureLines): Candidates => ({
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
          pointers: [at.hyperdrive],
          detected: at.hyperdrive,
        },
        {
          id: 'cache',
          name: 'CACHE',
          kind: 'cache',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [at.kv],
          detected: at.kv,
        },
        {
          id: 'detect-fixture-queue',
          name: 'detect-fixture-queue',
          kind: 'queue',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [at.producer],
          detected: at.producer,
        },
        {
          id: 'detect-fixture-queue',
          name: 'detect-fixture-queue',
          kind: 'queue',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [at.consumer],
          detected: at.consumer,
        },
        {
          id: 'stripe',
          name: 'STRIPE',
          kind: 'external',
          layer: 'external',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: [at.stripe],
          detected: at.stripe,
        },
      ],
      connections: [
        {
          from: 'detect-fixture-worker',
          to: 'hyperdrive',
          via: 'hyperdrive binding HYPERDRIVE',
          env: ['dev', 'prod'],
          detected: at.hyperdrive,
          pointers: [at.hyperdrive],
        },
        {
          from: 'detect-fixture-worker',
          to: 'cache',
          via: 'kv_namespaces binding CACHE',
          env: ['dev', 'prod'],
          detected: at.kv,
          pointers: [at.kv],
        },
        {
          from: 'detect-fixture-worker',
          to: 'detect-fixture-queue',
          via: 'queues.producers binding QUEUE_PRODUCER',
          env: ['dev', 'prod'],
          detected: at.producer,
          pointers: [at.producer],
        },
        {
          from: 'detect-fixture-queue',
          to: 'detect-fixture-worker',
          via: 'queues.consumers binding detect-fixture-queue',
          env: ['dev', 'prod'],
          detected: at.consumer,
          pointers: [at.consumer],
        },
        {
          from: 'detect-fixture-worker',
          to: 'stripe',
          via: 'STRIPE_API_KEY',
          env: ['dev', 'prod'],
          detected: at.stripe,
          pointers: [at.stripe],
        },
      ],
      hints: [],
      unclassified: [],
    });

    it('jsonc: hyperdrive, kv, queues, vars — exact candidates; comments and a URL survive', () => {
      const c = detectWrangler('apps/api/wrangler.jsonc', detectFixture('wrangler.jsonc'));
      expect(c).toEqual(
        expectedJsonc('apps/api/wrangler.jsonc', linesOf('apps/api/wrangler.jsonc', JSONC_LINES)),
      );
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

    it('toml: the same systems and connections as jsonc — only the located lines differ (RCB-177)', () => {
      const jsonc = detectWrangler('apps/api/wrangler.jsonc', detectFixture('wrangler.jsonc'));
      const toml = detectWrangler('apps/api/wrangler.toml', detectFixture('wrangler.toml'));
      // Everything but where each thing is written is identical across the two formats.
      const bare = (c: Candidates) =>
        JSON.stringify({
          systems: c.systems.map(({ detected: _d, pointers: _p, ...rest }) => rest),
          connections: c.connections.map(({ detected: _d, pointers: _p, ...rest }) => rest),
        });
      expect(bare(toml)).toBe(bare(jsonc));
      // ...and the located lines are what the TOML fixture says (lines 9, 14, 19, 22, 6).
      expect(toml).toEqual(
        expectedJsonc('apps/api/wrangler.toml', linesOf('apps/api/wrangler.toml', TOML_LINES)),
      );
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
            runtime: { dev: 'postgres:16 :5499', prod: null },
            pointers: ['docker-compose.yml:L2-L5'],
            detected: 'docker-compose.yml:L2-L5',
          },
          {
            id: 'redis',
            name: 'redis',
            kind: 'cache',
            layer: 'data',
            env: ['dev'],
            runtime: { dev: 'redis:7', prod: null },
            pointers: ['docker-compose.yml:L6-L7'],
            detected: 'docker-compose.yml:L6-L7',
          },
          {
            id: 'app',
            name: 'app',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: { dev: 'build .', prod: null },
            pointers: ['docker-compose.yml:L8-L12'],
            detected: 'docker-compose.yml:L8-L12',
          },
        ],
        connections: [
          {
            from: 'app',
            to: 'postgres',
            via: 'depends_on',
            env: ['dev'],
            detected: 'docker-compose.yml:L8-L12',
            pointers: ['docker-compose.yml:L8-L12'],
          },
          {
            from: 'app',
            to: 'redis',
            via: 'depends_on',
            env: ['dev'],
            detected: 'docker-compose.yml:L8-L12',
            pointers: ['docker-compose.yml:L8-L12'],
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
            pointers: [`${rel}:L2`],
            detected: `${rel}:L2`,
          },
          {
            id: 'github',
            name: 'GITHUB',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: [`${rel}:L4`],
            detected: `${rel}:L4`,
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
    it('dialect: "postgresql" -> the postgres db system, evidence = the `dialect:` line (fixture line 6)', () => {
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
            pointers: [`${rel}:L6`],
            detected: `${rel}:L6`,
          },
        ],
        connections: [],
        hints: [],
        unclassified: [],
      } satisfies Candidates);
    });
  });

  describe('detectPrismaSchema', () => {
    it('provider = "postgresql" inside datasource (not the generator block) -> postgres, evidence = that line (fixture line 2, not the generator\'s line 7)', () => {
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
            pointers: [`${rel}:L2`],
            detected: `${rel}:L2`,
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

    it('RCB-161 slice 3: an env-example row (no status) first + the integration package second -> kept row planned, why set', () => {
      const envPart: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'shopify',
            name: 'SHOPIFY',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['.env.example'],
            detected: '.env.example@SHOPIFY_API_KEY',
          },
        ],
      };
      const pkgPart = detectPackageJson(
        'packages/integrations/shopify/package.json',
        JSON.stringify({ name: '@globex/shopify' }),
      );
      const merged = mergeCandidates([envPart, pkgPart]);
      expect(merged.systems).toEqual([
        {
          id: 'shopify',
          name: 'SHOPIFY',
          kind: 'external',
          layer: 'external',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: ['.env.example', 'packages/integrations/shopify/package.json'],
          detected: '.env.example@SHOPIFY_API_KEY',
          status: 'planned',
          why:
            'package "@globex/shopify" looks like an integration (name matches "shopify") but ' +
            'has no bin, client, or server signal — proposed as planned',
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
        status: 'live',
        unblockedBy: [],
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
        status: 'live',
        unblockedBy: [],
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
        status: 'live',
        unblockedBy: [],
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

    it("RCB-161: keeps an updated detected row/connection's status+unblockedBy; a new row/connection gets live/[]", () => {
      const before = twoEnvDoc();
      const gatewayIdx = before.systems.findIndex((s) => s.id === 'gateway');
      const gateway = before.systems[gatewayIdx];
      if (gatewayIdx === -1 || !gateway) throw new Error('fixture missing gateway');
      const withUnblocker: SystemsDoc = {
        ...before,
        systems: before.systems.map((s, i) =>
          i === gatewayIdx ? { ...s, status: 'planned' as const, unblockedBy: ['RCB-9'] } : s,
        ),
        connections: before.connections.map((c) =>
          c.from === 'gateway' && c.to === 'api'
            ? { ...c, status: 'blocked' as const, unblockedBy: ['RCB-10'] }
            : c,
        ),
      };
      const result = applyDetected(withUnblocker, candidates(), AT);
      expect(result.updated).toContain('gateway');
      const updatedGateway = result.doc.systems.find((s) => s.id === 'gateway');
      expect(updatedGateway?.status).toBe('planned');
      expect(updatedGateway?.unblockedBy).toEqual(['RCB-9']);
      const updatedConn = result.doc.connections.find(
        (c) => c.from === 'gateway' && c.to === 'api',
      );
      expect(updatedConn?.status).toBe('blocked');
      expect(updatedConn?.unblockedBy).toEqual(['RCB-10']);

      const newService = result.doc.systems.find((s) => s.id === 'new-service');
      expect(newService?.status).toBe('live');
      expect(newService?.unblockedBy).toEqual([]);
    });

    it('RCB-161 slice 3: a new planned row gets status+why; a hand row skip is untouched; a detected live row with why null gets why filled', () => {
      const before = twoEnvDoc();
      const webBefore = before.systems.find((s) => s.id === 'web');
      if (!webBefore) throw new Error('fixture missing web');
      const gatewayBefore = before.systems.find((s) => s.id === 'gateway');
      if (!gatewayBefore) throw new Error('fixture missing gateway');
      expect(gatewayBefore.status).toBe('live');
      expect(gatewayBefore.why).toBeNull();

      const c: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'new-integration',
            name: '@globex/qbo',
            kind: 'external',
            layer: 'external',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['packages/integrations/qbo/package.json'],
            detected: 'packages/integrations/qbo/package.json',
            status: 'planned',
            why:
              'package "@globex/qbo" looks like an integration (name matches "qbo") but has no ' +
              'bin, client, or server signal — proposed as planned',
          },
          {
            id: 'web',
            name: 'marketing site v2',
            kind: 'client',
            layer: 'client',
            env: ['dev', 'prod'],
            runtime: { dev: 'vite', prod: 'static' },
            pointers: ['apps/web/src'],
            detected: 'package.json',
            status: 'planned',
            why: 'should never reach a hand row',
          },
          {
            id: 'gateway',
            name: 'edge gateway v2',
            kind: 'worker',
            layer: 'edge',
            env: ['dev', 'prod'],
            runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
            pointers: ['apps/gateway/src/index.ts'],
            detected: 'wrangler.jsonc',
            status: 'planned',
            why: 'candidate why for gateway',
          },
        ],
      };

      const result = applyDetected(before, c, AT);
      expect(result.added).toEqual(['new-integration']);
      expect(result.skipped).toEqual(['web']);
      expect(result.updated).toEqual(['gateway']);

      const added = result.doc.systems.find((s) => s.id === 'new-integration');
      expect(added?.status).toBe('planned');
      expect(added?.why).toBe(c.systems[0]?.why);
      expect(added?.unblockedBy).toEqual([]);

      const web = result.doc.systems.find((s) => s.id === 'web');
      expect(web).toEqual(webBefore);

      const gateway = result.doc.systems.find((s) => s.id === 'gateway');
      expect(gateway?.status).toBe('live');
      expect(gateway?.why).toBe('candidate why for gateway');
    });
  });

  // -----------------------------------------------------------------------------------------
  // RCB-162: a rejected system/connection is skipped, not re-added, by applyDetected
  // -----------------------------------------------------------------------------------------
  describe('applyDetected — RCB-162 rejected candidates', () => {
    const AT = '2026-09-27T00:00:00Z';

    const rejectingDoc = (): SystemsDoc => ({
      environments: { dev: { note: null }, prod: { note: null } },
      systems: [
        {
          id: 'globex-api',
          name: 'globex api',
          kind: 'service',
          layer: 'app',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          owner: null,
          pointers: [],
          docs: [],
          why: null,
          status: 'live',
          unblockedBy: [],
          source: { hand: 'owner', at: 'earlier' },
        },
      ],
      connections: [],
      rejected: [
        { id: 'hyperdrive', why: 'not used; globex-api talks to postgres directly' },
        { from: 'globex-api', to: 'hyperdrive', why: 'dead binding, removed in the rewrite' },
      ],
    });

    const candidates = (): Candidates => ({
      ...emptyCandidates(),
      systems: [
        {
          id: 'hyperdrive',
          name: 'Hyperdrive',
          kind: 'db',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: ['wrangler.jsonc'],
          detected: 'wrangler.jsonc@hyperdrive',
        },
        {
          id: 'redis',
          name: 'Redis',
          kind: 'cache',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: ['wrangler.jsonc'],
          detected: 'wrangler.jsonc@redis',
        },
      ],
      connections: [
        // Rejected as a PAIR (both this exact from/to appears in `rejected`).
        {
          from: 'globex-api',
          to: 'hyperdrive',
          via: 'Hyperdrive binding HYPERDRIVE',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc@hyperdrive',
        },
        // Not itself a rejected pair, but its `to` names a rejected SYSTEM id.
        {
          from: 'redis',
          to: 'hyperdrive',
          via: 'binding',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc@redis-hyperdrive',
        },
        // Neither endpoint nor pair rejected — must still go through normally.
        {
          from: 'globex-api',
          to: 'redis',
          via: 'binding',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc@redis',
        },
      ],
    });

    it('skips the rejected system, the rejected pair, and a connection touching a rejected system id — and reports all three', () => {
      const before = rejectingDoc();
      const result = applyDetected(before, candidates(), AT);

      // Candidate order: hyperdrive (system, rejected) then the connections in candidate order.
      expect(result.rejected).toEqual(['hyperdrive', 'globex-api→hyperdrive', 'redis→hyperdrive']);
      expect(result.added).toEqual(['redis', 'globex-api→redis']);
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([]);

      expect(result.doc.systems.some((s) => s.id === 'hyperdrive')).toBe(false);
      expect(result.doc.systems.some((s) => s.id === 'redis')).toBe(true);
      expect(
        result.doc.connections.some((c) => c.from === 'globex-api' && c.to === 'hyperdrive'),
      ).toBe(false);
      expect(result.doc.connections.some((c) => c.from === 'redis' && c.to === 'hyperdrive')).toBe(
        false,
      );
      expect(result.doc.connections.some((c) => c.from === 'globex-api' && c.to === 'redis')).toBe(
        true,
      );
    });

    it("the doc's own `rejected` list is unchanged by a detect run", () => {
      const before = rejectingDoc();
      const result = applyDetected(before, candidates(), AT);
      expect(result.doc.rejected).toEqual(before.rejected);
    });

    it('re-applying the same candidates is idempotent — still nothing added for the rejected rows', () => {
      const first = applyDetected(rejectingDoc(), candidates(), AT);
      const second = applyDetected(first.doc, candidates(), AT);
      expect(second.rejected).toEqual(['hyperdrive', 'globex-api→hyperdrive', 'redis→hyperdrive']);
      expect(second.added).toEqual([]);
      expect(serializeSystems(second.doc)).toEqual(serializeSystems(first.doc));
    });
  });

  // -----------------------------------------------------------------------------------------
  // RCB-162: a globex-shaped fixture (root pkg + worker + hyperdrive + that connection rejected)
  // re-applied twice adds nothing the second time.
  // -----------------------------------------------------------------------------------------
  describe('RCB-162: globex-shaped fixture — root pkg, worker, hyperdrive, and their connection, all rejected', () => {
    const AT = '2026-09-27T00:00:00Z';

    const globexDoc = (): SystemsDoc => ({
      environments: { dev: { note: null }, prod: { note: null } },
      systems: [],
      connections: [],
      rejected: [
        { id: 'globex', why: 'the root package is not a system worth tracking' },
        { id: 'worker', why: 'duplicate of the hand-tracked "api" system' },
        { id: 'hyperdrive', why: 'not used; the worker talks to postgres directly' },
        { from: 'worker', to: 'hyperdrive', why: 'dead binding, removed in the rewrite' },
      ],
    });

    const globexCandidates = (): Candidates => ({
      ...emptyCandidates(),
      systems: [
        {
          id: 'globex',
          name: 'globex',
          kind: 'tool',
          layer: 'ops',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: ['package.json'],
          detected: 'package.json',
        },
        {
          id: 'worker',
          name: 'globex worker',
          kind: 'worker',
          layer: 'edge',
          env: ['dev', 'prod'],
          runtime: { dev: 'wrangler dev', prod: 'Cloudflare Workers' },
          pointers: ['wrangler.jsonc'],
          detected: 'wrangler.jsonc',
        },
        {
          id: 'hyperdrive',
          name: 'Hyperdrive',
          kind: 'db',
          layer: 'data',
          env: ['dev', 'prod'],
          runtime: { dev: null, prod: null },
          pointers: ['wrangler.jsonc'],
          detected: 'wrangler.jsonc@hyperdrive',
        },
      ],
      connections: [
        {
          from: 'worker',
          to: 'hyperdrive',
          via: 'Hyperdrive binding HYPERDRIVE',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc@hyperdrive',
        },
      ],
    });

    it('every candidate is rejected on the first apply — nothing added', () => {
      const result = applyDetected(globexDoc(), globexCandidates(), AT);
      expect(result.added).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.rejected).toEqual(['globex', 'worker', 'hyperdrive', 'worker→hyperdrive']);
      expect(result.doc.systems).toEqual([]);
      expect(result.doc.connections).toEqual([]);
    });

    it('re-applied a second time against its own output: still nothing added (idempotent)', () => {
      const first = applyDetected(globexDoc(), globexCandidates(), AT);
      const second = applyDetected(first.doc, globexCandidates(), AT);
      expect(second.added).toEqual([]);
      expect(second.rejected).toEqual(['globex', 'worker', 'hyperdrive', 'worker→hyperdrive']);
      expect(serializeSystems(second.doc)).toEqual(serializeSystems(first.doc));
    });
  });

  describe('applyDetected — K15 drops a none environment', () => {
    const K15_AT = '2026-09-24T00:00:00Z';

    const noneProdDoc = (systems: SystemRow[] = []): SystemsDoc => ({
      environments: { dev: { note: 'local dev' }, prod: { none: 'no prod by design' } },
      systems,
      connections: [],
      rejected: [],
    });

    const bothNotesDoc = (systems: SystemRow[] = []): SystemsDoc => ({
      environments: { dev: { note: 'local dev' }, prod: { note: 'Cloudflare Workers' } },
      systems,
      connections: [],
      rejected: [],
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
        status: 'live',
        unblockedBy: [],
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

    it('RCB-161: an old fixture (no status/unblocked_by anywhere) never writes those keys — byte for byte the same as before this card', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      const text = serializeSystems(result.doc);
      expect(text).not.toContain('status:');
      expect(text).not.toContain('unblocked_by:');
      // every row/connection normalises to the absent-key default
      expect(
        result.doc.systems.every((s) => s.status === 'live' && s.unblockedBy.length === 0),
      ).toBe(true);
      expect(
        result.doc.connections.every((c) => c.status === 'live' && c.unblockedBy.length === 0),
      ).toBe(true);
    });

    it('RCB-161: round-trips a doc WITH status/unblocked_by set on a system and a connection', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      const withUnblockers: SystemsDoc = {
        ...result.doc,
        systems: result.doc.systems.map((s) =>
          s.id === 'worker-jobs' ? { ...s, status: 'planned', unblockedBy: ['RCB-9'] } : s,
        ),
        connections: result.doc.connections.map((c) =>
          c.from === 'worker-jobs' && c.to === 'postgres'
            ? { ...c, status: 'blocked', unblockedBy: ['RCB-9', 'RCB-10'] }
            : c,
        ),
      };
      const text = serializeSystems(withUnblockers);
      expect(text).toContain('status: planned');
      expect(text).toContain('status: blocked');
      expect(text).toContain('unblocked_by:');
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(withUnblockers);
    });

    // RCB-162 ---------------------------------------------------------------------------------
    // These compare actual BYTES of the serialized text, not parsed-object equality: a
    // parsed-object check could not catch a regression where serializeSystems always wrote
    // `rejected: []` for an empty list, because parseSystems normalises BOTH an absent
    // `rejected:` key AND an explicit empty one to the same `[]` — they'd reparse identically.
    it('an old file with no `rejected:` key round-trips byte-identical — no `rejected` key is ever written for an empty list', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      expect(result.doc.rejected).toEqual([]);
      const text = serializeSystems(result.doc);
      // Byte check on the actual text, not the reparsed structure.
      expect(text.includes('rejected')).toBe(false);
      // Nothing was appended after the connections block: the text ends exactly where the last
      // connection's `source.at` line ends.
      expect(
        text.endsWith('    source:\n      hand: owner\n      at: 2026-09-22T00:00:00Z\n'),
      ).toBe(true);
      // Re-serializing what comes back out is byte-for-byte the same text again.
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(serializeSystems(reparsed.doc)).toBe(text);
    });

    it('writes `rejected:` after `connections`, one of each kind, keys in id/why or from/to/why order, unquoted plain scalars', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      const withRejected: SystemsDoc = {
        ...result.doc,
        rejected: [
          { id: 'hyperdrive', why: 'not used; direct to postgres' },
          { from: 'globex-api', to: 'hyperdrive', why: 'dead binding' },
        ],
      };
      const text = serializeSystems(withRejected);
      const connectionsIdx = text.indexOf('\nconnections:');
      const rejectedIdx = text.indexOf('\nrejected:');
      expect(connectionsIdx).toBeGreaterThan(-1);
      expect(rejectedIdx).toBeGreaterThan(connectionsIdx);
      // Pinned tail bytes: exact key order (id/why, then from/to/why) and no quoting on these
      // plain scalars (`serializeSystems` never quotes a string that doesn't need it).
      expect(
        text.endsWith(
          'rejected:\n' +
            '  - id: hyperdrive\n' +
            '    why: not used; direct to postgres\n' +
            '  - from: globex-api\n' +
            '    to: hyperdrive\n' +
            '    why: dead binding\n',
        ),
      ).toBe(true);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(withRejected);
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

    it('RCB-161 slice 3: a STATUS column appears when a candidate has a status', () => {
      const c = detectPackageJson(
        'packages/integrations/shopify/package.json',
        JSON.stringify({ name: '@globex/shopify' }),
      );
      const report = formatDetectReport(c, { added: ['shopify'], updated: [], skipped: [] });
      expect(report).toContain('STATUS');
      expect(report).toContain('planned');
    });

    it('RCB-161 slice 3: the STATUS column is absent without one (byte-identical to before this card)', () => {
      const c = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      const report = formatDetectReport(c, {
        added: ['postgres', 'redis', 'app'],
        updated: [],
        skipped: [],
      });
      expect(report).not.toContain('STATUS');
      expect(report).toContain(
        '3 systems, 2 connections, 0 unclassified — 3 to add, 0 to update, 0 hand rows kept',
      );
    });

    // RCB-162 ---------------------------------------------------------------------------------
    it('appends ", <n> rejected kept out" when the plan reports rejections', () => {
      const c = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      const report = formatDetectReport(c, {
        added: ['postgres', 'redis'],
        updated: [],
        skipped: [],
        rejected: ['app', 'app→postgres'],
      });
      expect(report).toContain(
        '3 systems, 2 connections, 0 unclassified — 2 to add, 0 to update, 0 hand rows kept, 2 rejected kept out',
      );
    });

    it('with no rejections (absent or empty), the summary line is byte-identical to before this card', () => {
      const c = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      const withoutField = formatDetectReport(c, {
        added: ['postgres', 'redis', 'app'],
        updated: [],
        skipped: [],
      });
      const withEmptyField = formatDetectReport(c, {
        added: ['postgres', 'redis', 'app'],
        updated: [],
        skipped: [],
        rejected: [],
      });
      expect(withoutField).not.toContain('rejected kept out');
      expect(withEmptyField).not.toContain('rejected kept out');
      expect(withEmptyField).toBe(withoutField);
    });
  });

  // -----------------------------------------------------------------------------------------
  // serializeSystems — RCB-161 slice 3: a detect-added planned row round-trips
  // -----------------------------------------------------------------------------------------
  describe('serializeSystems — RCB-161 slice 3: a detect-added planned row', () => {
    it('writes status: planned and why:, and round-trips through parseSystems', () => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      const pkgCandidates = detectPackageJson(
        'packages/integrations/qbo/package.json',
        JSON.stringify({ name: '@globex/qbo' }),
      );
      const applied = applyDetected(result.doc, pkgCandidates, '2026-09-27T00:00:00Z');
      expect(applied.added).toEqual(['qbo']);
      const text = serializeSystems(applied.doc);
      expect(text).toContain('status: planned');
      expect(text).toContain('why:');
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(applied.doc);
    });
  });
  // -----------------------------------------------------------------------------------------
  // RCB-173: a connection's hand-added label / pointers / id survive serialize + a detect apply
  // -----------------------------------------------------------------------------------------
  describe('RCB-173: connection label / pointers / id round-trip through serializeSystems and applyDetected', () => {
    const AT = '2026-09-29T05:00:00Z';
    const twoEnvDoc = (): SystemsDoc => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('two-env.yml fixture failed to parse');
      return result.doc;
    };
    const isPair = (c: { from: string; to: string }, from: string, to: string) =>
      c.from === from && c.to === to;

    /** two-env.yml with hand-added fields on three connections: web→gateway (a HAND row: label
     * only), gateway→api (a DETECTED row: id + label + pointers), api→postgres (DETECTED: label +
     * pointers, no id). Passed through serialize + parse so it is what "on disk" would hold. */
    function onDiskDoc(): SystemsDoc {
      const base = twoEnvDoc();
      const edited: SystemsDoc = {
        ...base,
        connections: base.connections.map((c) => {
          if (isPair(c, 'web', 'gateway')) return { ...c, label: 'HTTPS' };
          if (isPair(c, 'gateway', 'api')) {
            return {
              ...c,
              id: 'edge-call',
              label: 'internal call',
              pointers: ['apps/gateway/src/index.ts'],
            };
          }
          if (isPair(c, 'api', 'postgres')) {
            return {
              ...c,
              label: 'via hyperdrive',
              pointers: ['src/api/index.ts', 'src/db.ts:L1-L5'],
            };
          }
          return c;
        }),
      };
      const reparsed = parseSystems(serializeSystems(edited));
      if (!reparsed.ok)
        throw new Error(`edited doc failed to reparse: ${reparsed.errors.join('; ')}`);
      return reparsed.doc;
    }

    const conn = (from: string, to: string) =>
      ({
        from,
        to,
        via: 'detected via',
        env: ['dev', 'prod'] as SystemEnv[],
        detected: 'wrangler.jsonc@v2',
      }) as const;

    it('serialize writes id/label right after from/to and pointers after env, and reparses equal', () => {
      const doc = onDiskDoc();
      const text = serializeSystems(doc);
      const start = text.indexOf('  - from: gateway\n    to: api\n');
      expect(start).toBeGreaterThan(-1);
      const next = text.indexOf('\n  - from:', start + 1);
      const block = text.slice(start, next === -1 ? undefined : next);
      const at = (k: string) => block.indexOf(`\n    ${k}:`);
      const order = ['id', 'label', 'via', 'env', 'pointers', 'source'].map(at);
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(doc);
    });

    it('an old file (no label/pointers/id on any connection) never writes those keys — and an empty pointers list is never written', () => {
      const text = serializeSystems(twoEnvDoc());
      const connectionsOnly = text.slice(text.indexOf('\nconnections:'));
      expect(connectionsOnly).not.toContain('label:');
      expect(connectionsOnly).not.toContain('pointers');
      expect(connectionsOnly).not.toMatch(/^ {4}id:/m);
      // A programmatic doc carrying `pointers: []` still writes nothing for it.
      const base = twoEnvDoc();
      const withEmpty: SystemsDoc = {
        ...base,
        connections: base.connections.map((c) => ({ ...c, pointers: [] })),
      };
      const emptyText = serializeSystems(withEmpty);
      expect(emptyText.slice(emptyText.indexOf('\nconnections:'))).not.toContain('pointers');
    });

    it("a detect apply keeps a detected connection's hand label/pointers/id (updated), and a hand connection's label (skipped)", () => {
      const before = onDiskDoc();
      const candidates: Candidates = {
        ...emptyCandidates(),
        connections: [conn('web', 'gateway'), conn('gateway', 'api'), conn('api', 'postgres')],
      };
      const applied = applyDetected(before, candidates, AT);
      expect(applied.skipped).toEqual(['web→gateway']);
      expect(applied.updated).toEqual(['gateway→api', 'api→postgres']);
      expect(applied.added).toEqual([]);

      // Through the serializer and back — the real `--apply` path.
      const after = parseSystems(serializeSystems(applied.doc));
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const find = (from: string, to: string) =>
        after.doc.connections.find((c) => isPair(c, from, to));
      // CONTROL: without `connectionExtras(existing)` in applyDetected's update branch these two
      // lose their label/pointers/id and fail here; without the serializer writing the keys, all
      // three fail.
      expect(find('gateway', 'api')).toMatchObject({
        id: 'edge-call',
        label: 'internal call',
        pointers: ['apps/gateway/src/index.ts'],
        via: 'detected via',
        source: { detected: 'wrangler.jsonc@v2', at: AT },
      });
      expect(find('api', 'postgres')).toMatchObject({
        label: 'via hyperdrive',
        pointers: ['src/api/index.ts', 'src/db.ts:L1-L5'],
        via: 'detected via',
      });
      expect('id' in (find('api', 'postgres') ?? {})).toBe(false);
      // the hand row is byte-for-byte what it was.
      expect(find('web', 'gateway')).toEqual(
        before.connections.find((c) => isPair(c, 'web', 'gateway')),
      );
      expect(find('web', 'gateway')?.label).toBe('HTTPS');
    });

    it('re-applying the same candidates over the result is idempotent (byte-identical text)', () => {
      const candidates: Candidates = {
        ...emptyCandidates(),
        connections: [conn('gateway', 'api'), conn('api', 'postgres')],
      };
      const once = applyDetected(onDiskDoc(), candidates, AT).doc;
      const onceText = serializeSystems(once);
      const twice = applyDetected(once, candidates, AT).doc;
      expect(serializeSystems(twice)).toBe(onceText);
    });

    it('a pair whose rows ALL carry ids: a candidate for the pair updates an existing row, never adds an id-less duplicate', () => {
      const base = twoEnvDoc();
      const detectedSource = { detected: 'wrangler.jsonc', at: '2026-09-22T00:00:00Z' };
      const pairRow = (id: string, label: string) => ({
        from: 'api',
        to: 'postgres',
        id,
        label,
        via: null,
        env: ['dev', 'prod'] as SystemEnv[],
        status: 'live' as const,
        unblockedBy: [],
        source: detectedSource,
      });
      const doc: SystemsDoc = {
        ...base,
        connections: [
          ...base.connections.filter((c) => !isPair(c, 'api', 'postgres')),
          pairRow('read', 'reads'),
          pairRow('write', 'writes'),
        ],
      };
      // sanity: this doc is itself valid on disk (a repeated pair, every row with its own id).
      expect(parseSystems(serializeSystems(doc)).ok).toBe(true);

      const candidates: Candidates = {
        ...emptyCandidates(),
        connections: [conn('api', 'postgres')],
      };
      const applied = applyDetected(doc, candidates, AT);
      // CONTROL: a matcher that only accepts an id-less row returns -1 here, ADDS a third
      // (id-less) api→postgres row, and both the length check and the reparse below fail.
      expect(applied.added).toEqual([]);
      expect(applied.updated).toEqual(['api→postgres']);
      const pair = applied.doc.connections.filter((c) => isPair(c, 'api', 'postgres'));
      expect(pair.map((c) => c.id)).toEqual(['read', 'write']);
      expect(pair.map((c) => c.label)).toEqual(['reads', 'writes']);
      const reparsed = parseSystems(serializeSystems(applied.doc));
      expect(reparsed.ok).toBe(true);
    });
  });
  // -----------------------------------------------------------------------------------------
  // RCB-177: line-accurate evidence and pointers
  // -----------------------------------------------------------------------------------------
  describe('RCB-180: paths through serializeSystems and applyDetected', () => {
    const AT = '2026-09-29T09:00:00Z';
    const twoEnvDoc = (): SystemsDoc => {
      const result = parseSystems(systemsFixture('two-env.yml'));
      if (!result.ok) throw new Error('two-env.yml fixture failed to parse');
      return result.doc;
    };
    const PATHS: NonNullable<SystemsDoc['paths']> = [
      {
        name: 'page load',
        hops: ['web', 'gateway', 'api', 'postgres'],
        source: { hand: 'owner', at: '2026-09-29T00:00:00Z' },
      },
      {
        name: 'nightly',
        hops: ['worker-jobs', 'postgres'],
        source: { detected: 'src/jobs.ts', at: '2026-09-29T00:00:00Z' },
      },
    ];
    const withPaths = (): SystemsDoc => ({ ...twoEnvDoc(), paths: PATHS });

    it('round-trips a doc WITH paths: parseSystems(serializeSystems(doc)) equals it, name/hops/source in that key order', () => {
      const doc = withPaths();
      const text = serializeSystems(doc);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc).toEqual(doc);
      // Pinned tail bytes (no `rejected:`): key order name, hops, source; hand and detected sources.
      expect(
        text.endsWith(
          'paths:\n' +
            '  - name: page load\n' +
            '    hops:\n' +
            '      - web\n' +
            '      - gateway\n' +
            '      - api\n' +
            '      - postgres\n' +
            '    source:\n' +
            '      hand: owner\n' +
            '      at: 2026-09-29T00:00:00Z\n' +
            '  - name: nightly\n' +
            '    hops:\n' +
            '      - worker-jobs\n' +
            '      - postgres\n' +
            '    source:\n' +
            '      detected: src/jobs.ts\n' +
            '      at: 2026-09-29T00:00:00Z\n',
        ),
      ).toBe(true);
      // and writing what came back is byte-for-byte the same text.
      expect(serializeSystems(reparsed.doc)).toBe(text);
    });

    it('`paths:` sits AFTER `connections:` and BEFORE `rejected:`', () => {
      const text = serializeSystems({
        ...withPaths(),
        rejected: [{ id: 'hyperdrive', why: 'not used' }],
      });
      const connectionsIdx = text.indexOf('\nconnections:');
      const pathsIdx = text.indexOf('\npaths:');
      const rejectedIdx = text.indexOf('\nrejected:');
      expect(connectionsIdx).toBeGreaterThan(-1);
      expect(pathsIdx).toBeGreaterThan(connectionsIdx);
      expect(rejectedIdx).toBeGreaterThan(pathsIdx);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc.paths).toEqual(PATHS);
      expect(reparsed.doc.rejected).toEqual([{ id: 'hyperdrive', why: 'not used' }]);
    });

    it('a file without `paths:` serializes byte-identical: no `paths` key for absent, undefined or []', () => {
      const bare = twoEnvDoc();
      expect('paths' in bare).toBe(false);
      const text = serializeSystems(bare);
      expect(text.includes('paths')).toBe(false);
      // The same bytes whether the key is absent, `undefined`, or an empty list.
      expect(serializeSystems({ ...bare, paths: [] })).toBe(text);
      expect(serializeSystems({ ...bare, paths: undefined })).toBe(text);
      // Nothing was appended after the connections block (same tail the RCB-162 test pins).
      expect(
        text.endsWith('    source:\n      hand: owner\n      at: 2026-09-22T00:00:00Z\n'),
      ).toBe(true);
      // A file that says `paths: []` reads the same and writes back without the key.
      const empty = parseSystems(`${systemsFixture('two-env.yml')}paths: []\n`);
      expect(empty.ok).toBe(true);
      if (!empty.ok) return;
      expect(serializeSystems(empty.doc)).toBe(text);
    });

    it('applyDetected carries `paths` through unchanged — adding, updating and skipping around them', () => {
      const before = withPaths();
      const candidates: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'new-service',
            name: 'new service',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: { dev: 'node', prod: null },
            pointers: ['src/new.ts'],
            detected: 'package.json',
          },
        ],
        connections: [
          {
            from: 'gateway',
            to: 'api',
            via: 'detected via',
            env: ['dev', 'prod'],
            detected: 'wrangler.jsonc@v2',
          },
          {
            from: 'api',
            to: 'new-service',
            via: null,
            env: ['dev'],
            detected: 'src/api.ts',
          },
        ],
      };
      const applied = applyDetected(before, candidates, AT);
      expect(applied.added).toEqual(['new-service', 'api→new-service']);
      expect(applied.updated).toEqual(['gateway→api']);
      expect(applied.doc.paths).toEqual(PATHS);
      // Through the serializer and back — the real `--apply` path — the paths are still on disk.
      const after = parseSystems(serializeSystems(applied.doc));
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.doc.paths).toEqual(PATHS);
      // Re-applying is idempotent, paths included.
      const again = applyDetected(applied.doc, candidates, AT);
      expect(serializeSystems(again.doc)).toBe(serializeSystems(applied.doc));
    });

    it('applyDetected over a doc with NO paths leaves no `paths` key (absent stays absent)', () => {
      const applied = applyDetected(twoEnvDoc(), emptyCandidates(), AT);
      expect('paths' in applied.doc).toBe(false);
    });
  });

  describe('RCB-177: locateEvidence', () => {
    it('lineEvidence: `rel:L<n>` for one line, `rel:L<a>-L<b>` for a range', () => {
      expect(lineEvidence('a.ts', { start: 3, end: 3 })).toBe('a.ts:L3');
      expect(lineEvidence('a.ts', { start: 3, end: 7 })).toBe('a.ts:L3-L7');
    });

    it('a token is a WHOLE word, bare or quoted: `queue` is not `queues` or `db-queue`', () => {
      const text = ['  "queues": 1,', '  "db-queue": 2,', '  "queue": 3'].join('\n');
      // CONTROL: a substring match (`indexOf` with no boundary check in `tokenColumn`) answers
      // line 1 and this fails.
      expect(locateEvidence(text, 'queue')).toEqual({ start: 3, end: 3 });
      expect(locateEvidence('queue: 1\n', 'queue')).toEqual({ start: 1, end: 1 });
      expect(locateEvidence("x: 'queue'\n", 'queue')).toEqual({ start: 1, end: 1 });
      expect(locateEvidence(text, 'nope')).toBeNull();
    });

    it('a line that is only a comment is never a match (`//`, `#`, a block comment)', () => {
      const text = [
        '// "queue"',
        '# queue',
        '/* x',
        'queue',
        '*/',
        '/* queue */',
        '"queue": 1',
      ].join('\n');
      // CONTROL: without `commentLines` the first hit is line 1 and this fails.
      expect(locateEvidence(text, 'queue')).toEqual({ start: 7, end: 7 });
    });

    it('json: a line that OPENS a bracket stands for everything to its closer', () => {
      const text = ['{', '  "vars": {', '    "A": "1"', '  },', '  "x": 1', '}'].join('\n');
      expect(locateEvidence(text, 'vars', { format: 'json' })).toEqual({ start: 2, end: 4 });
      // `text` (the default) never widens.
      expect(locateEvidence(text, 'vars')).toEqual({ start: 2, end: 2 });
    });

    it('json: a scalar in a `vars` MAP is one line; a token in an array-element record is the record', () => {
      const text = [
        '{', // 1
        '  "vars": {', // 2
        '    "A": "1",', // 3
        '    "RESEND_API_KEY": "",', // 4
        '    "B": "2"', // 5
        '  },', // 6
        '  "kv_namespaces": [', // 7
        '    {', // 8
        '      "binding": "CACHE",', // 9
        '      "id": "kv-1"', // 10
        '    }', // 11
        '  ]', // 12
        '}', // 13
      ].join('\n');
      // CONTROL: widening to ANY enclosing object (dropping the `parent === '['` test in
      // `jsonExtent`) answers 2-6 for the var and this fails.
      expect(locateEvidence(text, ['vars', 'RESEND_API_KEY'], { format: 'json' })).toEqual({
        start: 4,
        end: 4,
      });
      expect(
        locateEvidence(text, ['kv_namespaces', 'CACHE'], { format: 'json', field: 'binding' }),
      ).toEqual({ start: 8, end: 11 });
    });

    it('json: an item of exactly 40 lines is widened; one of 41 is the one line (EVIDENCE_MAX_LINES)', () => {
      const item = (total: number): string =>
        [
          '{',
          '  "hyperdrive": [',
          '    {',
          '      "binding": "BIG",',
          ...Array.from({ length: total - 3 }, (_, i) => `      "f${i}": 0,`),
          '    }',
          '  ]',
          '}',
        ].join('\n');
      expect(EVIDENCE_MAX_LINES).toBe(40);
      const opts = { format: 'json', field: 'binding' } as const;
      // CONTROL: `<=` -> `<` in `locateEvidence` fails the 40 case; a cap of 41+ fails the 41 case.
      expect(locateEvidence(item(40), ['hyperdrive', 'BIG'], opts)).toEqual({ start: 3, end: 42 });
      expect(locateEvidence(item(41), ['hyperdrive', 'BIG'], opts)).toEqual({ start: 4, end: 4 });
    });

    it('json: every path key must be a DIRECT child — a `hyperdrive` under env.production is not the top-level one', () => {
      const text = [
        '{', // 1
        '  "name": "env-worker",', // 2
        '  "env": {', // 3
        '    "production": {', // 4
        '      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "prod" }]', // 5
        '    }', // 6
        '  },', // 7
        '  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "top" }]', // 8
        '}', // 9
      ].join('\n');
      // CONTROL: dropping the depth check in `locateJson` answers line 5 and this fails.
      expect(
        locateEvidence(text, ['hyperdrive', 'HYPERDRIVE'], { format: 'json', field: 'binding' }),
      ).toEqual({ start: 8, end: 8 });
    });

    it('json: the value must be what `field` is SET TO — a dead_letter_queue mention is not the declaration', () => {
      const text = [
        '{', // 1
        '  "queues": {', // 2
        '    "consumers": [', // 3
        '      {', // 4
        '        "queue": "jobs",', // 5
        '        "dead_letter_queue": "jobs-dlq"', // 6
        '      },', // 7
        '      {', // 8
        '        "queue": "jobs-dlq"', // 9
        '      }', // 10
        '    ]', // 11
        '  }', // 12
        '}', // 13
      ].join('\n');
      const chain = ['queues', 'consumers', 'jobs-dlq'];
      // CONTROL: without `field` the first line holding "jobs-dlq" is line 6 (inside the FIRST
      // record) and this answers 4-7.
      expect(locateEvidence(text, chain, { format: 'json', field: 'queue' })).toEqual({
        start: 8,
        end: 10,
      });
      expect(locateEvidence(text, chain, { format: 'json' })).toEqual({ start: 4, end: 7 });
    });

    it('json: an unbalanced file yields the one line for a lone token and null for a path — never a guessed extent', () => {
      const text = ['{', '  "hyperdrive": [', '    { "binding": "X" }'].join('\n');
      expect(locateEvidence(text, 'X', { format: 'json' })).toEqual({ start: 3, end: 3 });
      expect(locateEvidence(text, ['hyperdrive', 'X'], { format: 'json' })).toBeNull();
    });

    it('yaml: a service defined AFTER a depends_on mention is found at its own key, to the end of its block', () => {
      const text = [
        'services:', // 1
        '  app:', // 2
        '    build: .', // 3
        '    depends_on:', // 4
        '      db:', // 5
        '        condition: service_healthy', // 6
        '  db:', // 7
        '    image: postgres:16', // 8
        '    ports:', // 9
        '      - "5433:5432"', // 10
        '# trailing comment', // 11
      ].join('\n');
      // CONTROL: a first-mention search (or ignoring indentation) answers line 5.
      expect(locateEvidence(text, ['services', 'db'], { format: 'yaml' })).toEqual({
        start: 7,
        end: 10,
      });
      expect(locateEvidence(text, ['services', 'app'], { format: 'yaml' })).toEqual({
        start: 2,
        end: 6,
      });
      expect(locateEvidence(text, ['services', 'nope'], { format: 'yaml' })).toBeNull();
    });

    it('toml: a leaf is searched only under a header of that exact table — [env.production.vars] is not [vars]', () => {
      const text = [
        'name = "toml-worker"', // 1
        '[env.production.vars]', // 2
        'STRIPE_API_KEY = "prod"', // 3
        '', // 4
        '[vars]', // 5
        'STRIPE_API_KEY = "test"', // 6
        '[[queues.producers]]', // 7
        'binding = "JOBS"', // 8
        'queue = "jobs"', // 9
        '[[queues.consumers]]', // 10
        'queue = "jobs"', // 11
      ].join('\n');
      // CONTROL: `format: 'text'` searches "vars" from line 2 and answers line 3.
      expect(locateEvidence(text, ['vars', 'STRIPE_API_KEY'], { format: 'toml' })).toEqual({
        start: 6,
        end: 6,
      });
      expect(
        locateEvidence(text, ['queues', 'consumers', 'jobs'], { format: 'toml', field: 'queue' }),
      ).toEqual({ start: 11, end: 11 });
      expect(
        locateEvidence(text, ['queues', 'producers', 'jobs'], { format: 'toml', field: 'queue' }),
      ).toEqual({ start: 9, end: 9 });
      expect(locateEvidence(text, ['queues', 'nope', 'jobs'], { format: 'toml' })).toBeNull();
    });
  });

  describe('RCB-177: detectors record the located lines as evidence and pointers', () => {
    const AT = '2026-09-29T05:00:00Z';
    // The brief's fixture: the hyperdrive binding is on LINE 14, inside the 5-line record 12-16.
    // Lines 8 and 11 are comments that name both `hyperdrive` and "HYPERDRIVE" — never evidence.
    const BRIEF_JSONC = [
      '{', // 1
      '  "name": "brief-worker",', // 2
      '  "compatibility_date": "2026-01-01",', // 3
      '  "observability": {', // 4
      '    "enabled": true', // 5
      '  },', // 6
      '  /* bindings below;', // 7
      '     // hyperdrive "HYPERDRIVE" is the primary db */', // 8
      '  "hyperdrive": [', // 9
      '    // hyperdrive "HYPERDRIVE" (primary)', // 10
      '    // second comment line', // 11
      '    {', // 12
      '      "id": "hd-1",', // 13
      '      "binding": "HYPERDRIVE",', // 14
      '      "localConnectionString": "postgres://localhost:5432/app"', // 15
      '    }', // 16
      '  ]', // 17
      '}', // 18
    ].join('\n');

    it('a hyperdrive binding on line 14 inside a 5-line record → wrangler.jsonc:L12-L16 as detected, system pointer AND connection pointer', () => {
      const rel = 'wrangler.jsonc';
      const c = detectWrangler(rel, BRIEF_JSONC);
      const hyperdrive = c.systems.find((s) => s.id === 'hyperdrive');
      // CONTROL: with `locateEvidence` returning null the row keeps `wrangler.jsonc@hyperdrive`
      // and the whole-file pointer, and every assertion below fails.
      expect(hyperdrive?.detected).toBe('wrangler.jsonc:L12-L16');
      expect(hyperdrive?.pointers).toEqual(['wrangler.jsonc:L12-L16']);
      expect(c.connections).toEqual([
        {
          from: 'brief-worker',
          to: 'hyperdrive',
          via: 'hyperdrive binding HYPERDRIVE',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc:L12-L16',
          pointers: ['wrangler.jsonc:L12-L16'],
        },
      ]);
      // the worker IS the whole file: its evidence and pointer stay the file.
      expect(c.systems.find((s) => s.id === 'brief-worker')).toMatchObject({
        detected: rel,
        pointers: [rel],
      });
      // and the pointer, read back through the real ref resolver, is exactly the 5-line record.
      const resolved = resolveRefText('wrangler.jsonc:L12-L16', BRIEF_JSONC);
      expect([resolved.start, resolved.end]).toEqual([12, 16]);
      expect(resolved.text).toContain('"binding": "HYPERDRIVE"');
    });

    it('an un-locatable value keeps `rel@key`, the whole-file pointer, and NO connection pointers', () => {
      // `jobs-q` is the queue "jobs-q" to JSON.parse and unfindable as text.
      const text = [
        '{',
        '  "name": "esc-worker",',
        '  "queues": {',
        '    "producers": [{ "binding": "JOBS", "queue": "jobs\\u002dq" }]',
        '  }',
        '}',
      ].join('\n');
      const c = detectWrangler('wrangler.jsonc', text);
      const q = c.systems.find((s) => s.id === 'jobs-q');
      expect(q).toMatchObject({
        detected: 'wrangler.jsonc@queues.producers',
        pointers: ['wrangler.jsonc'],
      });
      expect(c.connections).toEqual([
        {
          from: 'esc-worker',
          to: 'jobs-q',
          via: 'queues.producers binding JOBS',
          env: ['dev', 'prod'],
          detected: 'wrangler.jsonc@queues.producers',
        },
      ]);
      expect('pointers' in (c.connections[0] ?? {})).toBe(false);
    });

    it('the SAME queue name under producers and consumers is located in each, and the merged system keeps both', () => {
      const text = [
        '{', // 1
        '  "name": "both-worker",', // 2
        '  "queues": {', // 3
        '    "producers": [', // 4
        '      { "binding": "JOBS", "queue": "jobs" }', // 5
        '    ],', // 6
        '    "consumers": [', // 7
        '      { "queue": "jobs" }', // 8
        '    ]', // 9
        '  }', // 10
        '}', // 11
      ].join('\n');
      const merged = mergeCandidates([detectWrangler('wrangler.jsonc', text)]);
      // CONTROL: searching "jobs" over the whole file (no chain region) locates the consumer at
      // line 5 and the second pointer/connection below fail.
      expect(merged.systems.find((s) => s.id === 'jobs')).toMatchObject({
        detected: 'wrangler.jsonc:L5',
        pointers: ['wrangler.jsonc:L5', 'wrangler.jsonc:L8'],
      });
      expect(merged.connections.map((x) => [x.from, x.to, x.detected, x.pointers])).toEqual([
        ['both-worker', 'jobs', 'wrangler.jsonc:L5', ['wrangler.jsonc:L5']],
        ['jobs', 'both-worker', 'wrangler.jsonc:L8', ['wrangler.jsonc:L8']],
      ]);
    });

    it('a dead-letter queue is located at ITS OWN `queue` record, not at the record that names it as dead_letter_queue', () => {
      const text = [
        '{', // 1
        '  "name": "dlq-worker",', // 2
        '  "queues": {', // 3
        '    "consumers": [', // 4
        '      {', // 5
        '        "queue": "jobs",', // 6
        '        "dead_letter_queue": "jobs-dlq"', // 7
        '      },', // 8
        '      {', // 9
        '        "queue": "jobs-dlq"', // 10
        '      }', // 11
        '    ]', // 12
        '  }', // 13
        '}', // 14
      ].join('\n');
      const c = detectWrangler('wrangler.jsonc', text);
      // CONTROL: dropping `field: idField` at the call site answers L5-L8 for the DLQ.
      expect(c.systems.map((s) => [s.id, s.detected])).toEqual([
        ['dlq-worker', 'wrangler.jsonc'],
        ['jobs', 'wrangler.jsonc:L5-L8'],
        ['jobs-dlq', 'wrangler.jsonc:L9-L11'],
      ]);
    });

    it('a var in a small `vars` map is that ONE line, for the system and its connection', () => {
      const text = [
        '{',
        '  "name": "vars-worker",',
        '  "vars": {',
        '    "A": "1",',
        '    "RESEND_API_KEY": "",',
        '    "B": "2"',
        '  }',
        '}',
      ].join('\n');
      const c = detectWrangler('wrangler.jsonc', text);
      expect(c.systems.find((s) => s.id === 'resend')).toMatchObject({
        detected: 'wrangler.jsonc:L5',
        pointers: ['wrangler.jsonc:L5'],
      });
      expect(c.connections[0]).toMatchObject({
        detected: 'wrangler.jsonc:L5',
        pointers: ['wrangler.jsonc:L5'],
      });
    });

    it('toml: a var in [vars] is located under [vars], not the earlier [env.production.vars]; an inline `vars = {…}` is un-locatable and keeps rel@KEY', () => {
      const text = [
        'name = "toml-worker"',
        '[env.production.vars]',
        'STRIPE_API_KEY = "prod"',
        '',
        '[vars]',
        'STRIPE_API_KEY = "test"',
      ].join('\n');
      const c = detectWrangler('wrangler.toml', text);
      expect(c.systems.find((s) => s.id === 'stripe')).toMatchObject({
        detected: 'wrangler.toml:L6',
        pointers: ['wrangler.toml:L6'],
      });
      const inline = detectWrangler(
        'wrangler.toml',
        'name = "toml-worker"\nvars = { STRIPE_API_KEY = "x" }\n',
      );
      expect(inline.systems.find((s) => s.id === 'stripe')).toMatchObject({
        detected: 'wrangler.toml@STRIPE_API_KEY',
        pointers: ['wrangler.toml'],
      });
      expect('pointers' in (inline.connections[0] ?? {})).toBe(false);
    });

    it('compose: a service is its own indented block, even when another service depends_on it before its definition', () => {
      const text = [
        'services:', // 1
        '  app:', // 2
        '    build: .', // 3
        '    depends_on:', // 4
        '      db:', // 5
        '        condition: service_healthy', // 6
        '  db:', // 7
        '    image: postgres:16', // 8
        '    ports:', // 9
        '      - "5433:5432"', // 10
      ].join('\n');
      const c = detectCompose('docker-compose.yml', text);
      expect(c.systems.map((s) => [s.id, s.detected, s.pointers])).toEqual([
        ['app', 'docker-compose.yml:L2-L6', ['docker-compose.yml:L2-L6']],
        ['db', 'docker-compose.yml:L7-L10', ['docker-compose.yml:L7-L10']],
      ]);
      expect(c.connections).toEqual([
        {
          from: 'app',
          to: 'db',
          via: 'depends_on',
          env: ['dev'],
          detected: 'docker-compose.yml:L2-L6',
          pointers: ['docker-compose.yml:L2-L6'],
        },
      ]);
    });

    it('applyDetected: a NEW connection row carries its located pointers, an un-located one carries none; both survive serialize + parse', () => {
      const located: Candidates = {
        ...emptyCandidates(),
        systems: [
          {
            id: 'a',
            name: 'a',
            kind: 'service',
            layer: 'app',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['x.jsonc'],
            detected: 'x.jsonc',
          },
          {
            id: 'b',
            name: 'b',
            kind: 'db',
            layer: 'data',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['x.jsonc'],
            detected: 'x.jsonc',
          },
          {
            id: 'c',
            name: 'c',
            kind: 'db',
            layer: 'data',
            env: ['dev', 'prod'],
            runtime: { dev: null, prod: null },
            pointers: ['x.jsonc'],
            detected: 'x.jsonc',
          },
        ],
        connections: [
          {
            from: 'a',
            to: 'b',
            via: null,
            env: ['dev', 'prod'],
            detected: 'x.jsonc:L3-L6',
            pointers: ['x.jsonc:L3-L6'],
          },
          { from: 'a', to: 'c', via: null, env: ['dev', 'prod'], detected: 'x.jsonc@c' },
        ],
      };
      const applied = applyDetected(emptySystemsDoc(), located, AT);
      const ab = applied.doc.connections.find((x) => x.to === 'b');
      const ac = applied.doc.connections.find((x) => x.to === 'c');
      // CONTROL: without the `pointers` spread on the add branch of `applyDetected`, `ab` has none.
      expect(ab?.pointers).toEqual(['x.jsonc:L3-L6']);
      expect('pointers' in (ac ?? {})).toBe(false);
      const reparsed = parseSystems(serializeSystems(applied.doc));
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.doc.connections.find((x) => x.to === 'b')?.pointers).toEqual([
        'x.jsonc:L3-L6',
      ]);
    });

    it('two connections of one compose service never share a pointer array — a shared one serializes as a YAML anchor (`&a1`/`*a1`) and a re-read is not byte-identical', () => {
      const compose = detectCompose('docker-compose.yml', detectFixture('docker-compose.yml'));
      const [first, second] = compose.connections;
      // CONTROL: `connectionPointers` handing out ONE array (instead of a fresh one per call) makes
      // these the same object.
      expect(first?.pointers).toEqual(second?.pointers);
      expect(first?.pointers).not.toBe(second?.pointers);

      // applyDetected copies too: a candidate list that DOES share an array (a hand-built one, or
      // a future detector) still lands as separate arrays on the rows.
      const shared = ['docker-compose.yml:L8-L12'];
      const applied = applyDetected(
        emptySystemsDoc(),
        mergeCandidates([
          {
            ...compose,
            connections: compose.connections.map((c) => ({ ...c, pointers: shared })),
          },
        ]),
        AT,
      );
      const rows = applied.doc.connections;
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[0]?.pointers).not.toBe(rows[1]?.pointers);
      const text = serializeSystems(applied.doc);
      expect(text).not.toMatch(/&a\d|\*a\d/);
      const reparsed = parseSystems(text);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) expect(serializeSystems(reparsed.doc)).toBe(text);
    });

    describe('applyDetected: updating a detected connection that already has pointers', () => {
      const twoEnv = (): SystemsDoc => {
        const result = parseSystems(systemsFixture('two-env.yml'));
        if (!result.ok) throw new Error('two-env.yml fixture failed to parse');
        return result.doc;
      };
      const isPair = (c: { from: string; to: string }, from: string, to: string) =>
        c.from === from && c.to === to;
      const STALE = 'wrangler.jsonc:L1-L5';
      const HAND_TOKEN = 'wrangler.jsonc@triggers';
      const OTHER_FILE_RANGE = 'src/db.ts:L1-L5';
      const HAND_HEADING = 'docs/x.md#Heading';
      const withPointers = (): SystemsDoc => {
        const base = twoEnv();
        return {
          ...base,
          connections: base.connections.map((c) =>
            isPair(c, 'api', 'postgres')
              ? { ...c, pointers: [STALE, HAND_TOKEN, OTHER_FILE_RANGE, HAND_HEADING] }
              : c,
          ),
        };
      };
      const cand = (pointers?: string[]): Candidates => ({
        ...emptyCandidates(),
        connections: [
          {
            from: 'api',
            to: 'postgres',
            via: 'hyperdrive binding HYPERDRIVE',
            env: ['dev', 'prod'],
            detected: 'wrangler.jsonc:L10-L14',
            ...(pointers !== undefined ? { pointers } : {}),
          },
        ],
      });
      const pointersOf = (doc: SystemsDoc) =>
        doc.connections.find((c) => isPair(c, 'api', 'postgres'))?.pointers;

      it("the fresh :L range replaces the stale one it wrote last time; a hand @Token, #Heading and another file's range all stay", () => {
        const applied = applyDetected(withPointers(), cand(['wrangler.jsonc:L10-L14']), AT);
        expect(applied.updated).toEqual(['api→postgres']);
        // CONTROL: keeping `existing.pointers` verbatim (the RCB-173 rule alone) leaves STALE in
        // and no L10-L14; replacing the list with the candidate's drops the three hand ones;
        // a plain union keeps STALE.
        expect(pointersOf(applied.doc)).toEqual([
          HAND_TOKEN,
          OTHER_FILE_RANGE,
          HAND_HEADING,
          'wrangler.jsonc:L10-L14',
        ]);
      });

      it('re-applying the same candidate is byte-identical (idempotent)', () => {
        const once = applyDetected(withPointers(), cand(['wrangler.jsonc:L10-L14']), AT).doc;
        const twice = applyDetected(once, cand(['wrangler.jsonc:L10-L14']), AT).doc;
        expect(serializeSystems(twice)).toBe(serializeSystems(once));
        expect(pointersOf(twice)).toEqual(pointersOf(once));
      });

      it('an un-located candidate (no pointers) changes NOTHING about the existing ones', () => {
        const applied = applyDetected(withPointers(), cand(), AT);
        expect(pointersOf(applied.doc)).toEqual([
          STALE,
          HAND_TOKEN,
          OTHER_FILE_RANGE,
          HAND_HEADING,
        ]);
      });

      it('a HAND connection keeps its pointers byte-for-byte (skipped), whatever the candidate says', () => {
        const base = twoEnv();
        const doc: SystemsDoc = {
          ...base,
          connections: base.connections.map((c) =>
            isPair(c, 'web', 'gateway') ? { ...c, pointers: ['apps/web/src/api.ts:L1-L9'] } : c,
          ),
        };
        const candidates: Candidates = {
          ...emptyCandidates(),
          connections: [
            {
              from: 'web',
              to: 'gateway',
              via: 'HTTPS',
              env: ['dev', 'prod'],
              detected: 'wrangler.jsonc:L1-L2',
              pointers: ['wrangler.jsonc:L1-L2'],
            },
          ],
        };
        const applied = applyDetected(doc, candidates, AT);
        expect(applied.skipped).toEqual(['web→gateway']);
        expect(applied.doc.connections.find((c) => isPair(c, 'web', 'gateway'))).toEqual(
          doc.connections.find((c) => isPair(c, 'web', 'gateway')),
        );
      });
    });
  });
});
