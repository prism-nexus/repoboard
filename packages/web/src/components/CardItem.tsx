import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card, Decision, Size } from '@repoboard/core';
import { memo } from 'react';
import type { Arrival } from '../hooks.js';
import { gateChipText, type PhaseInfo } from '../store.js';
import { Avatar } from './Avatar.jsx';

/** RCB-67: the scale, quoted wherever a size is named — also the chip's `title`. */
export const SIZE_TITLE: Record<Size, string> = {
  S: 'S — one builder turn (≤ 2 h)',
  M: 'M — half a day, brief + tests',
  L: 'L — investigation first, days',
  XL: 'XL — plan-sized',
};

/**
 * RCB-68: a step's `phase`/`blocked` chips and a phase card's `rollup` chips. `phase` is
 * `undefined`/`null` (absent all of it) for a plain card — nothing is rendered, so a plain card's
 * DOM is byte-identical to before this card.
 */
function PhaseChips({ phase, cardId }: { phase: PhaseInfo; cardId: string }) {
  return (
    <>
      {phase.phase !== null ? <span className="chip chip--phase">{phase.phase}</span> : null}
      {phase.blocked !== null ? (
        <span
          className="chip chip--blocked"
          title={phase.blocked}
          data-testid={`blocked-${cardId}`}
        >
          blocked
        </span>
      ) : null}
      {phase.rollup !== null ? (
        <span className="chip chip--rollup">
          {phase.rollup.done}/{phase.rollup.total} done
        </span>
      ) : null}
      {phase.rollup?.blockedOn ? (
        <span className="chip chip--blocked" title={phase.rollup.blockedOn}>
          blocked on {gateChipText(phase.rollup.blockedOn)}
        </span>
      ) : null}
    </>
  );
}

/**
 * P8.1: an OPEN decision shows a warning `?` (and the option letters, when there are any) so the
 * owner sees the question and its choices from the board without opening the card. A DECIDED
 * card shows the chosen letter (or a checkmark for a words-only answer) as a small chip.
 */
function DecisionMark({ decision, cardId }: { decision: Decision; cardId: string }) {
  const open = decision.chosen === null && decision.decidedAt === null;
  const task = decision.kind === 'task';
  if (open) {
    if (task) {
      return (
        <span
          className="card__decision"
          title={`owner task: ${decision.question}`}
          data-testid={`decision-badge-${cardId}`}
        >
          <span className="card__decision-mark card__decision-mark--task">!</span>
        </span>
      );
    }
    return (
      <span
        className="card__decision"
        title={`needs a decision: ${decision.question}`}
        data-testid={`decision-badge-${cardId}`}
      >
        <span className="card__decision-mark">?</span>
        {decision.options.length > 0 ? (
          <span className="card__decision-letters">
            {decision.options.map((o) => o.letter).join(' ')}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className="chip chip--decided"
      title={`Decided${decision.chosen ? ` ${decision.chosen}` : ''}${
        decision.words ? ` — "${decision.words}"` : ''
      }`}
      data-testid={`decision-chip-${cardId}`}
    >
      {decision.chosen ?? '✓'}
    </span>
  );
}

interface Props {
  card: Card;
  active: boolean;
  arrival?: Arrival;
  fun: boolean;
  onOpen: (id: string) => void;
  /** P4.3: this card's files stay highlighted on the map. */
  pinned?: boolean;
  /** Avatar click: pin/unpin on the map. */
  onPin?: (id: string) => void;
  /** Pointer over the card: its files light up on the map. */
  onHover?: (id: string | null) => void;
  /** Render as the DragOverlay ghost: no sortable wiring. */
  overlay?: boolean;
  /** RCB-68: `phaseInfoFor(card, cards, config)` — absent/null for a card with no phase, gate or
   * children, which keeps its DOM byte-identical to before this card. */
  phase?: PhaseInfo | null;
}

/** RCB-151: memoized (default shallow prop compare) — at N cards on a board, an unmemoized
 * `CardItem` re-renders on every store change even when its own props didn't change (a select, a
 * filter toggle, a sort change). Every prop `Board.tsx` passes is built to stay referentially
 * stable across such a render (see that file's `phaseById`/`parentIds` memos and its
 * `useCallback`-wrapped handlers), so this memo actually skips work instead of always re-rendering
 * on a new inline object/function. */
export const CardItem = memo(function CardItem({
  card,
  active,
  arrival,
  fun,
  onOpen,
  pinned = false,
  onPin,
  onHover,
  overlay = false,
  phase = null,
}: Props) {
  const sortable = useSortable({
    id: card.id,
    data: { type: 'card', status: card.status },
    disabled: overlay,
  });
  const style: React.CSSProperties = overlay
    ? {}
    : { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition };
  const slide =
    fun && arrival ? (arrival.dir < 0 ? 'card__body--from-right' : 'card__body--from-left') : '';
  const bounce = fun && arrival?.toActive === true;
  const cls = [
    'card',
    card.priority ? `card--${card.priority}` : 'card--none',
    active ? 'card--active' : '',
    sortable.isDragging && !overlay ? 'card--dragging' : '',
    overlay ? 'card--overlay' : '',
    pinned ? 'card--pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover is a preview for the map; the buttons inside are the keyboard path
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      className={cls}
      style={style}
      data-testid={`card-${card.id}`}
      data-card={card.id}
      onMouseEnter={onHover ? () => onHover(card.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      {...(overlay ? {} : sortable.attributes)}
      {...(overlay ? {} : sortable.listeners)}
    >
      <div className={`card__body ${slide}`}>
        <div className="card__head">
          <button
            type="button"
            className="card__id"
            onClick={() => onOpen(card.id)}
            title={`Open ${card.id}`}
          >
            {card.id}
          </button>
          {card.decision ? <DecisionMark decision={card.decision} cardId={card.id} /> : null}
          {card.assignee ? (
            <button
              type="button"
              className={`card__pin ${pinned ? 'card__pin--on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onPin?.(card.id);
              }}
              aria-pressed={pinned}
              title={pinned ? 'Pinned on the map — click to unpin' : 'Pin on the map'}
              data-testid={`pin-${card.id}`}
            >
              <Avatar assignee={card.assignee} active={active} bounce={bounce} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="card__title"
          onClick={() => onOpen(card.id)}
          title={card.title}
        >
          {card.title}
        </button>
        {(card.size || card.labels?.length || card.files?.length || card.refs?.length || phase) && (
          <div className="card__meta">
            {card.size ? (
              <span
                className="chip chip--size"
                data-testid={`size-${card.id}`}
                title={SIZE_TITLE[card.size]}
              >
                {card.size}
              </span>
            ) : null}
            {card.labels?.map((l) => (
              <span key={l} className="chip">
                {l}
              </span>
            ))}
            {card.files?.length ? (
              <span className="card__files" title={card.files.join('\n')}>
                {card.files.length} {card.files.length === 1 ? 'file' : 'files'}
              </span>
            ) : null}
            {card.refs?.length ? (
              <span className="card__files" title={card.refs.join('\n')} data-testid="ref-count">
                {card.refs.length} {card.refs.length === 1 ? 'ref' : 'refs'}
              </span>
            ) : null}
            {phase ? <PhaseChips phase={phase} cardId={card.id} /> : null}
          </div>
        )}
      </div>
    </div>
  );
});
