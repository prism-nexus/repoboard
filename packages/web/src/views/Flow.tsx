/**
 * RCB-98 (plan docs/SYSTEMS-FLOW-PLAN.md §3.4): the Flow view — the third top-level view, beside
 * Board and Map. Per-system, not per-file: rows by `layer`, an env switch (`dev`/`prod`/`both`),
 * one-env dashing, a `none` environment's note in place of the diagram, and a drawer with the
 * row's fields, its `pointers` resolved live, and backlinks (cards whose `refs:`/`files:` name a
 * path under one of them). Layout comes from core's `layoutSystems` (RCB-95), pure, 0 KB added —
 * this file only draws the boxes and edges it returns. Fun stays off here (plan D9).
 */
import {
  type Card,
  layoutSystems,
  type ResolvedRef,
  type SystemRow,
  type SystemsDoc,
  systemsSummary,
} from '@repoboard/core';
import { useEffect, useMemo, useState } from 'react';
import { RefsList } from '../components/RefsList.jsx';
import { useBoardState, useStore } from '../hooks.js';
import { apiPath } from '../repo-key.js';
import type { FlowEnv } from '../store.js';

const ENVS: readonly FlowEnv[] = ['dev', 'prod', 'both'];

// Abstract layout units (core's `layoutSystems`) to pixels: a box is 1x1 unit, so setting these
// two constants equal to a box's on-screen size keeps every edge endpoint (computed in core from
// the SAME abstract box geometry) landing exactly on the box's border/centre — no separate fudge.
const SCALE_X = 170;
const SCALE_Y = 64;
const LABEL_W = 88;
const PAD = 20;

function px(x: number, y: number): { x: number; y: number } {
  return { x: LABEL_W + x * SCALE_X + PAD, y: y * SCALE_Y + PAD };
}

/** The spec text before the first `#` or `:` — the path half of a card's `refs:`/`files:` entry
 * (K7 forms: `path#Heading`, `path@Token`, `path:L10-L20`, or a bare `path`). */
function specPath(spec: string): string {
  const hash = spec.indexOf('#');
  const colon = spec.indexOf(':');
  const cut = hash === -1 ? colon : colon === -1 ? hash : Math.min(hash, colon);
  return cut === -1 ? spec : spec.slice(0, cut);
}

function pathUnderOrEqual(path: string, pointer: string): boolean {
  return path === pointer || path.startsWith(`${pointer}/`);
}

/** System-level who-is-where (plan §3.4): every card whose `refs:`/`files:` path equals or falls
 * under one of `pointers`. `[]` when the system has no pointers — an unconfigured system points
 * at nothing, so it backlinks nothing, never "everything" (CLAUDE.md: inert, not dangerous). */
export function backlinksFor(cards: readonly Card[], pointers: readonly string[]): Card[] {
  if (pointers.length === 0) return [];
  return cards.filter((c) => {
    const specs = [...(c.refs ?? []), ...(c.files ?? [])];
    return specs.some((spec) => {
      const path = specPath(spec);
      return pointers.some((ptr) => pathUnderOrEqual(path, ptr));
    });
  });
}

type SystemRefsState =
  | { kind: 'loading' }
  | { kind: 'ok'; refs: ResolvedRef[] }
  | { kind: 'error'; message: string };

/** Mirrors `Drawer.tsx`'s `useRefs`: fetched live on every select, never cached, skipped
 * entirely when the system has no pointers (no dead network call). */
function useSystemRefs(systemId: string, pointers: readonly string[]): SystemRefsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [state, setState] = useState<SystemRefsState>({ kind: 'loading' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `systemId` identity is the refetch trigger, by design (mirrors Drawer.tsx's useRefs)
  useEffect(() => {
    if (pointers.length === 0) {
      setState({ kind: 'ok', refs: [] });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    const url = apiPath(`/api/systems/${encodeURIComponent(systemId)}/refs`, repoKey);
    const load = async (): Promise<SystemRefsState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return { kind: 'error', message: `${url} → not an array` };
      return { kind: 'ok', refs: data as ResolvedRef[] };
    };
    load()
      .catch(
        (e: unknown): SystemRefsState => ({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [systemId]);
  return state;
}

function sourceText(source: SystemRow['source']): string {
  return 'hand' in source
    ? `hand: ${source.hand} · ${source.at}`
    : `detected: ${source.detected} · ${source.at}`;
}

interface SystemDrawerProps {
  system: SystemRow;
  doc: SystemsDoc;
  cards: readonly Card[];
  onClose: () => void;
  onOpenCard: (id: string) => void;
}

function SystemDrawer({ system, doc, cards, onClose, onOpenCard }: SystemDrawerProps) {
  const refs = useSystemRefs(system.id, system.pointers);
  const connections = useMemo(
    () => doc.connections.filter((c) => c.from === system.id || c.to === system.id),
    [doc.connections, system.id],
  );
  const backlinks = useMemo(() => backlinksFor(cards, system.pointers), [cards, system.pointers]);

  return (
    <aside className="drawer" role="dialog" aria-modal="false" data-testid="flow-drawer">
      <div className="drawer__bar">
        <span className="mono drawer__id">{system.id}</span>
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <h2 className="drawer__title">{system.name}</h2>
      <dl className="drawer__fields mono">
        <dt>kind</dt>
        <dd>{system.kind}</dd>
        <dt>layer</dt>
        <dd>{system.layer}</dd>
        <dt>env</dt>
        <dd>{system.env.join(', ')}</dd>
        <dt>runtime dev</dt>
        <dd>{system.runtime.dev ?? '—'}</dd>
        <dt>runtime prod</dt>
        <dd>{system.runtime.prod ?? '—'}</dd>
        <dt>owner</dt>
        <dd>{system.owner ?? '—'}</dd>
        <dt>source</dt>
        <dd>{sourceText(system.source)}</dd>
      </dl>
      {system.why ? (
        <section className="drawer__section">
          <h3>Why</h3>
          <p>{system.why}</p>
        </section>
      ) : null}
      <section className="drawer__section">
        <h3>Connections ({connections.length})</h3>
        {connections.length === 0 ? (
          <p className="rail__empty">No connections.</p>
        ) : (
          <ul className="drawer__files mono">
            {connections.map((c, i) => (
              <li key={`${c.from}-${c.to}-${i.toString()}`}>
                {c.from} → {c.to}
                {c.via ? ` (${c.via})` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
      {system.docs.length > 0 ? (
        <section className="drawer__section">
          <h3>Docs</h3>
          <ul className="drawer__files mono">
            {system.docs.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {system.pointers.length > 0 ? (
        <section className="drawer__section" data-testid="flow-drawer-refs">
          <h3>Pointers</h3>
          {refs.kind === 'loading' ? (
            <ul className="drawer__files mono muted">
              {system.pointers.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : refs.kind === 'error' ? (
            <div className="drawer__ref drawer__ref--error" role="alert">
              <div className="drawer__ref-head mono">could not load references</div>
              <div className="drawer__ref-error">{refs.message}</div>
            </div>
          ) : (
            <RefsList refs={refs.refs} />
          )}
        </section>
      ) : null}
      <section className="drawer__section" data-testid="flow-drawer-backlinks">
        <h3>Backlinks ({backlinks.length})</h3>
        {backlinks.length === 0 ? (
          <p className="rail__empty">No card references this system.</p>
        ) : (
          <ul className="drawer__files mono">
            {backlinks.map((c) => (
              <li key={c.id}>
                <button type="button" className="who__body" onClick={() => onOpenCard(c.id)}>
                  {c.id} — {c.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

interface DiagramProps {
  doc: SystemsDoc;
  env: FlowEnv;
  selectedSystem: string | null;
  onSelect: (id: string) => void;
}

function Diagram({ doc, env, selectedSystem, onSelect }: DiagramProps) {
  const layout = useMemo(() => layoutSystems(doc, env), [doc, env]);
  if (env !== 'both') {
    const note = layout.none[env];
    if (note !== undefined) return <p className="flow-note">{note}</p>;
  }
  const vbW = Math.max(LABEL_W + layout.width * SCALE_X + PAD * 2, LABEL_W + PAD * 2);
  const vbH = Math.max(layout.height * SCALE_Y + PAD * 2, PAD * 2);
  return (
    <svg
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMin meet"
      width={vbW}
      height={vbH}
      className="flow-svg"
      role="img"
      aria-label="Systems flow diagram"
      data-testid="flow-svg"
    >
      <title>Systems flow diagram</title>
      {layout.rows.map((row) => {
        const rowY = row.boxes[0]?.y ?? 0;
        const at = px(0, rowY);
        return (
          <text key={row.layer} x={PAD} y={at.y + SCALE_Y / 2} className="flow-row-label mono">
            {row.layer}
          </text>
        );
      })}
      {layout.edges.map((e, i) => {
        const points = e.points.map((p) => {
          const at = px(p.x, p.y);
          return `${at.x},${at.y}`;
        });
        return (
          <polyline
            key={`${e.from}-${e.to}-${i.toString()}`}
            points={points.join(' ')}
            className="flow-edge"
            data-edge={`${e.from}-${e.to}`}
            data-dashed={e.dashed}
            strokeDasharray={e.dashed ? '4 3' : undefined}
          >
            {e.via ? <title>{e.via}</title> : null}
          </polyline>
        );
      })}
      {layout.rows
        .flatMap((row) => row.boxes)
        .map((box) => {
          const at = px(box.x, box.y);
          const system = doc.systems.find((s) => s.id === box.id);
          const selected = selectedSystem === box.id;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG node; the drawer's close button is the keyboard path back out
            <g
              key={box.id}
              className={`flow-box ${selected ? 'flow-box--selected' : ''}`}
              data-box={box.id}
              onClick={() => onSelect(box.id)}
            >
              <rect
                x={at.x}
                y={at.y}
                width={SCALE_X}
                height={SCALE_Y}
                rx={6}
                data-dashed={box.dashed}
                strokeDasharray={box.dashed ? '4 3' : undefined}
              />
              <text x={at.x + 8} y={at.y + 18} className="flow-box__id mono">
                {box.id}
              </text>
              <text x={at.x + 8} y={at.y + 34} className="flow-box__name">
                {system?.name ?? box.id}
              </text>
              <text x={at.x + 8} y={at.y + SCALE_Y - 8} className="flow-box__env mono muted">
                {system ? system.env.join('+') : ''}
              </text>
            </g>
          );
        })}
    </svg>
  );
}

export function FlowView() {
  const store = useStore();
  const { systems, flowEnv, cards } = useBoardState();
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);

  if (systems === null) {
    return (
      <div className="map-empty" data-testid="flow">
        <p>Loading…</p>
      </div>
    );
  }

  const doc = systems.doc;
  const selected = doc?.systems.find((s) => s.id === selectedSystem) ?? null;

  return (
    <div className="flow" data-testid="flow">
      <div className="flow__bar map__bar">
        <fieldset className="seg">
          <legend className="sr-only">Environment</legend>
          {ENVS.map((e) => {
            const note =
              e !== 'both' && doc && 'none' in doc.environments[e]
                ? doc.environments[e].none
                : undefined;
            return (
              <button
                key={e}
                type="button"
                className={`seg__btn ${flowEnv === e ? 'seg__btn--on' : ''}`}
                aria-pressed={flowEnv === e}
                title={note}
                onClick={() => store.setFlowEnv(e)}
              >
                {e}
              </button>
            );
          })}
        </fieldset>
      </div>
      <div className="flow__canvas">
        {!systems.exists ? (
          <p className="flow-note" data-testid="flow-no-file">
            {systemsSummary(null, []).line}
          </p>
        ) : doc === null ? (
          <div className="flow-errors" data-testid="flow-errors">
            {systems.errors.map((e) => (
              <pre key={e}>{e}</pre>
            ))}
          </div>
        ) : (
          <Diagram
            doc={doc}
            env={flowEnv}
            selectedSystem={selectedSystem}
            onSelect={setSelectedSystem}
          />
        )}
      </div>
      {selected && doc ? (
        <SystemDrawer
          system={selected}
          doc={doc}
          cards={cards}
          onClose={() => setSelectedSystem(null)}
          onOpenCard={(id) => {
            store.select(id);
            store.setView('board');
          }}
        />
      ) : null}
    </div>
  );
}
