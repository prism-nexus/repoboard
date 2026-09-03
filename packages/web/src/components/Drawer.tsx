import type { Card, ResolvedRef } from '@repoboard/core';
import { useEffect, useMemo, useState } from 'react';
import { renderMarkdown, splitBody } from '../markdown.js';
import type { ColumnCards } from '../store.js';
import { relTime, shortActor } from '../time.js';
import { Avatar } from './Avatar.jsx';

interface Props {
  card: Card;
  columns: ColumnCards[];
  active: boolean;
  now: number;
  onClose: () => void;
  onMove: (id: string, status: string) => void;
  onUpdate: (id: string, patch: { title?: string; assignee?: string | null }) => void;
  /** P4.3: pin this card and switch to the map. */
  onShowOnMap?: (id: string) => void;
}

/** Slide-in card detail. ESC closes. Title/assignee commit on blur or Enter; status on change. */
export function Drawer({
  card,
  columns,
  active,
  now,
  onClose,
  onMove,
  onUpdate,
  onShowOnMap,
}: Props) {
  const [title, setTitle] = useState(card.title);
  const [assignee, setAssignee] = useState(card.assignee ?? '');
  // Reset drafts when a different card (or a fresh echo of this one) arrives.
  useEffect(() => setTitle(card.title), [card.title]);
  useEffect(() => setAssignee(card.assignee ?? ''), [card.assignee]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { description, log } = useMemo(() => splitBody(card.body), [card.body]);
  const html = useMemo(() => renderMarkdown(description), [description]);
  const refs = useRefs(card);

  const commitTitle = () => {
    const t = title.trim();
    if (t && t !== card.title) onUpdate(card.id, { title: t });
    else setTitle(card.title);
  };
  const commitAssignee = () => {
    const a = assignee.trim();
    if (a === (card.assignee ?? '')) return;
    onUpdate(card.id, { assignee: a === '' ? null : a });
  };
  const onEnter = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      e.currentTarget.blur();
    }
  };
  const statusKnown = columns.some((c) => c.id === card.status);

  return (
    <aside
      className="drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="drawer-title"
      data-testid="drawer"
    >
      <div className="drawer__bar">
        <span className={`mono drawer__id ${card.priority ? `pri-${card.priority}` : ''}`}>
          {card.id}
        </span>
        {card.priority ? (
          <span className={`chip chip--${card.priority}`}>{card.priority}</span>
        ) : null}
        {active ? <span className="drawer__active">active</span> : null}
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close (Esc)">
          ×
        </button>
      </div>
      <input
        id="drawer-title"
        className="drawer__title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={onEnter(commitTitle)}
        aria-label="Title"
      />
      <div className="drawer__fields">
        <label className="field">
          <span className="field__label">Status</span>
          <select
            className="field__input mono"
            value={card.status}
            onChange={(e) => onMove(card.id, e.target.value)}
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
            {statusKnown ? null : <option value={card.status}>{card.status}</option>}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Assignee</span>
          <span className="field__row">
            {card.assignee ? <Avatar assignee={card.assignee} active={active} /> : null}
            <input
              className="field__input mono"
              value={assignee}
              placeholder="nobody"
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={commitAssignee}
              onKeyDown={onEnter(commitAssignee)}
            />
          </span>
        </label>
        <div className="field">
          <span className="field__label">Updated</span>
          <span className="mono field__static" title={card.updated}>
            {relTime(card.updated, now)}
          </span>
        </div>
      </div>
      {card.labels?.length ? (
        <div className="drawer__labels">
          {card.labels.map((l) => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
        </div>
      ) : null}
      {card.files?.length ? (
        <section className="drawer__section">
          <h3>
            Files
            {onShowOnMap ? (
              <button
                type="button"
                className="drawer__map-link"
                onClick={() => onShowOnMap(card.id)}
              >
                show on map →
              </button>
            ) : null}
          </h3>
          <ul className="drawer__files mono">
            {card.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="drawer__section">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      </section>
      {card.refs?.length ? <References refs={refs} specs={card.refs} /> : null}
      {log.length ? (
        <section className="drawer__section">
          <h3>Log</h3>
          <ol className="timeline">
            {log.map((entry, i) => (
              <li key={`${entry.ts ?? 'x'}-${i.toString()}`} className="timeline__item">
                {entry.actor ? (
                  <Avatar assignee={entry.actor} />
                ) : (
                  <span className="timeline__dot" />
                )}
                <div className="timeline__text">
                  <span className="timeline__who">
                    {entry.actor ? shortActor(entry.actor) : ''}
                    {entry.ts ? (
                      <span className="mono muted" title={entry.ts}>
                        {' '}
                        {relTime(entry.ts, now)}
                      </span>
                    ) : null}
                  </span>
                  <span className="timeline__msg">{entry.message}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </aside>
  );
}

type RefsState =
  | { kind: 'loading' }
  | { kind: 'ok'; refs: ResolvedRef[] }
  | { kind: 'error'; message: string };

/**
 * K7: the referenced lines, fetched from the server when the drawer opens and again on every
 * `card` echo for this id (the store replaces the card object, so its identity is the trigger).
 * Never cached across cards: a new card id starts from `loading`.
 */
function useRefs(card: Card): RefsState {
  const [state, setState] = useState<RefsState>({ kind: 'loading' });
  const specs = card.refs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `card` identity is the refetch trigger (every card WS message), by design
  useEffect(() => {
    if (!specs?.length) return;
    let alive = true;
    setState({ kind: 'loading' });
    const url = `/api/cards/${encodeURIComponent(card.id)}/refs`;
    const load = async (): Promise<RefsState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return { kind: 'error', message: `${url} → not an array` };
      return { kind: 'ok', refs: data as ResolvedRef[] };
    };
    load()
      .catch(
        (e: unknown): RefsState => ({
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
  }, [card]);
  return state;
}

function refRange(r: ResolvedRef): string {
  if (r.start === null || r.end === null) return r.spec;
  const range = r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
  return `${r.path ?? r.spec}:${range}`;
}

function References({ refs, specs }: { refs: RefsState; specs: string[] }) {
  return (
    <section className="drawer__section" data-testid="drawer-refs">
      <h3>References</h3>
      {refs.kind === 'loading' ? (
        <ul className="drawer__files mono muted">
          {specs.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : refs.kind === 'error' ? (
        <div className="drawer__ref drawer__ref--error" role="alert">
          <div className="drawer__ref-head mono">could not load references</div>
          <div className="drawer__ref-error">{refs.message}</div>
        </div>
      ) : (
        refs.refs.map((r, i) => <Reference key={`${r.spec}-${i.toString()}`} r={r} />)
      )}
    </section>
  );
}

function Reference({ r }: { r: ResolvedRef }) {
  if (r.text === null) {
    return (
      <div className="drawer__ref drawer__ref--error" data-testid="ref-error">
        <div className="drawer__ref-head mono">{r.spec}</div>
        <div className="drawer__ref-error">{r.error ?? 'unresolved'}</div>
      </div>
    );
  }
  const isMarkdown = /\.(md|markdown)$/i.test(r.path ?? '');
  return (
    <div className="drawer__ref" data-testid="ref">
      <div className="drawer__ref-head mono">
        {refRange(r)}
        {r.truncated ? <span className="muted"> (truncated)</span> : null}
      </div>
      {isMarkdown ? (
        <div
          className="prose drawer__ref-body"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }}
        />
      ) : (
        <pre className="drawer__ref-body mono">{r.text}</pre>
      )}
    </div>
  );
}
