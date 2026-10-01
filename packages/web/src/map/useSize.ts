import { type RefObject, useLayoutEffect, useState } from 'react';

export interface Size {
  w: number;
  h: number;
}

/** jsdom has no ResizeObserver and measures 0×0; the fallback keeps layouts (and tests) sane. */
export const DEFAULT_SIZE: Size = { w: 960, h: 600 };

/** The element's content box, live. Falls back to DEFAULT_SIZE until something real is measured. */
export function useSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w <= 0 || h <= 0) return;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
