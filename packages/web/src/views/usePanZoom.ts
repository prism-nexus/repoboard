/**
 * RCB-174: pan/zoom for the Flow canvas. Hand-rolled, no dependency (plan Q2), modelled on
 * `Graph.tsx`'s wheel zoom (about the cursor, native non-passive listener) and its
 * background-drag pan — but kept here, not shared: Graph is not refactored.
 *
 * The transform is `translate(x y) scale(k)` on ONE inner `<g>`; `x`/`y` are the screen offset of
 * the content's origin inside the element, so a content point `c` sits at `c * k + (x, y)`.
 *
 * Gestures: plain wheel = zoom about the cursor (as Graph does; a trackpad pinch arrives as a
 * ctrl+wheel and zooms faster); drag = pan, wherever it starts, and a drag that moved more than
 * the click slop swallows the click that follows it, so it never selects the box it ended on;
 * two pointers = pinch (zoom about the midpoint, and the midpoint pans). Zoom is clamped to
 * `MIN_K`..`MAX_K`. The pure helpers below carry the arithmetic so it can be tested without a DOM.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_SIZE, type Size } from '../map/useSize.js';

export interface Transform {
  k: number;
  x: number;
  y: number;
}
export interface Point {
  x: number;
  y: number;
}
/** A box in CONTENT coordinates (the un-transformed diagram). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_K = 0.25;
export const MAX_K = 3;
/** Screen px kept clear around a fitted diagram. */
export const FIT_MARGIN = 8;
/** Screen px kept clear around a box panned into view. */
export const REVEAL_MARGIN = 16;
/** Same rate as Graph.tsx's wheel zoom; a ctrl+wheel (trackpad pinch) sends much smaller deltas. */
const WHEEL_RATE = 0.0015;
const PINCH_WHEEL_RATE = 0.01;
/** The +/- buttons' step. */
const ZOOM_STEP = 1.25;
/** Screen px a pointer may travel before a press stops being a click and becomes a pan. */
const CLICK_SLOP = 4;
const IDENTITY: Transform = { k: 1, x: 0, y: 0 };

export function clampK(k: number): number {
  return Number.isFinite(k) ? Math.min(MAX_K, Math.max(MIN_K, k)) : 1;
}

/** The transform that shows all of `content` inside `view`: scaled down to fit (never scaled UP
 * past 1 — a small diagram stays at its designed size) and centred. When the fit would need a
 * scale below `MIN_K`, the clamp wins and the diagram is anchored top-left instead, so the start
 * of it is on screen rather than its middle. */
export function fitTransform(content: Size, view: Size): Transform {
  if (content.w <= 0 || content.h <= 0) return IDENTITY;
  const k = clampK(
    Math.min(1, (view.w - 2 * FIT_MARGIN) / content.w, (view.h - 2 * FIT_MARGIN) / content.h),
  );
  const w = content.w * k;
  const h = content.h * k;
  return {
    k,
    x: w <= view.w ? (view.w - w) / 2 : FIT_MARGIN,
    y: h <= view.h ? (view.h - h) / 2 : FIT_MARGIN,
  };
}

/** Scale to `k` (clamped) keeping the content point currently under screen point `at` fixed. */
export function zoomAbout(t: Transform, k: number, at: Point): Transform {
  const next = clampK(k);
  const s = next / t.k;
  return { k: next, x: at.x - (at.x - t.x) * s, y: at.y - (at.y - t.y) * s };
}

/** Pan (never zoom) by the least amount that brings `r` fully inside `view`, keeping
 * `REVEAL_MARGIN` clear. Returns `t` itself (same object) when `r` is already inside. A box
 * larger than the view is aligned to the left/top margin. */
export function revealRect(t: Transform, r: Rect, view: Size): Transform {
  const left = t.x + r.x * t.k;
  const top = t.y + r.y * t.k;
  const right = left + r.w * t.k;
  const bottom = top + r.h * t.k;
  const dx =
    left < REVEAL_MARGIN || right - left > view.w - 2 * REVEAL_MARGIN
      ? REVEAL_MARGIN - left
      : right > view.w - REVEAL_MARGIN
        ? view.w - REVEAL_MARGIN - right
        : 0;
  const dy =
    top < REVEAL_MARGIN || bottom - top > view.h - 2 * REVEAL_MARGIN
      ? REVEAL_MARGIN - top
      : bottom > view.h - REVEAL_MARGIN
        ? view.h - REVEAL_MARGIN - bottom
        : 0;
  return dx === 0 && dy === 0 ? t : { k: t.k, x: t.x + dx, y: t.y + dy };
}

type Gesture =
  | { kind: 'pan'; start: Point; from: Transform }
  | { kind: 'pinch'; dist: number; mid: Point; from: Transform };

export interface PanZoom {
  /** Callback ref for the gesture surface (the element the transform is measured against). */
  ref: (el: HTMLElement | null) => void;
  tf: Transform;
  fit: () => void;
  /** 100%: scale 1 about the surface's centre. */
  actual: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Pan, minimally, so `rect` (content coordinates) is fully on screen. Re-measures the surface
   * first, so it sees a canvas the drawer has just narrowed. */
  reveal: (rect: Rect) => void;
}

/**
 * `content` is the diagram's size in content px, or `null` when there is nothing to pan (a note,
 * an error): gestures are then off and no transform is computed. The surface is fitted when it
 * first appears and whenever `resetKey` changes — NOT when `content` changes, so a live
 * `systems.yml` edit does not yank the reader's view.
 *
 * jsdom measures 0×0; `DEFAULT_SIZE` (the same fallback `useSize` uses) stands in, so a fit is
 * still computed there. The surface is measured on demand, at each gesture and button press, so
 * a canvas resized by anything (the drawer, the window) needs no observer.
 */
export function usePanZoom(content: Size | null, resetKey: string): PanZoom {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [tf, setTf] = useState<Transform>(IDENTITY);
  const tfRef = useRef<Transform>(IDENTITY);
  const contentRef = useRef<Size | null>(content);
  contentRef.current = content;
  const enabled = content !== null;

  const commit = useCallback((next: Transform) => {
    tfRef.current = next;
    setTf(next);
  }, []);

  const measure = useCallback((): Size => {
    if (!el) return DEFAULT_SIZE;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : DEFAULT_SIZE;
  }, [el]);

  const fit = useCallback(() => {
    const c = contentRef.current;
    if (el && c) commit(fitTransform(c, measure()));
  }, [el, commit, measure]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the refit trigger, by design; `fit` is stable for a given `el`
  useLayoutEffect(() => {
    if (enabled) fit();
  }, [enabled, resetKey, fit]);

  const zoomToward = useCallback(
    (k: number) => {
      if (!el || contentRef.current === null) return;
      const v = measure();
      commit(zoomAbout(tfRef.current, k, { x: v.w / 2, y: v.h / 2 }));
    },
    [el, commit, measure],
  );
  const actual = useCallback(() => zoomToward(1), [zoomToward]);
  const zoomIn = useCallback(() => zoomToward(tfRef.current.k * ZOOM_STEP), [zoomToward]);
  const zoomOut = useCallback(() => zoomToward(tfRef.current.k / ZOOM_STEP), [zoomToward]);

  const reveal = useCallback(
    (rect: Rect) => {
      if (!el || contentRef.current === null) return;
      const next = revealRect(tfRef.current, rect, measure());
      if (next !== tfRef.current) commit(next);
    },
    [el, commit, measure],
  );

  // Wheel, drag-pan and pinch. Native listeners: React's onWheel is passive and cannot
  // preventDefault, and the move/up listeners live on `window` so a drag that leaves the surface
  // still ends cleanly.
  useEffect(() => {
    if (!el || !enabled) return;
    const pointers = new Map<number, Point>();
    let origin: Point = { x: 0, y: 0 };
    let gesture: Gesture | null = null;
    let moved = false;
    let suppressClick = false;

    const local = (e: { clientX: number; clientY: number }): Point => ({
      x: e.clientX - origin.x,
      y: e.clientY - origin.y,
    });

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const rate = e.ctrlKey ? PINCH_WHEEL_RATE : WHEEL_RATE;
      const t = tfRef.current;
      commit(
        zoomAbout(t, t.k * Math.exp(-dy * rate), { x: e.clientX - r.left, y: e.clientY - r.top }),
      );
    };

    // (Re)start the gesture from wherever the pointers are now: one pointer pans, two pinch.
    const begin = () => {
      const pts = [...pointers.values()];
      const from = tfRef.current;
      const [a, b] = pts;
      if (a && b) {
        gesture = {
          kind: 'pinch',
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          from,
        };
        moved = true;
      } else if (a) {
        gesture = { kind: 'pan', start: a, from };
      } else {
        gesture = null;
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || gesture === null) return;
      pointers.set(e.pointerId, local(e));
      if (gesture.kind === 'pan') {
        const p = pointers.get(e.pointerId) ?? gesture.start;
        const dx = p.x - gesture.start.x;
        const dy = p.y - gesture.start.y;
        if (!moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
        moved = true;
        commit({ k: gesture.from.k, x: gesture.from.x + dx, y: gesture.from.y + dy });
      } else {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = clampK(gesture.from.k * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist));
        const s = k / gesture.from.k;
        commit({
          k,
          x: mid.x - (gesture.mid.x - gesture.from.x) * s,
          y: mid.y - (gesture.mid.y - gesture.from.y) * s,
        });
      }
      if (moved) {
        suppressClick = true;
        el.setAttribute('data-dragging', '');
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size === 0) {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        el.removeAttribute('data-dragging');
      }
      begin();
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (pointers.size === 0) {
        const r = el.getBoundingClientRect();
        origin = { x: r.left, y: r.top };
        moved = false;
        suppressClick = false;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }
      pointers.set(e.pointerId, local(e));
      begin();
    };

    // Capture phase: runs before the box's own click, which a drag must not trigger.
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeAttribute('data-dragging');
    };
  }, [el, enabled, commit]);

  return { ref: setEl, tf, fit, actual, zoomIn, zoomOut, reveal };
}
