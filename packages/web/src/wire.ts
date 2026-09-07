/** Wire contract, verbatim from BUILD-PLAN §3. The web never assumes more than this. */
import type { BoardConfig, Card, CardPatch, Event, RepoSnapshot } from '@repoboard/core';

/**
 * P7.2: `hasBoard` is false when the served root has no `.repoboard/` — map-only mode. It is
 * optional here because it is an additive field: a payload without it is one that predates P7.2,
 * and the safe reading of "absent" is "there is a board", which shows everything rather than
 * silently hiding the board (CLAUDE.md: an unconfigured rule must be inert, not dangerous).
 */
export type ServerMessage =
  | {
      type: 'snapshot';
      board: { config: BoardConfig; cards: Card[]; hasBoard?: boolean };
      repo: RepoSnapshot | null;
    }
  | { type: 'card'; card: Card }
  | { type: 'card:removed'; id: string }
  | { type: 'repo'; repo: RepoSnapshot }
  | { type: 'event'; event: Event };

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
