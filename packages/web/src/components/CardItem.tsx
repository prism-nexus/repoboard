import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card } from '@repoboard/core';
import type { Arrival } from '../hooks.js';
import { Avatar } from './Avatar.jsx';

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
}

export function CardItem({
  card,
  active,
  arrival,
  fun,
  onOpen,
  pinned = false,
  onPin,
  onHover,
  overlay = false,
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
        <button type="button" className="card__title" onClick={() => onOpen(card.id)}>
          {card.title}
        </button>
        {(card.labels?.length || card.files?.length) && (
          <div className="card__meta">
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
          </div>
        )}
      </div>
    </div>
  );
}
