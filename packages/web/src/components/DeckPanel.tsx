/**
 * RCB-218: the frame the three detail panels (Seats, Landed, Owner queue) share — a mono title, a
 * muted meta on the right, a body that scrolls inside itself (so one long list never pushes the
 * columns off the screen), and an optional foot line. Presentational only.
 */
import type { ReactNode } from 'react';

export function DeckPanel({
  title,
  meta,
  testId,
  foot,
  children,
}: {
  title: string;
  meta?: ReactNode;
  testId: string;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel" data-testid={testId} aria-label={title}>
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        {meta ? <span className="panel__meta">{meta}</span> : null}
      </div>
      <div className="panel__body">{children}</div>
      {foot ? <div className="panel__foot">{foot}</div> : null}
    </section>
  );
}
