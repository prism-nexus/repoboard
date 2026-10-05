/**
 * RCB-218: the Board's one status line — it replaces the "no leases, no windows" strip, the Ticker
 * and the "STATE written" caption on the Board view (the other views keep the strip and the
 * Ticker). Left to right: a pill per seat (symbol, name, pane, age), the Owner queue pill, a pill
 * per HELD lease (stale in amber), then on the right the newest event and the Hide/Show details
 * toggle. Presentational: every number and word comes in as a prop.
 */
import type { Card, Event } from '@repoboard/core';
import { relTime, shortActor, shortTime } from '../time.js';
import type { LeasesPayload, SeatRowPayload } from '../wire.js';
import {
  ageOf,
  lastEventText,
  SEAT_SYMBOL,
  type SeatKind,
  seatKind,
  whenLabel,
} from './status-model.js';

interface Props {
  seats: SeatRowPayload[];
  /** No STATE.md and no `seats` payload: the empty line says how to make one. */
  stateMissing: boolean;
  queue: Card[];
  leases: LeasesPayload | null;
  latest: Event | null;
  now: number;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onSeat: (name: string) => void;
  onOpenCard: (id: string) => void;
}

/** What a seat's symbol means, in words — the symbol alone is not an accessible name. */
const KIND_LABEL: Record<SeatKind, string> = {
  up: 'up',
  down: 'down',
  dead: 'says up, but its holder is dead',
  unknown: 'says up, liveness unknown',
};

function seatTitle(row: SeatRowPayload, kind: SeatKind, now: number): string {
  const since = row.at ? ` since ${whenLabel(row.at, now)}` : '';
  switch (kind) {
    case 'up':
      return `up${since}`;
    case 'down':
      return `down${since}`;
    case 'dead':
      return 'says UP, but its terminal process is gone';
    case 'unknown':
      return row.live === 'unknown'
        ? 'says UP; cannot tell if it is running (another machine, or no process id recorded)'
        : 'says UP; nothing records who holds it';
  }
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="pill__icon">
      <path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z" />
    </svg>
  );
}

export function StatusLine({
  seats,
  stateMissing,
  queue,
  leases,
  latest,
  now,
  detailsOpen,
  onToggleDetails,
  onSeat,
  onOpenCard,
}: Props) {
  const first = queue[0];
  const stale = new Set(leases?.stale ?? []);
  return (
    <div className="status" data-testid="status-line">
      {seats.map((row) => {
        const kind = seatKind(row);
        const age = ageOf(row.at, now);
        return (
          <button
            type="button"
            key={row.name}
            className={`pill pill--${kind}`}
            data-testid={`seat-pill-${row.name}`}
            data-kind={kind}
            title={seatTitle(row, kind, now)}
            onClick={() => onSeat(row.name)}
          >
            <span className="sym" role="img" aria-label={KIND_LABEL[kind]}>
              {SEAT_SYMBOL[kind]}
            </span>
            {row.name}
            {row.tag ? (
              <>
                {' '}
                <span className="mono">{row.tag}</span>
              </>
            ) : null}
            {age ? (
              <>
                {' '}
                <span className="muted">· {age}</span>
              </>
            ) : null}
          </button>
        );
      })}
      {seats.length === 0 ? (
        <span className="muted" data-testid="status-no-seats">
          {stateMissing ? 'no STATE.md yet — `repoboard init --practices`' : 'no seats recorded'}
        </span>
      ) : null}
      <button
        type="button"
        className="pill pill--owner"
        data-testid="owner-pill"
        disabled={first === undefined}
        onClick={() => first && onOpenCard(first.id)}
      >
        <span aria-hidden="true">⚑</span> Owner queue {queue.length}
      </button>
      {(leases?.leases ?? []).map((l) => {
        const isStale = stale.has(l.resource);
        return (
          <span
            key={l.resource}
            className={`pill pill--lease${isStale ? ' pill--stale' : ''}`}
            data-testid={`lease-pill-${l.resource}`}
            data-stale={isStale ? 'true' : 'false'}
            title={isStale ? 'a lease past its until — the holder may have died' : 'held lease'}
          >
            <LockIcon />
            <span className="mono">{l.resource}</span> · {shortActor(l.holder)} ·{' '}
            {isStale ? 'stale · ' : ''}until {l.until ? shortTime(l.until) : '—'}
          </span>
        );
      })}
      <span className="status__last" data-testid="status-last">
        {latest ? (
          <>
            last: <b>{shortActor(latest.actor)}</b> {lastEventText(latest)} ·{' '}
            {relTime(latest.ts, now)}
          </>
        ) : (
          'last: no activity yet'
        )}
      </span>
      <button
        type="button"
        className="fold"
        data-testid="status-toggle"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
      >
        {detailsOpen ? 'Hide details ▴' : 'Show details ▾'}
      </button>
    </div>
  );
}
