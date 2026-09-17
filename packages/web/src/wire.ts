/** Wire contract, verbatim from BUILD-PLAN §3. The web never assumes more than this. */
import type {
  BoardConfig,
  Card,
  CardPatch,
  Event,
  Lease,
  RepoSnapshot,
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
 * P7.2: `hasBoard` is false when the served root has no `.repoboard/` — map-only mode. It is
 * optional here because it is an additive field: a payload without it is one that predates P7.2,
 * and the safe reading of "absent" is "there is a board", which shows everything rather than
 * silently hiding the board (CLAUDE.md: an unconfigured rule must be inert, not dangerous).
 *
 * P8.2: `leases` on the snapshot is optional the same way — absent means "no leases, no windows",
 * never a crash, so a mock or a pre-P8.2 payload still renders (the Now strip's quiet line).
 */
export type ServerMessage =
  | {
      type: 'snapshot';
      board: { config: BoardConfig; cards: Card[]; hasBoard?: boolean };
      repo: RepoSnapshot | null;
      leases?: LeasesPayload;
    }
  | { type: 'card'; card: Card }
  | { type: 'card:removed'; id: string }
  | { type: 'repo'; repo: RepoSnapshot }
  | { type: 'event'; event: Event }
  | { type: 'leases'; leases: LeasesPayload };

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
