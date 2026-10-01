/**
 * RCB-152: a minimal MCP server + stdio transport, replacing `@modelcontextprotocol/sdk` at
 * runtime. `mcp.ts` calls only `McpServer.registerTool` (same signature the SDK's `McpServer`
 * takes), `connect`/`close`/`server.onclose`, and `StdioServerTransport`. This file implements
 * just that surface, for exactly the methods repoboard's MCP server answers: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Every other method (resources,
 * prompts, logging, completion, anything unknown) is `-32601 Method not found`, since this server
 * never registers those capabilities — the same outcome the SDK produces for an unregistered
 * handler (`shared/protocol.js`'s `_onrequest`, `handler === undefined` branch).
 *
 * Golden behaviour recorded against SDK 1.30 (2026-09-25): `.repoboard/local/wip/rcb152/
 * {req,resp}.jsonl`. Error texts below (`Tool X not found`, `Input validation error: Invalid
 * arguments for tool X: …`, `Method not found`, the `MCP error <code>: ` prefix) are copied
 * verbatim from `@modelcontextprotocol/sdk`'s `server/mcp.js` and `types.js` (see the SDK's
 * `McpError` constructor and `McpServer.setToolRequestHandlers`), not paraphrased. The
 * `getDotPath`/`getParseErrorMessage` pair mirrors `server/zod-compat.js` so a zod validation
 * failure reads exactly like the SDK's.
 *
 * The transport type (`RpcTransport`) is structural, not imported from the SDK: it is accepted by
 * — and accepts — the SDK's `InMemoryTransport`, so `test/mcp.test.ts` keeps driving this server
 * with the SDK's own `Client` over an in-memory pair without depending on the SDK at runtime.
 */
import { z } from 'zod';

/** The only content shape this server ever returns (mirrors the SDK's `CallToolResult`, the one
 * piece of SDK-authored surface `mcp.ts` still names as a type). */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** A JSON-RPC 2.0 message: request, notification, result or error — modelled as four separate
 * shapes (not one loose object) so the union is structurally compatible with the SDK's own
 * `JSONRPCMessage` (`shared/transport.d.ts`) in both directions: assignable to it (this server can
 * `send` on an SDK transport) and from it (this server can receive from one). That is what lets
 * `RpcTransport` below accept `InMemoryTransport` without an SDK import — a single object type
 * with every field optional is NOT interchangeable with the SDK's discriminated union (a request's
 * `method` is required, a notification carries no `id`, and so on). */
export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcResult {
  jsonrpc: '2.0';
  id: string | number;
  result: Record<string, unknown>;
}
export interface RpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}
export type RpcMessage = RpcRequest | RpcNotification | RpcResult | RpcErrorResponse;

/** The minimal contract this server needs from a transport — a subset of the SDK's `Transport`
 * interface, structurally compatible with it (see the file comment). */
export interface RpcTransport {
  start(): Promise<void>;
  send(message: RpcMessage, options?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: RpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

/** Copied from the SDK's `types.js`: the versions this server accepts verbatim in `initialize`,
 * plus the version it falls back to for anything else (including nothing usable at all). */
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors `server/zod-compat.js`'s `getDotPath`: turns a zod issue path into `a.b[0]` form. */
function getDotPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'object root';
  return path.reduce<string>((acc, seg, index) => {
    if (index === 0) return String(seg);
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return `${acc}.${String(seg)}`;
  }, '');
}

/** Mirrors `server/zod-compat.js`'s `getParseErrorMessage`: one line per issue, `message` then
 * ` at <path>` when the issue has one, joined with `\n` — the exact text the SDK puts in a failed
 * tool call's `isError` content. */
function getParseErrorMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.message} at ${getDotPath(issue.path)}`,
    )
    .join('\n');
}

interface RegisteredTool {
  title?: string;
  description?: string;
  /** Present even when the shape has zero keys (`inputSchema: {}`); absent (not just empty) is
   * what makes `tools/list` report the bare `{type:'object',properties:{}}` the SDK's
   * `EMPTY_OBJECT_JSON_SCHEMA` produces for a tool registered with no `inputSchema` at all. */
  schema?: z.ZodType;
  inputSchemaJson: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: unknown) => CallToolResult | Promise<CallToolResult>;
}

/** `EMPTY_OBJECT_JSON_SCHEMA` in the SDK's `server/mcp.js`: no `$schema`, unlike a registered
 * empty shape (`z.toJSONSchema(z.object({}), …)`), which does carry one. */
const EMPTY_OBJECT_JSON_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerOptions {
  instructions?: string;
}

/**
 * A minimal stand-in for the SDK's `McpServer`: only `registerTool`, `connect`, `close`, and the
 * nested `.server.onclose` `mcp.ts`'s `serveMcp` reads. `registerTool`'s signature — a config
 * object with `title`/`description`/`inputSchema`/`annotations` plus a handler taking the parsed
 * args — is unchanged from the SDK's, so the 29 registrations in `mcp.ts` needed no edits.
 */
export class McpServer {
  private readonly tools = new Map<string, RegisteredTool>();
  private transport: RpcTransport | undefined;
  /** `mcp.ts`'s `serveMcp` sets `server.server.onclose` before `connect()` and reads it only when
   * the transport actually closes, so a plain mutable holder is enough — no need to reproduce the
   * SDK's full `Server`/`Protocol` split. */
  readonly server: { onclose?: () => void } = {};

  constructor(
    private readonly info: McpServerInfo,
    private readonly options: McpServerOptions = {},
  ) {}

  registerTool<Shape extends z.ZodRawShape = z.ZodRawShape>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Shape;
      annotations?: Record<string, unknown>;
    },
    handler: (args: z.infer<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>,
  ): void {
    const schema = config.inputSchema === undefined ? undefined : z.object(config.inputSchema);
    const inputSchemaJson =
      schema === undefined
        ? EMPTY_OBJECT_JSON_SCHEMA
        : (z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>);
    this.tools.set(name, {
      title: config.title,
      description: config.description,
      schema,
      inputSchemaJson,
      annotations: config.annotations,
      handler: handler as (args: unknown) => CallToolResult | Promise<CallToolResult>,
    });
  }

  async connect(transport: RpcTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => this.handleMessage(message);
    transport.onclose = () => this.server.onclose?.();
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  private handleMessage(raw: unknown): void {
    if (!isRecord(raw)) return;
    const method = raw['method'];
    if (typeof method !== 'string') return;
    const id = raw['id'];
    // No `id`: a notification (`notifications/initialized`, `notifications/cancelled`, …) — the
    // SDK never replies to one, and neither do we.
    if (id === undefined) return;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    void this.dispatch(id, method, raw['params']).then((response) =>
      this.transport?.send(response),
    );
  }

  private async dispatch(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<RpcMessage> {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: this.handleInitialize(params) };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.listTools() } };
      case 'tools/call':
        // `CallToolResult` is a closed interface (no index signature), so it needs an explicit
        // widen to the `Record<string, unknown>` `RpcResult.result` carries — the values are the
        // same object either way.
        return {
          jsonrpc: '2.0',
          id,
          result: (await this.callTool(params)) as unknown as Record<string, unknown>,
        };
      default:
        // Every method this server does not implement (resources/prompts/logging/completion, or
        // anything unrecognised) — matches the SDK's fallback for an unregistered handler.
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
  }

  private handleInitialize(params: unknown): Record<string, unknown> {
    const requested = isRecord(params) ? params['protocolVersion'] : undefined;
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: this.info.name, version: this.info.version },
      ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
    };
  }

  private listTools(): Array<Record<string, unknown>> {
    return [...this.tools.entries()].map(([name, tool]) => ({
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchemaJson,
      annotations: tool.annotations,
      // The SDK's `registerTool` always installs `{taskSupport:'forbidden'}` regardless of what
      // the caller passes (`_createRegisteredTool` hardcodes it) — `mcp.ts` never asks for task
      // support, so this is the only value ever produced.
      execution: { taskSupport: 'forbidden' },
    }));
  }

  private async callTool(paramsRaw: unknown): Promise<CallToolResult> {
    const params = isRecord(paramsRaw) ? paramsRaw : {};
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    try {
      const tool = this.tools.get(name);
      if (!tool) {
        // Copied verbatim from the SDK's `McpServer.setToolRequestHandlers`.
        throw new Error(`MCP error -32602: Tool ${name} not found`);
      }
      let args: unknown;
      if (tool.schema) {
        const argsInput = params['arguments'] ?? {};
        const parsed = await tool.schema.safeParseAsync(argsInput);
        if (!parsed.success) {
          const message = getParseErrorMessage(parsed.error);
          // Copied verbatim from the SDK's `McpServer.validateToolInput`.
          throw new Error(
            `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${message}`,
          );
        }
        args = parsed.data;
      }
      return await tool.handler(args);
    } catch (e) {
      // Mirrors the SDK's `setToolRequestHandlers` catch: any error from lookup, validation or
      // the handler itself becomes an `isError` result, never a JSON-RPC-level error.
      const text = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
}

class ReadBuffer {
  private buffer: Buffer | undefined;

  append(chunk: Buffer): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
  }

  /** One line at a time, `\n`-delimited (a trailing `\r` stripped), matching the SDK's
   * `shared/stdio.js` `ReadBuffer`. */
  readLine(): string | null {
    if (!this.buffer) return null;
    const index = this.buffer.indexOf('\n');
    if (index === -1) return null;
    const line = this.buffer.toString('utf8', 0, index).replace(/\r$/, '');
    this.buffer = this.buffer.subarray(index + 1);
    return line;
  }

  clear(): void {
    this.buffer = undefined;
  }
}

/**
 * Newline-delimited JSON on stdin/stdout — stdout carries only the protocol (see `mcp.ts`'s file
 * comment). A line that fails `JSON.parse` is dropped silently: the SDK's own `ReadBuffer` already
 * advances past a bad line before its parse throws (the buffer is sliced before
 * `deserializeMessage` runs), so a malformed line never wedges the stream and never gets a reply —
 * reproduced here directly rather than through a try/catch around a shared slice-then-parse step.
 */
export class StdioServerTransport implements RpcTransport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;

  onmessage?: (message: RpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private readonly ondata = (chunk: Buffer): void => {
    this.readBuffer.append(chunk);
    for (;;) {
      const line = this.readBuffer.readLine();
      if (line === null) break;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(message)) this.onmessage?.(message as unknown as RpcMessage);
    }
  };

  private readonly onstdinerror = (error: Error): void => {
    this.onerror?.(error);
  };

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        'StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.',
      );
    }
    this.started = true;
    process.stdin.on('data', this.ondata);
    process.stdin.on('error', this.onstdinerror);
  }

  async close(): Promise<void> {
    process.stdin.off('data', this.ondata);
    process.stdin.off('error', this.onstdinerror);
    if (process.stdin.listenerCount('data') === 0) process.stdin.pause();
    this.readBuffer.clear();
    this.onclose?.();
  }

  send(message: RpcMessage): Promise<void> {
    return new Promise((resolve) => {
      const json = `${JSON.stringify(message)}\n`;
      if (process.stdout.write(json)) resolve();
      else process.stdout.once('drain', resolve);
    });
  }
}
