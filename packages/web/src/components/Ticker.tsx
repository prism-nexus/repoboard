import { avatarFor, type Event } from '@repoboard/core';
import { relTime, shortActor } from '../time.js';

interface Props {
  events: Event[];
  fun: boolean;
  now: number;
}

const SHOWN = 10;

function Line({ e, now }: { e: Event; now: number }) {
  const { emoji, color } = avatarFor(e.actor);
  return (
    <span className="ticker__item">
      <span className="ticker__emoji" style={{ color }} aria-hidden="true">
        {emoji}
      </span>
      <span className="ticker__actor">{shortActor(e.actor)}</span> moved{' '}
      <span className="mono">{e.cardId}</span> → <span className="mono">{e.to}</span>
      <span className="ticker__when"> · {relTime(e.ts, now)}</span>
    </span>
  );
}

/** Last ~10 events. Scrolls when fun is on; a single static line when it is off. */
export function Ticker({ events, fun, now }: Props) {
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
        <Line e={latest} now={now} />
      </div>
    );
  }
  const key = (e: Event, i: number) => `${e.ts}-${e.cardId}-${i}`;
  return (
    <div className="ticker ticker--scroll" aria-live="off">
      <div className="ticker__track" style={{ '--items': recent.length } as React.CSSProperties}>
        {recent.map((e, i) => (
          <Line key={key(e, i)} e={e} now={now} />
        ))}
        {recent.map((e, i) => (
          <Line key={`dup-${key(e, i)}`} e={e} now={now} />
        ))}
      </div>
    </div>
  );
}
