/**
 * P8.3, locked decision 7: today's daily log as a timeline beside the Ticker — newest block
 * first, a seat avatar, the title, and a native `<details>` disclosure for the full text (no
 * extra bundle weight for an expand/collapse control).
 */
import { avatarFor, parseLogBlocks } from '@repoboard/core';
import { relTime } from '../time.js';
import type { LogPayload } from '../wire.js';

interface Props {
  log: LogPayload | null;
  now: number;
}

export function LogTimeline({ log, now }: Props) {
  const blocks = log ? parseLogBlocks(log.text) : [];
  const newestFirst = [...blocks].reverse();

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
        // RCB-62: a hand-written block's `ts` is not guaranteed to be a parseable ISO `Date`
        // (`repolog.ts`'s `LogBlock.ts` doc comment) — `relTime` returns `''` on that, and the
        // human wrote e.g. `21:4xZ` on purpose (a redacted minute is a stamp, not an error), so
        // it is shown VERBATIM here rather than left blank or ever rendered as "Invalid Date".
        const when = relTime(b.ts, now) || b.ts;
        return (
          <details className="log-timeline__item" key={`${b.ts}-${b.seat}-${b.title}`}>
            <summary className="log-timeline__summary">
              <span className="log-timeline__emoji" style={{ color }} aria-hidden="true">
                {emoji}
              </span>
              <span className="log-timeline__seat">{b.seat}</span>
              <span className="log-timeline__title">{b.title}</span>
              <span className="log-timeline__when">{when}</span>
            </summary>
            <pre className="log-timeline__text">{b.text}</pre>
          </details>
        );
      })}
    </div>
  );
}
