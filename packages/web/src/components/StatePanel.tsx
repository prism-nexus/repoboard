/**
 * P8.3, locked decision 7: STATE.md as a collapsible panel at the top of the Board view (collapsed
 * state remembered in localStorage — a per-viewer convenience, so it lives here, not in the shared
 * store). OWNER QUEUE is NOT read from the wire payload's own (possibly stale-by-now) `ownerQueue`
 * field: it is recomputed here from the live `cards` the board already has, via the same
 * `needsDecision`/`ownerQueueLine` core functions the server uses, so a card's decision changing
 * updates this panel the instant the `card` message arrives — no dependency on a fresh `state`
 * broadcast. O11 retired the TopBar's `needs decision` filter, so a queue line SCROLLS to the
 * `decide` column instead of toggling anything (orchestrator note 2).
 */
import { type Card, needsDecision, ownerQueueLine } from '@repoboard/core';
import { useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import { shortTime } from '../time.js';
import type { StatePayload } from '../wire.js';

const STORAGE_KEY = 'repoboard.statePanelCollapsed';

/**
 * Every read and write wraps its OWN try/catch — not just the existence check — because
 * `localStorage` can exist as a reference yet still throw (or, as measured in this suite, expose
 * a `getItem` that is not a function) in a private window, under a restrictive environment, or a
 * broken shim. A per-viewer convenience like a collapsed panel must never crash the panel.
 */
function readCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
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
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section className="state-panel__section">
      <h3 className="state-panel__heading">{title}</h3>
      <div
        className="state-panel__prose"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderMarkdown (DOMPurify)
        dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
      />
    </section>
  );
}

export function StatePanel({ state, cards, decideColumnId, onGoToDecide }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };
  const openCards = cards.filter((c) => needsDecision(c));
  const chevron = collapsed ? '▸' : '▾';

  return (
    <div className="state-panel" data-testid="state-panel">
      <button
        type="button"
        className="state-panel__head"
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        <span className="state-panel__title">STATE</span>
        {state?.stamp ? (
          <span className="muted">
            written {shortTime(state.stamp)} by {state.actor}
          </span>
        ) : (
          <span className="muted">no STATE.md yet — `repoboard init --practices`</span>
        )}
        {openCards.length > 0 ? (
          <span className="state-panel__badge" data-testid="state-panel-queue-count">
            {openCards.length} needs decision
          </span>
        ) : null}
        <span className="state-panel__chevron" aria-hidden="true">
          {chevron}
        </span>
      </button>
      {!collapsed && state?.sections ? (
        <div className="state-panel__body">
          <Section title="Live" body={state.sections.live} />
          <Section title="Last landings" body={state.sections.lastLandings} />
          <section className="state-panel__section">
            <h3 className="state-panel__heading">Owner queue</h3>
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
          </section>
          <Section title="Seats" body={state.sections.seats} />
        </div>
      ) : null}
    </div>
  );
}
