/**
 * P8.3, locked decision 7: STATE.md as a panel at the top of the Board view. OWNER ISSUES is NOT
 * read from the wire payload's own (possibly stale-by-now) `ownerQueue` field: it is recomputed
 * here from the live `cards` the board already has, via the same `needsDecision`/`ownerQueueLine`
 * core functions the server uses, so a card's decision changing updates this panel the instant
 * the `card` message arrives — no dependency on a fresh `state` broadcast. O11 retired the
 * TopBar's `needs decision` filter, so a queue line SCROLLS to the `decide` column instead of
 * toggling anything (orchestrator note 2).
 *
 * RCB-66: the owner asked for "state, live, owner issues, seats" — STATE.md's four sections
 * under one umbrella — as collapsible rows that default to closed, plus today's log (previously a
 * strip beside the Ticker, `LogTimeline`) as a fifth row rather than dropped. All five rows are
 * independent, closed-by-default, and fit the window: one open row scrolls inside itself
 * (`.panel-row__body`), it does not grow the panel.
 */
import { type Card, needsDecision, ownerQueueLine, parseLogBlocks } from '@repoboard/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import { parseSeats, type Seat } from '../seats.js';
import { relTime, shortTime } from '../time.js';
import type { LogPayload, StatePayload } from '../wire.js';
import { LogTimeline, logBlockWhen } from './LogTimeline.jsx';

const STORAGE_KEY = 'repoboard.panelRows';

interface PanelRowsOpen {
  live?: boolean;
  lastLandings?: boolean;
  ownerIssues?: boolean;
  seats?: boolean;
  log?: boolean;
}

/**
 * Every read and write wraps its OWN try/catch — not just the existence check — because
 * `localStorage` can exist as a reference yet still throw (or, as measured in this suite, expose
 * a `getItem` that is not a function) in a private window, under a restrictive environment, or a
 * broken shim. A per-viewer convenience like which rows are open must never crash the panel.
 * Missing, unparseable, or throwing all read back as "no rows open" — every row starts closed.
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
  cards: Card[];
  /** The first `decision: true` column's id, or null when the board has none. */
  decideColumnId: string | null;
  onGoToDecide: (columnId: string) => void;
  log: LogPayload | null;
  now: number;
}

/**
 * One collapsible row: a button head (title, optional meta/badge, chevron) and a body rendered
 * ONLY when open — not hidden by CSS, so a closed row's text is genuinely absent from the DOM.
 * The accessible name of the head is the title followed by any meta, so a test can match it with
 * e.g. `/^LIVE/`.
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

/**
 * RCB-45: LIVE is window-locked — a fixed height (not max-height) that scrolls inside, pinned
 * width, no reflow as it grows, so it reads like a status board. `testId` is put on the window
 * div (the element the test — and the fixed height — actually applies to).
 */
function StateSection({
  body,
  locked,
  testId,
}: {
  body: string;
  locked?: boolean;
  testId?: string;
}) {
  const prose = (
    <div
      className="state-panel__prose"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderMarkdown (DOMPurify)
      dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
    />
  );
  return (
    <div className="state-panel__section">
      {locked ? (
        <div className="state-panel__window" data-testid={testId}>
          {prose}
        </div>
      ) : (
        prose
      )}
    </div>
  );
}

/**
 * RCB-85: SEATS closed-row preview — who's up/down without opening the row. `seats` comes from
 * `parseSeats` on the STATE.md `## SEATS` section; `now` is the panel's own `now` prop, same
 * value LOG uses for `logBlockWhen`.
 */
function SeatsStrip({ seats, now }: { seats: Seat[]; now: number }) {
  if (seats.length === 0) return null;
  return (
    <span className="state-panel__seats" data-testid="state-panel-seats">
      {seats.map((seat) => (
        <span
          key={`${seat.name}:${seat.status}:${seat.iso ?? ''}`}
          className={`chip chip--seat chip--seat-${seat.status.toLowerCase()}`}
          data-testid="seat-chip"
        >
          {seat.name} {seat.status}
          {seat.iso ? ` ${relTime(seat.iso, now)}` : ''}
        </span>
      ))}
    </span>
  );
}

export function StatePanel({ state, cards, decideColumnId, onGoToDecide, log, now }: Props) {
  const [rows, setRows] = useState<PanelRowsOpen>(readPanelRows);
  const toggle = (key: keyof PanelRowsOpen) => {
    setRows((prev) => {
      const next: PanelRowsOpen = { ...prev, [key]: !prev[key] };
      writePanelRows(next);
      return next;
    });
  };

  const openCards = cards.filter((c) => needsDecision(c));
  const sections = state?.sections ?? null;

  const logBlocks = log ? parseLogBlocks(log.text) : [];
  const newestLogBlock = logBlocks.length > 0 ? logBlocks[logBlocks.length - 1] : null;
  const logMeta = newestLogBlock
    ? `${logBlocks.length} block${logBlocks.length === 1 ? '' : 's'} today · ${logBlockWhen(
        newestLogBlock.ts,
        now,
      )}`
    : 'no log entries today';

  return (
    <div className="state-panel" data-testid="state-panel">
      <div className="state-panel__caption muted">
        {state?.stamp ? (
          <>
            STATE written {shortTime(state.stamp)} by {state.actor}
          </>
        ) : (
          <>no STATE.md yet — `repoboard init --practices`</>
        )}
      </div>
      {sections && state ? (
        <>
          <PanelRow title="LIVE" open={!!rows.live} onToggle={() => toggle('live')}>
            <StateSection body={sections.live} locked testId="state-panel-live" />
          </PanelRow>
          <PanelRow
            title="LAST LANDINGS"
            open={!!rows.lastLandings}
            onToggle={() => toggle('lastLandings')}
          >
            <StateSection body={sections.lastLandings} />
          </PanelRow>
          <PanelRow
            title="OWNER ISSUES"
            meta={
              openCards.length > 0 ? (
                <span className="state-panel__badge" data-testid="state-panel-queue-count">
                  {openCards.length} needs decision
                </span>
              ) : null
            }
            open={!!rows.ownerIssues}
            onToggle={() => toggle('ownerIssues')}
          >
            <div className="state-panel__section">
              {openCards.length === 0 ? (
                <p className="muted">No open decisions.</p>
              ) : (
                <ul className="state-panel__queue" data-testid="state-panel-queue">
                  {openCards.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="state-panel__queue-item"
                        disabled={decideColumnId === null}
                        onClick={() => decideColumnId && onGoToDecide(decideColumnId)}
                        title={decideColumnId ? `Go to the ${decideColumnId} column` : undefined}
                      >
                        {ownerQueueLine(c)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </PanelRow>
          <PanelRow
            title="SEATS"
            meta={<SeatsStrip seats={parseSeats(sections.seats)} now={now} />}
            open={!!rows.seats}
            onToggle={() => toggle('seats')}
          >
            <StateSection body={sections.seats} />
          </PanelRow>
        </>
      ) : null}
      <PanelRow
        title="LOG"
        meta={<span className="muted">{logMeta}</span>}
        open={!!rows.log}
        onToggle={() => toggle('log')}
      >
        <LogTimeline log={log} now={now} />
      </PanelRow>
    </div>
  );
}
