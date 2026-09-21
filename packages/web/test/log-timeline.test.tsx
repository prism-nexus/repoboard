/**
 * P8.3, locked decision 7: the daily log as a timeline — newest block first, a seat avatar, the
 * title, and an expand-for-text disclosure. RCB-66: it is now the LOG row's body in `StatePanel`
 * (closed by default), so every test opens the row first.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') }));
afterEach(() => vi.useRealTimers());

function openLog() {
  fireEvent.click(screen.getByRole('button', { name: /^LOG/ }));
}

const LOG_TEXT = [
  '# Log — 2026-09-02',
  '',
  '##### OPS 2026-09-02T18:00:00Z: armed the fires',
  '',
  'Five waiters set.',
  '',
  '##### BUILDER 2026-09-02T18:30:00Z: K117 landed',
  '',
  'Two copy lines shipped.',
  '',
].join('\n');

describe('LogTimeline', () => {
  it('with no log payload at all, reads as "no log entries today" once the row is open', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no log arg
    renderApp(store);
    openLog();
    expect(screen.getByTestId('log-timeline')).toHaveTextContent('no log entries today');
  });

  it('orders blocks newest first', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const summaries = timeline.querySelectorAll('.log-timeline__summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveTextContent('BUILDER');
    expect(summaries[0]).toHaveTextContent('K117 landed');
    expect(summaries[1]).toHaveTextContent('OPS');
    expect(summaries[1]).toHaveTextContent('armed the fires');
  });

  // RCB-62 (finding 3): MEASURED first (before this fix) — `relTime` itself returns `''` on
  // `Date.parse` NaN (unchanged), and this test's failure, pre-fix, showed the RENDERED result
  // for a redacted sibling stamp was `''` (blank), not the card's suspected "Invalid Date" — so
  // the bug is "blank", not "Invalid Date"; the fix is the same either way: show it verbatim.
  it('a redacted sibling stamp is shown VERBATIM, never blank and never "Invalid Date"', () => {
    const store = testStore();
    const text = [
      '# Log — 2026-09-18',
      '',
      '##### OPS 2026-09-18 21:4xZ: hand-written by the sibling',
      '',
      'text',
      '',
    ].join('\n');
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-18',
      text,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const when = timeline.querySelector('.log-timeline__when');
    expect(when?.textContent).toBe('2026-09-18 21:4xZ');
    expect(when?.textContent).not.toBe('');
    expect(when?.textContent).not.toContain('Invalid Date');
  });

  it('a parseable ISO stamp still renders the relative "…ago" form', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const whens = [...timeline.querySelectorAll('.log-timeline__when')].map((n) => n.textContent);
    expect(whens.some((t) => t?.endsWith('ago') || t === 'just now')).toBe(true);
  });

  it('the full text is inside a <details> disclosure, collapsed by default', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const items = timeline.querySelectorAll('details.log-timeline__item');
    expect(items).toHaveLength(2);
    for (const item of items) expect((item as HTMLDetailsElement).open).toBe(false);
    expect(timeline).toHaveTextContent('Five waiters set.'); // present in the DOM, just collapsed
  });

  // RCB-66: the LOG row head shows the count (and, when non-zero, the newest block's "when") so a
  // closed row still tells the viewer whether there is anything today.
  it('the LOG row head reads "no log entries today" with no payload', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no log arg
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('no log entries today');
  });

  it('the LOG row head reads "2 blocks today" with two blocks', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('2 blocks today');
  });
});
