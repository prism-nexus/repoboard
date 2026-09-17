/**
 * Mock transport: a fake board plus fake WS events on a timer, so `VITE_MOCK=1 pnpm dev`
 * runs with no server. Also what tests use (with `tick: null` for full control).
 */
import { appendLogLine, type Card, type Event, findColumn, formatLogLine } from '@repoboard/core';
import type { ServerMessage, Transport, TransportFactory, TransportHandlers } from '../wire.js';
import { MOCK_ACTORS, mockCards, mockConfig, mockRepo } from './data.js';

export interface MockOptions {
  /** Interval between fake events in ms; `null` emits nothing on its own. */
  tick?: number | null;
  /** Round-trip delay before a client message is echoed back. */
  echoMs?: number;
  /** Seed for the deterministic PRNG driving random moves. */
  seed?: number;
  /** Set to true to make a `card:move` never echo (exercise the snap-back). */
  dropEchoes?: boolean;
}

export interface MockTransport extends Transport {
  /** Push any server message, as if the socket delivered it. */
  emit(msg: ServerMessage): void;
  cards(): Card[];
}

export interface MockFactory extends TransportFactory {
  /** The most recently opened transport, so tests and the console can poke it. */
  last: MockTransport | null;
}

export function createMockTransport(options: MockOptions = {}): MockFactory {
  const factory: MockFactory = Object.assign(
    (handlers: TransportHandlers) => {
      const t = openMock(handlers, options);
      factory.last = t;
      return t;
    },
    { last: null as MockTransport | null },
  );
  return factory;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function openMock(handlers: TransportHandlers, options: MockOptions): MockTransport {
  const { tick = 4000, echoMs = 250, seed = 7, dropEchoes = false } = options;
  const rand = mulberry32(seed);
  const config = mockConfig();
  let cards = mockCards();
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!closed) fn();
    }, ms);
    timers.add(id);
  };

  const emit = (msg: ServerMessage) => {
    if (!closed) handlers.onMessage(msg);
  };

  const iso = () => new Date().toISOString();

  const move = (id: string, status: string, actor: string, note?: string) => {
    const card = cards.find((c) => c.id === id);
    if (!card || card.status === status) return;
    const from = card.status;
    const ts = iso();
    const line = formatLogLine(ts, actor, note ?? `moved ${from} → ${status}`);
    const next: Card = { ...card, status, updated: ts, body: appendLogLine(card.body, line) };
    cards = cards.map((c) => (c.id === id ? next : c));
    emit({ type: 'card', card: next });
    const event: Event = { ts, actor, type: 'move', cardId: id, from, to: status };
    emit({ type: 'event', event });
  };

  const touch = (id: string, actor: string, note: string) => {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const ts = iso();
    const next: Card = {
      ...card,
      updated: ts,
      body: appendLogLine(card.body, formatLogLine(ts, actor, note)),
    };
    cards = cards.map((c) => (c.id === id ? next : c));
    emit({ type: 'card', card: next });
  };

  const NOTES = [
    'tests green',
    'typecheck 0',
    'refactored the parser',
    'wrote the brief',
    'lint clean',
  ];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;

  const step = () => {
    const columns = config.columns.map((c) => c.id);
    const r = rand();
    if (r < 0.55) {
      // Nudge a card one column forward. Cards sitting on an open decision (the `decision: true`
      // column) are left alone — that is the owner's move, not the demo stepper's.
      const movable = cards.filter(
        (c) => !findColumn(config, c.status)?.done && !findColumn(config, c.status)?.decision,
      );
      const card = pick(movable);
      const idx = columns.indexOf(card.status);
      const to = columns[Math.min(columns.length - 1, idx + 1)];
      if (to) move(card.id, to, card.assignee ?? pick(MOCK_ACTORS));
    } else {
      const active = cards.filter((c) => findColumn(config, c.status)?.active);
      if (active.length) {
        const card = pick(active);
        touch(card.id, card.assignee ?? pick(MOCK_ACTORS), pick(NOTES));
      }
    }
    if (tick !== null) later(tick + rand() * tick * 0.5, step);
  };

  later(0, () => {
    handlers.onConnected(true);
    emit({ type: 'snapshot', board: { config, cards, hasBoard: true }, repo: mockRepo() });
    // A little history so the ticker has something to say.
    const now = Date.now();
    const history: Array<[string, string, string, string, number]> = [
      ['claude/core-agent', 'RB-3', 'doing', 'done', 120],
      ['claude/orchestrator', 'RB-7', 'todo', 'doing', 40],
      ['claude/orchestrator', 'RB-12', 'todo', 'doing', 35],
      ['claude/web-agent', 'RB-13', 'doing', 'decide', 25],
    ];
    for (const [actor, cardId, from, to, ago] of history) {
      emit({
        type: 'event',
        event: {
          ts: new Date(now - ago * 60_000).toISOString(),
          actor,
          type: 'move',
          cardId,
          from,
          to,
        },
      });
    }
    if (tick !== null) later(tick, step);
  });

  return {
    emit,
    cards: () => cards,
    send(msg) {
      if (dropEchoes) return;
      later(echoMs, () => {
        if (msg.type === 'card:move') move(msg.id, msg.status, 'you');
        else if (msg.type === 'card:update') {
          const card = cards.find((c) => c.id === msg.id);
          if (!card) return;
          const next: Card = { ...card, updated: iso() };
          for (const [k, v] of Object.entries(msg.patch)) {
            if (v === null) delete next[k];
            else if (v !== undefined) next[k] = v;
          }
          cards = cards.map((c) => (c.id === msg.id ? next : c));
          emit({ type: 'card', card: next });
        }
      });
    },
    close() {
      closed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      handlers.onConnected(false);
    },
  };
}
