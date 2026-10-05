/**
 * RCB-218: SEATS, the live view — one block per seat: its symbol, name and pane, "up since" /
 * "down since", what it is working on (the Doing cards assigned to it), what it has in flight,
 * what it owes, and its last two `seat` events. A seat that says UP but whose holder is dead says
 * how to take it over. Doing cards no seat holds are listed as unclaimed. This replaces the old
 * LIVE row ("seats is live and what is happening right now") and the STATE.md SEATS prose.
 */
import type { Card, Event } from '@repoboard/core';
import { useEffect, useRef, useState } from 'react';
import { relTime, shortActor } from '../time.js';
import type { SeatRowPayload } from '../wire.js';
import { DeckPanel } from './DeckPanel.jsx';
import {
  ageOf,
  cardsOfSeat,
  lastSeatEvents,
  SEAT_SYMBOL,
  type SeatKind,
  seatKey,
  seatKind,
  whenLabel,
} from './status-model.js';
import { tickerVerb } from './Ticker.jsx';

interface Props {
  seats: SeatRowPayload[];
  /** The Doing cards (cards in an `active` column), in board order. */
  doing: Card[];
  /** The Doing cards no UP seat holds — `[]` when there are no seats at all. */
  unclaimed: Card[];
  events: Event[];
  now: number;
  stateMissing: boolean;
  /** A pill was clicked: scroll that seat's block into view and flash it. `tick` changes per click
   * so clicking the same pill twice flashes twice. */
  focus: { name: string; tick: number } | null;
}

const KIND_LABEL: Record<SeatKind, string> = {
  up: 'up',
  down: 'down',
  dead: 'says up, but its holder is dead',
  unknown: 'says up, liveness unknown',
};

/** A bullet's `in-flight:` / `owes:` value: `null` is "the bullet has no such line", never "none". */
function Field({ value }: { value: string | null }) {
  if (value === null) return <span className="muted">not recorded</span>;
  if (value === '') return <span className="muted">—</span>;
  return <>{value}</>;
}

function SeatBlock({
  row,
  doing,
  events,
  now,
  flash,
  register,
}: {
  row: SeatRowPayload;
  doing: Card[];
  events: Event[];
  now: number;
  flash: boolean;
  register: (name: string, el: HTMLElement | null) => void;
}) {
  const kind = seatKind(row);
  // RCB-184: a home row is read-only here — its working-on cards, seat events and takeover live
  // on the home board, so none of the three is drawn (and none is looked up by a colliding name).
  const isHome = row.home !== null;
  const key = seatKey(row);
  const working = row.status === 'UP' && !isHome ? cardsOfSeat(doing, row) : [];
  const seen = isHome ? [] : lastSeatEvents(events, row.name);
  const word = row.status === 'UP' ? 'up' : 'down';
  const since = row.at
    ? `${word} since ${whenLabel(row.at, now)} (${relTime(row.at, now)})`
    : `${word}, stamp not readable`;
  return (
    <div
      className={`seat seat--${kind}${flash ? ' seat--flash' : ''}`}
      data-testid={`seat-block-${key}`}
      data-kind={kind}
      data-home={isHome ? 'true' : undefined}
      ref={(el) => register(key, el)}
    >
      <span className="sym" role="img" aria-label={KIND_LABEL[kind]}>
        {SEAT_SYMBOL[kind]}
      </span>
      <div>
        <div className="seat__line">
          <span className="seat__name">{row.name}</span>
          {row.tag ? <span className="mono muted">{row.tag}</span> : null}
          <span className="muted">{since}</span>
          {isHome ? (
            <span className="muted" data-testid={`seat-home-${key}`}>
              home · read-only
            </span>
          ) : null}
        </div>
        {kind === 'dead' && !isHome ? (
          <div className="seat__warn" data-testid={`seat-takeover-${key}`}>
            Says UP, but its terminal process is gone. Take it over with{' '}
            <span className="mono">seat {row.name} --up</span>.
          </div>
        ) : null}
        {kind === 'unknown' ? (
          <div className="seat__note muted">
            {row.live === 'unknown'
              ? 'Says UP; its holder is on another machine or has no process id recorded, so it cannot be told whether it is running.'
              : 'Says UP; no holder is recorded for this seat.'}
          </div>
        ) : null}
        <dl className="seat__kv">
          {row.status === 'UP' && !isHome ? (
            <>
              <dt>working on</dt>
              <dd data-testid={`seat-working-${key}`}>
                {working.length === 0 ? (
                  <span className="muted">no Doing card is assigned to it</span>
                ) : (
                  working.map((c) => (
                    <div key={c.id}>
                      <span className="cardref">{c.id}</span> {c.title}
                    </div>
                  ))
                )}
              </dd>
            </>
          ) : null}
          <dt>in flight</dt>
          <dd>
            <Field value={row.inFlight} />
          </dd>
          <dt>owes</dt>
          <dd>
            <Field value={row.owes} />
          </dd>
        </dl>
        {seen.length > 0 ? (
          <div className="seat__events" data-testid={`seat-events-${key}`}>
            {seen.map((e) => `${tickerVerb(e)} ${whenLabel(e.ts, now)}`).join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SeatsPanel({ seats, doing, unclaimed, events, now, stateMissing, focus }: Props) {
  const blocks = useRef(new Map<string, HTMLElement>());
  const register = (name: string, el: HTMLElement | null) => {
    if (el) blocks.current.set(name, el);
    else blocks.current.delete(name);
  };
  const [flashName, setFlashName] = useState<string | null>(null);
  const tick = focus?.tick;
  const name = focus?.name;
  // `tick` is the trigger: clicking the same pill again must scroll and flash again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the trigger, not a value read
  useEffect(() => {
    if (name === undefined) return;
    const el = blocks.current.get(name);
    // jsdom has no scrollIntoView, and a hidden tab may not honour it — never a reason to throw.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setFlashName(name);
    const id = setTimeout(() => setFlashName(null), 1600);
    return () => clearTimeout(id);
  }, [name, tick]);

  const up = seats.filter((s) => seatKind(s) !== 'down' && seatKind(s) !== 'dead').length;
  const dead = seats.filter((s) => seatKind(s) === 'dead').length;
  const meta =
    seats.length === 0
      ? null
      : up + dead === 0
        ? 'nobody up'
        : `${up} up${dead > 0 ? ` · ${dead} needs a look` : ''}`;

  return (
    <DeckPanel title="SEATS" meta={meta} testId="seats-panel">
      {seats.length === 0 ? (
        <div className="empty-note">
          {stateMissing
            ? 'No STATE.md yet — run `repoboard init --practices`.'
            : 'No seats recorded in STATE.md.'}
        </div>
      ) : null}
      {seats.length > 0 && up + dead === 0 && doing.length === 0 ? (
        <div className="empty-note" data-testid="seats-quiet">
          Nobody is on a seat and Doing is empty.
        </div>
      ) : null}
      {seats.map((row) => (
        <SeatBlock
          key={seatKey(row)}
          row={row}
          doing={doing}
          events={events}
          now={now}
          flash={flashName === seatKey(row)}
          register={register}
        />
      ))}
      {unclaimed.length > 0 ? (
        <div className="unclaimed" data-testid="seats-unclaimed">
          <span className="muted">Unclaimed in Doing:</span>
          {unclaimed.map((c) => (
            <div key={c.id}>
              <span className="cardref">{c.id}</span> {c.title}{' '}
              <span className="muted">
                · {ageOf(c.updated, now) || 'age unknown'}, no seat on it
                {c.assignee ? ` (assigned to ${shortActor(c.assignee)})` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </DeckPanel>
  );
}
