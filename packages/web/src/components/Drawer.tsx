import type { Card } from '@rcb/core';
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
}

/** Slide-in card detail. ESC closes. Title/assignee commit on blur or Enter; status on change. */
export function Drawer({ card, columns, active, now, onClose, onMove, onUpdate }: Props) {
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
          <h3>Files</h3>
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
