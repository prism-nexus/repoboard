import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptySystemsDoc, layoutSystems, parseSystems, type SystemsDoc } from '../src/systems.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/systems/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('systems.yml (RCB-95)', () => {
  describe('parseSystems', () => {
    it('parses two-env.yml ok', () => {
      const result = parseSystems(fixture('two-env.yml'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.systems).toHaveLength(6);
      expect(result.doc.connections).toHaveLength(5);
      expect(result.doc.environments.dev).toEqual({
        note: 'vite dev :5173 + wrangler dev :8787 + local postgres :5433',
      });
    });

    it('normalises missing optional fields to null/[] rather than guessing', () => {
      const result = parseSystems(fixture('two-env.yml'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // `web` omits `owner` entirely in the fixture.
      const web = result.doc.systems.find((s) => s.id === 'web');
      expect(web?.owner).toBeNull();
      // `worker-jobs` omits owner/pointers/docs/why and half of `runtime`.
      const workerJobs = result.doc.systems.find((s) => s.id === 'worker-jobs');
      expect(workerJobs?.owner).toBeNull();
      expect(workerJobs?.pointers).toEqual([]);
      expect(workerJobs?.docs).toEqual([]);
      expect(workerJobs?.why).toBeNull();
      expect(workerJobs?.runtime).toEqual({ dev: null, prod: 'queue consumer' });
      // connection worker-jobs -> postgres omits `via`.
      const conn = result.doc.connections.find((c) => c.from === 'worker-jobs');
      expect(conn?.via).toBeNull();
    });

    it('accepts an empty systems list with environments present', () => {
      const result = parseSystems(
        'environments:\n  dev: { note: null }\n  prod: { note: null }\nsystems: []\n',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.systems).toEqual([]);
      expect(result.doc.connections).toEqual([]);
    });

    it('errors when `environments` is missing', () => {
      const result = parseSystems('systems: []\n');
      expect(result.ok).toBe(false);
    });

    it('bad.yml produces EXACTLY the 5 expected errors, in row order', () => {
      const result = parseSystems(fixture('bad.yml'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'systems[0] (id "api"): unknown layer "middleware"',
        'systems[1] (id "db"): env must be a non-empty subset of dev, prod',
        'systems[2] (id "worker"): unknown kind "lambda"',
        'systems[3]: duplicate id "worker"',
        'connections[0]: "to" names unknown system "postgres"',
      ]);
    });

    it('rejects an id that does not match [a-z0-9-]+', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: Bad_ID
    name: x
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'systems[0] (id "Bad_ID"): invalid id "Bad_ID" (must match ^[a-z0-9-]+$)',
      ]);
    });
  });

  describe('emptySystemsDoc', () => {
    it('has both environments as {note: null} and no rows', () => {
      expect(emptySystemsDoc()).toEqual({
        environments: { dev: { note: null }, prod: { note: null } },
        systems: [],
        connections: [],
      });
    });
  });

  describe('layoutSystems', () => {
    const twoEnv = () => {
      const result = parseSystems(fixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      return result.doc;
    };

    it('"both": rows in SYSTEM_LAYERS order, only non-empty layers, one-env systems dashed', () => {
      const layout = layoutSystems(twoEnv(), 'both');
      const layers = layout.rows.map((r) => r.layer);
      // Layers present: client, edge, app, data, external (no `ops` system in the fixture), and
      // in exactly this order — hardcoded, not derived from SYSTEM_LAYERS, so a control that
      // reverses that constant still fails this line.
      expect(layers).toEqual(['client', 'edge', 'app', 'data', 'external']);
      const boxById = new Map(layout.rows.flatMap((r) => r.boxes).map((b) => [b.id, b]));
      expect(boxById.get('worker-jobs')?.dashed).toBe(true); // env: [prod]
      expect(boxById.get('sendgrid')?.dashed).toBe(true); // env: [dev]
      expect(boxById.get('api')?.dashed).toBe(false); // env: [dev, prod]
      expect(boxById.get('postgres')?.dashed).toBe(false);
      expect(layout.edges).toHaveLength(5);
      expect(layout.edges.some((e) => e.dashed)).toBe(true);
    });

    it('"prod": drops the dev-only system and its edges, nothing dashed', () => {
      const layout = layoutSystems(twoEnv(), 'prod');
      const ids = layout.rows.flatMap((r) => r.boxes.map((b) => b.id));
      expect(ids).not.toContain('sendgrid');
      expect(ids).toContain('worker-jobs');
      expect(layout.edges.every((e) => e.dashed === false)).toBe(true);
      expect(layout.edges.some((e) => e.to === 'sendgrid')).toBe(false);
      // 5 connections total, minus the one to sendgrid (dev-only) => 4 visible in prod.
      expect(layout.edges).toHaveLength(4);
    });

    it('"dev": drops the prod-only system and its edge', () => {
      const layout = layoutSystems(twoEnv(), 'dev');
      const ids = layout.rows.flatMap((r) => r.boxes.map((b) => b.id));
      expect(ids).not.toContain('worker-jobs');
      expect(ids).toContain('sendgrid');
      expect(layout.edges).toHaveLength(4);
    });

    it('orders a row topologically — the edge wins over id order, ties break by id', () => {
      const doc: SystemsDoc = {
        environments: { dev: { note: null }, prod: { note: null } },
        systems: [
          {
            id: 'alpha',
            name: 'alpha',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: {},
            owner: null,
            pointers: [],
            docs: [],
            why: null,
            source: { hand: 'x', at: 't' },
          },
          {
            id: 'beta',
            name: 'beta',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: {},
            owner: null,
            pointers: [],
            docs: [],
            why: null,
            source: { hand: 'x', at: 't' },
          },
          {
            id: 'zeta',
            name: 'zeta',
            kind: 'service',
            layer: 'app',
            env: ['dev'],
            runtime: {},
            owner: null,
            pointers: [],
            docs: [],
            why: null,
            source: { hand: 'x', at: 't' },
          },
        ],
        // `beta` must come before `alpha` despite losing the id sort.
        connections: [
          { from: 'beta', to: 'alpha', via: null, env: ['dev'], source: { hand: 'x', at: 't' } },
        ],
      };
      const layout = layoutSystems(doc, 'dev');
      expect(layout.rows).toHaveLength(1);
      const order = (layout.rows[0]?.boxes ?? []).map((b) => b.id);
      // beta before alpha (the edge), zeta unconnected and sorted in by id.
      expect(order).toEqual(['beta', 'alpha', 'zeta']);
    });

    it('is deterministic: two calls on the same doc give byte-identical JSON', () => {
      const doc = twoEnv();
      const a = JSON.stringify(layoutSystems(doc, 'both'));
      const b = JSON.stringify(layoutSystems(doc, 'both'));
      expect(a).toBe(b);
    });

    it('every x,y is non-negative and width/height match the bounding box', () => {
      const layout = layoutSystems(twoEnv(), 'both');
      const boxes = layout.rows.flatMap((r) => r.boxes);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
      }
      for (const e of layout.edges) {
        for (const p of e.points) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
        }
      }
      const allX = [
        ...boxes.flatMap((b) => [b.x, b.x + b.w]),
        ...layout.edges.flatMap((e) => e.points.map((p) => p.x)),
      ];
      const allY = [
        ...boxes.flatMap((b) => [b.y, b.y + b.h]),
        ...layout.edges.flatMap((e) => e.points.map((p) => p.y)),
      ];
      expect(layout.width).toBe(Math.max(...allX));
      expect(layout.height).toBe(Math.max(...allY));
    });

    describe('none-prod.yml', () => {
      const noneProd = () => {
        const result = parseSystems(fixture('none-prod.yml'));
        if (!result.ok) throw new Error('fixture failed to parse');
        return result.doc;
      };

      it('"both" still renders the diagram and carries none.prod', () => {
        const layout = layoutSystems(noneProd(), 'both');
        expect(layout.none.prod).toBe('local-only by design — speed and tokens');
        expect(layout.rows.length).toBeGreaterThan(0);
        expect(layout.edges.length).toBeGreaterThan(0);
      });

      it('"both": prod is none, so no box and no edge is dashed even though every row is one-env', () => {
        // RCB-98 fix: every system/connection here has env.length === 1 (dev-only), but `both`
        // only means "one of two stories to compare" when both environments actually have one.
        const layout = layoutSystems(noneProd(), 'both');
        const boxes = layout.rows.flatMap((r) => r.boxes);
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes.every((b) => b.dashed === false)).toBe(true);
        expect(layout.edges.length).toBeGreaterThan(0);
        expect(layout.edges.every((e) => e.dashed === false)).toBe(true);
      });

      it('"prod" view is empty rows/edges, with none.prod set', () => {
        const layout = layoutSystems(noneProd(), 'prod');
        expect(layout.rows).toEqual([]);
        expect(layout.edges).toEqual([]);
        expect(layout.none.prod).toBe('local-only by design — speed and tokens');
      });

      it('"dev" view renders normally (dev has a note, not none)', () => {
        const layout = layoutSystems(noneProd(), 'dev');
        expect(layout.rows.length).toBeGreaterThan(0);
        expect(layout.none.dev).toBeUndefined();
      });
    });
  });
});
