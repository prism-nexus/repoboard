/**
 * RCB-98 (plan docs/SYSTEMS-FLOW-PLAN.md §3.4): the Flow view — the third top-level view, beside
 * Board and Map. Per-system, not per-file: rows by `layer`, an env switch (`dev`/`prod`/`both`),
 * one-env dashing, a `none` environment's note in place of the diagram, and a drawer with the
 * row's fields, its `pointers` resolved live, and backlinks (cards whose `refs:`/`files:` name a
 * path under one of them). Layout comes from core's `layoutSystems` (RCB-95), pure, 0 KB added —
 * this file only draws the boxes and edges it returns. Fun stays off here (plan D9).
 */
import {
  type BoardConfig,
  type Card,
  defaultBoardConfig,
  layoutSystems,
  type ResolvedRef,
  type SystemRow,
  type SystemsDoc,
  systemsSummary,
  unblockerInfo,
} from '@repoboard/core';
import { useEffect, useMemo, useState } from 'react';
import { RefsList } from '../components/RefsList.jsx';
import { useBoardState, useStore } from '../hooks.js';
import { apiPath } from '../repo-key.js';
import type { FlowEnv, State } from '../store.js';
import type { SystemTestsPayload } from '../wire.js';

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

type SystemTestsState =
  | { kind: 'loading' }
  | { kind: 'ok'; tests: SystemTestsPayload | null }
  | { kind: 'error'; message: string };

/** Mirrors `useSystemRefs` exactly: fetched live on every select, never cached, skipped entirely
 * when the system has no pointers (no dead network call) — `tests: null` there, not an empty
 * payload, since "no pointers" and "pointers with zero tests" are different facts. */
function useSystemTests(systemId: string, pointers: readonly string[]): SystemTestsState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [state, setState] = useState<SystemTestsState>({ kind: 'loading' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `systemId` identity is the refetch trigger, by design (mirrors useSystemRefs)
  useEffect(() => {
    if (pointers.length === 0) {
      setState({ kind: 'ok', tests: null });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    const url = apiPath(`/api/systems/${encodeURIComponent(systemId)}/tests`, repoKey);
    const load = async (): Promise<SystemTestsState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const data: unknown = await res.json();
      return { kind: 'ok', tests: data as SystemTestsPayload };
    };
    load()
      .catch(
        (e: unknown): SystemTestsState => ({
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

/** RCB-113: the `· <pct>%` or `· <reason>` suffix `measured.pointers` adds to a pointer's line —
 * `''` when this pointer has no counterpart there (never true today; `measured.pointers` walks
 * the same pointer list, in the same order). */
function measuredSuffix(payload: SystemTestsPayload, pointer: string): string {
  const m = payload.measured.pointers.find((p) => p.pointer === pointer);
  if (m === undefined) return '';
  return m.pct !== null ? ` · ${m.pct.toFixed(1)}%` : ` · ${m.reason}`;
}

/** One `<li>` per pointer, per the wire contract: a non-null `tests` gives its count and file
 * list, a null `tests` with a `reason` gives the reason, otherwise `none` — plus RCB-113's
 * measured-coverage suffix. */
function testsLine(payload: SystemTestsPayload, p: SystemTestsPayload['pointers'][number]): string {
  const suffix = measuredSuffix(payload, p.pointer);
  if (p.tests !== null) {
    return p.tests.length === 0
      ? `${p.pointer} — none${suffix}`
      : `${p.pointer} — ${p.tests.length}: ${p.tests.join(', ')}${suffix}`;
  }
  if (p.reason !== null) return `${p.pointer} — ${p.reason}${suffix}`;
  return `${p.pointer} — none${suffix}`;
}

/** Mirrors `RefsList`'s collapsed toggle (RCB-109): closed shows nothing of `tests[]`, only a
 * `show`/`hide` button; open reveals the per-pointer list and the source sentence below it. */
function TestsToggle({ payload }: { payload: SystemTestsPayload }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="drawer__ref-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'hide' : 'show'}
      </button>
      {open ? (
        <>
          <ul className="drawer__files mono">
            {payload.pointers.map((p) => (
              <li key={p.pointer}>{testsLine(payload, p)}</li>
            ))}
          </ul>
          <p className="mono muted">{payload.source}</p>
          <p className="mono muted">{payload.measured.source}</p>
        </>
      ) : null}
    </>
  );
}

interface UnblockerRowsProps {
  ids: readonly string[];
  cards: readonly Card[];
  config: BoardConfig | null;
  onOpenCard: (id: string) => void;
}

/** RCB-161 slice 2: one row per `unblocked_by` id — shared by the drawer's own "Unblocked by"
 * section and a non-live connection's line, so both go through the SAME resolution
 * (`unblockerInfo`, core; also `repoboard systems show`'s CLI output) rather than a second
 * rendering of the same data. Empty list: the one "nothing recorded" line. */
function UnblockerRows({ ids, cards, config, onOpenCard }: UnblockerRowsProps) {
  if (ids.length === 0) {
    return <p className="rail__empty">Nothing recorded unblocks this yet.</p>;
  }
  return (
    <ul className="drawer__files mono">
      {ids.map((id) => {
        const info = unblockerInfo(id, cards, config ?? defaultBoardConfig());
        const nextStep = info.nextStep;
        return (
          <li key={id}>
            {info.card ? (
              <button type="button" className="who__body" onClick={() => onOpenCard(id)}>
                {id} — {info.card.title} [{info.card.status}]
              </button>
            ) : (
              <span>{id} (not on this board)</span>
            )}
            {info.decision ? (
              <div className="muted">
                <div>decision: {info.decision.question}</div>
                {info.decision.options.map((o) => (
                  <div key={o.letter}>
                    {o.letter}: {o.text}
                  </div>
                ))}
              </div>
            ) : nextStep ? (
              <button
                type="button"
                className="who__body muted"
                onClick={() => onOpenCard(nextStep.id)}
              >
                next step: {nextStep.id} {nextStep.title}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
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
  config: BoardConfig | null;
  onClose: () => void;
  onOpenCard: (id: string) => void;
}

function SystemDrawer({ system, doc, cards, config, onClose, onOpenCard }: SystemDrawerProps) {
  const refs = useSystemRefs(system.id, system.pointers);
  const tests = useSystemTests(system.id, system.pointers);
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
      <p className="drawer__meta mono">
        {system.kind} · {system.layer} · {system.env.join('+')}
        {system.status !== 'live' ? ` · ${system.status}` : ''}
      </p>
      <div className="drawer__fields">
        <div className="field">
          <span className="field__label">runtime dev</span>
          <span className="mono field__static">{system.runtime.dev ?? '—'}</span>
        </div>
        <div className="field">
          <span className="field__label">runtime prod</span>
          <span className="mono field__static">{system.runtime.prod ?? '—'}</span>
        </div>
      </div>
      {system.why ? (
        <section className="drawer__section">
          <h3>Why</h3>
          <p>{system.why}</p>
        </section>
      ) : null}
      {system.status !== 'live' || system.unblockedBy.length > 0 ? (
        <section className="drawer__section" data-testid="flow-drawer-unblockers">
          <h3>Unblocked by ({system.unblockedBy.length})</h3>
          <UnblockerRows
            ids={system.unblockedBy}
            cards={cards}
            config={config}
            onOpenCard={onOpenCard}
          />
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
                <div>
                  {c.from === system.id ? <strong>{c.from}</strong> : c.from} →{' '}
                  {c.to === system.id ? <strong>{c.to}</strong> : c.to}
                  {c.status !== 'live' ? ` · ${c.status}` : ''}
                </div>
                {c.via ? <span className="muted">via {c.via}</span> : null}
                {c.unblockedBy.length > 0 ? (
                  <UnblockerRows
                    ids={c.unblockedBy}
                    cards={cards}
                    config={config}
                    onOpenCard={onOpenCard}
                  />
                ) : null}
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
            <RefsList refs={refs.refs} collapsed />
          )}
        </section>
      ) : null}
      <section className="drawer__section" data-testid="flow-drawer-tests">
        <h3>Tests</h3>
        {tests.kind === 'loading' ? (
          <p className="mono muted">loading…</p>
        ) : tests.kind === 'error' ? (
          <div className="drawer__ref drawer__ref--error" role="alert">
            <div className="drawer__ref-head mono">could not load tests</div>
            <div className="drawer__ref-error">{tests.message}</div>
          </div>
        ) : tests.tests === null ? (
          <p className="mono">tests: n/a (no pointers)</p>
        ) : (
          <>
            <p className="mono">{tests.tests.line}</p>
            <p className="mono">{tests.tests.measured.line}</p>
            {tests.tests.pointers.some((p) => p.tests !== null) ? (
              <TestsToggle payload={tests.tests} />
            ) : null}
          </>
        )}
      </section>
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
      <p className="drawer__provenance mono muted">
        owner: {system.owner ?? '—'} · {sourceText(system.source)}
      </p>
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
        const notLive = e.status !== 'live';
        return (
          <polyline
            key={`${e.from}-${e.to}-${i.toString()}`}
            points={points.join(' ')}
            className={`flow-edge${notLive ? ` flow-edge--${e.status}` : ''}`}
            data-edge={`${e.from}-${e.to}`}
            data-dashed={e.dashed}
            data-status={notLive ? e.status : undefined}
            strokeDasharray={notLive ? '1 4' : e.dashed ? '4 3' : undefined}
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
          const notLive = box.status !== 'live';
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG node; the drawer's close button is the keyboard path back out
            <g
              key={box.id}
              className={`flow-box ${selected ? 'flow-box--selected' : ''}${notLive ? ` flow-box--${box.status}` : ''}`}
              data-box={box.id}
              data-status={notLive ? box.status : undefined}
              onClick={() => onSelect(box.id)}
            >
              <rect
                x={at.x}
                y={at.y}
                width={SCALE_X}
                height={SCALE_Y}
                rx={6}
                data-dashed={box.dashed}
                strokeDasharray={notLive ? '1 4' : box.dashed ? '4 3' : undefined}
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
              {notLive ? (
                <text
                  x={at.x + SCALE_X - 8}
                  y={at.y + 14}
                  textAnchor="end"
                  className="flow-box__badge mono"
                >
                  {box.status}
                </text>
              ) : null}
            </g>
          );
        })}
    </svg>
  );
}

/** RCB-111: the confirm's `<repoName>` — `state.repos`' entry for `repoKey ?? repos.primary`,
 * or `'this'` when repos have not loaded yet (mirrors the rest of the store's "absent means
 * inert, never a crash" reasoning). */
function planRepoName(repos: State['repos'], repoKey: State['repoKey']): string {
  if (!repos) return 'this';
  const key = repoKey ?? repos.primary;
  return repos.repos.find((r) => r.key === key)?.name ?? 'this';
}

export function FlowView() {
  const store = useStore();
  const { systems, flowEnv, cards, hasBoard, repos, repoKey, config } = useBoardState();
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [planConfirming, setPlanConfirming] = useState(false);
  const [planPending, setPlanPending] = useState(false);

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
          <>
            <p className="flow-note" data-testid="flow-no-file">
              {systemsSummary(null, []).line}
            </p>
            {hasBoard ? (
              planConfirming ? (
                <div data-testid="flow-plan-confirm">
                  <p className="muted">
                    {`Create 4 cards on the ${planRepoName(repos, repoKey)} board: a parent and three steps (detect → hand-correct → connect)?`}
                  </p>
                  <button
                    type="button"
                    className="toggle"
                    disabled={planPending}
                    onClick={() => {
                      setPlanPending(true);
                      void store.planSystemsMap().finally(() => setPlanPending(false));
                    }}
                  >
                    Create 4 cards
                  </button>
                  <button type="button" className="toggle" onClick={() => setPlanConfirming(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="toggle"
                  data-testid="flow-plan"
                  onClick={() => setPlanConfirming(true)}
                >
                  Plan the systems map
                </button>
              )
            ) : null}
          </>
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
          config={config}
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
