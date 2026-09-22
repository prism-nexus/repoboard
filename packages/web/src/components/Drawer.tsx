import type { BoardConfig, Card, Decision, ResolvedRef, Size } from '@repoboard/core';
import { gateState, rollup, stepsOf } from '@repoboard/core';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../hooks.js';
import { type LogEntry, renderMarkdown, renderNote, splitBody } from '../markdown.js';
import { apiPath } from '../repo-key.js';
import type { ColumnCards } from '../store.js';
import { relTime, shortActor } from '../time.js';
import { Avatar } from './Avatar.jsx';
import { RefsList } from './RefsList.jsx';

interface Props {
  card: Card;
  columns: ColumnCards[];
  active: boolean;
  now: number;
  onClose: () => void;
  onMove: (id: string, status: string) => void;
  onUpdate: (
    id: string,
    patch: { title?: string; assignee?: string | null; size?: Size | null },
  ) => void;
  /** P4.3: pin this card and switch to the map. */
  onShowOnMap?: (id: string) => void;
  /** P8.1: answer the card's open decision. */
  onDecide?: (id: string, input: { letter?: string; words?: string }) => void;
  /** RCB-70: append a durable, attributed remark under `## Notes`; resolves to whether it succeeded. */
  onAddNote?: (id: string, text: string, actor: string) => Promise<boolean>;
  /** RCB-68: every card on the board — read-only phase/gate lookups need the whole board, not
   * just this one card. */
  cards?: Card[];
  config?: BoardConfig | null;
  /** RCB-68: open another card (the parent, or a step) from the Phase block. */
  onOpen?: (id: string) => void;
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
  onDecide,
  onAddNote,
  cards = [],
  config = null,
  onOpen,
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

  const { description, notes, log } = useMemo(() => splitBody(card.body), [card.body]);
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
        <select
          className="field__input mono drawer__size"
          aria-label="Size"
          data-testid="size-select"
          value={card.size ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            onUpdate(card.id, { size: v === '' ? null : (v as Size) });
          }}
        >
          <option value="">—</option>
          <option value="S">S</option>
          <option value="M">M</option>
          <option value="L">L</option>
          <option value="XL">XL</option>
        </select>
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
      {card.decision ? (
        <DecisionSection
          decision={card.decision}
          now={now}
          onDecide={(input) => onDecide?.(card.id, input)}
        />
      ) : null}
      <PhaseSection card={card} cards={cards} config={config} onOpen={onOpen} />
      <NotesSection cardId={card.id} notes={notes} now={now} onAddNote={onAddNote} />
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
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [state, setState] = useState<RefsState>({ kind: 'loading' });
  const specs = card.refs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `card` identity is the refetch trigger (every card WS message), by design
  useEffect(() => {
    if (!specs?.length) return;
    let alive = true;
    setState({ kind: 'loading' });
    const url = apiPath(`/api/cards/${encodeURIComponent(card.id)}/refs`, repoKey);
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
        <RefsList refs={refs.refs} />
      )}
    </section>
  );
}

/**
 * P8.1: the Decision section, above the description. An OPEN decision shows one button per
 * option (letter bold, text beside it), a single-line words field, and a Decide button enabled
 * once a letter is picked or words are typed. A DECIDED card shows the answer and goes quiet —
 * no buttons, no fun (D9: readability wins here).
 */
function DecisionSection({
  decision,
  now,
  onDecide,
}: {
  decision: Decision;
  now: number;
  onDecide: (input: { letter?: string; words?: string }) => void;
}) {
  const open = decision.chosen === null && decision.decidedAt === null;
  const task = decision.kind === 'task';
  const [letter, setLetter] = useState<string | null>(null);
  const [words, setWords] = useState('');
  // A fresh question (or a hand edit that reopened one) clears any half-typed draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys on the question identity, not on letter/words themselves
  useEffect(() => {
    setLetter(null);
    setWords('');
  }, [decision.question, decision.askedAt]);

  if (!open) {
    return (
      <section className="drawer__section drawer__decision" data-testid="decision-section">
        <h3>{task ? 'Owner task' : 'Decision'}</h3>
        <p className="drawer__decision-question">{decision.question}</p>
        <p className="drawer__decision-answer" data-testid="decision-answer">
          {task ? 'Done' : 'Decided'}
          {decision.chosen ? ` ${decision.chosen}` : ''}
          {decision.words ? ` — "${decision.words}"` : ''} by {decision.decidedBy ?? 'unknown'}
          {decision.decidedAt ? (
            <>
              {' '}
              <span className="mono muted" title={decision.decidedAt}>
                {relTime(decision.decidedAt, now)}
              </span>
            </>
          ) : null}
        </p>
      </section>
    );
  }

  const canDecide = task || letter !== null || words.trim().length > 0;
  return (
    <section className="drawer__section drawer__decision" data-testid="decision-section">
      <h3>{task ? 'Owner task' : 'Decision'}</h3>
      <p className="drawer__decision-question">{decision.question}</p>
      {decision.options.length > 0 ? (
        <div className="drawer__decision-options">
          {decision.options.map((o) => (
            <button
              key={o.letter}
              type="button"
              className={`drawer__decision-option ${
                letter === o.letter ? 'drawer__decision-option--on' : ''
              }`}
              aria-pressed={letter === o.letter}
              onClick={() => setLetter((cur) => (cur === o.letter ? null : o.letter))}
              data-testid={`decision-option-${o.letter}`}
            >
              <strong>{o.letter}</strong> {o.text}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="field__input mono drawer__decision-words"
        placeholder={task ? 'notes, optional' : 'your words, kept verbatim'}
        value={words}
        onChange={(e) => setWords(e.target.value)}
        aria-label="Your words"
      />
      <button
        type="button"
        className="toggle drawer__decision-submit"
        disabled={!canDecide}
        onClick={() => onDecide({ letter: letter ?? undefined, words: words.trim() || undefined })}
      >
        {task ? 'Done' : 'Decide'}
      </button>
    </section>
  );
}

/**
 * RCB-68: read-only — the CLI/MCP/PATCH are the writers, not this drawer. On a step: the parent
 * (a button that opens it), the `phase` chip, and the gate's state line. On a phase card: the
 * steps list (`stepsOf`), one row each. Absent all three fields and any children → renders
 * nothing, DOM byte-identical to before this card (same rule `CardItem`'s chips follow).
 */
function PhaseSection({
  card,
  cards,
  config,
  onOpen,
}: {
  card: Card;
  cards: Card[];
  config: BoardConfig | null;
  onOpen?: (id: string) => void;
}) {
  if (!config) return null;
  const isStep = card.parent !== undefined || card.phase !== undefined || card.gate !== undefined;
  const cardRollup = rollup(card, cards, config);
  if (!isStep && !cardRollup) return null;

  const parentId = card.parent;
  const parentCard = parentId !== undefined ? (cards.find((c) => c.id === parentId) ?? null) : null;
  const gate = card.gate !== undefined ? gateState(card, cards, config) : null;
  const steps = cardRollup ? stepsOf(card.id, cards) : [];

  return (
    <section className="drawer__section drawer__phase" data-testid="phase-section">
      <h3>Phase</h3>
      {isStep ? (
        <div className="drawer__phase-step">
          {parentId !== undefined ? (
            <button
              type="button"
              className="drawer__phase-parent"
              onClick={() => onOpen?.(parentId)}
              data-testid="phase-parent-open"
              title={`Open ${parentId}`}
            >
              {parentId} {parentCard ? `— ${parentCard.title}` : '(no such card)'}
            </button>
          ) : null}
          {card.phase !== undefined ? <span className="chip chip--phase">{card.phase}</span> : null}
          {gate ? (
            <p className="drawer__phase-gate" data-testid="phase-gate-state">
              {gate.kind === 'clear'
                ? `clear — ${gate.by}`
                : gate.kind === 'blocked'
                  ? gate.reason
                  : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      {cardRollup ? (
        <ul className="drawer__phase-steps">
          {steps.map((step) => {
            const state = gateState(step, cards, config);
            return (
              <li
                key={step.id}
                className="drawer__phase-step-row"
                data-testid={`phase-step-${step.id}`}
              >
                <button
                  type="button"
                  className="drawer__phase-step-open"
                  onClick={() => onOpen?.(step.id)}
                  title={`Open ${step.id}`}
                >
                  {step.id}
                </button>
                {step.phase !== undefined ? (
                  <span className="chip chip--phase">{step.phase}</span>
                ) : null}
                <span className="mono muted">{step.status}</span>
                {state.kind === 'blocked' ? (
                  <span
                    className="chip chip--blocked"
                    title={state.reason}
                    data-testid={`phase-step-blocked-${step.id}`}
                  >
                    blocked
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

const NOTE_ACTOR_KEY = 'repoboard.noteActor';

/** A private window (or disabled storage) throws on either call — never let that crash the drawer. */
function readStoredNoteActor(): string {
  try {
    return localStorage.getItem(NOTE_ACTOR_KEY) || 'owner';
  } catch {
    return 'owner';
  }
}

function storeNoteActor(value: string): void {
  try {
    localStorage.setItem(NOTE_ACTOR_KEY, value);
  } catch {
    // ignore — nothing else can be done about a hostile/private storage
  }
}

/**
 * RCB-70: the owner's remarks on a card — a `## Notes` timeline (rendered through
 * `renderMarkdown`, like the description) and the box that appends to it. Renders even with zero
 * notes: the box is the point. Above the description, below the decision section (the owner's
 * remarks belong beside the decision they explain).
 */
function NotesSection({
  cardId,
  notes,
  now,
  onAddNote,
}: {
  cardId: string;
  notes: LogEntry[];
  now: number;
  onAddNote?: (id: string, text: string, actor: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [by, setBy] = useState(readStoredNoteActor);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !onAddNote) return;
    // The line shape is `- <ts> <actor> — <text>` with a whitespace-free actor (`formatLogLine`'s
    // parse in markdown.ts); a blank `by` falls back to `owner`, inner spaces become `-`.
    const actor = by.trim().split(/\s+/).join('-') || 'owner';
    // The textarea clears only once the promise resolves TRUE — a failure toasts (the store's own
    // job) and keeps the draft so the owner can retry without retyping it.
    void onAddNote(cardId, trimmed, actor).then((succeeded) => {
      if (succeeded) setText('');
    });
  };

  return (
    <section className="drawer__section" data-testid="notes-section">
      <h3>Notes</h3>
      {notes.length ? (
        <ol className="timeline">
          {notes.map((entry, i) => (
            <li key={`${entry.ts ?? 'x'}-${i.toString()}`} className="timeline__item">
              {entry.actor ? <Avatar assignee={entry.actor} /> : <span className="timeline__dot" />}
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
                <NoteMessage text={entry.message} />
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="notes">
        <textarea
          className="field__input notes__box"
          placeholder="Add a note…"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          }}
        />
        <div className="field__row">
          <input
            className="field__input mono"
            value={by}
            aria-label="Noted by"
            onChange={(e) => {
              setBy(e.target.value);
              storeNoteActor(e.target.value);
            }}
          />
          <button
            type="button"
            className="toggle"
            disabled={text.trim().length === 0}
            onClick={submit}
          >
            Add note
          </button>
        </div>
      </div>
    </section>
  );
}

/** A note's message, rendered through `renderNote` (DOMPurify-sanitized, single newline = `<br>`). */
function NoteMessage({ text }: { text: string }) {
  const html = renderNote(text);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderNote
  return <div className="timeline__msg prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
