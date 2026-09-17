/**
 * P8.3, locked decision 7: the daily log as a timeline beside the Ticker — newest block first,
 * a seat avatar, the title, and an expand-for-text disclosure.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') }));
afterEach(() => vi.useRealTimers());

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
  it('with no log payload at all, reads as "no log entries today"', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no log arg
    renderApp(store);
    expect(screen.getByTestId('log-timeline')).toHaveTextContent('no log entries today');
  });

  it('orders blocks newest first', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    const timeline = screen.getByTestId('log-timeline');
    const summaries = timeline.querySelectorAll('.log-timeline__summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveTextContent('BUILDER');
    expect(summaries[0]).toHaveTextContent('K117 landed');
    expect(summaries[1]).toHaveTextContent('OPS');
    expect(summaries[1]).toHaveTextContent('armed the fires');
  });

  it('the full text is inside a <details> disclosure, collapsed by default', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    const timeline = screen.getByTestId('log-timeline');
    const items = timeline.querySelectorAll('details.log-timeline__item');
    expect(items).toHaveLength(2);
    for (const item of items) expect((item as HTMLDetailsElement).open).toBe(false);
    expect(timeline).toHaveTextContent('Five waiters set.'); // present in the DOM, just collapsed
  });
});
