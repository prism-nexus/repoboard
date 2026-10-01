/**
 * RCB-70 (owner 2026-09-19 20:4xZ): a note — dated, attributed, appended, never rewritten — from
 * the web, the CLI and MCP. Pure, like `moveCard`/`updateCard`/`askDecision`/`decide` (CLAUDE.md
 * §0.4: one function per guarantee): returns a new card and an event, the caller writes both.
 */
import { appendNoteLine, formatNoteLine } from './log.js';
import { toIso } from './time.js';
import type { Card, Event } from './types.js';

export interface AddNoteOptions {
  text: string;
  actor: string;
  now: Date;
}

export type AddNoteResult = { ok: true; card: Card; event: Event } | { ok: false; error: string };

/**
 * Append one attributed remark to `card`'s `## Notes` section (created before `## Log` if
 * missing — `appendNoteLine`). Bumps `updated`. Writes NO `## Log` line: the note is itself dated
 * and attributed, and a second copy in the Log would be noise and would double the text in every
 * `card show`. Event shape is `store.appendLog`'s `update` shape with `type: 'note'` instead
 * (`from === to === card.status`; a note never changes status).
 */
export function addNote(card: Card, opts: AddNoteOptions): AddNoteResult {
  if (opts.text.trim().length === 0) {
    return { ok: false, error: 'note text must not be empty' };
  }
  const ts = toIso(opts.now);
  const next: Card = {
    ...card,
    updated: ts,
    body: appendNoteLine(card.body, formatNoteLine(ts, opts.actor, opts.text)),
  };
  const event: Event = {
    ts,
    actor: opts.actor,
    type: 'note',
    cardId: card.id,
    from: card.status,
    to: card.status,
  };
  return { ok: true, card: next, event };
}
