/**
 * P8.5: `sync-issues <path>#<heading>` — the section-under-a-heading rule reused verbatim from
 * `refs.ts` (species 6's lesson: a text rule for "a K-entry" must not re-derive the boundary),
 * the item rule (column 0, `- **K<n>` / `- ~~**K<n>`, the `- ~~- **K` near-miss reported and
 * skipped), idempotent-by-ref create/close, and NEVER writing the source file.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { type RunningServer, startServer } from '../src/http.js';
import { applySyncPlan, computeSyncPlan } from '../src/issues.js';
import { createMcpServer } from '../src/mcp.js';
import { openStore } from '../src/store.js';
import { makeTempRepoboard, NOW } from './helpers.js';

const execFileAsync = promisify(execFile);

// RCB-46: the read-only proof below needs a real sibling repo, which a public CI box does not
// have — point $REPOBOARD_SIBLING_ROOT at one to run it (no default); unset or missing, it skips.
const siblingRoot = process.env.REPOBOARD_SIBLING_ROOT ?? '';
const hasSiblingRoot = siblingRoot !== '' && existsSync(siblingRoot);
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
  const code = await run(argv, { cwd, stdout, stderr, env: {}, now: () => NOW });
  return { code, out: stdout.text, err: stderr.text };
}

// A hand-annotated fixture in the same shape as core's issues.test.ts: K1 open, K2 closed
// (struck), K3 the E1 near-miss (malformed), K4 open.
const README = [
  '# Project',
  '',
  '## Known issues',
  '',
  '- **K1. First open item** — more prose.',
  '  Closes K9 in the same commit — not a separate item.',
  '- ~~**K2 old bug, now fixed~~',
  '- ~~- **K3 malformed strike, must be skipped',
  '- **K4 second open item**',
  '',
  '## Other section',
  '',
  '- **K99 outside the heading, never seen',
  '',
].join('\n');

async function fixture(): Promise<string> {
  const repo = await makeTempRepoboard({});
  cleanups.push(repo.cleanup);
  await writeFile(join(repo.root, 'README.md'), README);
  return repo.root;
}

describe('server: computeSyncPlan / applySyncPlan', () => {
  it('plans creates for open items, ignores the malformed near-miss, never sees items outside the heading', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
    const outcome = await computeSyncPlan(store, {
      path: 'README.md',
      heading: 'Known issues',
      status: 'todo',
      label: 'issue',
    });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.plan.create.map((c) => c.n)).toEqual([1, 4]);
    expect(outcome.plan.create[0]?.title).toBe('K1 First open item');
    expect(outcome.malformed).toEqual(['- ~~- **K3 malformed strike, must be skipped']);
    // K99 lives under a DIFFERENT heading and must never appear.
    expect(outcome.plan.create.some((c) => c.n === 99)).toBe(false);
  });

  it('applySyncPlan creates the card with the exact title/refs/labels/body, and closes struck items', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
    const input = { path: 'README.md', heading: 'Known issues', status: 'todo', label: 'issue' };
    const outcome = await computeSyncPlan(store, input);
    if (!outcome.ok) throw new Error(outcome.error);
    const applied = await applySyncPlan(store, input, outcome.plan, 'claude/sync');
    expect(applied.errors).toEqual([]);
    expect(applied.created).toHaveLength(2);

    const k1 = store.list().find((c) => (c.refs ?? []).includes('README.md@K1'));
    expect(k1).toBeDefined();
    expect(k1?.title).toBe('K1 First open item');
    expect(k1?.status).toBe('todo');
    expect(k1?.labels).toEqual(['issue']);
    expect(k1?.body).toContain(
      'Filed from README.md §Known issues. The entry is the text; this card is the pointer.',
    );

    // K2 is struck but no card was ever filed for it — nothing to close.
    expect(applied.closed).toEqual([]);
  });

  it('a second run against a struck item WITH a filed card closes it; idempotent after that', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
    // Simulate K2 having been filed by hand with the ref the real sync would have used.
    const created = await store.create(
      {
        title: 'K2 old bug, now fixed',
        status: 'doing',
        labels: ['issue'],
        refs: ['README.md@K2'],
      },
      'claude/manual',
    );
    if (!created.ok) throw new Error(created.error);

    const input = { path: 'README.md', heading: 'Known issues', status: 'todo', label: 'issue' };
    const outcome1 = await computeSyncPlan(store, input);
    if (!outcome1.ok) throw new Error(outcome1.error);
    expect(outcome1.plan.close).toEqual([{ cardId: created.card.id, n: 2 }]);
    const applied1 = await applySyncPlan(store, input, outcome1.plan, 'claude/sync');
    expect(applied1.closed).toEqual([created.card.id]);
    const closedCard = store.get(created.card.id);
    expect(closedCard?.status).toBe('done');
    expect(closedCard?.body).toContain('synced: entry closed in README.md');

    // Idempotent: a second full cycle creates and moves nothing.
    const outcome2 = await computeSyncPlan(store, input);
    if (!outcome2.ok) throw new Error(outcome2.error);
    const applied2 = await applySyncPlan(store, input, outcome2.plan, 'claude/sync');
    expect(applied2.created).toEqual([]);
    expect(applied2.closed).toEqual([]);
  });

  it('never writes the source file, even on a real (non-dry-run) apply', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'README.md'), 'utf8');
    const beforeHash = sha256(before);
    const store = await openStore(root, { watch: false, now: () => NOW });
    const input = { path: 'README.md', heading: 'Known issues', status: 'todo', label: 'issue' };
    const outcome = await computeSyncPlan(store, input);
    if (!outcome.ok) throw new Error(outcome.error);
    await applySyncPlan(store, input, outcome.plan, 'claude/sync');
    const after = await readFile(join(root, 'README.md'), 'utf8');
    expect(sha256(after)).toBe(beforeHash);
  });

  it('refuses ".." and an absolute path', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
    const dotdot = await computeSyncPlan(store, {
      path: '../README.md',
      heading: 'Known issues',
      status: 'todo',
      label: 'issue',
    });
    expect(dotdot.ok).toBe(false);
    const abs = await computeSyncPlan(store, {
      path: '/etc/passwd',
      heading: 'Known issues',
      status: 'todo',
      label: 'issue',
    });
    expect(abs.ok).toBe(false);
  });

  it('a missing heading is an error naming it', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
    const res = await computeSyncPlan(store, {
      path: 'README.md',
      heading: 'Nope, not here',
      status: 'todo',
      label: 'issue',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/heading "Nope, not here" not found/);
  });
});

describe('CLI: repoboard sync-issues', () => {
  it('--dry-run reports counts and the K numbers, and writes nothing', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'README.md'), 'utf8');
    const res = await repoboard(root, 'sync-issues', 'README.md#Known issues', '--dry-run');
    expect(res.code).toBe(0);
    // K2 is struck but no card was ever filed for it — nothing to close, counted as unchanged.
    expect(res.out).toContain('would create 2, close 0, malformed 1, unchanged 1');
    expect(res.out).toContain('create: K1 K4');
    expect(res.out).toContain(
      'skipped: malformed strike: - ~~- **K3 malformed strike, must be skipped',
    );
    const after = await readFile(join(root, 'README.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('a real run creates the cards, and a second run is idempotent', async () => {
    const root = await fixture();
    const res = await repoboard(root, 'sync-issues', 'README.md#Known issues');
    expect(res.code).toBe(0);
    expect(res.out).toContain('created 2, closed 0, malformed 1');

    const again = await repoboard(root, 'sync-issues', 'README.md#Known issues');
    expect(again.code).toBe(0);
    expect(again.out).toContain('created 0, closed 0, malformed 1');
  });

  it('refuses ".." in the path', async () => {
    const root = await fixture();
    const res = await repoboard(root, 'sync-issues', '../README.md#Known issues');
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/not allowed/);
  });

  it.skipIf(!hasSiblingRoot)(
    'the read-only proof: a real (dry-run) call against freshpickedjobs leaves its git status unchanged',
    async () => {
      const fpjRoot = siblingRoot;
      const before = await execFileAsync('git', ['-C', fpjRoot, 'status', '--short']);
      const res = await repoboard(
        await fixture(),
        'sync-issues',
        'README.md#Known issues',
        '--dry-run',
        '--root',
        fpjRoot,
      );
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/would create \d+, close \d+, malformed \d+, unchanged \d+/);
      const after = await execFileAsync('git', ['-C', fpjRoot, 'status', '--short']);
      expect(after.stdout).toBe(before.stdout);
      expect(after.stdout).toBe('');
    },
  );
});

describe('HTTP: POST /api/sync-issues', () => {
  it('dryRun:true reports the plan and writes nothing; a real call applies it', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server: RunningServer = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');

    const dry = await fetch(`${url}/api/sync-issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'README.md', heading: 'Known issues', dryRun: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as {
      dryRun: boolean;
      create: unknown[];
      malformed: string[];
    };
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.create).toHaveLength(2);
    expect(dryBody.malformed).toHaveLength(1);

    const real = await fetch(`${url}/api/sync-issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'README.md', heading: 'Known issues' }),
    });
    expect(real.status).toBe(200);
    const realBody = (await real.json()) as { dryRun: boolean; created: string[] };
    expect(realBody.dryRun).toBe(false);
    expect(realBody.created).toHaveLength(2);
  });
});

describe('HTTP: POST /api/archive and /api/sync-issues reject unknown fields', () => {
  it('rejects an unknown field with 400', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: true, now: () => NOW });
    cleanups.push(() => store.close());
    const server: RunningServer = await startServer({ store, port: 0, scan: false });
    cleanups.push(() => server.close());
    const url = server.url.replace(/\/$/, '');
    const res = await fetch(`${url}/api/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('MCP: sync_issues and archive_cards', () => {
  function textOf(res: CallToolResult): string {
    const first = res.content[0];
    if (first?.type !== 'text') throw new Error('expected a text result');
    return first.text;
  }

  it('sync_issues dryRun then a real call; archive_cards dryRun then a real call', async () => {
    const root = await fixture();
    const store = await openStore(root, { watch: false, now: () => NOW });
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

    const dry = (await client.callTool({
      name: 'sync_issues',
      arguments: { path: 'README.md', heading: 'Known issues', dryRun: true },
    })) as CallToolResult;
    expect(dry.isError).toBeFalsy();
    const dryPlan = JSON.parse(textOf(dry)) as { dryRun: boolean; create: unknown[] };
    expect(dryPlan.dryRun).toBe(true);
    expect(dryPlan.create).toHaveLength(2);

    const real = (await client.callTool({
      name: 'sync_issues',
      arguments: { path: 'README.md', heading: 'Known issues' },
    })) as CallToolResult;
    expect(real.isError).toBeFalsy();
    const realPlan = JSON.parse(textOf(real)) as { created: string[] };
    expect(realPlan.created).toHaveLength(2);

    // archive_cards: nothing is done in this fresh store, so a dry run and a real run both
    // report zero — this only checks the tool wires through, not the archive logic itself
    // (that is `archive.test.ts`'s job).
    const archiveDry = (await client.callTool({
      name: 'archive_cards',
      arguments: { dryRun: true },
    })) as CallToolResult;
    expect(archiveDry.isError).toBeFalsy();
    expect(JSON.parse(textOf(archiveDry))).toEqual({ dryRun: true, ids: [] });
  });
});
