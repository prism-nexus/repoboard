/** Wire contract, verbatim from BUILD-PLAN §3. The web never assumes more than this. */
import type {
  BoardConfig,
  Card,
  CardPatch,
  DecisionOption,
  Event,
  Lease,
  RepoSnapshot,
  StateSections,
  Window,
} from '@repoboard/core';

/**
 * P8.2: the whole of `.repoboard/leases.yml` plus which resources are currently stale and the
 * server's own clock, so a client renders staleness without trusting its own. Same shape as
 * `GET /api/leases`.
 */
export interface LeasesPayload {
  leases: Lease[];
  windows: Window[];
  stale: string[];
  now: string;
}

/**
 * P8.3: `GET /api/state`'s shape, and the `state` half of the WS snapshot. OWNER QUEUE is
 * generated fresh server-side from cards that need a decision every time this is sent — but the
 * web recomputes its OWN display list from the live `cards` it already has (P8.1's `needsDecision`
 * + `ownerQueueLine`), so a `card` message updating a decision does not need a fresh `state`
 * broadcast to stay accurate; `ownerQueue`/`text` here are for a plain HTTP/CLI/MCP caller.
 * `stamp`/`sections`/etc. are all `null` before any STATE.md exists.
 */
export interface StatePayload {
  stamp: string | null;
  actor: string | null;
  sections: StateSections | null;
  ownerQueue: Array<{ id: string; question: string; options: DecisionOption[] }>;
  text: string | null;
}

/** P8.3: one `.repoboard/log/<date>.md` file — the `log` half of the WS snapshot and messages. */
export interface LogPayload {
  date: string;
  text: string;
}

/**
 * P7.2: `hasBoard` is false when the served root has no `.repoboard/` — map-only mode. It is
 * optional here because it is an additive field: a payload without it is one that predates P7.2,
 * and the safe reading of "absent" is "there is a board", which shows everything rather than
 * silently hiding the board (CLAUDE.md: an unconfigured rule must be inert, not dangerous).
 *
 * P8.2: `leases` on the snapshot is optional the same way — absent means "no leases, no windows",
 * never a crash, so a mock or a pre-P8.2 payload still renders (the Now strip's quiet line).
 *
 * P8.3: `state`/`log` are optional the same way — absent means "nothing yet", never a crash.
 */
export type ServerMessage =
  | {
      type: 'snapshot';
      board: { config: BoardConfig; cards: Card[]; hasBoard?: boolean };
      repo: RepoSnapshot | null;
      leases?: LeasesPayload;
      state?: StatePayload;
      log?: LogPayload;
    }
  | { type: 'card'; card: Card }
  | { type: 'card:removed'; id: string }
  | { type: 'repo'; repo: RepoSnapshot }
  | { type: 'event'; event: Event }
  | { type: 'leases'; leases: LeasesPayload }
  | { type: 'state'; state: StatePayload }
  | { type: 'log'; date: string; text: string };

export type ClientMessage =
  | { type: 'card:move'; id: string; status: string }
  | { type: 'card:update'; id: string; patch: CardPatch };

export interface Transport {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  onMessage(msg: ServerMessage): void;
  onConnected(connected: boolean): void;
}

/** Something that opens a connection: the real socket (ws.ts) or the mock (mock/). */
export type TransportFactory = (handlers: TransportHandlers) => Transport;

export function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}
