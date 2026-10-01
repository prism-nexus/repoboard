import type { Card } from '@repoboard/core';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Lane } from '../store.js';

/**
 * RCB-151 step 3: a column flattened to DOM order — either a lane head or a card. `Board.tsx`
 * builds this the same way whether or not the column is virtualized, so the two paths share one
 * idea of "what row is at index i".
 */
export type Row =
  | { kind: 'lane'; key: string; lane: Lane }
  | { kind: 'card'; key: string; card: Card };

interface Props {
  rows: Row[];
  /** RCB-84: the shared scroller (`.board`) — a column is never its own scroller. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The dragged card's row id, if any — kept mounted outside the window (dnd-kit's
   * `activeNode`/keyboard sensor need it in the DOM even off-screen). */
  activeId: string | null;
  renderRow: (row: Row) => ReactNode;
  /** A row's height before anything of it has actually been measured. */
  estimate: (row: Row) => number;
}

/** Past each edge of the scroller's visible area, in px — a fast scroll or a keyboard move lands
 * on an already-mounted neighbour instead of a blank frame. */
const OVERSCAN_PX = 600;
/** jsdom has no layout: `.board`'s `clientHeight` reads 0 — this keeps the window sane there too. */
const FALLBACK_CLIENT_HEIGHT = 600;
/** `.column__cards`' own flex `gap` (RCB-84) — a virtualized column positions rows absolutely, so
 * the gap has to be added back by hand. */
const ROW_GAP_PX = 6;

/** Cumulative top offset of every row (index-aligned with `rows`), plus the box's total height —
 * a row's height comes from `heights` (measured) when there is one, else `estimate`. */
function layOut(
  rows: Row[],
  heights: ReadonlyMap<string, number>,
  estimate: (row: Row) => number,
): { offsets: number[]; total: number } {
  const offsets: number[] = new Array(rows.length);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    offsets[i] = y;
    y += (heights.get(row.key) ?? estimate(row)) + ROW_GAP_PX;
  }
  return { offsets, total: y };
}

/** The row indices whose box overlaps `[lo, hi]` (both in the column's own, scroll-position-
 * independent coordinates), as a half-open `[start, end)` — one forward scan; a column runs to a
 * few hundred rows at most, not thousands. */
function windowFor(offsets: number[], lo: number, hi: number): [number, number] {
  let start = 0;
  while (start < offsets.length - 1 && (offsets[start + 1] ?? Infinity) <= lo) start++;
  let end = start;
  while (end < offsets.length && (offsets[end] ?? Infinity) <= hi) end++;
  return [start, end];
}

/** RCB-151 step 3: hand-rolled virtualization for a column above `VIRTUALIZE_AT` (`Board.tsx`).
 * Renders a `position: relative` box (`.virtual-rows`, in `styles.css`) whose height is the sum of
 * every row; each mounted row is an absolutely-positioned wrapper (`.virtual-row`) at its own
 * offset, so rows stay in index order for Tab and for a11y even though only a slice is mounted. */
export function VirtualRows({ rows, scrollRef, activeId, renderRow, estimate }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const colTop = useRef(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  // The setter is the only thing this is for: forcing a re-render after a ResizeObserver
  // measurement changes a row's cached height (mutating the `Map` above is not, on its own, a
  // React dependency anything re-renders on).
  const [, forceMeasureRerender] = useState(0);

  // Cheap enough (a column runs to a few hundred rows) to recompute every render rather than
  // fight a memo over a `Map` ref it can't see into.
  const { offsets, total } = layOut(rows, heights.current, estimate);

  const updateRange = () => {
    const board = scrollRef.current;
    const clientHeight = (board?.clientHeight ?? 0) || FALLBACK_CLIENT_HEIGHT;
    const scrollTop = board?.scrollTop ?? 0;
    const lo = scrollTop - colTop.current - OVERSCAN_PX;
    const hi = scrollTop + clientHeight - colTop.current + OVERSCAN_PX;
    const [start, end] = windowFor(offsets, lo, hi);
    setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
  };
  // A ref to the latest `updateRange` closure: the scroll listener and the ResizeObserver below
  // are wired up once (mount-only effect) and must still see this render's `offsets`/`total`.
  const updateRangeRef = useRef(updateRange);
  updateRangeRef.current = updateRange;

  // RCB-151 step 3 design: "search/filter change rows: clamp start to the new length" — a row
  // count changing (not just reordering) is the case an old `range` can point past the end of.
  // React's supported "adjust state while rendering" pattern: compared against a ref of the last
  // seen count, and guarded so it fires at most once per actual change, not an effect at all.
  const lastRowCount = useRef(rows.length);
  if (lastRowCount.current !== rows.length) {
    lastRowCount.current = rows.length;
    updateRange();
  }

  // Paint-blocking only: gives the first frame a sane window instead of a blank one.
  // `scrollRef.current` (`.board`) is not yet attached here — React commits refs and layout
  // effects bottom-up, so an ancestor host element's ref attaches AFTER this descendant's layout
  // effect runs — but `updateRange` already falls back to FALLBACK_CLIENT_HEIGHT / colTop 0 when
  // `board` is null, so this still lands a real window. The subscription below (which needs
  // `board`) is wired up in a passive effect instead.
  useLayoutEffect(() => {
    updateRangeRef.current();
  }, []);

  // RCB-151 step 3 fix: this was a `useLayoutEffect`, so it ran before React attached `.board`'s
  // ref (see the layout effect above) — `scrollRef.current` was null, the `if (!board) return`
  // bailed, and the scroll listener/ResizeObserver were never attached (mount-only deps, so it
  // never retried). A passive effect runs only after every ref in the commit — including
  // ancestors' — has been attached, so `board` is guaranteed non-null by the time this runs.
  useEffect(() => {
    // Local to this one effect instance (it only runs once, on mount): colTop cancels the
    // current scroll back out, so it is the column's position in the board's UNSCROLLED content
    // — measured here and on a board resize, not on every scroll frame, where it would be
    // invariant in a real browser anyway.
    const measureColTop = () => {
      const board = scrollRef.current;
      const box = boxRef.current;
      if (!board || !box) return;
      colTop.current =
        box.getBoundingClientRect().top - board.getBoundingClientRect().top + board.scrollTop;
    };
    const board = scrollRef.current;
    measureColTop();
    updateRangeRef.current();
    if (!board) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateRangeRef.current();
      });
    };
    board.addEventListener('scroll', onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measureColTop();
        updateRangeRef.current();
      });
      ro.observe(board);
    }
    return () => {
      board.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [scrollRef]);

  // One ResizeObserver per column, observing every currently-mounted row wrapper; heights are
  // cached by row KEY (a card's id), so a sort reuses what was already measured for it.
  const rowRO = useRef<ResizeObserver | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    rowRO.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target instanceof HTMLElement ? entry.target.dataset.rowKey : undefined;
        if (!key) continue;
        const h = Math.round(entry.contentRect.height);
        if (h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) forceMeasureRerender((t) => t + 1);
    });
    return () => rowRO.current?.disconnect();
  }, []);

  const observeRow = (row: Row) => (el: HTMLDivElement | null) => {
    const prev = rowEls.current.get(row.key);
    if (prev && prev !== el) rowRO.current?.unobserve(prev);
    if (el) {
      rowEls.current.set(row.key, el);
      rowRO.current?.observe(el);
    } else {
      rowEls.current.delete(row.key);
    }
  };

  // The window, plus the dragged card's row wherever it actually is — RCB-151 step 3's control:
  // drop this and a card being dragged off-screen unmounts, which stops dnd-kit's auto-scroll and
  // loses the keyboard sensor's focus.
  const visible: number[] = [];
  for (let i = range[0]; i < range[1]; i++) visible.push(i);
  if (activeId !== null) {
    const activeIndex = rows.findIndex((r) => r.key === activeId);
    if (activeIndex >= 0 && (activeIndex < range[0] || activeIndex >= range[1])) {
      visible.push(activeIndex);
      visible.sort((a, b) => a - b);
    }
  }

  return (
    <div ref={boxRef} className="virtual-rows" style={{ height: total }}>
      {visible.map((i) => {
        const row = rows[i];
        if (!row) return null;
        return (
          <div
            key={row.key}
            ref={observeRow(row)}
            className="virtual-row"
            data-row-key={row.key}
            style={{ top: offsets[i] ?? 0 }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
