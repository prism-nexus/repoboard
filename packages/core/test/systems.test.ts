import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_LABEL_MAX,
  DEFAULT_SYSTEMS_BUDGET_BYTES,
  emptySystemsDoc,
  FLOW_PATH_NAME_MAX,
  flowOverview,
  type LayoutPoint,
  layoutSystems,
  parseSystems,
  type SystemLayer,
  type SystemsDoc,
} from '../src/systems.js';

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
        note: 'vite dev :5173 + wrangler dev :8700 + local postgres :5499',
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

    // RCB-161 slice 1 -----------------------------------------------------------------------
    it('an unknown `status` on a system row is an error naming the row', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: svc
    name: x
    kind: service
    layer: app
    env: [dev]
    status: shipped
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual(['systems[0] (id "svc"): unknown status "shipped"']);
    });

    it('an `unblocked_by` entry not shaped like a card id is an error naming the row', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: svc
    name: x
    kind: service
    layer: app
    env: [dev]
    unblocked_by: ["not a card id"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'systems[0] (id "svc"): unblocked_by entry "not a card id" is not a card id',
      ]);
    });

    it('an unknown `status` and a bad `unblocked_by` entry on a CONNECTION are each an error', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: a
    name: a
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
  - id: b
    name: b
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
connections:
  - from: a
    to: b
    env: [dev]
    status: shipped
    unblocked_by: ["nope"]
    source: { hand: "owner", at: "t" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'connections[0]: unknown status "shipped"',
        'connections[0]: unblocked_by entry "nope" is not a card id',
      ]);
    });

    it('a valid status and unblocked_by round-trip through parseSystems', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: svc
    name: x
    kind: service
    layer: app
    env: [dev]
    status: planned
    unblocked_by: ["RCB-9", "RCB-10"]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.systems[0]?.status).toBe('planned');
      expect(result.doc.systems[0]?.unblockedBy).toEqual(['RCB-9', 'RCB-10']);
    });

    it('absent `status`/`unblocked_by` normalise to "live"/[] (today\'s behaviour, byte for byte)', () => {
      const result = parseSystems(fixture('two-env.yml'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const s of result.doc.systems) {
        expect(s.status).toBe('live');
        expect(s.unblockedBy).toEqual([]);
      }
      for (const c of result.doc.connections) {
        expect(c.status).toBe('live');
        expect(c.unblockedBy).toEqual([]);
      }
    });

    // RCB-162 -------------------------------------------------------------------------------
    it('an old file with no `rejected:` key normalises to `rejected: []`', () => {
      const result = parseSystems(fixture('two-env.yml'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.rejected).toEqual([]);
    });

    it('parses a `rejected:` block with one of each kind (system and connection)', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: globex-api
    name: x
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
rejected:
  - id: hyperdrive
    why: "not used; globex-api talks to postgres directly"
  - from: globex-api
    to: hyperdrive
    why: "dead binding, removed in the rewrite"
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.rejected).toEqual([
        { id: 'hyperdrive', why: 'not used; globex-api talks to postgres directly' },
        { from: 'globex-api', to: 'hyperdrive', why: 'dead binding, removed in the rewrite' },
      ]);
    });

    it('a rejected entry with no `why` is an error', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - id: hyperdrive
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
    });

    it('a rejected entry with an empty `why` is an error', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - id: hyperdrive
    why: ""
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
    });

    it('a rejected entry with neither `id` nor `from`/`to` (or both) is an error', () => {
      const neither = parseSystems(`environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - why: "no target named"
`);
      expect(neither.ok).toBe(false);
      const both = parseSystems(`environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - id: hyperdrive
    from: globex-api
    to: hyperdrive
    why: "ambiguous"
`);
      expect(both.ok).toBe(false);
    });

    it('a rejected system id that is also a row in `systems` is "rejected but present"', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: hyperdrive
    name: x
    kind: db
    layer: data
    env: [dev]
    source: { hand: "owner", at: "t" }
rejected:
  - id: hyperdrive
    why: "should not also be a live row"
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual(['rejected but present: hyperdrive']);
    });

    it('a rejected connection pair that is also in `connections` is "rejected but present"', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: globex-api
    name: x
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
  - id: hyperdrive
    name: y
    kind: db
    layer: data
    env: [dev]
    source: { hand: "owner", at: "t" }
connections:
  - from: globex-api
    to: hyperdrive
    env: [dev]
    source: { hand: "owner", at: "t" }
rejected:
  - from: globex-api
    to: hyperdrive
    why: "should not also be a live connection"
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual(['rejected but present: globex-api→hyperdrive']);
    });

    it('a duplicate rejection (same id, or same pair, twice) is an error naming the row', () => {
      const dupId = parseSystems(`environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - id: hyperdrive
    why: "first"
  - id: hyperdrive
    why: "second"
`);
      expect(dupId.ok).toBe(false);
      if (dupId.ok) return;
      expect(dupId.errors).toEqual(['rejected[1]: duplicate rejection "hyperdrive"']);

      const dupPair = parseSystems(`environments:
  dev: { note: null }
  prod: { note: null }
rejected:
  - from: globex-api
    to: hyperdrive
    why: "first"
  - from: globex-api
    to: hyperdrive
    why: "second"
`);
      expect(dupPair.ok).toBe(false);
      if (dupPair.ok) return;
      expect(dupPair.errors).toEqual(['rejected[1]: duplicate rejection "globex-api→hyperdrive"']);
    });
  });

  // RCB-173 ---------------------------------------------------------------------------------
  // Connection `label` / `pointers` / `id`, unknown keys as warnings, the byte budget as a warning.
  describe('parseSystems — RCB-173 connection fields, unknown-key and over-budget warnings', () => {
    const HEAD = `environments:
  dev: { note: null }
  prod: { note: null }
`;
    const TWO_SYSTEMS = `systems:
  - id: web
    name: web
    kind: client
    layer: client
    env: [dev]
    source: { hand: "owner", at: "t" }
  - id: api
    name: api
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
`;
    /** One connection block; `extra` is spliced in as raw YAML lines (each already indented 4). */
    const conn = (extra = '') => `  - from: web
    to: api
    env: [dev]
${extra}    source: { hand: "owner", at: "t" }
`;
    const doc = (connections: string, tail = '') =>
      `${HEAD}${TWO_SYSTEMS}connections:\n${connections}${tail}`;

    it('the budget default is 16,384 B (owner 2026-09-29), not the old 4,096', () => {
      expect(DEFAULT_SYSTEMS_BUDGET_BYTES).toBe(16384);
    });

    it('parses label + pointers + id onto the connection; a connection without them has NO such keys', () => {
      const result = parseSystems(
        doc(
          `${conn('    id: rest\n    label: REST calls\n    pointers: ["src/api/index.ts", "src/api/routes.ts:L1-L9"]\n')}${conn('    id: ws\n')}`,
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.connections[0]).toMatchObject({
        id: 'rest',
        label: 'REST calls',
        pointers: ['src/api/index.ts', 'src/api/routes.ts:L1-L9'],
      });
      // absent on disk -> absent in memory (a `label: undefined` key would still be `in`).
      const bare = result.doc.connections[1];
      expect(bare).toBeDefined();
      expect('label' in (bare ?? {})).toBe(false);
      expect('pointers' in (bare ?? {})).toBe(false);
      const noExtras = parseSystems(doc(conn()));
      expect(noExtras.ok).toBe(true);
      if (!noExtras.ok) return;
      const only = noExtras.doc.connections[0] ?? {};
      expect('id' in only).toBe(false);
      expect('label' in only).toBe(false);
      expect('pointers' in only).toBe(false);
    });

    it('an explicit empty `pointers: []` also stays absent in memory (never written back either)', () => {
      const result = parseSystems(doc(conn('    pointers: []\n')));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect('pointers' in (result.doc.connections[0] ?? {})).toBe(false);
    });

    it('a label is 1..40 characters: 40 ok, 41 and "" are errors naming the row', () => {
      expect(CONNECTION_LABEL_MAX).toBe(40);
      const ok = parseSystems(doc(conn(`    label: ${'x'.repeat(40)}\n`)));
      expect(ok.ok).toBe(true);
      const tooLong = parseSystems(doc(conn(`    label: ${'x'.repeat(41)}\n`)));
      expect(tooLong.ok).toBe(false);
      if (tooLong.ok) return;
      expect(tooLong.errors).toEqual(['connections[0]: label must be 1-40 characters']);
      const empty = parseSystems(doc(conn('    label: ""\n')));
      expect(empty.ok).toBe(false);
      if (empty.ok) return;
      expect(empty.errors).toEqual(['connections[0]: label must be 1-40 characters']);
    });

    it('a connection id must match [a-z0-9-]+', () => {
      const result = parseSystems(doc(conn('    id: "Not Valid!"\n')));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'connections[0]: invalid id "Not Valid!" (must match ^[a-z0-9-]+$)',
      ]);
    });

    it('a duplicate (from,to) pair with no ids is an error naming the second row (and the first)', () => {
      const result = parseSystems(doc(`${conn()}${conn()}`));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toEqual([
        'connections[1]: duplicate connection "web→api" (also connections[0]) — rows sharing a from/to pair each need a distinct id',
      ]);
    });

    it('a duplicate pair is fine when EVERY row of it has a distinct id', () => {
      const result = parseSystems(doc(`${conn('    id: rest\n')}${conn('    id: ws\n')}`));
      expect(result.ok).toBe(true);
    });

    it('a duplicate pair with one id missing, or the same id twice, is still an error', () => {
      const oneMissing = parseSystems(doc(`${conn('    id: rest\n')}${conn()}`));
      expect(oneMissing.ok).toBe(false);
      if (oneMissing.ok) return;
      expect(oneMissing.errors).toHaveLength(1);
      expect(oneMissing.errors[0]).toContain('connections[1]: duplicate connection "web→api"');
      const sameId = parseSystems(doc(`${conn('    id: rest\n')}${conn('    id: rest\n')}`));
      expect(sameId.ok).toBe(false);
      if (sameId.ok) return;
      expect(sameId.errors).toHaveLength(1);
      expect(sameId.errors[0]).toContain('connections[1]: duplicate connection "web→api"');
    });

    it('a repeated pair does not affect a different pair (api→web alongside two web→api rows with ids)', () => {
      const reverse = `  - from: api
    to: web
    env: [dev]
    source: { hand: "owner", at: "t" }
`;
      const result = parseSystems(
        doc(`${conn('    id: rest\n')}${conn('    id: ws\n')}${reverse}`),
      );
      expect(result.ok).toBe(true);
    });

    it('unknown keys on a system, a connection and the top level are WARNED by path + key; the parse still succeeds', () => {
      const text = `${HEAD}colour: blue
systems:
  - id: web
    name: web
    kind: client
    layer: client
    env: [dev]
    ownr: backend
    source: { hand: "owner", at: "t" }
  - id: api
    name: api
    kind: service
    layer: app
    env: [dev]
    source: { hand: "owner", at: "t" }
connections:
${conn('    lable: typo\n')}`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([
        {
          kind: 'systems-unknown-key',
          path: 'top level',
          key: 'colour',
          message:
            'systems-unknown-key: top level: unknown key "colour" — ignored, and dropped if systems detect --apply rewrites the file',
        },
        {
          kind: 'systems-unknown-key',
          path: 'systems[0]',
          key: 'ownr',
          message:
            'systems-unknown-key: systems[0] (id "web"): unknown key "ownr" — ignored, and dropped if systems detect --apply rewrites the file',
        },
        {
          kind: 'systems-unknown-key',
          path: 'connections[0]',
          key: 'lable',
          message:
            'systems-unknown-key: connections[0] (web→api): unknown key "lable" — ignored, and dropped if systems detect --apply rewrites the file',
        },
      ]);
      // inert, not dangerous: the row itself is intact.
      expect(result.doc.systems[0]?.id).toBe('web');
      expect(result.doc.connections[0]?.via).toBeNull();
    });

    it('every KNOWN key (incl. the new connection ones and the two-env.yml fixture) warns nothing', () => {
      const full = parseSystems(
        doc(
          conn(
            '    id: a\n    label: L\n    via: v\n    pointers: [p]\n    status: planned\n    unblocked_by: ["RCB-1"]\n',
          ),
        ),
      );
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.warnings).toEqual([]);
      const fixtureResult = parseSystems(fixture('two-env.yml'));
      expect(fixtureResult.ok).toBe(true);
      if (!fixtureResult.ok) return;
      expect(fixtureResult.warnings).toEqual([]);
    });

    it('over budget is a WARNING with bytes vs budget, counted in UTF-8 BYTES, at exactly budget+1 and not at budget', () => {
      const withWhy = (why: string) => `${HEAD}systems:
  - id: web
    name: web
    kind: client
    layer: client
    env: [dev]
    why: "${why}"
    source: { hand: "owner", at: "t" }
`;
      const bytesOf = (t: string) => new TextEncoder().encode(t).length;
      const base = bytesOf(withWhy(''));
      const atBudget = withWhy('x'.repeat(DEFAULT_SYSTEMS_BUDGET_BYTES - base));
      expect(bytesOf(atBudget)).toBe(DEFAULT_SYSTEMS_BUDGET_BYTES);
      const atResult = parseSystems(atBudget);
      expect(atResult.ok).toBe(true);
      if (!atResult.ok) return;
      expect(atResult.warnings).toEqual([]);

      const over = withWhy('x'.repeat(DEFAULT_SYSTEMS_BUDGET_BYTES - base + 1));
      const overResult = parseSystems(over);
      expect(overResult.ok).toBe(true);
      if (!overResult.ok) return;
      expect(overResult.warnings).toEqual([
        {
          kind: 'systems-over-budget',
          bytes: DEFAULT_SYSTEMS_BUDGET_BYTES + 1,
          budget: DEFAULT_SYSTEMS_BUDGET_BYTES,
          message: `systems-over-budget: .repoboard/systems.yml is ${DEFAULT_SYSTEMS_BUDGET_BYTES + 1} B, over the ${DEFAULT_SYSTEMS_BUDGET_BYTES} B budget (warned, not enforced)`,
        },
      ]);
      // the doc is still fully parsed: warned, not enforced.
      expect(overResult.doc.systems).toHaveLength(1);

      // Bytes, not characters: 8,200 two-byte characters is 8,200 chars (well under 16,384) but
      // over 16,384 bytes.
      const wide = withWhy('é'.repeat(8200));
      expect(wide.length).toBeLessThan(DEFAULT_SYSTEMS_BUDGET_BYTES);
      const wideResult = parseSystems(wide);
      expect(wideResult.ok).toBe(true);
      if (!wideResult.ok) return;
      expect(wideResult.warnings.map((w) => w.kind)).toEqual(['systems-over-budget']);
    });
  });

  describe('parseSystems — RCB-180 paths', () => {
    // two-env.yml: web -> gateway -> api -> postgres; worker-jobs -> postgres (prod); api -> sendgrid (dev).
    const withPaths = (paths: string) => `${fixture('two-env.yml')}paths:\n${paths}`;
    const path = (name: string, hops: string, extra = '') =>
      `  - name: ${name}\n    hops: ${hops}\n${extra}    source: { hand: "owner", at: "t" }\n`;
    const errorsOf = (text: string): string[] => {
      const result = parseSystems(text);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.errors;
    };

    it('a `paths:` list parses onto doc.paths (name, hops in order, source), and warns nothing', () => {
      const result = parseSystems(
        withPaths(
          `${path('page load', '[web, gateway, api, postgres]')}${path('nightly', '[worker-jobs, postgres]')}`,
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.paths).toEqual([
        {
          name: 'page load',
          hops: ['web', 'gateway', 'api', 'postgres'],
          source: { hand: 'owner', at: 't' },
        },
        { name: 'nightly', hops: ['worker-jobs', 'postgres'], source: { hand: 'owner', at: 't' } },
      ]);
      // `paths` is a KNOWN top-level key: the unknown-key warning reads the schema's own shape.
      expect(result.warnings).toEqual([]);
    });

    it('an unknown key in a `paths[i]` entry is WARNED once, by path and key; the parse still succeeds', () => {
      // `serializeSystems` writes only name/hops/source, so `systems detect --apply` would drop it.
      const result = parseSystems(
        withPaths(
          `${path('page load', '[web, gateway]')}${path('nightly', '[worker-jobs, postgres]', '    hopz: [web]\n')}`,
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.warnings).toEqual([
        {
          kind: 'systems-unknown-key',
          path: 'paths[1]',
          key: 'hopz',
          message:
            'systems-unknown-key: paths[1] (name "nightly"): unknown key "hopz" — ignored, and dropped if systems detect --apply rewrites the file',
        },
      ]);
      // inert, not dangerous: the entry itself is intact.
      expect(result.doc.paths?.[1]).toEqual({
        name: 'nightly',
        hops: ['worker-jobs', 'postgres'],
        source: { hand: 'owner', at: 't' },
      });
      // CONTROL: no loop over `raw.paths` in `systemsWarnings` (or a `knownPath` that admits
      // every key) leaves `warnings` empty and fails the first assertion; a `knownPath` missing
      // one of name/hops/source would also warn on the clean docs in the tests around this one.
    });

    it('a `detected` source parses too; a source with neither key is an ordinary zod issue', () => {
      const detected = parseSystems(
        withPaths(
          '  - name: p\n    hops: [web, gateway]\n    source: { detected: "src/a.ts", at: "t" }\n',
        ),
      );
      expect(detected.ok).toBe(true);
      if (!detected.ok) return;
      expect(detected.doc.paths?.[0]?.source).toEqual({ detected: 'src/a.ts', at: 't' });
      const none = errorsOf(
        withPaths('  - name: p\n    hops: [web, gateway]\n    source: { at: "t" }\n'),
      );
      expect(none).toEqual([
        'paths.0.source: source must have exactly one of "detected" or "hand"',
      ]);
    });

    it('a file with no `paths:` — or an empty one — has NO `paths` key in memory (not `[]`, not undefined)', () => {
      const bare = parseSystems(fixture('two-env.yml'));
      expect(bare.ok).toBe(true);
      if (!bare.ok) return;
      expect('paths' in bare.doc).toBe(false);
      const empty = parseSystems(withPaths('').replace('paths:\n', 'paths: []\n'));
      expect(empty.ok).toBe(true);
      if (!empty.ok) return;
      expect('paths' in empty.doc).toBe(false);
    });

    it('an unknown hop id names the path and the hop index; the pair check does not repeat it', () => {
      expect(errorsOf(withPaths(path('lost', '[web, nowhere, api]')))).toEqual([
        'paths[0] (name "lost"): hops[1] names unknown system "nowhere"',
      ]);
    });

    it('a consecutive pair with no connection is an error: `hop <a>→<b> is not a connection`', () => {
      expect(errorsOf(withPaths(path('skip', '[web, api]')))).toEqual([
        'paths[0] (name "skip"): hop web→api is not a connection',
      ]);
      // the SECOND pair is the bad one: the first (web→gateway) is a connection and is not reported.
      expect(errorsOf(withPaths(path('half', '[web, gateway, postgres]')))).toEqual([
        'paths[0] (name "half"): hop gateway→postgres is not a connection',
      ]);
    });

    it('when only the REVERSE connection exists the error says so: ` (<b>→<a> is)`', () => {
      expect(errorsOf(withPaths(path('backwards', '[gateway, web]')))).toEqual([
        'paths[0] (name "backwards"): hop gateway→web is not a connection (web→gateway is)',
      ]);
    });

    it("a connection in only ONE env still satisfies a hop: env is the view's business, not the parse's", () => {
      // api→sendgrid is dev-only, worker-jobs→postgres prod-only.
      const result = parseSystems(
        withPaths(`${path('mail', '[api, sendgrid]')}${path('job', '[worker-jobs, postgres]')}`),
      );
      expect(result.ok).toBe(true);
    });

    it('a pair with parallel rows (RCB-173 ids) is satisfied by any of them, once', () => {
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - { id: web, name: web, kind: client, layer: client, env: [dev], source: { hand: "o", at: "t" } }
  - { id: api, name: api, kind: service, layer: app, env: [dev], source: { hand: "o", at: "t" } }
connections:
  - { from: web, to: api, id: rest, env: [dev], source: { hand: "o", at: "t" } }
  - { from: web, to: api, id: ws, env: [dev], source: { hand: "o", at: "t" } }
paths:
  - name: both
    hops: [web, api]
    source: { hand: "o", at: "t" }
`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.doc.paths).toHaveLength(1);
    });

    it('a repeated name is an error naming the second path and the first', () => {
      expect(
        errorsOf(withPaths(`${path('same', '[web, gateway]')}${path('same', '[gateway, api]')}`)),
      ).toEqual(['paths[1] (name "same"): duplicate name "same" (also paths[0])']);
    });

    it('fewer than 2 hops is an error (1 hop and 0 hops)', () => {
      expect(errorsOf(withPaths(path('one', '[web]')))).toEqual([
        'paths[0] (name "one"): needs at least 2 hops',
      ]);
      expect(errorsOf(withPaths(path('none', '[]')))).toEqual([
        'paths[0] (name "none"): needs at least 2 hops',
      ]);
    });

    it('a name is 1..40 characters: 40 ok, 41 and "" are errors naming the path', () => {
      expect(FLOW_PATH_NAME_MAX).toBe(40);
      const ok = parseSystems(withPaths(path('x'.repeat(40), '[web, gateway]')));
      expect(ok.ok).toBe(true);
      expect(errorsOf(withPaths(path('x'.repeat(41), '[web, gateway]')))).toEqual([
        `paths[0] (name "${'x'.repeat(41)}"): name must be 1-40 characters`,
      ]);
      expect(errorsOf(withPaths(path('""', '[web, gateway]')))).toEqual([
        'paths[0] (name ""): name must be 1-40 characters',
      ]);
    });

    it('EVERY error is collected, path by path in `paths:` order (not first-only)', () => {
      expect(
        errorsOf(
          withPaths(
            `${path('a', '[web, api]')}${path('b', '[web]')}${path('a', '[gateway, web]')}${path('d', '[web, ghost, api]')}`,
          ),
        ),
      ).toEqual([
        'paths[0] (name "a"): hop web→api is not a connection',
        'paths[1] (name "b"): needs at least 2 hops',
        'paths[2] (name "a"): duplicate name "a" (also paths[0])',
        'paths[2] (name "a"): hop gateway→web is not a connection (web→gateway is)',
        'paths[3] (name "d"): hops[1] names unknown system "ghost"',
      ]);
    });
  });

  describe('flowOverview (RCB-180)', () => {
    const twoEnv = () => {
      const result = parseSystems(fixture('two-env.yml'));
      if (!result.ok) throw new Error('fixture failed to parse');
      return result.doc;
    };

    it('two-env.yml, both: one data store, one external, and the two systems nothing connects into', () => {
      expect(flowOverview(twoEnv(), 'both')).toEqual({
        dataStores: ['postgres'],
        externals: ['sendgrid'],
        entryPoints: ['web', 'worker-jobs'],
      });
    });

    it('is over what the env DRAWS: prod loses the dev-only external, dev loses the prod-only entry point', () => {
      expect(flowOverview(twoEnv(), 'prod')).toEqual({
        dataStores: ['postgres'],
        externals: [],
        entryPoints: ['web', 'worker-jobs'],
      });
      expect(flowOverview(twoEnv(), 'dev')).toEqual({
        dataStores: ['postgres'],
        externals: ['sendgrid'],
        entryPoints: ['web'],
      });
    });

    it('entry points follow the env: a system whose only feeder is not drawn there becomes one', () => {
      // gateway is entered from web in both envs. Drop web from prod: the gateway has no incoming
      // connection left in prod and becomes an entry point there — but not in dev or both.
      const doc = twoEnv();
      const web = doc.systems.find((s) => s.id === 'web');
      if (!web) throw new Error('fixture lost web');
      web.env = ['dev'];
      expect(flowOverview(doc, 'prod').entryPoints).toEqual(['gateway', 'worker-jobs']);
      expect(flowOverview(doc, 'dev').entryPoints).toEqual(['web']);
      expect(flowOverview(doc, 'both').entryPoints).toEqual(['web', 'worker-jobs']);
    });

    it('a `none` environment draws nothing, so all three groups are empty', () => {
      const result = parseSystems(fixture('none-prod.yml'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(flowOverview(result.doc, 'prod')).toEqual({
        dataStores: [],
        externals: [],
        entryPoints: [],
      });
      // the same doc in dev still draws its systems (control: emptiness is the env's, not the doc's).
      expect(flowOverview(result.doc, 'dev')).toEqual({
        dataStores: ['sqlite'],
        externals: [],
        entryPoints: ['cli'],
      });
    });

    it("ids are in systems: FILE order, not the layout's row order", () => {
      // File order: zeta (app), omega (external), alpha (client), beta (external), mid (data),
      // deep (data). The layout draws client, app, data, external rows, ids ascending — a different
      // order in every group.
      const row = (id: string, layer: string) =>
        `  - { id: ${id}, name: ${id}, kind: service, layer: ${layer}, env: [dev], source: { hand: "o", at: "t" } }\n`;
      const link = (from: string, to: string) =>
        `  - { from: ${from}, to: ${to}, env: [dev], source: { hand: "o", at: "t" } }\n`;
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
${row('zeta', 'app')}${row('omega', 'external')}${row('alpha', 'client')}${row('beta', 'external')}${row('mid', 'data')}${row('deep', 'data')}connections:
${link('zeta', 'omega')}${link('alpha', 'zeta')}${link('zeta', 'mid')}${link('zeta', 'beta')}${link('zeta', 'deep')}`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(flowOverview(result.doc, 'dev')).toEqual({
        dataStores: ['mid', 'deep'],
        externals: ['omega', 'beta'],
        entryPoints: ['alpha'],
      });
    });

    it('an isolated system, and one connected only to itself, are not entry points; a self-loop does not stop one being an entry', () => {
      const row = (id: string) =>
        `  - { id: ${id}, name: ${id}, kind: service, layer: app, env: [dev], source: { hand: "o", at: "t" } }\n`;
      const link = (from: string, to: string) =>
        `  - { from: ${from}, to: ${to}, env: [dev], source: { hand: "o", at: "t" } }\n`;
      const text = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
${row('lonely')}${row('looper')}${row('starter')}${row('sink')}connections:
${link('looper', 'looper')}${link('starter', 'starter')}${link('starter', 'sink')}`;
      const result = parseSystems(text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(flowOverview(result.doc, 'dev').entryPoints).toEqual(['starter']);
    });

    it('an empty doc has three empty groups', () => {
      expect(flowOverview(emptySystemsDoc(), 'both')).toEqual({
        dataStores: [],
        externals: [],
        entryPoints: [],
      });
    });
  });

  describe('emptySystemsDoc', () => {
    it('has both environments as {note: null} and no rows', () => {
      expect(emptySystemsDoc()).toEqual({
        environments: { dev: { note: null }, prod: { note: null } },
        systems: [],
        connections: [],
        rejected: [],
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
            status: 'live',
            unblockedBy: [],
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
            status: 'live',
            unblockedBy: [],
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
            status: 'live',
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          },
        ],
        // `beta` must come before `alpha` despite losing the id sort.
        connections: [
          {
            from: 'beta',
            to: 'alpha',
            via: null,
            env: ['dev'],
            status: 'live',
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          },
        ],
        rejected: [],
      };
      const layout = layoutSystems(doc, 'dev');
      expect(layout.rows).toHaveLength(1);
      const order = (layout.rows[0]?.boxes ?? []).map((b) => b.id);
      // beta before alpha (the edge), zeta unconnected and sorted in by id.
      expect(order).toEqual(['beta', 'alpha', 'zeta']);
    });

    it('RCB-161 slice 2: a box/edge carries its row/connection status, absent on disk defaults to live', () => {
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
            status: 'planned',
            unblockedBy: [],
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
            status: 'live',
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          },
        ],
        connections: [
          {
            from: 'alpha',
            to: 'beta',
            via: null,
            env: ['dev'],
            status: 'blocked',
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          },
        ],
        rejected: [],
      };
      const layout = layoutSystems(doc, 'dev');
      const boxById = new Map(layout.rows.flatMap((r) => r.boxes).map((b) => [b.id, b]));
      expect(boxById.get('alpha')?.status).toBe('planned');
      expect(boxById.get('beta')?.status).toBe('live');
      expect(layout.edges).toHaveLength(1);
      expect(layout.edges[0]?.status).toBe('blocked');
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

    describe('K14: edge detours around a box in its column', () => {
      /** Independent of the production helper on purpose: this re-derives "does this segment
       * cross that rectangle" from scratch so the test does not just re-check the implementation
       * against itself. Segments here are always axis-aligned (horizontal or vertical), so a
       * plain interval-overlap test on x and y is exact; boundary-touching (grazing an edge, not
       * passing through) does not count as a hit. */
      function segmentHitsRect(
        a: LayoutPoint,
        b: LayoutPoint,
        rect: { x: number; y: number; w: number; h: number },
      ): boolean {
        const xLo = Math.min(a.x, b.x);
        const xHi = Math.max(a.x, b.x);
        const yLo = Math.min(a.y, b.y);
        const yHi = Math.max(a.y, b.y);
        return xHi > rect.x && xLo < rect.x + rect.w && yHi > rect.y && yLo < rect.y + rect.h;
      }

      it("api -> sendgrid clears postgres: no segment of the path intersects postgres's rectangle", () => {
        // Two-env fixture, env `both`: api (app row) and sendgrid (external row) share a column
        // two rows apart, with postgres (data row) sitting directly between them.
        const layout = layoutSystems(twoEnv(), 'both');
        const boxes = layout.rows.flatMap((r) => r.boxes);
        const postgres = boxes.find((b) => b.id === 'postgres');
        expect(postgres).toBeDefined();
        if (!postgres) return;
        const edge = layout.edges.find((e) => e.from === 'api' && e.to === 'sendgrid');
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.points.length).toBeGreaterThanOrEqual(2);
        for (let i = 0; i + 1 < edge.points.length; i++) {
          const a = edge.points[i];
          const b = edge.points[i + 1];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (!a || !b) continue;
          expect(segmentHitsRect(a, b, postgres)).toBe(false);
        }
      });

      it('gateway -> api (adjacent rows, one column, nothing between) is one straight vertical line, port to port', () => {
        // Regression pin: gateway (edge row) -> api (app row) share a column one row apart, with
        // no row (hence no box) between them, so the K14 detour must never fire here.
        const layout = layoutSystems(twoEnv(), 'both');
        const edge = layout.edges.find((e) => e.from === 'gateway' && e.to === 'api');
        expect(edge).toBeDefined();
        if (!edge) return;
        // gateway: x 0, y 2, h 1 -> bottom edge y 3. api: x 0, y 4, h 1 -> top edge y 4. Each has
        // one edge on that side, so both ports are the centre, x 0.5: one line, no elbow.
        // (RCB-179: this pinned the pre-routing path, an elbow at midY 3.5 written out as
        // [{0.5,3},{0.5,3.5},{0.5,3.5},{0.5,4}] — two of those four points were the same line.)
        expect(edge.points).toEqual([
          { x: 0.5, y: 3 },
          { x: 0.5, y: 4 },
        ]);
      });
    });

    describe('RCB-179: edges get ports, lanes and routes around boxes', () => {
      interface Routed {
        rows: { boxes: { id: string; x: number; y: number; w: number; h: number }[] }[];
        edges: { from: string; to: string; points: LayoutPoint[] }[];
        width: number;
        height: number;
      }
      type Kind = 'end' | 'shared-end' | 'bounds' | 'diagonal' | 'box' | 'overlap';
      const EPS = 1e-9;

      /** Every way `layout`'s routes break the guarantees, tagged. Written from the guarantees, not
       * from `routeEdges`: a segment is in a box when it crosses the box's INTERIOR (grazing a
       * border is not); two segments overlap when they are collinear and share a stretch longer
       * than rounding error (touching at a point is not). Own end boxes are held to the same rule —
       * a route leaves its box, it does not run through it. */
      function problems(layout: Routed): { kind: Kind; message: string }[] {
        const found: { kind: Kind; message: string }[] = [];
        const boxes = layout.rows.flatMap((r) => r.boxes);
        const label = (i: number) => {
          const e = layout.edges[i];
          return `edge ${i} ${e?.from}->${e?.to}`;
        };
        const seenEnds = new Map<string, string>();
        layout.edges.forEach((e, i) => {
          const ends = [
            { role: 'exit', p: e.points[0], id: e.from },
            { role: 'entry', p: e.points[e.points.length - 1], id: e.to },
          ];
          for (const { role, p, id } of ends) {
            const box = boxes.find((b) => b.id === id);
            if (p === undefined || box === undefined) {
              found.push({ kind: 'end', message: `${label(i)}: no ${role} point` });
              continue;
            }
            const onSide =
              (Math.abs(p.y - box.y) <= EPS || Math.abs(p.y - (box.y + box.h)) <= EPS) &&
              p.x > box.x + EPS &&
              p.x < box.x + box.w - EPS;
            if (!onSide) {
              found.push({
                kind: 'end',
                message: `${label(i)}: ${role} is not on a top/bottom side`,
              });
            }
            const key = `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
            const other = seenEnds.get(key);
            if (other !== undefined) {
              found.push({
                kind: 'shared-end',
                message: `${label(i)} ${role} is the point ${other} uses`,
              });
            } else seenEnds.set(key, `${label(i)} ${role}`);
          }
          for (const p of e.points) {
            if (p.x < 0 || p.y < 0) {
              found.push({ kind: 'bounds', message: `${label(i)}: negative point ${p.x},${p.y}` });
            }
            if (p.x > layout.width + EPS || p.y > layout.height + EPS) {
              found.push({
                kind: 'bounds',
                message: `${label(i)}: point ${p.x},${p.y} outside ${layout.width} x ${layout.height}`,
              });
            }
          }
        });

        type Seg = { a: LayoutPoint; b: LayoutPoint; vertical: boolean };
        const segs: Seg[][] = layout.edges.map((e, i) => {
          const out: Seg[] = [];
          for (let k = 0; k + 1 < e.points.length; k++) {
            const a = e.points[k];
            const b = e.points[k + 1];
            if (a === undefined || b === undefined) continue;
            const dx = Math.abs(a.x - b.x);
            const dy = Math.abs(a.y - b.y);
            if (dx <= EPS && dy <= EPS) continue;
            if (dx > EPS && dy > EPS)
              found.push({ kind: 'diagonal', message: `${label(i)}: diagonal` });
            out.push({ a, b, vertical: dx <= EPS });
          }
          return out;
        });
        segs.forEach((list, i) => {
          for (const s of list) {
            for (const b of boxes) {
              if (
                Math.max(s.a.x, s.b.x) > b.x + EPS &&
                Math.min(s.a.x, s.b.x) < b.x + b.w - EPS &&
                Math.max(s.a.y, s.b.y) > b.y + EPS &&
                Math.min(s.a.y, s.b.y) < b.y + b.h - EPS
              ) {
                found.push({
                  kind: 'box',
                  message: `${label(i)}: a segment is inside box ${b.id}`,
                });
              }
            }
          }
        });
        for (let i = 0; i < segs.length; i++) {
          for (let j = i; j < segs.length; j++) {
            for (const [p, a] of (segs[i] ?? []).entries()) {
              for (const [q, b] of (segs[j] ?? []).entries()) {
                if (i === j && q <= p) continue;
                if (a.vertical !== b.vertical) continue;
                const [ca, cb] = a.vertical ? [a.a.x, b.a.x] : [a.a.y, b.a.y];
                if (Math.abs(ca - cb) > EPS) continue;
                const span = (s: Seg) =>
                  s.vertical
                    ? [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)]
                    : [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)];
                const [aLo = 0, aHi = 0] = span(a);
                const [bLo = 0, bHi = 0] = span(b);
                if (Math.min(aHi, bHi) - Math.max(aLo, bLo) > EPS) {
                  found.push({
                    kind: 'overlap',
                    message: `${label(i)} and ${label(j)} share a stretch of ${a.vertical ? 'x' : 'y'} = ${ca}`,
                  });
                }
              }
            }
          }
        }
        return found;
      }
      const only = (layout: Routed, ...kinds: Kind[]) =>
        problems(layout)
          .filter((p) => kinds.includes(p.kind))
          .map((p) => p.message);

      /** A doc from `[id, layer]` systems and `[from, to, id?]` connections. */
      function docOf(
        systems: readonly (readonly [string, SystemLayer])[],
        connections: readonly (readonly [string, string] | readonly [string, string, string])[],
      ): SystemsDoc {
        return {
          environments: { dev: { note: null }, prod: { note: null } },
          systems: systems.map(([id, layer]) => ({
            id,
            name: id,
            kind: 'service' as const,
            layer,
            env: ['dev' as const, 'prod' as const],
            runtime: {},
            owner: null,
            pointers: [],
            docs: [],
            why: null,
            status: 'live' as const,
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          })),
          connections: connections.map(([from, to, id]) => ({
            from,
            to,
            ...(id === undefined ? {} : { id }),
            via: null,
            env: ['dev' as const, 'prod' as const],
            status: 'live' as const,
            unblockedBy: [],
            source: { hand: 'x', at: 't' },
          })),
          rejected: [],
        };
      }

      /** a member's shape: 18 boxes over four rows; `api` is a hub with 11 edges; 9 edges are two or
       * three rows long; one two-way pair across rows and one inside a row; two `id`ed rows of one
       * pair; one edge inside a row. */
      const acmeShaped = () =>
        docOf(
          [
            ['web', 'client'],
            ['mobile', 'client'],
            ['admin', 'client'],
            ['api', 'app'],
            ['auth-svc', 'app'],
            ['billing', 'app'],
            ['jobs', 'app'],
            ['notifier', 'app'],
            ['search', 'app'],
            ['postgres', 'data'],
            ['redis', 'data'],
            ['s3', 'data'],
            ['queue', 'data'],
            ['warehouse', 'data'],
            ['stripe', 'external'],
            ['sendgrid', 'external'],
            ['twilio', 'external'],
            ['github', 'external'],
          ],
          [
            ['web', 'api'],
            ['mobile', 'api'],
            ['admin', 'api'],
            ['api', 'auth-svc'],
            ['api', 'postgres', 'reads'],
            ['api', 'postgres', 'writes'],
            ['api', 'redis'],
            ['api', 'queue'],
            ['api', 's3'],
            ['api', 'stripe'],
            ['api', 'sendgrid'],
            ['billing', 'postgres'],
            ['billing', 'stripe'],
            ['stripe', 'billing'],
            ['jobs', 'queue'],
            ['queue', 'jobs'],
            ['jobs', 'postgres'],
            ['github', 'jobs'],
            ['notifier', 'sendgrid'],
            ['notifier', 'twilio'],
            ['notifier', 'queue'],
            ['search', 'warehouse'],
            ['warehouse', 'search'],
            ['web', 'postgres'],
            ['admin', 'stripe'],
            ['auth-svc', 'redis'],
          ],
        );
      const rowIndexOf = (layout: Routed) =>
        new Map(layout.rows.flatMap((r, i) => r.boxes.map((b) => [b.id, i] as const)));

      /** mulberry32 — a random doc is a function of its seed. */
      function randomDoc(seed: number): SystemsDoc {
        let s = seed >>> 0;
        const next = () => {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
        const layers: SystemLayer[] = ['client', 'edge', 'app', 'data', 'external', 'ops'];
        const systems: [string, SystemLayer][] = [];
        const rowCount = int(1, 6);
        for (let r = 0; r < rowCount; r++) {
          const boxCount = int(1, 7);
          for (let c = 0; c < boxCount; c++) systems.push([`s${r}-${c}`, layers[r] ?? 'ops']);
        }
        const connections: ([string, string] | [string, string, string])[] = [];
        const seen = new Map<string, number>();
        for (let k = int(0, 40); k > 0; k--) {
          const from = systems[int(0, systems.length - 1)]?.[0] ?? '';
          const to = systems[int(0, systems.length - 1)]?.[0] ?? '';
          const n = seen.get(`${from}>${to}`) ?? 0;
          seen.set(`${from}>${to}`, n + 1);
          // A repeated pair is legal only when every row of it has its own id.
          if (n === 1) {
            const first = connections.findIndex((c) => c[0] === from && c[1] === to);
            connections[first] = [from, to, 'p0'];
          }
          connections.push(n === 0 ? [from, to] : [from, to, `p${n}`]);
        }
        return docOf(systems, connections);
      }

      it('CONTROL: the checker reports a shared port, a collinear overlap, a segment inside a box and a negative point, and passes a clean layout', () => {
        const box = (id: string, y: number) => ({ id, x: 0, y, w: 1, h: 1 });
        const rows = [{ boxes: [box('a', 0)] }, { boxes: [box('b', 2)] }, { boxes: [box('c', 4)] }];
        const layout = (edges: Routed['edges']): Routed => ({ rows, edges, width: 1, height: 5 });
        const at = (...xy: number[]) =>
          xy.flatMap((v, i) => (i % 2 ? [] : [{ x: v, y: xy[i + 1] ?? 0 }]));
        const clean = layout([
          { from: 'a', to: 'b', points: at(0.25, 1, 0.25, 2) },
          { from: 'b', to: 'c', points: at(0.5, 3, 0.5, 4) },
        ]);
        expect(problems(clean)).toEqual([]);
        const sharedExit = layout([
          { from: 'a', to: 'b', points: at(0.5, 1, 0.5, 2) },
          {
            from: 'a',
            to: 'c',
            points: at(0.5, 1, 0.5, 1.5, 1.25, 1.5, 1.25, 3.5, 0.75, 3.5, 0.75, 4),
          },
        ]);
        expect(only(sharedExit, 'shared-end')).toHaveLength(1);
        const overlap = layout([
          { from: 'a', to: 'b', points: at(0.25, 1, 0.25, 1.5, 0.75, 1.5, 0.75, 2) },
          { from: 'a', to: 'b', points: at(0.4, 1, 0.4, 1.5, 0.9, 1.5, 0.9, 2) },
        ]);
        expect(only(overlap, 'overlap')).toHaveLength(1);
        expect(only(overlap, 'shared-end', 'box')).toEqual([]);
        const throughBox = layout([{ from: 'a', to: 'c', points: at(0.5, 1, 0.5, 4) }]);
        expect(only(throughBox, 'box')).toHaveLength(1);
        const outside = { ...clean, width: 0.4 };
        expect(only(outside, 'bounds').length).toBeGreaterThan(0);
        // CONTROL of the control: a checker that never reports fails each `toHaveLength(1)`.
      });

      it('the acme-shaped doc is what it claims: >= 15 boxes over 4 rows, a hub of >= 8 edges, multi-row edges, a two-way pair, parallel rows', () => {
        const layout = layoutSystems(acmeShaped(), 'both');
        const rowOf = rowIndexOf(layout);
        expect(layout.rows).toHaveLength(4);
        expect(layout.rows.flatMap((r) => r.boxes).length).toBeGreaterThanOrEqual(15);
        expect(
          layout.edges.filter((e) => e.from === 'api' || e.to === 'api').length,
        ).toBeGreaterThanOrEqual(8);
        const span = (e: { from: string; to: string }) =>
          Math.abs((rowOf.get(e.to) ?? 0) - (rowOf.get(e.from) ?? 0));
        expect(layout.edges.filter((e) => span(e) >= 2).length).toBeGreaterThanOrEqual(5);
        expect(layout.edges.filter((e) => span(e) === 0)).toHaveLength(1);
        expect(layout.edges.filter((e) => e.from === 'api' && e.to === 'postgres')).toHaveLength(2);
        expect(layout.edges.some((e) => e.from === 'stripe' && e.to === 'billing')).toBe(true);
        expect(layout.edges.some((e) => e.from === 'billing' && e.to === 'stripe')).toBe(true);
        // CONTROL: delete the hub's edges or the multi-row ones from the doc and this fails —
        // the properties below say nothing about a doc without them.
      });

      it('no two edges share an exit or entry point, and every end is on a top/bottom side of its box (acme-shaped)', () => {
        const layout = layoutSystems(acmeShaped(), 'both');
        expect(only(layout, 'end', 'shared-end')).toEqual([]);
        // CONTROL: place every port at the box centre (`x + w / 2`) instead of spreading them and
        // the hub's exits (8 on one side) all meet at one point; `shared-end` reports them.
      });

      it('a side with n edges spreads them at x + w * (k + 1) / (n + 1), ordered by the far end x (ties: connection order)', () => {
        const doc = acmeShaped();
        const layout = layoutSystems(doc, 'both');
        const api = layout.rows.flatMap((r) => r.boxes).find((b) => b.id === 'api');
        // api's bottom side carries 8 exits (its 3 entries are on the top side). Boxes sit at
        // x = 1.5 * column: postgres 0, auth-svc and queue 1.5, redis 3, s3 4.5 — and in the
        // external row sendgrid 1.5, stripe 3 — so `reads` (connection 4) comes before `writes`
        // (5), and among far ends at one x the earlier connection comes first.
        const order = [4, 5, 3, 7, 10, 6, 9, 8];
        const bottom = order.map((i) => layout.edges[i]?.points[0]);
        expect(order.map((i) => doc.connections[i]?.to)).toEqual([
          'postgres',
          'postgres',
          'auth-svc',
          'queue',
          'sendgrid',
          'redis',
          'stripe',
          's3',
        ]);
        bottom.forEach((p, k) => {
          expect(p?.y).toBe(3);
          expect(p?.x).toBeCloseTo((api?.x ?? 0) + (api?.w ?? 0) * ((k + 1) / 9), 9);
        });
        expect(doc.connections[4]?.id).toBe('reads');
        // The top side carries 3 entries, from web, mobile, admin: columns 2, 1, 0 by far end x.
        const top = [0, 1, 2].map((i) => layout.edges[i]?.points.at(-1));
        for (const p of top) expect(p?.y).toBe(2);
        expect((top[2]?.x ?? 9) < (top[1]?.x ?? 0)).toBe(true);
        expect((top[1]?.x ?? 9) < (top[0]?.x ?? 0)).toBe(true);
        expect(top[2]?.x).toBeCloseTo(0.25, 9);
        expect(top[1]?.x).toBeCloseTo(0.5, 9);
        expect(top[0]?.x).toBeCloseTo(0.75, 9);
        // CONTROL: order the slots by connection index alone and `auth-svc`/`queue`/`redis` move
        // (the `toEqual` of the order and the x checks fail); use the box centre and every x is 0.5.
      });

      it('no two edges run along one x or one y (acme-shaped): each horizontal run has its own y in a row gap, each long vertical run its own x in a column gap', () => {
        const layout = layoutSystems(acmeShaped(), 'both');
        expect(only(layout, 'overlap')).toEqual([]);
        // Long routes: 6 points, the vertical run is points[2] -> points[3]. It is in a column
        // gap or right of the last column (never inside a box's x band), and two long routes
        // that cross a row gap in common never share its x.
        const rowOf = rowIndexOf(layout);
        const boxXs = [...new Set(layout.rows.flatMap((r) => r.boxes.map((b) => b.x)))];
        const long = layout.edges
          .filter((e) => Math.abs((rowOf.get(e.to) ?? 0) - (rowOf.get(e.from) ?? 0)) >= 2)
          .map((e) => ({
            e,
            x: e.points[2]?.x ?? Number.NaN,
            lo: Math.min(rowOf.get(e.from) ?? 0, rowOf.get(e.to) ?? 0),
            hi: Math.max(rowOf.get(e.from) ?? 0, rowOf.get(e.to) ?? 0),
          }));
        expect(long.length).toBeGreaterThanOrEqual(5);
        for (const l of long) {
          expect(l.e.points).toHaveLength(6);
          expect(l.e.points[2]?.x).toBe(l.e.points[3]?.x);
          expect(boxXs.some((bx) => l.x > bx - EPS && l.x < bx + 1 + EPS)).toBe(false);
        }
        for (const [i, a] of long.entries()) {
          for (const b of long.slice(i + 1)) {
            if (a.lo < b.hi && b.lo < a.hi) expect(Math.abs(a.x - b.x)).toBeGreaterThan(1e-6);
          }
        }
        // CONTROL: give every long route lane 0 (`lane = 0`) — the routes on one column gap share
        // an x and both checks fail; give every horizontal run track 0 and `overlap` reports them.
      });

      it('no route enters a box: not a foreign one between its ends, not its own (acme-shaped and the K14 doc)', () => {
        expect(only(layoutSystems(acmeShaped(), 'both'), 'box')).toEqual([]);
        expect(only(layoutSystems(twoEnv(), 'both'), 'box')).toEqual([]);
        // A column of three, the middle one unconnected: a -> c has equal ports (one edge on each
        // end) and would run straight through b.
        const column = layoutSystems(
          docOf(
            [
              ['a', 'client'],
              ['b', 'app'],
              ['c', 'data'],
            ],
            [['a', 'c']],
          ),
          'both',
        );
        expect(only(column, 'box')).toEqual([]);
        expect(column.edges[0]?.points.length).toBeGreaterThan(2);
        // The same pair with nothing between is the one straight line.
        const near = layoutSystems(
          docOf(
            [
              ['a', 'client'],
              ['c', 'app'],
            ],
            [['a', 'c']],
          ),
          'both',
        );
        expect(near.edges[0]?.points).toEqual([
          { x: 0.5, y: 1 },
          { x: 0.5, y: 2 },
        ]);
        // CONTROL: drop the `allBoxes.some(...)` guard on `straight` and a -> c is one vertical
        // line through b (`box` reports it, and `points.length` is 2).
      });

      it('every point is >= 0 and inside width x height, which are exactly the extent of the boxes and points (acme-shaped)', () => {
        const layout = layoutSystems(acmeShaped(), 'both');
        expect(only(layout, 'bounds')).toEqual([]);
        const xs = [
          ...layout.rows.flatMap((r) => r.boxes.flatMap((b) => [b.x + b.w])),
          ...layout.edges.flatMap((e) => e.points.map((p) => p.x)),
        ];
        const ys = [
          ...layout.rows.flatMap((r) => r.boxes.flatMap((b) => [b.y + b.h])),
          ...layout.edges.flatMap((e) => e.points.map((p) => p.y)),
        ];
        expect(layout.width).toBe(Math.max(...xs));
        expect(layout.height).toBe(Math.max(...ys));
        // A one-column doc whose only edge must go around the box between its ends: its lane is
        // right of the last column (the box ends at x 1, the first lane is at 1.25), so the
        // diagram is wider than its boxes — and the lane point is still inside width.
        const column = layoutSystems(
          docOf(
            [
              ['a', 'client'],
              ['b', 'app'],
              ['c', 'data'],
            ],
            [['a', 'c']],
          ),
          'both',
        );
        expect(column.width).toBe(1.25);
        expect(column.edges[0]?.points.map((p) => p.x)).toEqual([0.5, 0.5, 1.25, 1.25, 0.5, 0.5]);
        expect(only(column, 'bounds')).toEqual([]);
        // CONTROL: compute width/height from the boxes alone (drop the edge points from `allX`,
        // `allY`) and the lane point falls outside width: `bounds` reports it and `width` is 1.
      });

      it('is deterministic: the same doc built twice gives byte-identical JSON, in every env', () => {
        for (const env of ['both', 'dev', 'prod'] as const) {
          expect(JSON.stringify(layoutSystems(acmeShaped(), env))).toBe(
            JSON.stringify(layoutSystems(acmeShaped(), env)),
          );
        }
        // CONTROL: break a tie in the port sort with `Math.random()` and two builds differ.
      });

      it('a two-way pair and parallel rows of one pair are separate routes, in and across columns', () => {
        // b <-> c: one column, two ways; c <-> d: two columns (an elbow each way); a -> b twice
        // (`id`ed rows).
        const doc = docOf(
          [
            ['a', 'client'],
            ['b', 'app'],
            ['x', 'app'],
            ['c', 'data'],
            ['d', 'data'],
          ],
          [
            ['a', 'b', 'one'],
            ['a', 'b', 'two'],
            ['b', 'c'],
            ['c', 'b'],
            ['x', 'd'],
            ['d', 'x'],
          ],
        );
        const layout = layoutSystems(doc, 'both');
        expect(only(layout, 'end', 'shared-end', 'overlap', 'box')).toEqual([]);
        const pointsOf = (from: string, to: string, k = 0) =>
          layout.edges.filter((e) => e.from === from && e.to === to)[k]?.points;
        const pairs: [LayoutPoint[] | undefined, LayoutPoint[] | undefined][] = [
          [pointsOf('a', 'b', 0), pointsOf('a', 'b', 1)],
          [pointsOf('b', 'c'), pointsOf('c', 'b')],
          [pointsOf('x', 'd'), pointsOf('d', 'x')],
        ];
        for (const [p, q] of pairs) {
          expect(p).toBeDefined();
          expect(q).toBeDefined();
          expect(JSON.stringify(p)).not.toBe(JSON.stringify(q));
          expect(JSON.stringify(p)).not.toBe(JSON.stringify([...(q ?? [])].reverse()));
        }
        // CONTROL: ports at the box centre (or one slot per box side, not per edge end) put both
        // routes of a pair on the same points — `shared-end` and the `not.toBe`s fail.
      });

      it('two edges that must cross (a -> d and b -> c, sources and targets swapped) do not overlap: one gets a dogleg', () => {
        // Row one: a, b (columns 0, 1); row two: c, d... ids sort a < b and c < d, so a is column 0
        // and d column 1: a -> d and b -> c cross. Each end is alone on its side, so the two ports
        // in each column are at the same x — one route's top stub and the other's bottom stub are
        // on one line, and neither track order lets both stubs clear: the route of the lower index
        // takes a jog (6 points instead of 4).
        const layout = layoutSystems(
          docOf(
            [
              ['a', 'app'],
              ['b', 'app'],
              ['c', 'data'],
              ['d', 'data'],
            ],
            [
              ['a', 'd'],
              ['b', 'c'],
            ],
          ),
          'both',
        );
        expect(problems(layout)).toEqual([]);
        expect(layout.edges.map((e) => e.points.length)).toEqual([6, 4]);
        // CONTROL: remove the cycle-breaking loop in `solveGap` and the stubs at x = 0.5 and
        // x = 2 overlap (`overlap` reports a shared stretch of x).
      });

      it('300 random docs (self-loops, two-way pairs, parallel rows, blocked columns): no shared end, no overlap, no route inside a box, deterministic', () => {
        let edges = 0;
        for (let seed = 1; seed <= 300; seed++) {
          const doc = randomDoc(seed);
          const layout = layoutSystems(doc, 'both');
          edges += layout.edges.length;
          expect(problems(layout).map((p) => `seed ${seed}: ${p.message}`)).toEqual([]);
          expect(JSON.stringify(layoutSystems(randomDoc(seed), 'both'))).toBe(
            JSON.stringify(layout),
          );
        }
        // Not vacuous: 300 docs of up to 40 connections.
        expect(edges).toBeGreaterThan(3000);
        // CONTROL: any of the controls above (lane 0, centre ports, no `straight` guard, no
        // dogleg) makes some seed report a problem.
      });

      describe('RCB-192: a row gap grows with its track count', () => {
        /** The y of every horizontal run strictly inside the gap below row `g` (between that row's
         * bottom and the next row's top), each distinct y once, ascending — one per track in use. */
        function trackYs(layout: Routed, g: number): number[] {
          const lo = (layout.rows[g]?.boxes[0]?.y ?? Number.NaN) + 1;
          const hi = layout.rows[g + 1]?.boxes[0]?.y ?? Number.NaN;
          const ys: number[] = [];
          for (const e of layout.edges) {
            e.points.forEach((a, k) => {
              const b = e.points[k + 1];
              if (b === undefined || Math.abs(a.y - b.y) > EPS || Math.abs(a.x - b.x) <= EPS)
                return;
              if (a.y > lo + EPS && a.y < hi - EPS) ys.push(a.y);
            });
          }
          return ys
            .sort((p, q) => p - q)
            .filter((y, k, all) => k === 0 || y - (all[k - 1] ?? 0) > EPS);
        }
        /** The length of every vertical segment of every route. */
        const verticals = (layout: Routed): number[] =>
          layout.edges.flatMap((e) =>
            e.points.flatMap((a, k) => {
              const b = e.points[k + 1];
              if (b === undefined || Math.abs(a.x - b.x) > EPS) return [];
              const len = Math.abs(a.y - b.y);
              return len > EPS ? [len] : [];
            }),
          );
        const rowTop = (layout: Routed, i: number) => layout.rows[i]?.boxes[0]?.y ?? Number.NaN;
        /** 0.125 units: an 8 px arrowhead at 64 px a unit (`MIN_TRACK_PITCH`), written out here on
         * purpose — not imported from the code under test. */
        const PITCH = 0.125;

        /** Two rows of `n` boxes (`t*` above, `u*` below); box i of the top row has one edge, to box
         * `to(i)` of the bottom row. Every port is alone on its side, so the runs are what crowds
         * the gap: `trackYs` counts the tracks (measured: `cross` n = 10 gives 11, `shift` n = 6
         * gives 7 and n = 7 gives 8). `cross` sends box i to n-1-i, so every pair of edges crosses
         * and the ports of a column face each other: some routes get a dogleg. */
        const twoRows = (n: number, to: (i: number) => number): SystemsDoc => {
          const cols = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
          return docOf(
            [
              ...cols.map((c) => [`t${c}`, 'client'] as const),
              ...cols.map((c) => [`u${c}`, 'app'] as const),
            ],
            cols.map((c, i) => [`t${c}`, `u${cols[to(i)] ?? c}`] as const),
          );
        };
        const cross = (n: number) => twoRows(n, (i) => n - 1 - i);
        const shift = (n: number) => twoRows(n, (i) => (i + 1) % n);

        it('a gap with 11 tracks is 0.125 * (tracks + 1) tall: every vertical is >= 0.125, tracks are 0.125 apart, nothing breaks', () => {
          const layout = layoutSystems(cross(10), 'both');
          expect(layout.rows).toHaveLength(2);
          const ys = trackYs(layout, 0);
          // Not vacuous: at least 9 tracks in the one gap (measured: 11).
          expect(ys.length).toBeGreaterThanOrEqual(9);
          // (a) no vertical segment is shorter than an arrowhead.
          const vs = verticals(layout);
          expect(vs.length).toBeGreaterThan(0);
          for (const len of vs) expect(len).toBeGreaterThanOrEqual(PITCH - EPS);
          // (b) the gap is exactly as tall as its tracks need, and they are evenly spread in it.
          const gap = rowTop(layout, 1) - (rowTop(layout, 0) + 1);
          expect(Math.abs(gap - PITCH * (ys.length + 1))).toBeLessThanOrEqual(EPS);
          const edges = [rowTop(layout, 0) + 1, ...ys, rowTop(layout, 1)];
          for (let k = 1; k < edges.length; k++) {
            expect(Math.abs((edges[k] ?? 0) - (edges[k - 1] ?? 0) - PITCH)).toBeLessThanOrEqual(
              EPS,
            );
          }
          // (c) every guarantee of RCB-179 still holds on the moved boxes.
          expect(only(layout, 'end', 'shared-end', 'bounds', 'diagonal', 'box', 'overlap')).toEqual(
            [],
          );
          // (d) a row's boxes share one y; rows go strictly down.
          for (const row of layout.rows) {
            expect(row.boxes).toHaveLength(10);
            expect(new Set(row.boxes.map((b) => b.y)).size).toBe(1);
          }
          expect(rowTop(layout, 1)).toBeGreaterThan(rowTop(layout, 0));
          // (e) deterministic.
          expect(JSON.stringify(layoutSystems(cross(10), 'both'))).toBe(JSON.stringify(layout));
          // CONTROL C1: `MIN_TRACK_PITCH = 0` leaves the gap at 1 unit — the tracks are 1/12 apart,
          // so (a) reports verticals of 0.0833 and (b) a gap of 1, not 1.5. CONTROL C2: leave the
          // boxes at `rowIndex * ROW_PITCH` (drop the `box.y = tops[i]` loop in `layoutSystems`) and
          // the routes end on the moved row top, 2.5, while the box stays at 2: (c) reports 'end'.
        });

        it('the threshold: 7 tracks fit the old 1-unit gap and leave the rows where they were, 8 grow it to 1.125', () => {
          const seven = layoutSystems(shift(6), 'both');
          expect(trackYs(seven, 0)).toHaveLength(7);
          expect(rowTop(seven, 1)).toBe(2);
          const eight = layoutSystems(shift(7), 'both');
          expect(trackYs(eight, 0)).toHaveLength(8);
          expect(rowTop(eight, 1)).toBe(2.125);
          // CONTROL: `MIN_TRACK_PITCH * tracks` (dropping the `+ 1`) leaves 8 tracks at exactly 1
          // unit, the second row stays at 2 and the last `toBe` fails; `* (tracks + 2)` grows the
          // 7-track gap to 1.125 and the first `toBe` fails.
        });

        it('a doc whose gaps are all small is untouched: twoEnv rows sit at index * 2 exactly, in every env', () => {
          for (const env of ['both', 'dev', 'prod'] as const) {
            const layout = layoutSystems(twoEnv(), env);
            expect(layout.rows.length).toBeGreaterThan(1);
            layout.rows.forEach((row, i) => {
              for (const box of row.boxes) expect(box.y).toBe(i * 2);
              if (i + 1 < layout.rows.length)
                expect(trackYs(layout, i).length).toBeLessThanOrEqual(7);
            });
          }
          // CONTROL: a margin on every gap (`gapHeight` returning `... + 0.125`) puts row 1 at
          // 2.125 and this fails. twoEnv's gaps hold at most 2 tracks (measured), so nothing here
          // grows; the seat checks the repoboard and globex maps by sha.
        });

        it('a grown gap moves every row below it: the acme-shaped hub gap (17 tracks) is 2.25 tall, so rows sit at 0, 2, 5.25, 7.25', () => {
          const layout = layoutSystems(acmeShaped(), 'both');
          expect(trackYs(layout, 1)).toHaveLength(17);
          expect(layout.rows.map((_, i) => rowTop(layout, i))).toEqual([0, 2, 5.25, 7.25]);
          // Gap 1 is 0.125 * 18 = 2.25 tall; gaps 0 and 2 hold 4 tracks each (1 unit, ungrown), so
          // only the rows below gap 1 move: row 2 by 1.25, row 3 with it.
          expect(layout.height).toBe(8.25);
          expect(problems(layout)).toEqual([]);
          for (const len of verticals(layout)) expect(len).toBeGreaterThanOrEqual(PITCH - EPS);
          // CONTROL: fix every row at `rowIndex * ROW_PITCH` and the rows are 0, 2, 4, 6.
        });

        it('300 random docs: each row gap is exactly max(1, 0.125 * (tracks + 1)) tall, no vertical is under 0.125', () => {
          let grown = 0;
          for (let seed = 1; seed <= 300; seed++) {
            const layout = layoutSystems(randomDoc(seed), 'both');
            for (let g = 0; g + 1 < layout.rows.length; g++) {
              const tracks = trackYs(layout, g).length;
              const gap = rowTop(layout, g + 1) - (rowTop(layout, g) + 1);
              const want = Math.max(1, PITCH * (tracks + 1));
              expect(
                Math.abs(gap - want),
                `seed ${seed} gap ${g}: ${tracks} tracks`,
              ).toBeLessThanOrEqual(EPS);
              if (gap > 1 + EPS) grown += 1;
            }
            for (const len of verticals(layout)) {
              expect(len, `seed ${seed}`).toBeGreaterThanOrEqual(PITCH - EPS);
            }
          }
          // Not vacuous (measured: 167 of 721 gaps grew, most tracks in one gap 24).
          expect(grown).toBeGreaterThan(100);
          // CONTROL: `MIN_TRACK_PITCH = 0` (measured on the pre-change layout: 167 gaps too short,
          // the shortest vertical 0.04) fails both expectations in the loop.
        });
      });
    });
  });
});
