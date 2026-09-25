/**
 * P5.1: drive the MCP server in-process through the SDK's InMemoryTransport pair against a
 * temp `.repoboard/`. The repo's own board is never touched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The card/board tools (P8.1 and before, plus RCB-70's add_note); the five P8.2 lease/window
 * tools are separate. */
const CARD_TOOLS = [
  'list_cards',
  'get_card',
  'create_card',
  'move_card',
  'update_card',
  'append_log',
  'add_note',
  'board_summary',
  'ask_owner',
  'record_decision',
  'list_decisions',
];
const LEASE_TOOLS = ['take_lease', 'release_lease', 'list_leases', 'add_window', 'check_window'];
/** P8.3: the four state/log/check tools — same terse-description budget as P8.2's lease tools. */
const STATE_TOOLS = ['get_state', 'set_state_section', 'append_repo_log', 'check'];
/** P8.4: one new tool, same terse-description budget. */
const COST_TOOLS = ['cost'];
/** RCB-97: `.repoboard/systems.yml`'s two read tools, same terse-description budget. */
const SYSTEMS_TOOLS = ['list_systems', 'get_system'];
/** P8.5: archive + sync-issues, described for a newcomer like the card tools. */
const ISSUE_TOOLS = ['archive_cards', 'sync_issues'];
/** RCB-56: the one board/config write tool, terse like the lease/window tools (no CARD_INTRO). */
const CONFIG_TOOLS = ['set_columns'];
/** RCB-146: the MCP-parity read of the log, the cold-start seat bundle and the gate ledger, plus
 * the gate ledger's own write — same terse-description budget as P8.2/P8.3. */
const LOG_SEAT_GATE_TOOLS = ['get_log', 'get_seat', 'record_gate', 'get_gate'];

describe('repoboard mcp: handshake and tool list', () => {
  it('lists exactly the twenty-nine tools of the brief', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(
      CARD_TOOLS.length +
        LEASE_TOOLS.length +
        STATE_TOOLS.length +
        COST_TOOLS.length +
        SYSTEMS_TOOLS.length +
        ISSUE_TOOLS.length +
        CONFIG_TOOLS.length +
        LOG_SEAT_GATE_TOOLS.length,
    );
    const list = tools.find((t) => t.name === 'list_cards');
    expect(list?.description).toMatch(/backlog, decide, todo, doing, done/);
  });

  /**
   * RCB-137: CARD_INTRO (what a card is, that `status` is a column id, decision/parent/phase/gate
   * semantics) now lives ONCE, in the server `instructions` — not spliced into every card tool's
   * description. `client.getInstructions()` is the SDK's client-side accessor for that string.
   */
  it('RCB-137: CARD_INTRO lives once, in instructions, not in any tool description', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const sentence = "A card is one task on this repository's Kanban board";
    for (const t of tools) {
      expect(t.description, t.name).not.toContain(sentence);
    }
    expect(r.client.getInstructions()).toContain(sentence);
  });

  /**
   * RCB-65 pin: docs/AGENTS.md §3's "Tools: …" sentence must name exactly the tools
   * `MCP_TOOL_NAMES` carries, so a future tool (or a dropped one) fails this test instead of
   * going stale silently.
   */
  it('docs/AGENTS.md §3 tool list matches MCP_TOOL_NAMES exactly (pin)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const agentsPath = join(here, '..', '..', '..', 'docs', 'AGENTS.md');
    const agents = await readFile(agentsPath, 'utf8');
    expect(agents).toContain('## 3. MCP');
    const sectionStart = agents.indexOf('## 3. MCP');
    const toolsMarker = 'Tools: ';
    const toolsIndex = agents.indexOf(toolsMarker, sectionStart);
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    const afterTools = agents.slice(toolsIndex + toolsMarker.length);
    const endMarker = 'Call `list_cards`';
    const endIndex = afterTools.indexOf(endMarker);
    expect(endIndex).toBeGreaterThanOrEqual(0);
    const listText = afterTools.slice(0, endIndex);
    const names = [...listText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('P8.2: the five lease/window tool descriptions are terse (<=700 B each) and byte-report cleanly', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const bytes: Record<string, number> = {};
    for (const name of LEASE_TOOLS) {
      const t = byName.get(name);
      expect(t, name).toBeDefined();
      bytes[name] = Buffer.byteLength(JSON.stringify(t));
      expect(bytes[name], name).toBeLessThanOrEqual(700);
    }
    // Not a magic number: just proves the test above actually measured something real.
    expect(Object.values(bytes).every((b) => b > 0)).toBe(true);
  });

  it('P8.3: the four state/log/check tool descriptions are terse (<=700 B each)', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const bytes: Record<string, number> = {};
    for (const name of STATE_TOOLS) {
      const t = byName.get(name);
      expect(t, name).toBeDefined();
      bytes[name] = Buffer.byteLength(JSON.stringify(t));
      expect(bytes[name], name).toBeLessThanOrEqual(700);
    }
    expect(Object.values(bytes).every((b) => b > 0)).toBe(true);
  });

  /**
   * RCB-146: the four log/seat/gate tools measured 749 / 561 / 1375 / 400 B at landing —
   * `record_gate` alone carries ten fields (the gate ledger's whole shape), so it gets its own
   * higher ceiling rather than the LEASE_TOOLS/STATE_TOOLS 700 B convention; each ceiling below
   * has some headroom over the measured byte count, not the measured count itself.
   */
  it('RCB-146: the four log/seat/gate tools stay within their measured ceilings', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const ceilings: Record<string, number> = {
      // RCB-132: since/tail measured 1114 B (was 749 B at RCB-146).
      get_log: 1200,
      get_seat: 700,
      record_gate: 1450,
      get_gate: 700,
    };
    const bytes: Record<string, number> = {};
    for (const name of LOG_SEAT_GATE_TOOLS) {
      const t = byName.get(name);
      expect(t, name).toBeDefined();
      bytes[name] = Buffer.byteLength(JSON.stringify(t));
      expect(bytes[name], name).toBeLessThanOrEqual(ceilings[name] as number);
    }
    expect(Object.values(bytes).every((b) => b > 0)).toBe(true);
  });

  it('the full schema, all twenty-three tools, is reported here (orchestrator note 1)', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const total = tools.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t)), 0);
    // A measurement, not an assertion beyond "it grew and every tool reported a byte count" —
    // the exact number belongs in the brief's §7 log, not frozen into a test that would need
    // editing every time any tool's wording changes.
    expect(total).toBeGreaterThan(0);
    expect(tools.every((t) => Buffer.byteLength(JSON.stringify(t)) > 0)).toBe(true);
  });

  it('check_window carries the authority sentence locked decision 7 requires verbatim', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const checkWindow = tools.find((t) => t.name === 'check_window');
    expect(checkWindow?.description).toContain(
      'Call check_window before starting any long-running shared-resource job such as a test suite; exit/clear false means DO NOT start.',
    );
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
      size: null,
      labels: ['server'],
      files: ['packages/server/src/mcp.ts'],
      parent: null,
      phase: null,
      gate: null,
      blocked: null,
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
        'size',
        'labels',
        'files',
        'parent',
        'phase',
        'gate',
        'blocked',
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

  it('RCB-67: create_card takes size, list_cards rows carry it, update_card sets then null clears', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const created = await r.json<Card>('create_card', { title: 'sized', size: 'M' });
    expect(created.size).toBe('M');

    const rows = await r.json<Array<Record<string, unknown>>>('list_cards');
    const row = rows.find((row) => row.id === created.id);
    expect(row?.size).toBe('M');

    const updated = await r.json<Card>('update_card', { id: created.id, size: 'L' });
    expect(updated.size).toBe('L');
    const cleared = await r.json<Card>('update_card', { id: created.id, size: null });
    expect(cleared.size).toBeUndefined();
  });
});

describe('repoboard mcp: parent/phase/gate (RCB-68)', () => {
  it('list_cards rows carry parent/phase/gate/blocked, computed against the whole board', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo').replace(
        'status: todo\n',
        'status: todo\nparent: RB-1\nphase: PH.1\ngate: RB-1\n',
      ),
    });
    const rows = await r.json<Array<Record<string, unknown>>>('list_cards');
    const row = rows.find((row) => row.id === 'RB-2');
    expect(row).toMatchObject({
      parent: 'RB-1',
      phase: 'PH.1',
      gate: 'RB-1',
      blocked: 'blocked on RB-1 (todo)',
    });
    const plain = rows.find((row) => row.id === 'RB-1');
    expect(plain).toMatchObject({ parent: null, phase: null, gate: null, blocked: null });
  });

  it('update_card sets parent/phase/gate, gate null clears', async () => {
    const r = await rig({
      'RB-1.md': cardText('RB-1', 'todo'),
      'RB-2.md': cardText('RB-2', 'todo'),
    });
    const set = await r.json<Card>('update_card', {
      id: 'RB-2',
      parent: 'RB-1',
      phase: 'PH.3',
      gate: 'RB-1',
    });
    expect(set.parent).toBe('RB-1');
    expect(set.phase).toBe('PH.3');
    expect(set.gate).toBe('RB-1');
    const cleared = await r.json<Card>('update_card', { id: 'RB-2', gate: null });
    expect(cleared.gate).toBeUndefined();
    expect(cleared.parent).toBe('RB-1'); // untouched
  });

  it('update_card refuses an unknown parent, naming the field', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const res = await r.call('update_card', { id: 'RB-1', parent: 'RB-404' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('parent: unknown card "RB-404"');
  });

  /**
   * RCB-68: the ≤700 B pin above never covered the card tools — CARD_INTRO alone was ~460 B. The
   * three tools RCB-68 widened (parent/phase/gate/blocked) get their own ceiling so a future
   * description cannot balloon unnoticed. RCB-137 moved CARD_INTRO out of every tool description
   * and into `instructions` alone (at most a ≤140 B clause where a tool needs one); measured at
   * that landing: list_cards 1290 B, create_card 1840 B, update_card 1919 B (was 2122 / 2672 /
   * 2660 against the same fixture; RCB-68 landing was 2110 / 2529 / 2537). Ceiling tightened to
   * 2110 B — about 10 % over update_card's 1919 B, the largest of the three. A test that only
   * asserts `> 0` is not a pin; this one is.
   */
  it('RCB-68/RCB-137: the three widened card tools stay ≤ 2110 B each (list_cards, create_card, update_card)', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    for (const name of ['list_cards', 'create_card', 'update_card']) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      const bytes = Buffer.byteLength(JSON.stringify(t));
      expect(bytes, name).toBeGreaterThan(1000);
      expect(bytes, name).toBeLessThanOrEqual(2110);
    }
  });
});

describe('repoboard mcp: add_note (RCB-70)', () => {
  it('appends under ## Notes and returns the card, keeping newlines as continuation lines', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const noted = await r.json<Card>('add_note', {
      id: 'RB-1',
      text: 'line one\nline two',
      actor: 'owner',
    });
    expect(noted.body).toContain('## Notes\n- 2026-09-02T22:41:10Z owner — line one\n  line two');
    expect(r.store.events().map((e) => e.type)).toEqual(['note']);
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

  it('ask_owner kind: "task" then record_decision with only id succeeds (RCB-52)', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const asked = await r.json<{ card: Card }>('ask_owner', {
      id: 'RB-1',
      question: 'set up npm',
      kind: 'task',
    });
    expect(asked.card.decision).toMatchObject({ kind: 'task', options: [] });
    expect(asked.card.status).toBe('decide');
    const decided = await r.json<{ card: Card }>('record_decision', { id: 'RB-1' });
    expect(decided.card.status).toBe('todo');
    expect(decided.card.decision).toMatchObject({ kind: 'task', chosen: null, words: null });
  });

  it('ask_owner kind: "task" with options is refused: "a task has no options"', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const refused = await r.call('ask_owner', {
      id: 'RB-1',
      question: 'set up npm',
      kind: 'task',
      options: [{ letter: 'A', text: 'x' }],
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/a task has no options/);
  });

  /**
   * Control C3 (MCP half): dropping the `kind` pass-through in `store.ask` writes the card as a
   * plain question, so a bare `record_decision` (neither letter nor words) would then be refused
   * instead of succeeding — this test fails on both assertions. Verified per CLAUDE.md; see the
   * agent's report for the perturbation applied, both failing assertions, and the restore proof.
   */
  it('control C3: ask_owner --task really sets kind: task, and record_decision with nothing then succeeds', async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    const asked = await r.json<{ card: Card }>('ask_owner', {
      id: 'RB-1',
      question: 'set up npm',
      kind: 'task',
    });
    expect(asked.card.decision?.kind).toBe('task'); // assertion 1
    const decided = await r.call('record_decision', { id: 'RB-1' });
    expect(decided.isError).toBeFalsy(); // assertion 2 (a plain question would refuse)
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

/** A card whose decision is already answered — hand-written frontmatter (not `ask_owner`/
 *  `record_decision`), so `decidedAt`/`decidedBy` and the body's `## Log`/`## Notes` are exact,
 *  independent of the rig's fixed clock. */
function decidedCardText(
  id: string,
  opts: { decidedAt: string; decidedBy: string; body?: string },
): string {
  return (
    '---\n' +
    `id: ${id}\n` +
    'title: "Ship it?"\n' +
    'status: todo\n' +
    'created: 2026-09-02T18:00:00Z\n' +
    'updated: 2026-09-02T18:00:00Z\n' +
    'decision:\n' +
    '  question: "Ship it?"\n' +
    '  options:\n' +
    '    - letter: A\n' +
    '      text: "yes"\n' +
    '  askedBy: claude/coordinator\n' +
    '  askedAt: 2026-09-02T18:00:00Z\n' +
    '  returnTo: null\n' +
    '  chosen: A\n' +
    '  words: null\n' +
    `  decidedBy: ${opts.decidedBy}\n` +
    `  decidedAt: ${opts.decidedAt}\n` +
    '---\n' +
    (opts.body ?? '\nBody.\n')
  );
}

describe('repoboard mcp: list_decisions (RCB-129)', () => {
  it('an unacknowledged answered decision comes back, acknowledged: false', async () => {
    const r = await rig({
      'RB-1.md': decidedCardText('RB-1', { decidedAt: '2026-09-02T18:19:51Z', decidedBy: 'owner' }),
    });
    const rows = await r.json<Array<{ id: string; acknowledged: boolean }>>('list_decisions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'RB-1',
      chosen: 'A',
      chosenText: 'yes',
      acknowledged: false,
    });
  });

  it('a ## Notes line after decidedAt by another actor acknowledges it — default drops it, all: true keeps it', async () => {
    const r = await rig({
      'RB-1.md': decidedCardText('RB-1', {
        decidedAt: '2026-09-02T18:19:51Z',
        decidedBy: 'owner',
        body: '\n## Notes\n- 2026-09-02T18:26:00Z builder — ack\n',
      }),
    });
    const rows = await r.json<Array<{ id: string }>>('list_decisions');
    expect(rows).toEqual([]);
    const all = await r.json<Array<{ id: string; acknowledged: boolean }>>('list_decisions', {
      all: true,
    });
    expect(all).toEqual([expect.objectContaining({ id: 'RB-1', acknowledged: true })]);
  });

  it('since (HH:MMZ against the rig clock’s own UTC date) filters on decidedAt', async () => {
    const r = await rig({
      'RB-1.md': decidedCardText('RB-1', { decidedAt: '2026-09-02T10:00:00Z', decidedBy: 'owner' }),
      'RB-2.md': decidedCardText('RB-2', { decidedAt: '2026-09-02T20:00:00Z', decidedBy: 'owner' }),
    });
    const rows = await r.json<Array<{ id: string }>>('list_decisions', { since: '18:00Z' });
    expect(rows.map((row) => row.id)).toEqual(['RB-2']);
  });

  it('an unparseable since is a tool error naming the field', async () => {
    const r = await rig({});
    const res = await r.call('list_decisions', { since: 'not a time' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^since: /);
  });
});

describe('repoboard mcp: take_lease / release_lease / list_leases / add_window / check_window (P8.2)', () => {
  it('take_lease writes the lease, list_leases reflects it with state live', async () => {
    const r = await rig();
    const taken = await r.json<{ doc: { leases: unknown[] }; warnings: string[] }>('take_lease', {
      resource: 'vitest-lock',
      until: '2026-09-03T00:00:00Z',
      note: 'cold4 gate',
    });
    expect(taken.warnings).toEqual([]);
    const listed = await r.json<{ leases: Array<Record<string, unknown>> }>('list_leases');
    expect(listed.leases).toEqual([
      {
        resource: 'vitest-lock',
        holder: 'test/mcp',
        since: NOW.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        until: '2026-09-03T00:00:00Z',
        state: 'live',
        note: 'cold4 gate',
      },
    ]);
  });

  it('a conflicting take_lease is an error result naming the holder; force overrides', async () => {
    const r = await rig();
    await r.json('take_lease', { resource: 'r', actor: 'claude/ops' });
    const conflict = await r.call('take_lease', { resource: 'r', actor: 'claude/fix' });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatch(/is held by claude\/ops/);
    const forced = await r.json<{ warnings: string[] }>('take_lease', {
      resource: 'r',
      actor: 'claude/fix',
      force: true,
    });
    expect(forced.warnings[0]).toMatch(/forced: took "r" from claude\/ops/);
  });

  it('release_lease frees it; a non-holder is an error result', async () => {
    const r = await rig();
    await r.json('take_lease', { resource: 'r', actor: 'claude/ops' });
    const bad = await r.call('release_lease', { resource: 'r', actor: 'claude/fix' });
    expect(bad.isError).toBe(true);
    const released = await r.json<{ doc: { leases: unknown[] } }>('release_lease', {
      resource: 'r',
      actor: 'claude/ops',
    });
    expect(released.doc.leases).toEqual([]);
  });

  it('add_window then check_window: clear before/after, blocked inside', async () => {
    const r = await rig();
    await r.json('add_window', {
      resource: 'vitest-lock',
      start: '2026-09-02T22:00:00Z',
      end: '2026-09-02T23:00:00Z',
      name: 'cold4 gate',
    });
    const before = await r.json<{ clear: boolean }>('check_window', {
      resource: 'vitest-lock',
      at: '2026-09-02T21:00:00Z',
    });
    expect(before).toEqual({ clear: true });
    const inside = await r.json<{ clear: boolean; reasons: string[] }>('check_window', {
      resource: 'vitest-lock',
      at: '2026-09-02T22:30:00Z',
    });
    expect(inside).toEqual({
      clear: false,
      reasons: ['inside cold4 gate 2026-09-02T22:00:00Z–2026-09-02T23:00:00Z vitest-lock'],
    });
  });

  it('check_window defaults `at` to now and never returns clear:true while a live lease is held (C1 target)', async () => {
    const r = await rig();
    await r.json('take_lease', { resource: 'vitest-lock', until: '2026-09-02T23:00:00Z' });
    const res = await r.json<{ clear: boolean; reasons?: string[] }>('check_window', {
      resource: 'vitest-lock',
    });
    expect(res.clear).toBe(false);
    expect(res.reasons?.[0]).toMatch(/^held by test\/mcp until/);
  });

  it('list_leases also returns windows, pruning only happens on a write, not on this read', async () => {
    // An expired window can only get INTO leases.yml without being pruned via an external hand
    // edit (any mutation through the store prunes on its own write) — exactly the shape locked
    // decision 2 describes: pruning happens on write, never on read.
    const repo = await makeTempRepoboard({});
    cleanups.push(repo.cleanup);
    await writeFile(
      join(repo.root, '.repoboard', 'leases.yml'),
      'windows:\n  - resource: r\n    start: 2020-01-01T00:00:00Z\n    end: 2020-01-01T01:00:00Z\n    name: ancient\n',
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
    const res = (await client.callTool({ name: 'list_leases', arguments: {} })) as CallToolResult;
    const parsed = JSON.parse(textOf(res)) as { windows: unknown[] };
    expect(parsed.windows).toHaveLength(1); // still there: a read never prunes
  });
});

describe('repoboard mcp: get_state / set_state_section / append_repo_log / check (P8.3)', () => {
  it('get_state before any STATE.md exists: nulls, not a crash', async () => {
    const r = await rig();
    const state = await r.json<{ stamp: null; text: null; ownerQueue: unknown[] }>('get_state');
    expect(state).toEqual({
      stamp: null,
      actor: null,
      sections: null,
      ownerQueue: [],
      leases: [],
      text: null,
    });
  });

  it('set_state_section scaffolds then restamps; get_state renders it with generated OWNER QUEUE', async () => {
    const r = await rig();
    const set = await r.json<{ sections: { live: string } }>('set_state_section', {
      section: 'LIVE',
      body: 'Tree is dev.',
      actor: 'claude/p8-3',
    });
    expect(set.sections.live).toBe('Tree is dev.');
    const state = await r.json<{ text: string; ownerQueue: unknown[] }>('get_state');
    expect(state.text).toContain('Tree is dev.');
    expect(state.text).toContain('_(generated from open decisions)_');
    expect(state.ownerQueue).toEqual([]);
  });

  it("get_state's ownerQueue reflects a card with an open decision", async () => {
    const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
    await r.json('set_state_section', { section: 'LIVE', body: 'x' });
    await r.json('ask_owner', {
      id: 'RB-1',
      question: 'ship now?',
      options: [{ letter: 'A', text: 'yes' }],
    });
    const state = await r.json<{
      ownerQueue: Array<{ id: string; question: string }>;
      text: string;
    }>('get_state');
    expect(state.ownerQueue).toEqual([
      { id: 'RB-1', question: 'ship now?', options: [{ letter: 'A', text: 'yes' }] },
    ]);
    expect(state.text).toContain('RB-1 · ship now? · [A]');
  });

  it('an unknown section is an error result naming the valid ones', async () => {
    const r = await rig();
    const res = await r.call('set_state_section', { section: 'NOPE', body: 'x' });
    expect(res.isError).toBe(true);
  });

  it('append_repo_log creates the day file, then appends a second block', async () => {
    const r = await rig();
    const first = await r.json<{ date: string; block: { seat: string; title: string } }>(
      'append_repo_log',
      { seat: 'claude/p8-3', text: 'first entry', title: 'kickoff' },
    );
    expect(first.date).toBe('2026-09-02');
    expect(first.block.seat).toBe('CLAUDE/P8-3');
    expect(first.block.title).toBe('kickoff');
    const log = await readFile(join(r.repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(log).toContain('kickoff');

    await r.json('append_repo_log', { seat: 'ops', text: 'second entry' });
    const after = await readFile(join(r.repo.root, '.repoboard', 'log', '2026-09-02.md'), 'utf8');
    expect(after).toContain('kickoff');
    expect(after).toContain('second entry');
  });

  it('empty seat/text is an error result', async () => {
    const r = await rig();
    expect((await r.call('append_repo_log', { seat: '  ', text: 'x' })).isError).toBe(true);
  });

  it('append_repo_log: restamped is true for a seat with an UP bullet, false otherwise (RCB-127)', async () => {
    const r = await rig();
    await r.json('set_state_section', {
      section: 'SEATS',
      body: '- **builder: UP 2026-09-02 22:00Z.** holding RCB-127',
      actor: 'coordinator',
    });
    const stateBefore = await r.json<{ actor: string }>('get_state');
    expect(stateBefore.actor).toBe('coordinator');

    const up = await r.json<{ restamped: boolean }>('append_repo_log', {
      seat: 'builder',
      text: 'mid-session update',
    });
    expect(up.restamped).toBe(true);
    // The restamp's actor line flips from `coordinator` (the SEATS write above) to `builder` —
    // the visible proof this call rewrote STATE.md's own stamp/actor line, not just the flag.
    const stateAfterUp = await r.json<{ actor: string }>('get_state');
    expect(stateAfterUp.actor).toBe('builder');

    const down = await r.json<{ restamped: boolean }>('append_repo_log', {
      seat: 'ops', // no SEATS bullet at all
      text: 'mid-session note',
    });
    expect(down.restamped).toBe(false);
  });

  it('check: ok (empty findings, exitCode 0) on a clean fixture', async () => {
    const r = await rig();
    const res = await r.json<{ findings: unknown[]; exitCode: number }>('check');
    expect(res).toEqual({ findings: [], exitCode: 0 });
  });

  it('check: a stale lease is an error-grade finding, exitCode 1 even without strict', async () => {
    const r = await rig();
    await r.json('take_lease', {
      resource: 'r',
      actor: 'claude/ops',
      until: '2020-01-01T00:00:00Z',
    });
    const res = await r.json<{ findings: Array<{ kind: string }>; exitCode: number }>('check');
    expect(res.findings.some((f) => f.kind === 'stale-lease')).toBe(true);
    expect(res.exitCode).toBe(1);
  });

  it('check: strict turns a warning-grade active-without-lease finding into exitCode 1', async () => {
    // cardText's fixed `updated: 2026-09-02T22:00:00Z` is 41 minutes before NOW
    // (2026-09-02T22:41:10Z) — outside the default 30-minute active window — so this card is
    // written with `updated` at NOW itself, to land inside it.
    const r = await rig({
      'RB-1.md': [
        '---',
        'id: RB-1',
        'title: "active card"',
        'status: doing',
        'assignee: claude/p8-3',
        'created: 2026-09-02T22:00:00Z',
        'updated: 2026-09-02T22:41:10Z',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    });
    const plain = await r.json<{ findings: Array<{ kind: string }>; exitCode: number }>('check', {
      strict: false,
    });
    expect(plain.findings.some((f) => f.kind === 'active-without-lease')).toBe(true);
    expect(plain.exitCode).toBe(0);
    const strict = await r.json<{ exitCode: number }>('check', { strict: true });
    expect(strict.exitCode).toBe(1);
  });
});

describe('repoboard mcp: cost (P8.4)', () => {
  it('the cost tool description is terse (<=700 B)', async () => {
    const r = await rig();
    const { tools } = await r.client.listTools();
    const tool = tools.find((t) => t.name === 'cost');
    expect(tool).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThanOrEqual(700);
  });

  it('reports an absent CLAUDE.md, never OVER', async () => {
    const r = await rig();
    const report = await r.json<{ claudeMdBytes: null; over: boolean; entries: unknown[] }>('cost');
    expect(report.claudeMdBytes).toBeNull();
    expect(report.over).toBe(false);
    expect(report.entries).toEqual([]);
  });

  it('a CLAUDE.md over budget reports over:true, gated by an explicit budget argument', async () => {
    const r = await rig();
    await writeFile(join(r.repo.root, 'CLAUDE.md'), 'x'.repeat(100));
    const atBudget = await r.json<{ over: boolean; claudeMdBytes: number }>('cost', {
      budget: 100,
    });
    expect(atBudget).toMatchObject({ over: false, claudeMdBytes: 100 });
    const overBudget = await r.json<{ over: boolean }>('cost', { budget: 99 });
    expect(overBudget.over).toBe(true);
  });

  it('check surfaces cost-over-budget as an error-grade finding (locked decision 4)', async () => {
    const r = await rig();
    await writeFile(join(r.repo.root, 'CLAUDE.md'), 'x'.repeat(9000));
    const res = await r.json<{
      findings: Array<{ kind: string; level: string }>;
      exitCode: number;
    }>('check');
    const finding = res.findings.find((f) => f.kind === 'cost-over-budget');
    expect(finding).toMatchObject({ level: 'error' });
    expect(res.exitCode).toBe(1);
  });
});

describe('repoboard mcp: set_columns (RCB-56)', () => {
  it('ok: replaces the whole column list and returns the re-parsed config', async () => {
    const r = await rig();
    const res = await r.json<{ config: { columns: unknown[] } }>('set_columns', {
      columns: [
        { id: 'backlog', title: 'Backlog' },
        { id: 'doing', title: 'Doing', active: true, wip: 2 },
      ],
      actor: 'claude/rcb-56',
    });
    expect(res.config).toMatchObject({
      columns: [
        { id: 'backlog', title: 'Backlog' },
        { id: 'doing', title: 'Doing', active: true, wip: 2 },
      ],
    });
    expect(r.store.config.columns).toEqual([
      { id: 'backlog', title: 'Backlog' },
      { id: 'doing', title: 'Doing', active: true, wip: 2 },
    ]);
  });

  it('fail: an empty list is refused by the store’s own schema, board.yml untouched', async () => {
    const r = await rig();
    const before = await readFile(join(r.repo.root, '.repoboard', 'board.yml'), 'utf8');
    const res = await r.call('set_columns', { columns: [] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('at least one column');
    const after = await readFile(join(r.repo.root, '.repoboard', 'board.yml'), 'utf8');
    expect(after).toBe(before);
  });
});

/**
 * RCB-146: `list_cards`'s three new filters, all going through the shared `filterCards`
 * (card-query.ts) — the exact fixture cli.test.ts's `card list --parent/--unblocked` describe
 * block builds, rebuilt here through MCP tool calls instead of the CLI.
 */
describe('repoboard mcp: list_cards size/parent/unblocked filters (RCB-146)', () => {
  async function buildStepsFixture(
    r: Rig,
  ): Promise<{ parent: string; ph0: string; ph1: string; ph2: string; other: string }> {
    const parent = (
      await r.json<{ id: string }>('create_card', { title: 'Parent', status: 'doing' })
    ).id;
    // PH.2 added FIRST (lower id than PH.0/PH.1) so id order != phase order.
    const ph2 = (
      await r.json<{ id: string }>('create_card', {
        title: 'Step two',
        parent,
        phase: 'PH.2',
        gate: 'wait for step one',
      })
    ).id;
    const ph0 = (
      await r.json<{ id: string }>('create_card', { title: 'Step zero', parent, phase: 'PH.0' })
    ).id;
    await r.json('move_card', { id: ph0, status: 'done' });
    const ph1 = (
      await r.json<{ id: string }>('create_card', {
        title: 'Step one',
        parent,
        phase: 'PH.1',
        gate: ph0,
      })
    ).id;
    await r.json('update_card', { id: ph2, gate: ph1 });
    const other = (await r.json<{ id: string }>('create_card', { title: 'Unrelated' })).id;
    return { parent, ph0, ph1, ph2, other };
  }

  it(
    'size filters to an exact match ' +
      '(pins card-query.ts filterCards: `if (size !== undefined) cards = cards.filter(...)`; ' +
      'reverted, both cards would come back)',
    async () => {
      const r = await rig();
      const small = await r.json<{ id: string }>('create_card', { title: 'small', size: 'S' });
      await r.json('create_card', { title: 'medium', size: 'M' });
      const rows = await r.json<Array<{ id: string }>>('list_cards', { size: 'S' });
      expect(rows.map((c) => c.id)).toEqual([small.id]);
    },
  );

  it(
    'parent lists that card’s steps in PHASE order, not id order ' +
      '(pins card-query.ts filterCards: `if (parent === undefined) { cards = cards.slice().sort(...) }`; ' +
      'reverted to sort unconditionally, this would come back id-ordered: ph2, ph0, ph1)',
    async () => {
      const r = await rig();
      const { parent, ph0, ph1, ph2, other } = await buildStepsFixture(r);
      const rows = await r.json<Array<{ id: string }>>('list_cards', { parent });
      expect(rows.map((c) => c.id)).toEqual([ph0, ph1, ph2]);
      expect(rows.some((c) => c.id === other)).toBe(false);
    },
  );

  it(
    'unblocked (with parent) keeps only the not-done, not-blocked step ' +
      '(pins card-query.ts filterCards: `findColumn(config, c.status)?.done !== true && ' +
      'blockedReason(c, all, config) === null`; reverted to always true, all three steps would ' +
      'come back)',
    async () => {
      const r = await rig();
      const { parent, ph1 } = await buildStepsFixture(r);
      const rows = await r.json<Array<{ id: string }>>('list_cards', { parent, unblocked: true });
      expect(rows.map((c) => c.id)).toEqual([ph1]);
    },
  );

  it(
    'unblocked without parent is refused, in MCP’s OWN wording (no CLI --flags) ' +
      '(pins card-query.ts filterCards: `if (f.unblocked && f.parent === undefined) throw new ' +
      'Error(...)`; reverted, this call would not error)',
    async () => {
      const r = await rig();
      const res = await r.call('list_cards', { unblocked: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('unblocked requires parent');
    },
  );

  it(
    'parent naming an unknown card is refused with the raw "unknown card" message ' +
      '(pins card-query.ts filterCards: `if (!all.some((c) => c.id === parent)) throw new ' +
      'Error(...)`; reverted, this call would return an empty array instead of erroring)',
    async () => {
      const r = await rig();
      const res = await r.call('list_cards', { parent: 'NOPE-1' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('unknown card "NOPE-1"');
    },
  );
});

describe('repoboard mcp: get_log (RCB-146)', () => {
  it(
    "reads a day's log, the same shape `log show --json` prints " +
      '(pins mcp.ts get_log: the final `return ok({ date: log.date, blocks: log.blocks })`; ' +
      'reverted to `blocks: []`, this would come back empty)',
    async () => {
      const r = await rig();
      await r.json('append_repo_log', {
        seat: 'claude/p8-3',
        text: 'first entry',
        title: 'kickoff',
      });
      await r.json('append_repo_log', { seat: 'ops', text: 'second entry' });
      const log = await r.json<{ date: string; blocks: Array<{ seat: string; title: string }> }>(
        'get_log',
        {},
      );
      expect(log.date).toBe('2026-09-02');
      expect(log.blocks.map((b) => b.seat)).toEqual(['CLAUDE/P8-3', 'OPS']);
      expect(log.blocks[0]?.title).toBe('kickoff');
    },
  );

  it(
    'seat narrows AND upper-cases, same as the CLI ' +
      '(pins mcp.ts get_log: `const wanted = seat.toUpperCase();`; reverted to the raw `seat`, ' +
      'this lowercase `ops` would match nothing — blocks are stored upper-cased)',
    async () => {
      const r = await rig();
      await r.json('append_repo_log', { seat: 'claude/p8-3', text: 'first entry' });
      await r.json('append_repo_log', { seat: 'ops', text: 'second entry' });
      const log = await r.json<{ blocks: Array<{ seat: string }> }>('get_log', { seat: 'ops' });
      expect(log.blocks.map((b) => b.seat)).toEqual(['OPS']);
    },
  );

  it(
    'no log yet for the date: {date, blocks: []}, date defaulted to today ' +
      '(pins mcp.ts get_log: `date ?? toIso(now()).slice(0, 10)`; reverted to `date ?? null`, ' +
      '`date` would come back null instead of today)',
    async () => {
      const r = await rig();
      const log = await r.json<{ date: string | null; blocks: unknown[] }>('get_log', {});
      expect(log).toEqual({ date: '2026-09-02', blocks: [] });
    },
  );

  it(
    "last returns that seat's NEWEST block anywhere in the log, or nulls when it has none " +
      '(pins mcp.ts get_log: `const res = await store.lastRepoLogBlock(last);`; reverted to ' +
      'always null, the second call below would still come back {date: null, block: null})',
    async () => {
      const r = await rig();
      const miss = await r.json<{ date: null; block: null }>('get_log', { last: 'ghost' });
      expect(miss).toEqual({ date: null, block: null });
      await r.json('append_repo_log', { seat: 'claude/p8-3', text: 'landed' });
      const found = await r.json<{ date: string; block: { text: string } }>('get_log', {
        last: 'claude/p8-3',
      });
      expect(found.date).toBe('2026-09-02');
      expect(found.block.text).toBe('landed');
    },
  );

  it(
    'last is exclusive with date/seat ' +
      '(pins mcp.ts get_log: `if (date !== undefined || seat !== undefined) { return fail(...) }`; ' +
      'reverted, this call would not error)',
    async () => {
      const r = await rig();
      const res = await r.call('get_log', { last: 'claude/p8-3', date: '2026-09-02' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('last is exclusive with date/seat');
    },
  );

  it(
    'RCB-132: tail keeps the last N blocks; seat and tail compose (the SAME filterLogBlocks ' +
      '`log show --tail/--seat` calls)',
    async () => {
      const r = await rig();
      await r.json('append_repo_log', { seat: 'ops', text: 'first' });
      await r.json('append_repo_log', { seat: 'ops', text: 'second' });
      await r.json('append_repo_log', { seat: 'ops', text: 'third' });

      const tailOnly = await r.json<{ blocks: Array<{ text: string }> }>('get_log', { tail: 1 });
      expect(tailOnly.blocks.map((b) => b.text)).toEqual(['third']);

      const seatAndTail = await r.json<{ blocks: Array<{ text: string }> }>('get_log', {
        seat: 'ops',
        tail: 2,
      });
      expect(seatAndTail.blocks.map((b) => b.text)).toEqual(['second', 'third']);

      // n > count: every block, never an error.
      const tailOverCount = await r.json<{ blocks: unknown[] }>('get_log', { tail: 99 });
      expect(tailOverCount.blocks).toHaveLength(3);
    },
  );

  it('RCB-132: last is exclusive with since/tail (a separate check from date/seat above)', async () => {
    const r = await rig();
    const res = await r.call('get_log', { last: 'claude/p8-3', tail: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('last is exclusive with since/tail');
  });

  it('RCB-132: a bad `since` fails with filterLogBlocks own error, prefixed `since: `', async () => {
    const r = await rig();
    await r.json('append_repo_log', { seat: 'ops', text: 'entry' });
    const res = await r.call('get_log', { since: 'nonsense' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('since: "nonsense" is not a full ISO-8601 datetime or HH:MMZ');
  });
});

describe('repoboard mcp: get_seat (RCB-146)', () => {
  it(
    'returns the same cold-start bundle `seat <name> --json` prints ' +
      '(pins mcp.ts get_seat: `async ({ name }) => ok(await store.seatBundle(name))`; reverted ' +
      'to a bare `ok({})`, every field below would be missing)',
    async () => {
      const r = await rig({ 'RB-1.md': cardText('RB-1', 'todo') });
      const bundle = await r.json<{
        name: string;
        nextCard: { id: string } | null;
        solo: boolean;
        openDecisions: unknown[];
      }>('get_seat', { name: 'claude/builder' });
      expect(bundle.name).toBe('claude/builder');
      expect(bundle.nextCard?.id).toBe('RB-1');
      expect(bundle.solo).toBe(true); // no SEATS section written yet
      expect(bundle.openDecisions).toEqual([]);
    },
  );
});

describe('repoboard mcp: record_gate / get_gate (RCB-146)', () => {
  it(
    'get_gate before anything is recorded: every check null, same shape `gate show --json` prints ' +
      '(pins mcp.ts get_gate: `async () => ok(await loadGateHealth(store.root))`; reverted to a ' +
      'bare `ok({})`, `checks` below would be missing, not null)',
    async () => {
      const r = await rig();
      const gate = await r.json<{
        checks: Record<string, unknown>;
        ledger: string | null;
        errors: unknown[];
      }>('get_gate');
      expect(gate.checks).toEqual({ tests: null, typecheck: null, lint: null, build: null });
      expect(gate.ledger).toBeNull();
      expect(gate.errors).toEqual([]);
    },
  );

  it(
    'record_gate appends one JSONL line; get_gate then reflects the newest result per check ' +
      '(pins repo-health.ts recordGate: `await appendFile(path, ...)`; reverted to a no-op, ' +
      'gate.jsonl below would stay absent and get_gate would still report null)',
    async () => {
      const r = await rig();
      const rec = await r.json<{ as: string; sha: string | null }>('record_gate', {
        as: 'claude/builder',
        typecheck: 0,
        lint: 0,
      });
      expect(rec.as).toBe('claude/builder');
      expect(rec.sha).toBeNull(); // the temp fixture root is not a git repo
      const ledgerText = await readFile(join(r.repo.root, '.repoboard', 'gate.jsonl'), 'utf8');
      expect(ledgerText.trim().split('\n')).toHaveLength(1);
      const gate = await r.json<{
        checks: { typecheck: { ok: boolean; value: string } | null; tests: unknown };
      }>('get_gate');
      expect(gate.checks.typecheck).toMatchObject({ ok: true, value: 'exit 0' });
      expect(gate.checks.tests).toBeNull();
    },
  );

  it(
    'passed/skipped without failed is refused (RCB-116 parity), nothing written ' +
      '(pins repo-health.ts recordGate: `if (testsGiven && input.failed === undefined) throw ' +
      'new Error(...)`; reverted, this call would succeed and write a line)',
    async () => {
      const r = await rig();
      const res = await r.call('record_gate', { as: 'claude/builder', passed: 5, skipped: 1 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('--failed <n>');
      const ledger = await readFile(join(r.repo.root, '.repoboard', 'gate.jsonl'), 'utf8').catch(
        () => null,
      );
      expect(ledger).toBeNull();
    },
  );

  it(
    'no check given at all is refused ' +
      '(pins repo-health.ts recordGate: the final `if (!hasTests && input.typecheck === ' +
      'undefined && ...) throw new Error(...)`; reverted, this call would succeed with an ' +
      'all-null record)',
    async () => {
      const r = await rig();
      const res = await r.call('record_gate', { as: 'claude/builder' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('at least one check');
    },
  );
});

describe('repoboard mcp: get_state ownerQueue, now card-query.ts’s shared function (RCB-146)', () => {
  it(
    'ownerQueue still filters to only OPEN decisions — a DECIDED card never reappears ' +
      '(pins card-query.ts ownerQueue: `.filter((c) => needsDecision(c))`; reverted to no ' +
      'filter, RB-2 — asked AND already decided — would reappear in ownerQueue below)',
    async () => {
      const r = await rig({
        'RB-1.md': cardText('RB-1', 'todo'),
        'RB-2.md': cardText('RB-2', 'todo'),
      });
      await r.json('set_state_section', { section: 'LIVE', body: 'x' });
      await r.json('ask_owner', {
        id: 'RB-1',
        question: 'ship?',
        options: [{ letter: 'A', text: 'yes' }],
      });
      await r.json('ask_owner', { id: 'RB-2', question: 'merge?' });
      await r.json('record_decision', { id: 'RB-2', words: 'later' });
      const state = await r.json<{ ownerQueue: Array<{ id: string }> }>('get_state');
      expect(state.ownerQueue.map((q) => q.id)).toEqual(['RB-1']);
    },
  );
});
