/**
 * RCB-97 B (plan docs/SYSTEMS-FLOW-PLAN.md §3.3): the server surfaces over
 * `.repoboard/systems.yml` — `store.systems()`/`check()`/`seatBundle()`, `repoboard systems` /
 * `systems show <id>`, MCP `list_systems`/`get_system`, `GET /api/systems` + the WS `systems`
 * message, and `cost` counting the file. Every fixture is a temp dir (brief) — `.repoboard/systems.yml`
 * is never created in THIS repo. The doc text is copied from
 * `packages/core/test/fixtures/systems/two-env.yml` (RCB-95's own fixture), with one change: the
 * `api` system's `pointers` names a real file this suite writes into the temp repo, so `systems
 * show api` has a real span to resolve.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { run } from '../src/cli.js';
import { gatherCost } from '../src/cost.js';
import { startServer } from '../src/http.js';
import { createMcpServer, MCP_TOOL_NAMES } from '../src/mcp.js';
import { type CardStore, openStore } from '../src/store.js';
import { makeTempRepoboard, NOW, type TempRepo } from './helpers.js';

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function freshRepo(): Promise<TempRepo> {
  const repo = await makeTempRepoboard({});
  cleanups.push(repo.cleanup);
  return repo;
}

/** Every field two-env.yml's `api` row carries, except `pointers` names a file this suite writes
 * (`src/api/index.ts`) instead of `[]` — so `systems show api` has a real span to resolve. */
const VALID_SYSTEMS_YML = `environments:
  dev:  { note: "vite dev :5173 + wrangler dev :8787 + local postgres :5433" }
  prod: { note: "Cloudflare Workers; Neon via Hyperdrive" }
systems:
  - id: web
    name: marketing site
    kind: client
    layer: client
    env: [dev, prod]
    runtime: { dev: "vite dev", prod: "static hosting" }
    pointers: ["apps/web/src"]
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: gateway
    name: edge gateway
    kind: worker
    layer: edge
    env: [dev, prod]
    runtime: { dev: "wrangler dev", prod: "Cloudflare Workers" }
    owner: backend
    pointers: ["apps/gateway/src/index.ts"]
    docs: ["docs/BUILD-PLAN.md#§3"]
    why: null
    source: { detected: "wrangler.jsonc", at: "2026-09-22T00:00:00Z" }
  - id: api
    name: api service
    kind: service
    layer: app
    env: [dev, prod]
    runtime: { dev: "node server", prod: "Cloudflare Workers" }
    owner: null
    pointers: ["src/api/index.ts"]
    docs: []
    why: "core business logic"
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - id: worker-jobs
    name: background jobs
    kind: job
    layer: app
    env: [prod]
    runtime: { prod: "queue consumer" }
    source: { detected: "package.json", at: "2026-09-22T00:00:00Z" }
  - id: postgres
    name: primary database
    kind: db
    layer: data
    env: [dev, prod]
    runtime: { dev: "local postgres :5433", prod: "Neon via Hyperdrive" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { detected: "wrangler.jsonc@hyperdrive", at: "2026-09-22T00:00:00Z" }
  - id: sendgrid
    name: transactional email
    kind: email
    layer: external
    env: [dev]
    runtime: { dev: "sandbox key" }
    owner: null
    pointers: []
    docs: []
    why: null
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
connections:
  - from: web
    to: gateway
    via: "HTTPS"
    env: [dev, prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: gateway
    to: api
    via: "HTTP internal"
    env: [dev, prod]
    source: { detected: "wrangler.jsonc", at: "2026-09-22T00:00:00Z" }
  - from: api
    to: postgres
    via: "Hyperdrive binding HYPERDRIVE"
    env: [dev, prod]
    source: { detected: "wrangler.jsonc@hyperdrive", at: "2026-09-22T00:00:00Z" }
  - from: worker-jobs
    to: postgres
    env: [prod]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
  - from: api
    to: sendgrid
    via: "SMTP relay"
    env: [dev]
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;

/** Several independent semantic errors at once (bad id, unknown kind, unknown layer, empty env) —
 * `parseSystems` collects every one, not just the first (core's own contract). */
const INVALID_SYSTEMS_YML = `environments:
  dev: { note: null }
  prod: { note: null }
systems:
  - id: "Not Valid!"
    name: broken
    kind: nonsense
    layer: nowhere
    env: []
    source: { hand: "owner", at: "2026-09-22T00:00:00Z" }
`;

async function writeSystemsYml(root: string, text: string): Promise<void> {
  await mkdir(join(root, '.repoboard'), { recursive: true });
  await writeFile(join(root, '.repoboard', 'systems.yml'), text);
}

/** Writes `src/api/index.ts` (the `api` row's pointer in `VALID_SYSTEMS_YML`) into `root`. */
async function writeApiPointerFile(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  await writeFile(join(root, 'src', 'api', 'index.ts'), 'export const API_MARKER = true;\n');
}

/** RCB-110: a test file that imports the `api` pointer written by `writeApiPointerFile` — the
 * one test coverage `systems show`/`get_system` should find. */
async function writeApiTestFile(root: string): Promise<void> {
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'api.test.ts'), "import '../src/api/index.js';\n");
}

// ---------------------------------------------------------------------------------------------
// 1. store.systems() — absent, valid, invalid
// ---------------------------------------------------------------------------------------------

describe('store.systems() (RCB-97)', () => {
  it('absent: {doc:null, errors:[], exists:false}', async () => {
    const repo = await freshRepo();
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    expect(store.systems()).toEqual({ doc: null, errors: [], exists: false });
  });

  it('valid: 6 systems, no errors, exists', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const { doc, errors, exists } = store.systems();
    expect(exists).toBe(true);
    expect(errors).toEqual([]);
    expect(doc?.systems).toHaveLength(6);
    expect(doc?.connections).toHaveLength(5);
  });

  it('invalid: doc:null, errors non-empty, exists — never the last good doc', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, INVALID_SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const { doc, errors, exists } = store.systems();
    expect(doc).toBeNull();
    expect(exists).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 2/3. CLI: `repoboard systems [--json]` and `repoboard systems show <id> [--json]`
// ---------------------------------------------------------------------------------------------

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

describe('CLI: repoboard systems (RCB-97)', () => {
  it('the table: two env lines, ID/KIND header, 6 rows; --json mirrors store.systems()', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    const table = await repoboard(repo.root, 'systems');
    expect(table.code).toBe(0);
    expect(table.out).toContain('dev: vite dev :5173 + wrangler dev :8787 + local postgres :5433');
    expect(table.out).toContain('prod: Cloudflare Workers; Neon via Hyperdrive');
    expect(table.out).toMatch(/ID\s+KIND/);
    for (const id of ['web', 'gateway', 'api', 'worker-jobs', 'postgres', 'sendgrid']) {
      expect(table.out).toMatch(new RegExp(`^${id}\\s`, 'm'));
    }

    const json = await repoboard(repo.root, 'systems', '--json');
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as { doc: { systems: unknown[] }; exists: boolean };
    expect(parsed.exists).toBe(true);
    expect(parsed.doc.systems).toHaveLength(6);
  });

  it('no file: the one "no systems.yml yet" line, exit 0', async () => {
    const repo = await freshRepo();
    const res = await repoboard(repo.root, 'systems');
    expect(res.code).toBe(0);
    expect(res.out.trim()).toContain('no systems.yml yet');
  });

  it('invalid: each error on stderr, exit 1', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, INVALID_SYSTEMS_YML);
    const res = await repoboard(repo.root, 'systems');
    expect(res.code).toBe(1);
    expect(res.err.length).toBeGreaterThan(0);
    expect(res.out).toBe('');

    const json = await repoboard(repo.root, 'systems', '--json');
    expect(json.code).toBe(1);
  });
});

describe('CLI: repoboard systems show <id> (RCB-97)', () => {
  it('kind, 3 connections, a resolved pointer span; unknown id exits 1', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    await writeApiPointerFile(repo.root);

    const res = await repoboard(repo.root, 'systems', 'show', 'api');
    expect(res.code).toBe(0);
    expect(res.out).toContain('kind: service');
    expect(res.out).toContain('connections:');
    expect([...res.out.matchAll(/ → /g)]).toHaveLength(3);
    expect(res.out).toContain('API_MARKER');

    const json = await repoboard(repo.root, 'systems', 'show', 'api', '--json');
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as {
      system: { id: string };
      connections: unknown[];
      pointers: Array<{ text: string | null }>;
    };
    expect(parsed.system.id).toBe('api');
    expect(parsed.connections).toHaveLength(3);
    expect(parsed.pointers[0]?.text).toContain('API_MARKER');

    const unknown = await repoboard(repo.root, 'systems', 'show', 'nope');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('unknown system "nope"');
  });

  it('RCB-110: tests block — a pointer with a covering test, and one with none', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    await writeApiPointerFile(repo.root);
    await writeApiTestFile(repo.root);

    const api = await repoboard(repo.root, 'systems', 'show', 'api');
    expect(api.code).toBe(0);
    expect(api.out).toContain('tests: 1 file');
    expect(api.out).toContain('src/api/index.ts: 1 — test/api.test.ts');

    const apiJson = await repoboard(repo.root, 'systems', 'show', 'api', '--json');
    const apiParsed = JSON.parse(apiJson.out) as { tests: { files: number | null } };
    expect(apiParsed.tests.files).toBe(1);

    // gateway's pointer (apps/gateway/src/index.ts) is never written to this repo.
    const gateway = await repoboard(repo.root, 'systems', 'show', 'gateway');
    expect(gateway.code).toBe(0);
    expect(gateway.out).toContain('tests: n/a (no source pointers)');
    expect(gateway.out).toContain('apps/gateway/src/index.ts: not found');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. seat <name> — exactly one "Systems:" line in every one of the three states
// ---------------------------------------------------------------------------------------------

describe('CLI: repoboard seat — Systems line (RCB-97)', () => {
  async function seatOutput(setup: (root: string) => Promise<void>): Promise<string> {
    const repo = await freshRepo();
    await setup(repo.root);
    const res = await repoboard(repo.root, 'seat', 'claude/p9');
    expect(res.code).toBe(0);
    return res.out;
  }

  it('absent: one line, "no systems.yml yet"', async () => {
    const out = await seatOutput(async () => undefined);
    const matches = [...out.matchAll(/^Systems:.*$/gm)];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[0]).toContain('no systems.yml yet');
  });

  it('valid: one line, the systems/connections/envs summary', async () => {
    const out = await seatOutput((root) => writeSystemsYml(root, VALID_SYSTEMS_YML));
    const matches = [...out.matchAll(/^Systems:.*$/gm)];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[0]).toBe('Systems: 6 systems, 5 connections, dev+prod — repoboard systems');
  });

  it('invalid: one line, "systems.yml invalid"', async () => {
    const out = await seatOutput((root) => writeSystemsYml(root, INVALID_SYSTEMS_YML));
    const matches = [...out.matchAll(/^Systems:.*$/gm)];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[0]).toContain('systems.yml invalid');
  });
});

// ---------------------------------------------------------------------------------------------
// 5. check: systems-invalid / systems-stale
// ---------------------------------------------------------------------------------------------

describe('store.check(): systems-invalid / systems-stale (RCB-97)', () => {
  it('invalid file: a systems-invalid finding, exit 1 (strict or not)', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, INVALID_SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const res = await store.check(false);
    expect(res.findings.some((f) => f.kind === 'systems-invalid' && f.level === 'error')).toBe(
      true,
    );
    expect(res.exitCode).toBe(1);
  });

  it(
    'a detected row (gateway) no longer yielded by any source file: systems-stale warning, ' +
      'exit 0 without --strict, 1 with --strict',
    async () => {
      const repo = await freshRepo();
      // No wrangler/package.json files in this fixture at all: `detectSystems` yields empty
      // candidates, so every `source.detected` row (gateway, worker-jobs, postgres) is stale.
      await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
      const store = await openStore(repo.root, { watch: false, now: () => NOW });
      cleanups.push(() => store.close());

      const plain = await store.check(false);
      const stale = plain.findings.find((f) => f.kind === 'systems-stale');
      expect(stale?.level).toBe('warning');
      expect(stale?.message).toContain('gateway');
      expect(plain.exitCode).toBe(0);

      const strict = await store.check(true);
      expect(strict.exitCode).toBe(1);
    },
  );

  it('no file: neither finding', async () => {
    const repo = await freshRepo();
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const res = await store.check(false);
    expect(
      res.findings.some((f) => f.kind === 'systems-invalid' || f.kind === 'systems-stale'),
    ).toBe(false);
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. cost: `.repoboard/systems.yml` counted with why: 'systems'
// ---------------------------------------------------------------------------------------------

describe('cost: systems.yml entry (RCB-97)', () => {
  it('present: an entry with why "systems"; absent: no such entry', async () => {
    const withFile = await freshRepo();
    await writeSystemsYml(withFile.root, VALID_SYSTEMS_YML);
    const reportWith = await gatherCost(withFile.root, 8192);
    const entry = reportWith.entries.find((e) => e.file === '.repoboard/systems.yml');
    expect(entry?.why).toBe('systems');

    const withoutFile = await freshRepo();
    const reportWithout = await gatherCost(withoutFile.root, 8192);
    expect(reportWithout.entries.some((e) => e.file === '.repoboard/systems.yml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. MCP: list_systems / get_system
// ---------------------------------------------------------------------------------------------

interface McpRig {
  repo: TempRepo;
  store: CardStore;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  json<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

function textOf(res: CallToolResult): string {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

async function mcpRig(): Promise<McpRig> {
  const repo = await freshRepo();
  const store = await openStore(repo.root, { watch: false, now: () => NOW });
  cleanups.push(() => store.close());
  const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const json = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const res = await call(name, args);
    expect(res.isError, `tool ${name} failed: ${textOf(res)}`).toBeFalsy();
    return JSON.parse(textOf(res)) as T;
  };
  return { repo, store, call, json };
}

describe('MCP: list_systems / get_system (RCB-97)', () => {
  it('MCP_TOOL_NAMES gains exactly two tools (base 23 -> 25 at RCB-97; 29 after RCB-146)', () => {
    expect(MCP_TOOL_NAMES).toContain('list_systems');
    expect(MCP_TOOL_NAMES).toContain('get_system');
    expect(MCP_TOOL_NAMES.length).toBe(29);
  });

  it('list_systems: rows trimmed to five keys; empty/errors reflect exists+errors', async () => {
    const r = await mcpRig();
    const before = await r.json<{ exists: boolean; errors: string[]; systems: unknown[] }>(
      'list_systems',
    );
    expect(before).toEqual({
      exists: false,
      errors: [],
      environments: null,
      systems: [],
      connections: [],
    });

    await writeSystemsYml(r.repo.root, VALID_SYSTEMS_YML);
    // No watcher (watch:false) — re-open a fresh store view the way the CLI does per call.
    await r.store.close();
    const store2 = await openStore(r.repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store2.close());
    const server2 = createMcpServer({ store: store2, defaultActor: 'test/mcp', now: () => NOW });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server2.connect(st);
    const client2 = new Client({ name: 'repoboard-test-2', version: '0.0.0' });
    await client2.connect(ct);
    cleanups.push(async () => {
      await client2.close();
      await server2.close();
    });
    const res = (await client2.callTool({
      name: 'list_systems',
      arguments: {},
    })) as CallToolResult;
    const after = JSON.parse(textOf(res)) as {
      exists: boolean;
      systems: Array<Record<string, unknown>>;
      connections: unknown[];
    };
    expect(after.exists).toBe(true);
    expect(after.systems).toHaveLength(6);
    expect(after.connections).toHaveLength(5);
    for (const row of after.systems) {
      expect(Object.keys(row).sort()).toEqual(['env', 'id', 'kind', 'layer', 'runtime'].sort());
    }
  });

  it('get_system: full row + connections + resolved pointers; unknown id fails', async () => {
    const repo = await freshRepo();
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    await writeApiPointerFile(repo.root);
    await writeApiTestFile(repo.root);
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    cleanups.push(() => store.close());
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;

    const okRes = await call('get_system', { id: 'api' });
    expect(okRes.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(okRes)) as {
      system: { id: string };
      connections: unknown[];
      pointers: Array<{ text: string | null }>;
      tests: { files: number | null; pointers: Array<{ pointer: string; tests: string[] | null }> };
    };
    expect(parsed.system.id).toBe('api');
    expect(parsed.connections).toHaveLength(3);
    expect(parsed.pointers[0]?.text).toContain('API_MARKER');
    expect(parsed.tests.files).toBe(1);
    expect(parsed.tests.pointers[0]?.tests).toEqual(['test/api.test.ts']);

    const failRes = await call('get_system', { id: 'nope' });
    expect(failRes.isError).toBe(true);
    expect(textOf(failRes)).toContain('unknown system "nope"');
  });
});

// ---------------------------------------------------------------------------------------------
// 8. HTTP: GET /api/systems, WS snapshot + systems message
// ---------------------------------------------------------------------------------------------

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}

/** Buffers every message from the moment it is constructed (attached synchronously right after
 * `connectWs` resolves) — the same anti-race shape `http.test.ts`'s own `WsClient` uses: a
 * listener attached only after an `await` can miss a message that arrives in the same tick. */
class MsgQueue {
  private readonly queue: unknown[] = [];
  private waiter: { pred: (m: unknown) => boolean; resolve: (m: unknown) => void } | null = null;
  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const m: unknown = JSON.parse(String(data));
      if (this.waiter?.pred(m)) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(m);
        return;
      }
      this.queue.push(m);
    });
  }
  next<T = unknown>(pred: (m: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
    const i = this.queue.findIndex((m) => pred(m as T));
    if (i !== -1) return Promise.resolve(this.queue.splice(i, 1)[0] as T);
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        rej(new Error('timed out waiting for ws message'));
      }, timeoutMs);
      this.waiter = {
        pred: (m) => pred(m as T),
        resolve: (m) => {
          clearTimeout(timer);
          res(m as T);
        },
      };
    });
  }
}

describe('HTTP: /api/systems and the WS systems message (RCB-97)', () => {
  it('GET /api/systems is 200 with the payload; WS snapshot carries it; a file edit broadcasts systems', async () => {
    const repo = await freshRepo();
    // Written BEFORE the store opens/watches (same reliability note as store.test.ts's leases
    // watcher test: a brand-new file's chokidar `add` is flaky under concurrent test load; a
    // pre-existing file's later `change` is not).
    await writeSystemsYml(repo.root, VALID_SYSTEMS_YML);
    const store = await openStore(repo.root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    const res = await fetch(`${url}/api/systems`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { doc: { systems: unknown[] }; exists: boolean };
    expect(body.exists).toBe(true);
    expect(body.doc.systems).toHaveLength(6);

    const ws = await connectWs(url);
    cleanups.push(async () => ws.close());
    const queue = new MsgQueue(ws);
    const snap = await queue.next<{ type: string; systems: { exists: boolean } }>(
      (m) => (m as { type: string }).type === 'snapshot',
    );
    expect(snap.systems.exists).toBe(true);

    const systemsMsgPromise = queue.next<{ type: string; doc: { environments: unknown } }>(
      (m) => (m as { type: string }).type === 'systems',
    );
    const edited = VALID_SYSTEMS_YML.replace(
      'vite dev :5173 + wrangler dev :8787 + local postgres :5433',
      'EDITED dev note',
    );
    await writeFile(join(repo.root, '.repoboard', 'systems.yml'), edited);
    const msg = await systemsMsgPromise;
    expect(JSON.stringify(msg.doc.environments)).toContain('EDITED dev note');

    // read-back proof: the edit really landed on disk, not just in-memory.
    const onDisk = await readFile(join(repo.root, '.repoboard', 'systems.yml'), 'utf8');
    expect(onDisk).toContain('EDITED dev note');
  });
});
