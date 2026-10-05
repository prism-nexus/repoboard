/**
 * RCB-218: LANDED — what git says landed. `landings.rows` (commits grouped by the card id their
 * subject starts with, newest first) are joined to the LIVE cards for a title and a column; a card
 * that landed but is not in a `done: true` column is flagged, so the board stops drifting from the
 * code. A short sha is a link when the server knows the repo's web base. This replaces the
 * hand-typed LAST LANDINGS prose of STATE.md, which nothing kept current.
 */
import type { BoardConfig, Card } from '@repoboard/core';
import { relTime } from '../time.js';
import type { LandingRow, LandingsPayload } from '../wire.js';
import { DeckPanel } from './DeckPanel.jsx';
import { columnLabel, isDoneColumn, isWebBase } from './status-model.js';

interface Props {
  /** `null`: the server did not send landings at all (it predates them). */
  landings: LandingsPayload | null;
  cards: Card[];
  config: BoardConfig;
  now: number;
}

/** A card with this many commits shows this many shas, then `+N more` — one busy card must not
 * push every other landing out of the panel. */
const SHAS_SHOWN = 6;

/** `ACME-214: release: publish from CI` -> `release: publish from CI` — the subject minus the card
 * id it starts with, for a landing whose card is no longer on the board. */
function subjectWithoutId(cardId: string, subject: string): string {
  return subject.startsWith(cardId) ? subject.slice(cardId.length).replace(/^[:\s]+/, '') : subject;
}

function Landing({
  row,
  web,
  card,
  config,
  now,
}: {
  row: LandingRow;
  web: string | null;
  card: Card | undefined;
  config: BoardConfig;
  now: number;
}) {
  const newest = row.commits[0];
  // The card is on the board: its own title, its own column. Not on the board (archived, or a typo
  // of an id): the newest commit's subject is the only title there is — and there is no column to
  // flag, so nothing is claimed about it.
  const title = card ? card.title : newest ? subjectWithoutId(row.cardId, newest.subject) : '';
  const stillIn =
    card && !isDoneColumn(config, card.status) ? columnLabel(config, card.status) : null;
  const base = isWebBase(web) ? web.replace(/\/+$/, '') : null;
  const shown = row.commits.slice(0, SHAS_SHOWN);
  return (
    <div className="land" data-testid={`landing-${row.cardId}`}>
      <span className="sym" aria-hidden="true">
        ✓
      </span>
      <div>
        <div className="land__title">
          <span className="cardref">{row.cardId}</span>{' '}
          {card ? title : <span className="muted">{title}</span>}
        </div>
        <div className="land__meta">
          {shown.map((c) =>
            base ? (
              <a
                key={c.sha}
                className="sha"
                href={`${base}/commit/${encodeURIComponent(c.sha)}`}
                target="_blank"
                rel="noreferrer"
              >
                {c.sha}
              </a>
            ) : (
              <span key={c.sha} className="sha sha--plain">
                {c.sha}
              </span>
            ),
          )}
          {row.commits.length > SHAS_SHOWN ? (
            <span>+{row.commits.length - SHAS_SHOWN} more</span>
          ) : null}
          {newest ? (
            <span>
              · {newest.author} · {relTime(newest.at, now)}
            </span>
          ) : null}
          {stillIn !== null ? (
            <span className="flag" data-testid={`landing-flag-${row.cardId}`}>
              ⚠ landed, card still in {stillIn}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LandedPanel({ landings, cards, config, now }: Props) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return (
    <DeckPanel
      title="LANDED"
      meta={landings ? 'from git' : null}
      testId="landed-panel"
      foot={landings ? <span title="where these rows came from">{landings.source}</span> : null}
    >
      {landings === null ? (
        <div className="empty-note" data-testid="landed-unsupported">
          Landings need a newer server — this one did not send them.
        </div>
      ) : landings.rows.length === 0 ? (
        <div className="empty-note">No commit starts with a card id in this window.</div>
      ) : (
        landings.rows.map((row) => (
          <Landing
            key={row.cardId}
            row={row}
            web={landings.web}
            card={byId.get(row.cardId)}
            config={config}
            now={now}
          />
        ))
      )}
    </DeckPanel>
  );
}
