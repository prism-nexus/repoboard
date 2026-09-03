/**
 * P4 map shell: layer toggle (treemap | graph), heat modes, breadcrumb, legend, the canvas, and
 * the rail ("who is where" + the file panel). All model work lives in ../map/model.ts.
 */
import { avatarFor, type Card, findColumn } from '@repoboard/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/Avatar.jsx';
import { useBoardState, useNow, useStore } from '../hooks.js';
import {
  cardsNaming,
  dirColors,
  formatBytes,
  formatLines,
  GRAPH_NODE_LIMIT,
  graphData,
  graphDirOptions,
  LANG_PALETTE,
  MAP_MODES,
  type MapMode,
  RECENT_RAMP,
  whoIsWhere,
} from '../map/model.js';
import { relTime, shortActor } from '../time.js';
import { Graph } from './Graph.jsx';
import { type Timing, Treemap } from './Treemap.jsx';

type Layer = 'treemap' | 'graph';

export function MapView() {
  const store = useStore();
  const { repo, cards, config, fun, pinned, hoverId } = useBoardState();
  const now = useNow();
  const [layer, setLayer] = useState<Layer>('treemap');
  const [mode, setMode] = useState<MapMode>('size');
  const [zoomPath, setZoomPath] = useState('');
  const [panelPath, setPanelPath] = useState<string | null>(null);
  const [graphDir, setGraphDir] = useState<string | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);

  const files = repo?.files ?? [];
  const edges = repo?.edges ?? [];
  const known = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const who = useMemo(
    () => whoIsWhere(cards, config, now, pinned, hoverId, known),
    [cards, config, now, pinned, hoverId, known],
  );

  // Zooming into a directory the snapshot no longer has (rename, rescan) falls back to the root.
  useEffect(() => {
    if (zoomPath && !files.some((f) => f.path.startsWith(`${zoomPath}/`))) setZoomPath('');
  }, [files, zoomPath]);

  const dirOptions = useMemo(() => graphDirOptions(edges), [edges]);
  const graph = useMemo(() => {
    const all = graphData(files, edges);
    if (graphDir !== null) return graphData(files, edges, graphDir);
    if (all.totalNodes <= GRAPH_NODE_LIMIT) return all;
    // Over the limit and nothing chosen yet: the biggest directory that fits, else the biggest.
    const pick = dirOptions.find((d) => d.nodes <= GRAPH_NODE_LIMIT) ?? dirOptions[0];
    return graphData(files, edges, pick?.path ?? '');
  }, [files, edges, graphDir, dirOptions]);
  const graphColors = useMemo(() => dirColors(graph.nodes.map((n) => n.dir)), [graph]);
  const effectiveGraphDir =
    graphDir ??
    (graph.totalNodes > GRAPH_NODE_LIMIT
      ? ((dirOptions.find((d) => d.nodes <= GRAPH_NODE_LIMIT) ?? dirOptions[0])?.path ?? '')
      : '');

  const onTiming = useCallback((t: Timing) => {
    setTiming((prev) =>
      prev &&
      Math.abs(prev.layoutMs - t.layoutMs) < 0.05 &&
      Math.abs(prev.commitMs - t.commitMs) < 0.5 &&
      prev.nodes === t.nodes
        ? prev
        : t,
    );
  }, []);
  const openFile = useCallback((path: string) => setPanelPath(path), []);

  if (!repo) {
    return (
      <div className="map-empty">
        <p>{config ? 'Waiting for the repo scan…' : 'Waiting for the board…'}</p>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="map-empty">
        <p>The scan found no files.</p>
      </div>
    );
  }

  const crumbs = zoomPath ? zoomPath.split('/') : [];
  const nowDate = new Date(now);

  return (
    <div className="map" data-testid="map">
      <div className="map__bar">
        <fieldset className="seg">
          <legend className="sr-only">Layer</legend>
          <button
            type="button"
            className={`seg__btn ${layer === 'treemap' ? 'seg__btn--on' : ''}`}
            aria-pressed={layer === 'treemap'}
            onClick={() => setLayer('treemap')}
          >
            Treemap
          </button>
          <button
            type="button"
            className={`seg__btn ${layer === 'graph' ? 'seg__btn--on' : ''}`}
            aria-pressed={layer === 'graph'}
            onClick={() => setLayer('graph')}
            title={edges.length === 0 ? 'No JS/TS import edges in this repo' : undefined}
          >
            Imports{edges.length ? ` (${graph.totalNodes})` : ''}
          </button>
        </fieldset>
        {layer === 'treemap' ? (
          <>
            <fieldset className="seg">
              <legend className="sr-only">Heat</legend>
              {MAP_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`seg__btn ${mode === m.id ? 'seg__btn--on' : ''}`}
                  aria-pressed={mode === m.id}
                  title={m.title}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </fieldset>
            <nav className="crumbs mono" aria-label="Directory">
              <button
                type="button"
                className={`crumbs__item ${crumbs.length === 0 ? 'crumbs__item--here' : ''}`}
                onClick={() => setZoomPath('')}
              >
                {repoName(repo.root)}
              </button>
              {crumbs.map((seg, i) => {
                const path = crumbs.slice(0, i + 1).join('/');
                return (
                  <span key={path}>
                    <span className="crumbs__sep">/</span>
                    <button
                      type="button"
                      className={`crumbs__item ${i === crumbs.length - 1 ? 'crumbs__item--here' : ''}`}
                      onClick={() => setZoomPath(path)}
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </nav>
          </>
        ) : (
          <label className="graph-pick">
            <span className="muted">Directory</span>
            <select
              className="field__input"
              value={effectiveGraphDir}
              onChange={(e) => setGraphDir(e.target.value)}
            >
              <option value="" disabled={graph.totalNodes > GRAPH_NODE_LIMIT}>
                {graph.totalNodes > GRAPH_NODE_LIMIT
                  ? `whole repo — too big (${graph.totalNodes} > ${GRAPH_NODE_LIMIT})`
                  : `whole repo (${graph.totalNodes})`}
              </option>
              {dirOptions.map((d) => (
                <option key={d.path} value={d.path} disabled={d.nodes > GRAPH_NODE_LIMIT}>
                  {d.path} ({d.nodes}
                  {d.nodes > GRAPH_NODE_LIMIT ? ', too big' : ''})
                </option>
              ))}
            </select>
          </label>
        )}
        <Legend layer={layer} mode={mode} colors={graphColors} />
      </div>
      <div className="map__body">
        <div className="map__canvas">
          {layer === 'treemap' ? (
            <Treemap
              files={files}
              ghosts={who.ghosts}
              mode={mode}
              zoomPath={zoomPath}
              onZoom={setZoomPath}
              highlights={who.byPath}
              fun={fun}
              now={now}
              onFileClick={openFile}
              onTiming={onTiming}
            />
          ) : edges.length === 0 ? (
            <div className="map-empty">
              <p>No import edges — the graph covers JS/TS relative imports only.</p>
            </div>
          ) : (
            <Graph
              data={graph}
              colors={graphColors}
              highlights={who.byPath}
              fun={fun}
              onFileClick={openFile}
              onTiming={onTiming}
            />
          )}
        </div>
        <aside className="map__rail">
          <section className="rail__section">
            <h3 className="rail__h">Who is where</h3>
            {who.cards.length === 0 ? (
              <p className="rail__empty">
                No active card names files. Cards in an <em>active</em> column, updated in the last{' '}
                {config?.activeWindowMinutes ?? 30} min, light up their <code>files:</code> here.
                Click a card's avatar on the board to pin it.
              </p>
            ) : (
              <ul className="rail__list">
                {who.cards.map(({ card, why, assignee }) => {
                  const missing = card.files?.filter((p) => !known.has(p)).length ?? 0;
                  const isPinned = pinned.includes(card.id);
                  return (
                    <li
                      key={card.id}
                      className={`who ${hoverId === card.id ? 'who--hover' : ''}`}
                      onMouseEnter={() => store.setHover(card.id)}
                      onMouseLeave={() => store.setHover(null)}
                      data-testid={`who-${card.id}`}
                    >
                      <button
                        type="button"
                        className={`who__pin ${isPinned ? 'who__pin--on' : ''}`}
                        onClick={() => store.togglePin(card.id)}
                        aria-pressed={isPinned}
                        title={isPinned ? 'Unpin' : 'Pin: keep highlighted'}
                      >
                        <Avatar assignee={assignee} active={why === 'active'} />
                      </button>
                      <button
                        type="button"
                        className="who__body"
                        onClick={() => store.select(card.id)}
                        title={`Open ${card.id}`}
                      >
                        <span className="who__line">
                          <span className="who__id mono">{card.id}</span>
                          <span className="who__actor">{shortActor(assignee)}</span>
                          <span className={`who__why who__why--${why}`}>
                            {why === 'active' ? 'active' : why === 'pinned' ? 'pinned' : 'hover'}
                          </span>
                        </span>
                        <span className="who__title">{card.title}</span>
                        <span className="who__files mono">
                          {card.files?.length ?? 0} files
                          {missing ? ` · ${missing} missing` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {panelPath ? (
            <FilePanel
              path={panelPath}
              file={files.find((f) => f.path === panelPath) ?? null}
              cards={cardsNaming(cards, panelPath)}
              now={now}
              activeOf={(c) => (config ? findColumn(config, c.status)?.active === true : false)}
              isActiveNow={(c) =>
                config ? who.cards.some((w) => w.card.id === c.id && w.why === 'active') : false
              }
              nowDate={nowDate}
              onOpen={(id) => store.select(id)}
              onClose={() => setPanelPath(null)}
            />
          ) : null}
        </aside>
      </div>
      <div className="map__foot mono">
        {files.length} files · {edges.length} edges
        {timing
          ? ` · ${timing.nodes} nodes · layout ${timing.layoutMs.toFixed(1)} ms · commit ${timing.commitMs.toFixed(0)} ms`
          : ''}
        {' · scanned '}
        {relTime(repo.scannedAt, now)}
      </div>
    </div>
  );
}

function repoName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function Legend({
  layer,
  mode,
  colors,
}: {
  layer: Layer;
  mode: MapMode;
  colors: ReadonlyMap<string, string>;
}) {
  if (layer === 'graph') {
    return (
      <ul className="legend" aria-label="Directories">
        {[...colors.entries()].slice(0, 14).map(([dir, color]) => (
          <li key={dir} className="legend__item">
            <span className="legend__swatch" style={{ background: color }} />
            {dir}
          </li>
        ))}
      </ul>
    );
  }
  if (mode === 'recent') {
    return (
      <ul className="legend" aria-label="Last commit">
        {RECENT_RAMP.map((r) => (
          <li key={r.id} className="legend__item">
            <span className="legend__swatch" style={{ background: r.color }} />
            {r.label}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="legend" aria-label="Languages">
      {LANG_PALETTE.map((s) => (
        <li key={s.key} className="legend__item">
          <span className="legend__swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

interface FilePanelProps {
  path: string;
  file: {
    bytes: number;
    lines: number | null;
    lang: string;
    commits30d: number;
    commits90d: number;
    lastCommitAt: string | null;
  } | null;
  cards: Card[];
  now: number;
  nowDate: Date;
  activeOf: (c: Card) => boolean;
  isActiveNow: (c: Card) => boolean;
  onOpen: (id: string) => void;
  onClose: () => void;
}

function FilePanel({
  path,
  file,
  cards,
  now,
  activeOf,
  isActiveNow,
  onOpen,
  onClose,
}: FilePanelProps) {
  return (
    <section className="rail__section file-panel" data-testid="file-panel">
      <div className="file-panel__bar">
        <h3 className="rail__h">File</h3>
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="file-panel__path mono">{path}</div>
      {file ? (
        <dl className="file-panel__stats mono">
          <dt>lang</dt>
          <dd>{file.lang}</dd>
          <dt>size</dt>
          <dd>{formatBytes(file.bytes)}</dd>
          <dt>lines</dt>
          <dd>{formatLines(file.lines)}</dd>
          <dt>commits</dt>
          <dd>
            {file.commits30d} / 30d · {file.commits90d} / 90d
          </dd>
          <dt>last</dt>
          <dd>{file.lastCommitAt ? relTime(file.lastCommitAt, now) : '—'}</dd>
        </dl>
      ) : (
        <p className="rail__empty">
          Not in the repo scan — a card names it, the disk does not have it.
        </p>
      )}
      <h4 className="rail__h4">
        {cards.length === 0
          ? 'No card names this file'
          : `${cards.length} card${cards.length === 1 ? '' : 's'}`}
      </h4>
      <ul className="rail__list">
        {cards.map((c) => {
          const assignee = c.assignee ?? 'unassigned';
          return (
            <li key={c.id} className="who">
              <span className="who__pin">
                <Avatar assignee={assignee} active={isActiveNow(c)} />
              </span>
              <button type="button" className="who__body" onClick={() => onOpen(c.id)}>
                <span className="who__line">
                  <span className="who__id mono">{c.id}</span>
                  <span className={`chip ${activeOf(c) ? 'chip--active-col' : ''}`}>
                    {c.status}
                  </span>
                </span>
                <span className="who__title">{c.title}</span>
                <span className="who__files mono">
                  {shortActor(assignee)} · {avatarFor(assignee).emoji}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
