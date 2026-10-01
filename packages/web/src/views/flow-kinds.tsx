/**
 * RCB-175: what a Flow box says about its KIND. `kind` is required on every systems.yml row (13
 * values, core's `SYSTEM_KINDS`) but until now only the drawer showed it, so a postgres box
 * looked like a worker. Each kind gets one glyph (a plain SVG path — no icon library) and one of
 * four families, which colours its glyph and its kind name (`styles.css`, `--flow-fam-*`).
 *
 * Both tables are `Record<SystemKind, …>`, so adding a kind to core fails the typecheck here
 * instead of drawing a box with no glyph.
 */
import { SYSTEM_KINDS, type SystemKind } from '@repoboard/core';

/** data stores / compute / external services / ops tooling. */
export type KindFamily = 'data' | 'compute' | 'external' | 'ops';

export type GlyphName =
  | 'window'
  | 'square'
  | 'cog'
  | 'clock'
  | 'cylinder'
  | 'bolt'
  | 'bars'
  | 'shield'
  | 'envelope'
  | 'play'
  | 'cloud'
  | 'hexagon';

/** Drawn on a 14 x 14 grid. `filled` shapes are solid (with a 0.6 px rounding stroke); the rest
 * are 1.3 px outlines. */
const GLYPHS: Record<GlyphName, { d: string; filled: boolean }> = {
  window: { d: 'M1.5 2.5h11v9h-11z M1.5 5.5h11', filled: false },
  square: { d: 'M2.5 2.5h9v9h-9z', filled: false },
  cog: {
    d: 'M7 4.2a2.8 2.8 0 1 1 0 5.6a2.8 2.8 0 1 1 0-5.6z M7 1v2 M7 11v2 M1 7h2 M11 7h2',
    filled: false,
  },
  clock: { d: 'M7 2a5 5 0 1 1 0 10a5 5 0 1 1 0-10z M7 4.5V7l2 1.2', filled: false },
  cylinder: {
    d: 'M2.5 3.2c0-1 2-1.8 4.5-1.8s4.5.8 4.5 1.8c0 1-2 1.8-4.5 1.8S2.5 4.2 2.5 3.2z M2.5 3.2v7.6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.2',
    filled: false,
  },
  bolt: { d: 'M8 1.5 3.5 8h3l-.8 4.5 4.8-6.5h-3z', filled: true },
  bars: { d: 'M2 2h10v2H2z M2 6h7v2H2z M2 10h10v2H2z', filled: true },
  shield: {
    d: 'M7 1.5 2.5 3.3v3.4c0 2.7 1.9 4.5 4.5 5.8c2.6-1.3 4.5-3.1 4.5-5.8V3.3z',
    filled: false,
  },
  envelope: { d: 'M1.5 3h11v8h-11z M1.5 3.5 7 7.8l5.5-4.3', filled: false },
  play: { d: 'M4 2.5v9l7.5-4.5z', filled: true },
  cloud: {
    d: 'M4 11.5a2.6 2.6 0 0 1-.4-5.2a3.7 3.7 0 0 1 7.1-.7a2.9 2.9 0 0 1-.2 5.9z',
    filled: false,
  },
  hexagon: { d: 'M4.5 2.5h5l2.5 4.5-2.5 4.5h-5L2 7z', filled: false },
};

/** Auth and email are third-party services in every board seen so far (Supabase auth, SendGrid),
 * so they sit in `external`; `client`/`service`/`worker`/`job` are the code we run. */
export const KIND_META: Record<SystemKind, { glyph: GlyphName; family: KindFamily }> = {
  client: { glyph: 'window', family: 'compute' },
  service: { glyph: 'square', family: 'compute' },
  worker: { glyph: 'cog', family: 'compute' },
  job: { glyph: 'clock', family: 'compute' },
  db: { glyph: 'cylinder', family: 'data' },
  storage: { glyph: 'cylinder', family: 'data' },
  cache: { glyph: 'bolt', family: 'data' },
  queue: { glyph: 'bars', family: 'data' },
  auth: { glyph: 'shield', family: 'external' },
  email: { glyph: 'envelope', family: 'external' },
  external: { glyph: 'cloud', family: 'external' },
  ci: { glyph: 'play', family: 'ops' },
  tool: { glyph: 'hexagon', family: 'ops' },
};

export const FAMILY_LABEL: Record<KindFamily, string> = {
  data: 'data stores',
  compute: 'compute',
  external: 'external',
  ops: 'ops',
};

/** The glyph grid's side, in the same pixels as the box it sits in. */
export const GLYPH_SIZE = 14;

interface KindGlyphProps {
  kind: SystemKind;
  /** Top-left corner on the surrounding SVG's user grid; `0` inside the legend's own `<svg>`. */
  x?: number;
  y?: number;
}

/** One kind's glyph, coloured by family through `currentColor` (the `flow-fam--*` class). The
 * `data-glyph` attribute is the shape's name, so a test (or a curious devtools user) can tell a
 * cylinder from a cog without reading path data. */
export function KindGlyph({ kind, x = 0, y = 0 }: KindGlyphProps) {
  const { glyph, family } = KIND_META[kind];
  const shape = GLYPHS[glyph];
  return (
    <g
      className={`flow-glyph flow-fam--${family}`}
      data-glyph={glyph}
      transform={`translate(${x} ${y})`}
    >
      <path
        d={shape.d}
        fill={shape.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={shape.filled ? 0.6 : 1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </g>
  );
}

/** The kinds in `kinds`, once each, in `SYSTEM_KINDS` order — the legend lists exactly these. */
export function kindsPresent(kinds: Iterable<SystemKind>): SystemKind[] {
  const seen = new Set(kinds);
  return SYSTEM_KINDS.filter((k) => seen.has(k));
}

interface FlowLegendProps {
  id: string;
  kinds: readonly SystemKind[];
}

/** The toolbar's collapsible legend: one row per kind on THIS map (never the whole vocabulary). */
export function FlowLegend({ id, kinds }: FlowLegendProps) {
  return (
    <section
      className="flow-legend"
      id={id}
      aria-label="Kinds on this map"
      data-testid="flow-legend"
    >
      <ul>
        {kinds.map((kind) => {
          const { family } = KIND_META[kind];
          return (
            <li key={kind} className={`flow-fam--${family}`} data-legend-kind={kind}>
              <svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 14 14" aria-hidden="true">
                <KindGlyph kind={kind} />
              </svg>
              <span className="flow-legend__kind mono">{kind}</span>
              <span className="flow-legend__family">{FAMILY_LABEL[family]}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
