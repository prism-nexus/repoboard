/**
 * P8.3, locked decision 7: the daily log as a timeline — newest block first, a seat avatar,
 * the title, and a native `<details>` disclosure for the full text (no extra bundle weight for an
 * expand/collapse control). RCB-66: this is the LOG row's body in `StatePanel`, not a strip beside
 * the Ticker. RCB-218: each block carries a mark for what it is (▲ took a seat, ▼ stood down, ✓
 * landed, • anything else), and the payload may be an earlier day's (`logDayLabel`).
 *
 * RCB-223: a row is a four-column grid — mark · time · seat · title — so the times and seats line
 * up down the list (the time used to trail the title, ragged).
 */
import { avatarFor, parseLogBlocks } from '@repoboard/core';
import { useState } from 'react';
import { renderNote } from '../markdown.js';
import { relTime } from '../time.js';
import type { LogPayload } from '../wire.js';

interface Props {
  log: LogPayload | null;
  now: number;
}

/**
 * RCB-62: a hand-written block's `ts` is not guaranteed to be a parseable ISO `Date`
 * (`repolog.ts`'s `LogBlock.ts` doc comment) — `relTime` returns `''` on that, and a human may
 * write e.g. `21:4xZ` on purpose (a redacted minute is a stamp, not an error), so it is shown
 * VERBATIM here rather than left blank or ever rendered as "Invalid Date". Exported so the LOG
 * row's head meta (`StatePanel.tsx`) computes the newest block's "when" the same way, rather than
 * duplicating the fallback rule.
 */
export function logBlockWhen(ts: string, now: number): string {
  return relTime(ts, now) || ts;
}

/** RCB-218: what a block's title says it is — a seat coming up, going down, or a card landing. */
export type LogKind = 'up' | 'down' | 'landed' | 'other';

export const LOG_MARK: Record<LogKind, string> = { up: '▲', down: '▼', landed: '✓', other: '•' };
const LOG_KIND_LABEL: Record<LogKind, string> = {
  up: 'took a seat',
  down: 'stood down',
  landed: 'landed',
  other: 'entry',
};

// The keywords are the log's own upper-case words (`UP (A7B2): …`, `DOWN at the context line`,
// `RCB-9 LANDED 7e2c118`). Case-sensitive on purpose: "set up the rig" is not a seat coming up. The
// look-around keeps `UP-TO-DATE` / `BACKUP` from matching.
const LOG_KIND_RE: Record<Exclude<LogKind, 'other'>, RegExp> = {
  up: /(?<![\w-])UP(?![\w-])/,
  down: /(?<![\w-])DOWN(?![\w-])/,
  landed: /(?<![\w-])LANDED(?![\w-])/,
};

/**
 * RCB-218: ▲ for a title with UP, ▼ for DOWN, ✓ for LANDED, • for none of them. A title naming more
 * than one (`DOWN: ACME-9 LANDED`) is the one whose keyword comes FIRST — a stand-down that mentions a
 * landing is a stand-down, a landing that mentions a seat is a landing.
 */
export function logBlockKind(title: string): LogKind {
  let best: LogKind = 'other';
  let bestAt = Number.POSITIVE_INFINITY;
  for (const kind of ['up', 'down', 'landed'] as const) {
    const at = title.search(LOG_KIND_RE[kind]);
    if (at !== -1 && at < bestAt) {
      best = kind;
      bestAt = at;
    }
  }
  return best;
}

/**
 * RCB-218: which day the log payload is, in words — `today` (its date is `now`'s UTC day),
 * `yesterday`, else the date itself. The server sends today's file when it has entries and the
 * newest earlier day otherwise (RCB-217), so the LOG row must say which one it is showing. A
 * payload with no date reads as today (nothing to contradict it).
 */
export function logDayLabel(date: string | undefined, now: number): string {
  if (!date) return 'today';
  const day = 86_400_000;
  if (date === new Date(now).toISOString().slice(0, 10)) return 'today';
  if (date === new Date(now - day).toISOString().slice(0, 10)) return 'yesterday';
  return date;
}

export function LogTimeline({ log, now }: Props) {
  const blocks = log ? parseLogBlocks(log.text) : [];
  const newestFirst = [...blocks].reverse();
  // RCB-143: a member board has 112 blocks — the body's markdown is parsed only for a block whose
  // own <details> is open, so a closed block costs no `renderNote` call. Keyed by the same
  // `${ts}-${seat}-${title}` as the `<details>` `key`, so open state survives newest-first re-sorts.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

  if (newestFirst.length === 0) {
    return (
      <div className="log-timeline log-timeline--empty" data-testid="log-timeline">
        <span className="muted">no log entries today</span>
      </div>
    );
  }

  return (
    <div className="log-timeline" data-testid="log-timeline">
      {newestFirst.map((b) => {
        const { emoji, color } = avatarFor(b.seat);
        const when = logBlockWhen(b.ts, now);
        const kind = logBlockKind(b.title);
        const key = `${b.ts}-${b.seat}-${b.title}`;
        const open = openKeys.has(key);
        return (
          <details
            className="log-timeline__item"
            key={key}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              setOpenKeys((prev) => {
                const next = new Set(prev);
                if (isOpen) next.add(key);
                else next.delete(key);
                return next;
              });
            }}
          >
            <summary className="log-timeline__summary">
              <span
                className={`log-timeline__mark log-timeline__mark--${kind}`}
                data-kind={kind}
                role="img"
                aria-label={LOG_KIND_LABEL[kind]}
              >
                {LOG_MARK[kind]}
              </span>
              <span className="log-timeline__when">{when}</span>
              <span className="log-timeline__seat">
                <span className="log-timeline__emoji" style={{ color }} aria-hidden="true">
                  {emoji}
                </span>{' '}
                {b.seat}
              </span>
              <span className="log-timeline__title">{b.title}</span>
            </summary>
            {open ? (
              <div
                className="log-timeline__text"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by renderNote (DOMPurify)
                dangerouslySetInnerHTML={{ __html: renderNote(b.text) }}
              />
            ) : null}
          </details>
        );
      })}
    </div>
  );
}
