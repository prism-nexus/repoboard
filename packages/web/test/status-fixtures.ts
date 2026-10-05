/**
 * RCB-218: fixtures for the Board's new top (status line, Seats, Landed, Owner queue). `helpers.tsx`'s
 * positional `snapshot()` cannot carry the `seats`/`landings` payloads without growing a seventh and
 * eighth optional argument, so `sendSnapshot` takes one options object instead.
 */
import { type BoardConfig, type Card, defaultBoardConfig, type Event } from '@repoboard/core';
import type { Store } from '../src/store.js';
import type {
  LandingRow,
  LandingsPayload,
  LeasesPayload,
  LogPayload,
  SeatRowPayload,
  StatePayload,
} from '../src/wire.js';

/** The pinned clock of every test in the RCB-218 files. */
export const NOW_ISO = '2026-09-02T22:41:10Z';

/** An UP builder, alive, up 12 minutes before `NOW_ISO` — override what a test is about. */
export function seatRow(over: Partial<SeatRowPayload> = {}): SeatRowPayload {
  return {
    name: 'builder',
    home: null,
    status: 'UP',
    at: '2026-09-02T22:29:00Z',
    tag: 'A7B2',
    label: 'A7B2 · acme builder',
    live: 'alive',
    inFlight: 'none',
    owes: 'none',
    ...over,
  };
}

export function landingRow(cardId: string, shas: string[] = ['a1c94e2']): LandingRow {
  return {
    cardId,
    commits: shas.map((sha) => ({
      sha,
      at: '2026-09-02T22:11:00Z',
      author: 'builder',
      subject: `${cardId}: the work behind ${sha}`,
    })),
  };
}

export function landingsPayload(
  rows: LandingRow[],
  over: Partial<LandingsPayload> = {},
): LandingsPayload {
  return {
    rows,
    web: 'https://github.com/acme/demo',
    source: 'git log HEAD, last 14 days',
    ...over,
  };
}

export function seatEvent(actor: string, to: 'UP' | 'DOWN', ts: string, resource?: string): Event {
  return {
    ts,
    actor,
    type: 'seat',
    cardId: null,
    from: null,
    to,
    ...(resource ? { resource } : {}),
  };
}

type Decision = NonNullable<Card['decision']>;

/** An open (unanswered) decision on a card — the Owner queue's input. */
export function openDecision(question = 'Ship it?', over: Partial<Decision> = {}): Decision {
  return {
    question,
    options: [
      { letter: 'A', text: 'yes, ship now' },
      { letter: 'B', text: 'no, wait' },
    ],
    askedBy: 'claude/agent',
    askedAt: '2026-09-02T22:00:00Z',
    returnTo: 'todo',
    chosen: null,
    words: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

export interface SnapshotOptions {
  cards?: Card[];
  config?: BoardConfig;
  seats?: SeatRowPayload[];
  landings?: LandingsPayload;
  state?: StatePayload;
  leases?: LeasesPayload;
  log?: LogPayload;
}

/** A snapshot carrying exactly the fields given — an absent one is absent on the wire, as it is
 * from a server that predates it. */
export function sendSnapshot(store: Store, o: SnapshotOptions = {}): void {
  store.dispatch({
    type: 'snapshot',
    board: { config: o.config ?? defaultBoardConfig(), cards: o.cards ?? [], hasBoard: true },
    repo: null,
    ...(o.state ? { state: o.state } : {}),
    ...(o.leases ? { leases: o.leases } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.seats ? { seats: o.seats } : {}),
    ...(o.landings ? { landings: o.landings } : {}),
  });
}
