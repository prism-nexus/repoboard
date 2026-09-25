/**
 * RCB-152: replays the golden MCP session recorded against `@modelcontextprotocol/sdk` 1.30
 * (`test/fixtures/mcp-session/{req,resp}.jsonl`, board `test/fixtures/mcp-session/board/`) through
 * `createMcpServer` from `../src/mcp.js`, over `mcp-rpc.ts`'s own `RpcTransport` — never the SDK's
 * `InMemoryTransport` (this is the "no SDK at runtime" path; `mcp.test.ts` still exercises the SDK
 * `Client` against this same server for the ordinary tool-by-tool coverage).
 *
 * This is a CONTROL, not just a snapshot: each golden response encodes a specific piece of
 * behaviour — initialize's protocol-version fallback, `tools/list`'s 30-tool shape (id 3 alone
 * re-recorded from this server at RCB-129/131/132: a tool added, four descriptions changed), the
 * exact `MCP error -32602: …` text for an unknown tool and for bad `move_card` args, `-32601 Method not
 * found` for everything this server does not implement, and silence for every notification and the
 * one malformed line. Changing an error string in `mcp-rpc.ts` desyncs it from the recording and
 * fails this test (see the report on RCB-152's card for the perturbation actually run).
 */
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import type { RpcMessage, RpcTransport } from '../src/mcp-rpc.js';
import { openStore } from '../src/store.js';
import { makeTempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'mcp-session');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A minimal in-memory `RpcTransport` pair — this repo's own replacement for the SDK's
 * `InMemoryTransport`, since the point of RCB-152 is that nothing here depends on the SDK. */
function linkedPair(): [RpcTransport, RpcTransport] {
  const a: RpcTransport = {
    start: async () => {},
    close: async () => {
      b.onclose?.();
    },
    send: async (message) => {
      b.onmessage?.(message);
    },
  };
  const b: RpcTransport = {
    start: async () => {},
    close: async () => {
      a.onclose?.();
    },
    send: async (message) => {
      a.onmessage?.(message);
    },
  };
  return [a, b];
}

/** Deep-equal after JSON round-trip, `serverInfo.version` ignored (the brief's own comparison
 * rule: this server's version drifts from whatever the golden was recorded with). */
function normalize(message: RpcMessage): unknown {
  const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const result = clone['result'];
  if (result && typeof result === 'object') {
    const serverInfo = (result as Record<string, unknown>)['serverInfo'];
    if (serverInfo && typeof serverInfo === 'object') {
      (serverInfo as Record<string, unknown>)['version'] = 'IGNORED';
    }
  }
  return clone;
}

describe('repoboard mcp: replay against the SDK 1.30 golden (RCB-152)', () => {
  it('every response deep-equals the golden, by id; every silent id stays silent', async () => {
    const root = await makeTempDir('repoboard-mcp-replay-');
    cleanups.push(() => Promise.resolve());
    await mkdir(join(root, '.repoboard'), { recursive: true });
    await cp(join(fixtureDir, 'board'), join(root, '.repoboard'), { recursive: true });

    const store = await openStore(root, { watch: false });
    cleanups.push(() => store.close());
    const server = createMcpServer({ store, defaultActor: 'test/mcp-replay' });
    const [clientTransport, serverTransport] = linkedPair();
    await server.connect(serverTransport);
    cleanups.push(() => server.close());

    const reqText = await readFile(join(fixtureDir, 'req.jsonl'), 'utf8');
    const reqLines = reqText.split('\n').filter((l) => l.trim().length > 0);
    const respText = await readFile(join(fixtureDir, 'resp.jsonl'), 'utf8');
    const golden: RpcMessage[] = respText
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RpcMessage);
    const goldenIds = golden.map((m) => ('id' in m ? m.id : undefined));

    const responses: RpcMessage[] = [];
    const allReplied = new Promise<void>((resolve) => {
      clientTransport.onmessage = (message) => {
        responses.push(message);
        if (responses.length >= golden.length) resolve();
      };
    });

    let unparseableLines = 0;
    for (const line of reqLines) {
      // The one deliberately malformed line (`not json`) can't even be constructed as an
      // `RpcMessage` to hand this in-memory pair — it never reaches `McpServer` at all here.
      // That line's actual handling (a real wire byte stream, no reply, no crash) is
      // `StdioServerTransport`'s job, not `McpServer`'s; it's covered by the CLI replay in
      // RCB-152's report (`node dist/cli.js mcp --root <copy>` piped `req.jsonl` verbatim), not
      // by this in-process test. Counting it here just keeps the "12 of 15" arithmetic honest.
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        unparseableLines += 1;
        continue;
      }
      await clientTransport.send(message);
    }
    expect(unparseableLines).toBe(1);
    // Every request that gets a reply produces one synchronously-enqueued response; this resolves
    // once as many replies have arrived as the golden recorded (12 of the 15 lines — three are
    // notifications or the one malformed line, and get none).
    await allReplied;

    const gotById = new Map(responses.map((m) => [('id' in m ? m.id : undefined) as unknown, m]));
    expect(gotById.size).toBe(golden.length);
    expect([...gotById.keys()].sort()).toEqual([...goldenIds].sort());

    for (const want of golden) {
      const id = 'id' in want ? want.id : undefined;
      const got = gotById.get(id);
      expect(got, `no response for id ${String(id)}`).toBeDefined();
      expect(normalize(got as RpcMessage), `id ${String(id)}`).toEqual(normalize(want));
    }
  });
});
