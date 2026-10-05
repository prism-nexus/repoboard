/**
 * The top of the Board (RCB-218; before it, P8.3 + RCB-66's five collapsible STATE.md rows).
 *
 * One status line (`StatusLine`) that replaces the Now strip and the Ticker on the Board view, a
 * deck of three panels under it — SEATS (the live view), LANDED (from git) and OWNER QUEUE — and the
 * LOG row. The panels show or hide together behind the status line's Hide/Show details toggle,
 * remembered in `localStorage` (`repoboard.panelRows`) like the five rows were.
 *
 * Nothing here is parsed from STATE.md's prose any more: seats come from the server's `seats`
 * payload (or core's parse of the same SEATS section when a server predates it), landings from git,
 * and the Owner queue is recomputed from the live `cards`. LIVE and LAST LANDINGS — slow-changing
 * hand-typed prose that was 12 days stale — are gone from the Board; they stay in STATE.md.
 */
import { type BoardConfig, type Card, type Event, parseLogBlocks } from '@repoboard/core';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type {
  LandingsPayload,
  LeasesPayload,
  LogPayload,
  SeatRowPayload,
  StatePayload,
} from '../wire.js';
import { LandedPanel } from './LandedPanel.jsx';
import { LogTimeline, logBlockWhen, logDayLabel } from './LogTimeline.jsx';
import { OwnerQueuePanel } from './OwnerQueuePanel.jsx';
import { SeatsPanel } from './SeatsPanel.jsx';
import { StatusLine } from './StatusLine.jsx';
import {
  doingCards,
  newestEvent,
  ownerQueueCards,
  seatRowsFor,
  unclaimedDoing,
} from './status-model.js';

const STORAGE_KEY = 'repoboard.panelRows';

/**
 * `details`: the deck of three panels is shown (the default — only an explicit `false` hides it, so
 * an absent or old-shaped value reads as "shown"). `log`: the LOG row is open (default closed).
 * Keys left over from the five-row panel (`live`, `ownerIssues`, …) are ignored.
 */
interface PanelRowsOpen {
  details?: boolean;
  log?: boolean;
}

/**
 * Every read and write wraps its OWN try/catch — not just the existence check — because
 * `localStorage` can exist as a reference yet still throw (or, as measured in this suite, expose
 * a `getItem` that is not a function) in a private window, under a restrictive environment, or a
 * broken shim. A per-viewer convenience like whether the details are open must never crash the
 * panel. Missing, unparseable, or throwing all read back as `{}` — the defaults.
 */
function readPanelRows(): PanelRowsOpen {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as PanelRowsOpen) : {};
  } catch {
    return {};
  }
}

function writePanelRows(rows: PanelRowsOpen): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    }
  } catch {
    // Per-viewer convenience only — losing it is not an error.
  }
}

interface Props {
  state: StatePayload | null;
  /** The server's seat rows; `null` when it predates them (STATE.md's SEATS section is read instead). */
  seats: SeatRowPayload[] | null;
  /** The server's landings; `null` when it predates them. */
  landings: LandingsPayload | null;
  leases: LeasesPayload | null;
  events: Event[];
  cards: Card[];
  config: BoardConfig;
  /** Opens a card's drawer — an Owner queue item, and the status line's Owner queue pill. */
  onOpenCard: (id: string) => void;
  log: LogPayload | null;
  now: number;
}

/**
 * One collapsible row: a button head (title, optional meta/badge, chevron) and a body rendered
 * ONLY when open — not hidden by CSS, so a closed row's text is genuinely absent from the DOM.
 * The accessible name of the head is the title followed by any meta, so a test can match it with
 * e.g. `/^LOG/`.
 */
function PanelRow({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="panel-row">
      <button type="button" className="panel-row__head" aria-expanded={open} onClick={onToggle}>
        <span className="panel-row__title">{title}</span>
        {meta}
        <span className="panel-row__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="panel-row__body">{children}</div> : null}
    </div>
  );
}

export function StatePanel({
  state,
  seats,
  landings,
  leases,
  events,
  cards,
  config,
  onOpenCard,
  log,
  now,
}: Props) {
  const [rows, setRows] = useState<PanelRowsOpen>(readPanelRows);
  const [focus, setFocus] = useState<{ name: string; tick: number } | null>(null);
  const toggle = (key: keyof PanelRowsOpen, current: boolean) => {
    setRows((prev) => {
      const next: PanelRowsOpen = { ...prev, [key]: !current };
      writePanelRows(next);
      return next;
    });
  };
  const detailsOpen = rows.details !== false;
  const logOpen = rows.log === true;

  const seatRows = useMemo(() => seatRowsFor(seats, state), [seats, state]);
  const stateMissing = seats === null && !state?.sections;
  const queue = useMemo(() => ownerQueueCards(cards), [cards]);
  const doing = useMemo(() => doingCards(cards, config), [cards, config]);
  const unclaimed = useMemo(() => unclaimedDoing(doing, seatRows), [doing, seatRows]);

  // A seat pill opens the details when they are hidden, then asks the Seats panel to scroll to and
  // flash that seat's block (it mounts with the request already set, so the effect still fires).
  const onSeat = (name: string) => {
    if (!detailsOpen) {
      setRows((prev) => {
        const next: PanelRowsOpen = { ...prev, details: true };
        writePanelRows(next);
        return next;
      });
    }
    setFocus((prev) => ({ name, tick: (prev?.tick ?? 0) + 1 }));
  };

  const logBlocks = log ? parseLogBlocks(log.text) : [];
  const newestLogBlock = logBlocks.length > 0 ? logBlocks[logBlocks.length - 1] : null;
  const day = logDayLabel(log?.date, now);
  const logMeta = newestLogBlock
    ? `${logBlocks.length} block${logBlocks.length === 1 ? '' : 's'} ${
        day === 'today' || day === 'yesterday' ? day : `on ${day}`
      } · ${logBlockWhen(newestLogBlock.ts, now)}`
    : day === 'today'
      ? 'no log entries today'
      : `no log entries · ${day}`;

  return (
    <div className="state-panel" data-testid="state-panel">
      <StatusLine
        seats={seatRows}
        stateMissing={stateMissing}
        queue={queue}
        leases={leases}
        latest={newestEvent(events)}
        now={now}
        detailsOpen={detailsOpen}
        onToggleDetails={() => {
          // A request to scroll to a seat is spent once the deck goes away; a re-shown deck must not
          // replay it.
          if (detailsOpen) setFocus(null);
          toggle('details', detailsOpen);
        }}
        onSeat={onSeat}
        onOpenCard={onOpenCard}
      />
      {detailsOpen ? (
        <div className="deck" data-testid="state-deck">
          <SeatsPanel
            seats={seatRows}
            doing={doing}
            unclaimed={unclaimed}
            events={events}
            now={now}
            stateMissing={stateMissing}
            focus={focus}
          />
          <LandedPanel landings={landings} cards={cards} config={config} now={now} />
          <OwnerQueuePanel queue={queue} config={config} onOpenCard={onOpenCard} />
        </div>
      ) : null}
      <PanelRow
        title="LOG"
        meta={<span className="muted">{logMeta}</span>}
        open={logOpen}
        onToggle={() => toggle('log', logOpen)}
      >
        <LogTimeline log={log} now={now} />
      </PanelRow>
    </div>
  );
}
