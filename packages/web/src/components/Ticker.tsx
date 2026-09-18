import { avatarFor, type Card, type Event } from '@repoboard/core';
import { useMemo } from 'react';
import { relTime, shortActor } from '../time.js';

interface Props {
  events: Event[];
  cards: Card[];
  fun: boolean;
  now: number;
}

const SHOWN = 10;

/** RCB-44: truncate a card title for the ticker line. 48 chars or fewer is untouched; longer
 * is cut to 47 chars plus a single U+2026 ellipsis. */
export function shortTitle(title: string, max = 48): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

function Line({ e, now, titles }: { e: Event; now: number; titles: Map<string, string> }) {
  const { emoji, color } = avatarFor(e.actor);
  // RCB-44: a missing title (no cardId, or the card is gone — archived/removed) renders as
  // nothing, never a placeholder like "untitled".
  const title = e.cardId ? titles.get(e.cardId) : undefined;
  return (
    <span className="ticker__item">
      <span className="ticker__emoji" style={{ color }} aria-hidden="true">
        {emoji}
      </span>
      <span className="ticker__actor">{shortActor(e.actor)}</span> moved{' '}
      <span className="mono">{e.cardId}</span>{' '}
      {title ? <span className="ticker__title">{shortTitle(title)}</span> : null} →{' '}
      <span className="mono">{e.to}</span>
      <span className="ticker__when"> · {relTime(e.ts, now)}</span>
    </span>
  );
}

/** Last ~10 events. Scrolls when fun is on; a single static line when it is off. */
export function Ticker({ events, cards, fun, now }: Props) {
  // RCB-44: id → title, built once per render of the cards list (not per event).
  const titles = useMemo(() => new Map(cards.map((c) => [c.id, c.title])), [cards]);
  const recent = events.slice(-SHOWN).reverse();
  const latest = recent[0];
  if (!latest) {
    return (
      <div className="ticker ticker--empty" aria-live="polite">
        <span className="ticker__item">No moves yet. Drag a card, or let an agent work.</span>
      </div>
    );
  }
  if (!fun) {
    return (
      <div className="ticker ticker--static" aria-live="polite">
        <Line e={latest} now={now} titles={titles} />
      </div>
    );
  }
  const key = (e: Event, i: number) => `${e.ts}-${e.cardId}-${i}`;
  return (
    <div className="ticker ticker--scroll" aria-live="off">
      <div className="ticker__track" style={{ '--items': recent.length } as React.CSSProperties}>
        {recent.map((e, i) => (
          <Line key={key(e, i)} e={e} now={now} titles={titles} />
        ))}
        {recent.map((e, i) => (
          <Line key={`dup-${key(e, i)}`} e={e} now={now} titles={titles} />
        ))}
      </div>
    </div>
  );
}
