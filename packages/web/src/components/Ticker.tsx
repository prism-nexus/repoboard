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

/**
 * RCB-65: one verb (or short verb phrase) per `Event.type` — the contract is the table in
 * `docs/RCB-65-TICKER-VERBS-BRIEF.md`. The switch has NO `default`: if `Event['type']` ever
 * grows a tenth member, the `never` assignment below fails to typecheck right here instead of a
 * new event type silently reading "moved".
 */
export function tickerVerb(e: Event): string {
  switch (e.type) {
    case 'move':
      return 'moved';
    case 'create':
      return 'created';
    case 'update':
      return 'updated';
    case 'ask':
      return 'asked on';
    case 'decide':
      return 'decided';
    case 'note':
      return 'noted on';
    case 'archive':
      return 'archived';
    case 'lease':
      return e.to === 'released' ? 'released' : 'took';
    case 'window':
      return 'added window';
    case 'columns':
      return 'set columns';
  }
  const exhaustive: never = e.type;
  return exhaustive;
}

/**
 * RCB-65: the per-type line body (everything between the emoji and the "· <relTime>" suffix).
 * `parts` carries the pre-rendered actor/id/title/resource spans so this switch only decides
 * shape (arrow or not, which fields, which words). Same exhaustiveness guard as `tickerVerb`:
 * no `default`, so a tenth `Event.type` fails typecheck here too.
 */
function lineBody(
  e: Event,
  parts: {
    actor: React.ReactNode;
    id: React.ReactNode;
    title: React.ReactNode;
    resource: React.ReactNode;
  },
): React.ReactNode {
  const { actor, id, title, resource } = parts;
  switch (e.type) {
    case 'move':
      return (
        <>
          {actor} {tickerVerb(e)} {id} {title} → <span className="mono">{e.to}</span>
        </>
      );
    case 'create':
      return (
        <>
          {actor} {tickerVerb(e)} {id} {title} in <span className="mono">{e.to}</span>
        </>
      );
    case 'update':
    case 'ask':
    case 'note':
    case 'archive':
      return (
        <>
          {actor} {tickerVerb(e)} {id} {title}
        </>
      );
    case 'decide':
      return (
        <>
          {actor} {tickerVerb(e)} {id} {title}
          {e.letter ? (
            <>
              {' '}
              → <span className="mono">{e.letter}</span>
            </>
          ) : null}
        </>
      );
    case 'lease':
      return (
        <>
          {actor} {tickerVerb(e)} {resource}
        </>
      );
    case 'window':
      return (
        <>
          {actor} {tickerVerb(e)} <span className="mono">{e.to}</span> on {resource}
        </>
      );
    case 'columns':
      return (
        <>
          {actor} {tickerVerb(e)} → <span className="mono">{e.to}</span>
        </>
      );
  }
  const exhaustive: never = e.type;
  return exhaustive;
}

function Line({ e, now, titles }: { e: Event; now: number; titles: Map<string, string> }) {
  const { emoji, color } = avatarFor(e.actor);
  // RCB-44: a missing title (no cardId, or the card is gone — archived/removed) renders as
  // nothing, never a placeholder like "untitled".
  const title = e.cardId ? titles.get(e.cardId) : undefined;
  const parts = {
    actor: <span className="ticker__actor">{shortActor(e.actor)}</span>,
    id: <span className="mono">{e.cardId}</span>,
    // RCB-44's rule, unchanged: absent when there is no cardId or the card is gone.
    title: title ? <span className="ticker__title">{shortTitle(title)}</span> : null,
    // `resource` is optional on the type; never let a missing one render the word "undefined".
    resource: <span className="mono">{e.resource ?? ''}</span>,
  };
  return (
    <span className="ticker__item">
      <span className="ticker__emoji" style={{ color }} aria-hidden="true">
        {emoji}
      </span>
      {lineBody(e, parts)}
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
