/**
 * RCB-97 A (plan docs/SYSTEMS-FLOW-PLAN.md §3.3): `systems-surface.ts` — `systemsSummary`'s one
 * line for `repoboard seat`, `formatSystemsTable`'s fixed-width table, `formatSystemRow`'s single
 * row detail. Exact-text assertions throughout (CLAUDE.md: measurements, not adjectives).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptySystemsDoc, parseSystems, type SystemEnv, type SystemsDoc } from '../src/systems.js';
import {
  formatSystemRow,
  formatSystemsTable,
  SYSTEMS_ROW_MAX_BYTES,
  systemsSummary,
} from '../src/systems-surface.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/systems/${name}`, import.meta.url)),
    'utf8',
  );
}

function parseFixture(name: string): SystemsDoc {
  const result = parseSystems(fixture(name));
  if (!result.ok) throw new Error(`fixture ${name} failed to parse: ${result.errors.join('; ')}`);
  return result.doc;
}

/** A minimal, valid `SystemRow` for `env`, nothing else under test. */
function sys(id: string, env: SystemEnv[]): SystemsDoc['systems'][number] {
  return {
    id,
    name: id,
    kind: 'service',
    layer: 'app',
    env,
    runtime: { dev: null, prod: null },
    owner: null,
    pointers: [],
    docs: [],
    why: null,
    status: 'live',
    unblockedBy: [],
    source: { hand: 'test', at: '2026-09-22T00:00:00Z' },
  };
}

describe('systems surfaces (RCB-97)', () => {
  describe('systemsSummary', () => {
    it('errors non-empty (1 error) — invalid, count 0, envs falls back to dev+prod', () => {
      expect(systemsSummary(null, ['bad row'])).toEqual({
        systems: 0,
        connections: 0,
        envs: 'dev+prod',
        line: 'Systems: systems.yml invalid (1 error) — repoboard check',
      });
    });

    it('errors non-empty (3 errors) — pluralised', () => {
      expect(systemsSummary(null, ['a', 'b', 'c']).line).toBe(
        'Systems: systems.yml invalid (3 errors) — repoboard check',
      );
    });

    it('doc null, no errors — "no systems.yml yet", counts 0, envs dev+prod', () => {
      expect(systemsSummary(null, [])).toEqual({
        systems: 0,
        connections: 0,
        envs: 'dev+prod',
        line: 'Systems: no systems.yml yet — repoboard systems detect proposes one',
      });
    });

    it('both environments {none} — envs "none"', () => {
      const doc: SystemsDoc = {
        environments: { dev: { none: 'no dev story' }, prod: { none: 'no prod story' } },
        systems: [],
        connections: [],
      };
      const s = systemsSummary(doc, []);
      expect(s.envs).toBe('none');
      expect(s.line).toBe('Systems: 0 systems, 0 connections, none — repoboard systems');
    });

    it('prod {none} only — envs "prod none"', () => {
      const doc: SystemsDoc = {
        environments: { dev: { note: 'dev story' }, prod: { none: 'no prod story' } },
        systems: [sys('a', ['dev'])],
        connections: [],
      };
      expect(systemsSummary(doc, []).envs).toBe('prod none');
    });

    it('dev {none} only — envs "dev none"', () => {
      const doc: SystemsDoc = {
        environments: { dev: { none: 'no dev story' }, prod: { note: 'prod story' } },
        systems: [sys('a', ['prod'])],
        connections: [],
      };
      expect(systemsSummary(doc, []).envs).toBe('dev none');
    });

    it('systems span both envs — "dev+prod"', () => {
      const doc: SystemsDoc = {
        ...emptySystemsDoc(),
        systems: [sys('a', ['dev']), sys('b', ['prod'])],
      };
      const s = systemsSummary(doc, []);
      expect(s).toEqual({
        systems: 2,
        connections: 0,
        envs: 'dev+prod',
        line: 'Systems: 2 systems, 0 connections, dev+prod — repoboard systems',
      });
    });

    it('every system is dev-only — "dev only"', () => {
      const doc: SystemsDoc = { ...emptySystemsDoc(), systems: [sys('a', ['dev'])] };
      const s = systemsSummary(doc, []);
      expect(s.envs).toBe('dev only');
      expect(s.line).toBe('Systems: 1 systems, 0 connections, dev only — repoboard systems');
    });

    it('every system is prod-only — "prod only"', () => {
      const doc: SystemsDoc = { ...emptySystemsDoc(), systems: [sys('a', ['prod'])] };
      const s = systemsSummary(doc, []);
      expect(s.envs).toBe('prod only');
      expect(s.line).toBe('Systems: 1 systems, 0 connections, prod only — repoboard systems');
    });

    it('no systems at all (empty list, environments not none) — "dev+prod"', () => {
      const doc = emptySystemsDoc();
      const s = systemsSummary(doc, []);
      expect(s).toEqual({
        systems: 0,
        connections: 0,
        envs: 'dev+prod',
        line: 'Systems: 0 systems, 0 connections, dev+prod — repoboard systems',
      });
    });
  });

  describe('formatSystemsTable', () => {
    it('two-env.yml — exact text', () => {
      const doc = parseFixture('two-env.yml');
      expect(formatSystemsTable(doc)).toBe(
        [
          'dev: vite dev :5173 + wrangler dev :8787 + local postgres :5433',
          'prod: Cloudflare Workers; Neon via Hyperdrive',
          'ID           KIND     LAYER     ENV       RUNTIME',
          'web          client   client    dev+prod  vite dev→static hosting',
          'gateway      worker   edge      dev+prod  wrangler dev→Cloudflare Workers',
          'api          service  app       dev+prod  node server→Cloudflare Workers',
          'worker-jobs  job      app       prod      -→queue consumer',
          'postgres     db       data      dev+prod  local postgres :5433→Neon via Hyp…',
          'sendgrid     email    external  dev       sandbox key→-',
          '',
        ].join('\n'),
      );
    });

    it('none-prod.yml — exact text (prod none prints "none: <note>" in place of the diagram row)', () => {
      const doc = parseFixture('none-prod.yml');
      expect(formatSystemsTable(doc)).toBe(
        [
          'dev: local dev only',
          'prod: none: local-only by design — speed and tokens',
          'ID      KIND     LAYER   ENV  RUNTIME',
          'cli     tool     client  dev  node dist/cli.js→-',
          'server  service  app     dev  node dist/server.js→-',
          'sqlite  storage  data    dev  filesystem→-',
          '',
        ].join('\n'),
      );
    });

    it('a system with an empty list of systems prints "(no systems)", no table', () => {
      expect(formatSystemsTable(emptySystemsDoc())).toBe('dev: -\nprod: -\n(no systems)\n');
    });

    it('a 200-char runtime: every line stays within SYSTEMS_ROW_MAX_BYTES and the truncated one ends "…"', () => {
      const doc: SystemsDoc = {
        ...emptySystemsDoc(),
        systems: [
          {
            ...sys('longrun', ['dev', 'prod']),
            runtime: { dev: 'x'.repeat(200), prod: null },
          },
        ],
      };
      const text = formatSystemsTable(doc);
      const lines = text.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(SYSTEMS_ROW_MAX_BYTES);
      }
      const row = lines.find((l) => l.startsWith('longrun'));
      expect(row).toBeDefined();
      expect(row?.endsWith('…')).toBe(true);
    });

    it('RCB-161: STATUS column after ENV, shows a non-live status', () => {
      const doc: SystemsDoc = {
        ...emptySystemsDoc(),
        systems: [{ ...sys('a', ['dev']), status: 'planned' }],
      };
      const text = formatSystemsTable(doc);
      const header = text.split('\n')[2];
      expect(header).toBe('ID  KIND     LAYER  ENV  STATUS   RUNTIME');
      const row = text.split('\n')[3];
      expect(row).toBe('a   service  app    dev  planned  -→-');
    });
  });

  describe('formatSystemRow', () => {
    it('"api" in two-env.yml — exact text, including all 3 connections touching it', () => {
      const doc = parseFixture('two-env.yml');
      expect(formatSystemRow(doc, 'api')).toBe(
        [
          'id: api',
          'name: api service',
          'kind: service',
          'layer: app',
          'env: dev+prod',
          'runtime dev: node server',
          'runtime prod: Cloudflare Workers',
          'owner: -',
          'why: core business logic',
          'source: hand owner at 2026-09-22T00:00:00Z',
          'pointers:',
          '  (none)',
          'docs:',
          '  (none)',
          'connections:',
          '  gateway → api (HTTP internal) [dev+prod]',
          '  api → postgres (Hyperdrive binding HYPERDRIVE) [dev+prod]',
          '  api → sendgrid (SMTP relay) [dev]',
          '',
        ].join('\n'),
      );
    });

    it('an unknown id returns null', () => {
      const doc = parseFixture('two-env.yml');
      expect(formatSystemRow(doc, 'nope')).toBeNull();
    });

    it('RCB-161: a non-live status, an unblocked_by list, and a connection status suffix', () => {
      const doc: SystemsDoc = {
        ...emptySystemsDoc(),
        systems: [
          { ...sys('a', ['dev']), status: 'planned', unblockedBy: ['RCB-9', 'RCB-10'] },
          sys('b', ['dev']),
        ],
        connections: [
          {
            from: 'a',
            to: 'b',
            via: null,
            env: ['dev'],
            status: 'blocked',
            unblockedBy: ['RCB-9'],
            source: { hand: 'test', at: 't' },
          },
        ],
      };
      expect(formatSystemRow(doc, 'a')).toBe(
        [
          'id: a',
          'name: a',
          'kind: service',
          'layer: app',
          'env: dev',
          'status: planned',
          'runtime dev: -',
          'runtime prod: -',
          'owner: -',
          'why: -',
          'source: hand test at 2026-09-22T00:00:00Z',
          'pointers:',
          '  (none)',
          'docs:',
          '  (none)',
          'unblocked by:',
          '  RCB-9',
          '  RCB-10',
          'connections:',
          '  a → b (-) [dev] · blocked',
          '',
        ].join('\n'),
      );
    });
  });
});
