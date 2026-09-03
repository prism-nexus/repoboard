import { useEffect, useRef } from 'react';

interface Props {
  /** Fire once per increment. */
  burst: number;
  /** Where to fire from, in viewport px; defaults to the top-right quarter. */
  origin?: { x: number; y: number } | null;
}

const COUNT = 60;
const DURATION_MS = 1200;
const COLORS = ['#ff6b5c', '#f2b33d', '#4fc37e', '#7aa7ff', '#f032e6', '#42d4f4'];

/** Self-written confetti: ~60 canvas particles for 1.2 s. No library. */
export function Confetti({ burst, origin }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (burst === 0) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ox = origin?.x ?? canvas.width * 0.85;
    const oy = origin?.y ?? canvas.height * 0.2;
    const parts = Array.from({ length: COUNT }, (_, i) => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const v = 4 + Math.random() * 6;
      return {
        x: ox,
        y: oy,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: 4 + Math.random() * 4,
        h: 6 + Math.random() * 6,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: COLORS[i % COLORS.length] as string,
      };
    });
    const start = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const k = (t - start) / DURATION_MS;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (k >= 1) return;
      ctx.globalAlpha = 1 - k * k;
      for (const p of parts) {
        p.vy += 0.25;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [burst, origin]);
  return <canvas ref={ref} className="confetti" />;
}
