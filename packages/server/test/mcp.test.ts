/**
 * P5.1: drive the MCP server in-process through the SDK's InMemoryTransport pair against a
 * temp `.repoboard/`. The repo's own board is never touched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Card } from '@repoboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer, MCP_TOOL_NAMES } from '../src/mcp.js';
import { type CardStore, openStore } from '../src/store.js';
import { cardText, makeTempRepoboard, NOW, type TempRepo } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Rig {
  repo: TempRepo;
  store: CardStore;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  json<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

async function rig(cards: Record<string, string> = {}, defaultActor = 'test/mcp'): Promise<Rig> {
  const repo = await makeTempRepoboard(cards);
  cleanups.push(repo.cleanup);
  const store = await openStore(repo.root, { watch: false, now: () => NOW });
  const server = createMcpServer({ store, defaultActor, now: () => NOW });
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
  return { repo, store, client, call, json };
}

function textOf(res: CallToolResult): string {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

describe('repoboard mcp: handshake and tool list', () => {
  it('lists exactly the nine tools of the brief, each described for a newcomer', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/A card is one task/);
      expect(t.description, t.name).toMatch(/column id/);
    }
    const list = tools.find((t) => t.name === 'list_cards');
    expect(list?.description).toMatch(/backlog, decide, todo, doing, done/);
  });
});

describe('repoboard mcp: create → list → move → get', () => {
  it('creates, lists compactly, moves with a log line, and writes an events row', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo', { assignee: 'someone' }) });

    const created = await r.json<Card>('create_card', {
      title: 'Wire the MCP: server',
      labels: ['server'],
      files: ['packages/server/src/mcp.ts'],
      body: 'Do the thing.\n',
    });
    expect(created.id).toBe('RB-2');
    expect(created.status).toBe('backlog');
    expect(created.created).toBe('2026-09-02T22:41:10Z');

    const rows = await r.json<Array<Record<string, unknown>>>('list_cards');
    expect(rows.map((c) => c.id)).toEqual(['RB-1', 'RB-2']);
    expect(rows[1]).toEqual({
      id: 'RB-2',
      title: 'Wire the MCP: server',
      status: 'backlog',
      assignee: null,
      priority: null,
      labels: ['server'],
      files: ['packages/server/src/mcp.ts'],
      updated: '2026-09-02T22:41:10Z',
    });
    expect(rows[1]).not.toHaveProperty('body');
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([
        'id',
        'title',
        'status',
        'assignee',
        'priority',
        'labels',
        'files',
        'updated',
      ]);
    }
    const fullRows = await r.json<Array<{ id: string; body: string }>>('list_cards', {
      full: true,
    });
    expect(fullRows.map((c) => c.id).sort()).toEqual(['RB-1', 'RB-2']);
    expect(fullRows.find((c) => c.id === 'RB-2')?.body).toContain('Do the thing.');
    const byAssignee = await r.json<Array<{ id: string }>>('list_cards', { assignee: 'someone' });
    expect(byAssignee.map((c) => c.id)).toEqual(['RB-1']);
    const byLabel = await r.json<Array<{ id: string }>>('list_cards', { label: 'server' });
    expect(byLabel.map((c) => c.id)).toEqual(['RB-2']);

    const moved = await r.json<{ card: Card; warnings: string[] }>('move_card', {
      id: 'RB-2',
      status: 'doing',
      actor: 'claude/tester',
    });
    expect(moved.card.status).toBe('doing');
    expect(moved.warnings).toEqual([]);

    const full = await r.json<Card>('get_card', { id: 'RB-2' });
    expect(full.status).toBe('doing');
    expect(full.body).toContain('## Log');
    expect(full.body).toContain('- 2026-09-02T22:41:10Z claude/tester — moved backlog → doing');

    const onDisk = await readFile(join(r.repo.cardsDir, 'RB-2.md'), 'utf8');
    expect(onDisk).toContain('title: "Wire the MCP: server"'); // K1: colon titles are quoted
    expect(onDisk).toContain('status: doing');

    const events = (await readFile(join(r.repo.root, '.repoboard', 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'create',
        cardId: 'RB-2',
        from: null,
        to: 'backlog',
        actor: 'test/mcp',
      }),
      expect.objectContaining({
        type: 'move',
        cardId: 'RB-2',
        from: 'backlog',
        to: 'doing',
        actor: 'claude/tester',
      }),
    ]);
  });

  it('reports a WIP breach as a warning, not a refusal', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'doing'),
      'RB-2.md': cardText('RB-2', 'doing'),
      'RB-3.md': cardText('RB-3', 'doing'),
      'RB-4.md': cardText('RB-4', 'todo'),
    });
    const res = await r.call('move_card', { id: 'RB-4', status: 'doing' });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { card: Card; warnings: string[] };
    expect(parsed.card.status).toBe('doing');
    expect(parsed.warnings).toEqual([
      expect.stringMatching(/WIP limit exceeded: "doing" allows 3/),
    ]);

    const summary = await r.json<{
      columns: Array<{ id: string; count: number; wip: number | null }>;
      wipBreaches: Array<{ column: string; count: number; wip: number }>;
    }>('board_summary');
    expect(summary.columns.map((c) => c.id)).toEqual([
      'backlog',
      'decide',
      'todo',
      'doing',
      'done',
    ]);
    expect(summary.columns.find((c) => c.id === 'doing')).toMatchObject({ count: 4, wip: 3 });
    expect(summary.wipBreaches).toEqual([{ column: 'doing', count: 4, wip: 3 }]);
  });
});

describe('repoboard mcp: update_card and append_log', () => {
  it('update_card changes fields and clears with null; append_log writes exactly one line', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo', { assignee: 'old' }) });
    const updated = await r.json<Card>('update_card', {
      id: 'RB-1',
      title: 'Renamed',
      assignee: null,
      priority: 'high',
      files: ['a.ts'],
    });
    expect(updated.title).toBe('Renamed');
    expect(updated.assignee).toBeUndefined();
    expect(updated.priority).toBe('high');
    expect(updated.files).toEqual(['a.ts']);
    expect(updated.body).toContain('— updated title, assignee, priority, files');

    const logged = await r.json<Card>('append_log', {
      id: 'RB-1',
      text: 'verified:\n  3 tests pass',
      actor: 'claude/mcp-agent',
    });
    const logLines = logged.body.split('\n').filter((l) => l.startsWith('- '));
    expect(logLines).toHaveLength(2);
    expect(logLines[1]).toBe('- 2026-09-02T22:41:10Z claude/mcp-agent — verified: 3 tests pass');
    expect(r.store.events().map((e) => e.type)).toEqual(['update', 'update']);
  });

  it('uses $REPOBOARD_ACTOR-style default actor when the call carries none', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') }, 'claude/default-actor');
    const logged = await r.json<Card>('append_log', { id: 'RB-1', text: 'hi' });
    expect(logged.body).toContain('claude/default-actor — hi');
  });
});

describe('repoboard mcp: errors', () => {
  it('returns isError with a one-line message naming the bad field', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const badStatus = await r.call('move_card', { id: 'RB-1', status: 'nowhere' });
    expect(badStatus.isError).toBe(true);
    expect(textOf(badStatus)).toMatch(
      /^status: unknown column "nowhere" \(columns: backlog, decide/,
    );
    expect(textOf(badStatus)).not.toContain('\n');

    const badId = await r.call('get_card', { id: 'RB-99' });
    expect(badId.isError).toBe(true);
    expect(textOf(badId)).toMatch(/^id: unknown card "RB-99"/);

    const badCreate = await r.call('create_card', { title: 'x', status: 'nope' });
    expect(badCreate.isError).toBe(true);
    expect(textOf(badCreate)).toMatch(/^status: unknown column "nope"/);
    expect(r.store.list().map((c) => c.id)).toEqual(['RB-1']);

    const empty = await r.call('update_card', { id: 'RB-1' });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/^nothing to update/);

    const badPriority = await r.call('create_card', { title: 'x', priority: 'urgent' });
    expect(badPriority.isError).toBe(true);
    expect(textOf(badPriority)).toMatch(/priority/);
  });
});

describe('repoboard mcp: get_card resolveRefs and refs on create/update (K7)', () => {
  it('resolves refs live under `refs` only when asked, and create/update carry refs', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'todo').replace(
        'status: todo\n',
        'status: todo\nrefs:\n  - docs/plan.md@P6.1\n  - .git/config\n',
      ),
    });
    await mkdir(join(r.repo.root, 'docs'));
    await writeFile(
      join(r.repo.root, 'docs', 'plan.md'),
      '# Plan\n- **P6.1** README.\n  more\n- **P6.2** next\n',
    );
    const plain = await r.json<Card>('get_card', { id: 'RB-1' });
    expect(plain.refs).toEqual(['docs/plan.md@P6.1', '.git/config']);
    const resolved = await r.json<{
      refs: {
        spec: string;
        text: string | null;
        error: string | null;
        start: number | null;
        end: number | null;
      }[];
    }>('get_card', { id: 'RB-1', resolveRefs: true });
    expect(resolved.refs).toEqual([
      {
        spec: 'docs/plan.md@P6.1',
        path: 'docs/plan.md',
        start: 2,
        end: 3,
        text: '- **P6.1** README.\n  more',
        truncated: false,
        error: null,
      },
      {
        spec: '.git/config',
        path: '.git/config',
        start: null,
        end: null,
        text: null,
        truncated: false,
        error: '.git/ not allowed: .git/config',
      },
    ]);
    const created = await r.json<Card>('create_card', {
      title: 'Pointed',
      refs: ['docs/plan.md:L1'],
    });
    expect(created.refs).toEqual(['docs/plan.md:L1']);
    const updated = await r.json<Card>('update_card', { id: created.id, refs: null });
    expect('refs' in updated).toBe(false);
    expect(updated.body).toContain('updated refs');
  });
});

describe('repoboard mcp: ask_owner / record_decision (P8.1)', () => {
  it('ask_owner opens a decision, moves the card into decide, records returnTo', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await r.json<{ card: Card; warnings: string[] }>('ask_owner', {
      id: 'RB-1',
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
    });
    expect(res.card.status).toBe('decide');
    expect(res.card.decision).toMatchObject({
      question: 'Ship it?',
      returnTo: 'todo',
      chosen: null,
    });
    expect(res.warnings).toEqual([]);
  });

  it('asking again while OPEN is refused; replace: true withdraws and re-asks', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    await r.json('ask_owner', { id: 'RB-1', question: 'First?' });
    const refused = await r.call('ask_owner', { id: 'RB-1', question: 'Second?' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/already has an open decision: "First\?"/);
    const replaced = await r.json<{ card: Card }>('ask_owner', {
      id: 'RB-1',
      question: 'Second?',
      replace: true,
    });
    expect(replaced.card.decision?.question).toBe('Second?');
    expect(replaced.card.body).toContain('question withdrawn');
  });

  it('record_decision answers, moves the card back, and is authority (chosen/words readable)', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'doing') });
    await r.json('ask_owner', {
      id: 'RB-1',
      question: 'Ship it?',
      options: [
        { letter: 'A', text: 'yes' },
        { letter: 'B', text: 'no' },
      ],
    });
    const decided = await r.json<{ card: Card }>('record_decision', { id: 'RB-1', letter: 'A' });
    expect(decided.card.status).toBe('doing');
    expect(decided.card.decision).toMatchObject({ chosen: 'A', decidedBy: 'test/mcp' });
    const got = await r.json<Card>('get_card', { id: 'RB-1' });
    expect(got.decision?.chosen).toBe('A');
  });

  it('record_decision refuses an unknown letter and refuses when nothing is open', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const nothingOpen = await r.call('record_decision', { id: 'RB-1', letter: 'A' });
    expect(nothingOpen.isError).toBe(true);
    expect(textOf(nothingOpen)).toMatch(/no decision is open on RB-1/);

    await r.json('ask_owner', {
      id: 'RB-1',
      question: 'q?',
      options: [{ letter: 'A', text: 'x' }],
    });
    const bad = await r.call('record_decision', { id: 'RB-1', letter: 'Z' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/letter: unknown option "Z" \(valid: A\)/);
  });

  it('list_cards needsDecision:true filters to open decisions only', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo'),
    });
    await r.json('ask_owner', { id: 'RB-1', question: 'q?' });
    const rows = await r.json<{ id: string }[]>('list_cards', { needsDecision: true });
    expect(rows.map((row) => row.id)).toEqual(['RB-1']);
    await r.json('record_decision', { id: 'RB-1', words: 'ok' });
    const rowsAfter = await r.json<{ id: string }[]>('list_cards', { needsDecision: true });
    expect(rowsAfter).toEqual([]);
  });

  it('a board with no decision:true column leaves status alone (badge only)', async () => {
    const repo = await makeTempRepoboard({ 'RB-1.md': cardText('RB-1', 'todo') });
    cleanups.push(repo.cleanup);
    await writeFile(
      join(repo.root, '.repoboard', 'board.yml'),
      'prefix: RB\nactiveWindowMinutes: 30\ncolumns:\n  - id: todo\n  - id: doing\n  - id: done\n',
    );
    const store = await openStore(repo.root, { watch: false, now: () => NOW });
    const server = createMcpServer({ store, defaultActor: 'test/mcp', now: () => NOW });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'repoboard-test', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const res = (await client.callTool({
      name: 'ask_owner',
      arguments: { id: 'RB-1', question: 'q?' },
    })) as CallToolResult;
    const parsed = JSON.parse(textOf(res)) as { card: Card };
    expect(parsed.card.status).toBe('todo');
    expect(parsed.card.decision?.returnTo).toBeNull();
  });
});
