import type { Card } from '@repoboard/core';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { State, Store } from './store.js';

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside <StoreContext.Provider>');
  return store;
}

/** The whole state object; it is replaced immutably so this is a stable snapshot. */
export function useBoardState(): State {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** A clock that ticks every `intervalMs`, so "active" rings and "2m ago" labels age out. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface Arrival {
  /** -1 moved left, +1 moved right, 0 unknown column. */
  dir: -1 | 0 | 1;
  toActive: boolean;
  toDone: boolean;
}

export interface Arrivals {
  byId: ReadonlyMap<string, Arrival>;
  /** Increments every time a card lands in a `done` column — the confetti trigger. */
  doneBurst: number;
}

export const ARRIVAL_MS = 700;

/**
 * Detect cards whose column changed since the previous render, for the fun layer.
 * Entries expire after ARRIVAL_MS. The first render seeds without animating.
 */
export function useArrivals(
  cards: Card[],
  columnIndex: (status: string) => number,
  isActiveColumn: (status: string) => boolean,
  isDoneColumn: (status: string) => boolean,
): Arrivals {
  const prev = useRef<Map<string, string> | null>(null);
  const [arrivals, setArrivals] = useState<Arrivals>({ byId: new Map(), doneBurst: 0 });

  useEffect(() => {
    const next = new Map(cards.map((c) => [c.id, c.status] as const));
    const before = prev.current;
    prev.current = next;
    if (!before) return;
    const changed = new Map<string, Arrival>();
    let landedDone = 0;
    for (const c of cards) {
      const was = before.get(c.id);
      if (was === undefined || was === c.status) continue;
      const a = columnIndex(was);
      const b = columnIndex(c.status);
      const dir: Arrival['dir'] = a < 0 || b < 0 ? 0 : b > a ? 1 : b < a ? -1 : 0;
      const toDone = isDoneColumn(c.status) && !isDoneColumn(was);
      if (toDone) landedDone++;
      changed.set(c.id, { dir, toActive: isActiveColumn(c.status), toDone });
    }
    if (changed.size === 0) return;
    setArrivals((s) => ({ byId: changed, doneBurst: s.doneBurst + landedDone }));
    const id = setTimeout(
      () => setArrivals((s) => ({ byId: new Map(), doneBurst: s.doneBurst })),
      ARRIVAL_MS,
    );
    return () => clearTimeout(id);
  }, [cards, columnIndex, isActiveColumn, isDoneColumn]);

  return arrivals;
}
