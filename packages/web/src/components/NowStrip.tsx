/**
 * P8.2, locked decision 9: a strip directly under the TopBar, on every view — who holds what,
 * the next window, stale leases in the warning color. Collapses to one quiet line when there is
 * nothing to say. No modal, no fun (D9: readability wins).
 */
import type { Lease, Window } from '@repoboard/core';
import { shortActor, shortTime } from '../time.js';
import type { LeasesPayload } from '../wire.js';

interface Props {
  leases: LeasesPayload | null;
  now: number;
}

function untilLabel(until: string | undefined): string {
  return until ? shortTime(until) : '—';
}

/** The soonest window on `resource`-agnostic terms that has not ended yet, current or upcoming. */
function nextWindow(windows: Window[], nowMs: number): Window | undefined {
  return [...windows]
    .filter((w) => Date.parse(w.end) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
}

export function NowStrip({ leases, now }: Props) {
  const hasAnything = leases !== null && (leases.leases.length > 0 || leases.windows.length > 0);
  if (!hasAnything) {
    return (
      <div className="now-strip now-strip--quiet" data-testid="now-strip">
        <span className="muted">no leases, no windows</span>
      </div>
    );
  }

  const staleSet = new Set(leases.stale);
  const live: Lease[] = leases.leases.filter((l) => !staleSet.has(l.resource));
  const staleCount = leases.stale.length;
  const upcoming = nextWindow(leases.windows, now);

  return (
    <div className="now-strip" data-testid="now-strip">
      {live.map((l) => (
        <span
          key={l.resource}
          className="now-strip__item"
          data-testid={`now-strip-holding-${l.resource}`}
        >
          holding: <span className="mono">{l.resource}</span> · {shortActor(l.holder)} · until{' '}
          {untilLabel(l.until)}
        </span>
      ))}
      {upcoming ? (
        <span className="now-strip__item" data-testid="now-strip-window">
          next window: {upcoming.name} {shortTime(upcoming.start)}–{shortTime(upcoming.end)}{' '}
          <span className="mono">{upcoming.resource}</span>
        </span>
      ) : null}
      {staleCount > 0 ? (
        <span className="now-strip__item now-strip__item--stale" data-testid="now-strip-stale">
          stale ×{staleCount}
        </span>
      ) : null}
      {live.length === 0 && !upcoming && staleCount === 0 ? (
        <span className="muted">no leases, no windows</span>
      ) : null}
    </div>
  );
}
