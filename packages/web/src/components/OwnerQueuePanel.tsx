/**
 * RCB-218: OWNER QUEUE — the cards that need a decision, recomputed here from the LIVE `cards`
 * (`needsDecision` / `ownerQueueLine`, the same core functions the server uses), so an answered
 * decision leaves the list the instant the `card` message arrives. Each item shows its letters (in
 * `ownerQueueLine`) and, when the card is not in the decide column, a badge naming the column it
 * does sit in. Clicking an item opens that card's drawer — it used to scroll to the Needs-decision
 * column, which can be empty while the waiting card sits in Done (owner-approved change).
 */
import { type BoardConfig, type Card, ownerQueueLine } from '@repoboard/core';
import { DeckPanel } from './DeckPanel.jsx';
import { columnLabel } from './status-model.js';

interface Props {
  queue: Card[];
  config: BoardConfig;
  onOpenCard: (id: string) => void;
}

export function OwnerQueuePanel({ queue, config, onOpenCard }: Props) {
  const decideColumnId = config.columns.find((c) => c.decision === true)?.id ?? null;
  return (
    <DeckPanel
      title="OWNER QUEUE"
      meta={queue.length > 0 ? `${queue.length} waiting` : null}
      testId="owner-panel"
    >
      {queue.length === 0 ? (
        <div className="empty-note" data-testid="owner-empty">
          No open decisions.
        </div>
      ) : (
        <ul className="oq-list" data-testid="owner-queue">
          {queue.map((c) => (
            <li key={c.id} className="oq-item">
              <button
                type="button"
                className="oq"
                data-testid={`owner-item-${c.id}`}
                onClick={() => onOpenCard(c.id)}
              >
                <span className="oq__top">
                  <span className="oq__line">{ownerQueueLine(c)}</span>
                  {c.status !== decideColumnId ? (
                    <span className="oq__where" data-testid={`owner-where-${c.id}`}>
                      in {columnLabel(config, c.status)}
                    </span>
                  ) : null}
                </span>
                <span className="oq__go">Open the card to answer →</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </DeckPanel>
  );
}
