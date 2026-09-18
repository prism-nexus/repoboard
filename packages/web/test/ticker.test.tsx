/**
 * RCB-44: the ticker's "what moved" line carries the card's short title beside its id, so a
 * human reads what got done without opening the card.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from '@repoboard/core';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortTitle } from '../src/components/Ticker.jsx';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const NOW_ISO = '2026-09-02T22:41:10Z';
// vitest shims `__dirname`; `fileURLToPath(new URL(…, import.meta.url))` throws under jsdom.
const STYLES_PATH = join(__dirname, '..', 'src', 'styles.css');

beforeEach(() => vi.useFakeTimers({ now: new Date(NOW_ISO) }));
afterEach(() => vi.useRealTimers());

function moveEvent(overrides: Partial<Event> = {}): Event {
  return {
    ts: NOW_ISO,
    actor: 'claude/builder',
    type: 'move',
    cardId: 'RCB-9',
    from: 'todo',
    to: 'done',
    ...overrides,
  };
}

describe('Ticker', () => {
  it("a move line shows the card's title after its id", () => {
    const store = testStore();
    store.setFun(false);
    snapshot(store, [card('RCB-9', 'todo', { title: 'Fix the watcher' })]);
    renderApp(store);
    act(() => store.dispatch({ type: 'event', event: moveEvent() }));
    const ticker = screen.getByText(/moved/).closest('.ticker');
    expect(ticker).toHaveTextContent('RCB-9 Fix the watcher → done');
  });

  it('a title longer than 48 chars is cut with an ellipsis', () => {
    const longTitle = 'x'.repeat(60);
    const store = testStore();
    store.setFun(false);
    snapshot(store, [card('RCB-9', 'todo', { title: longTitle })]);
    renderApp(store);
    act(() => store.dispatch({ type: 'event', event: moveEvent() }));
    const ticker = screen.getByText(/moved/).closest('.ticker');
    expect(ticker).toHaveTextContent(`${'x'.repeat(47)}…`);
    expect(ticker).not.toHaveTextContent(longTitle);
  });

  it('an event for a card the board no longer has renders the id alone', () => {
    const store = testStore();
    store.setFun(false);
    snapshot(store, [card('RCB-9', 'todo', { title: 'Fix the watcher' })]);
    renderApp(store);
    act(() => store.dispatch({ type: 'event', event: moveEvent({ cardId: 'RCB-404' }) }));
    const ticker = screen.getByText(/moved/).closest('.ticker');
    expect(ticker).toHaveTextContent('RCB-404 → done');
    expect(ticker?.querySelector('.ticker__title')).toBeNull();
    expect(ticker).not.toHaveTextContent('untitled');
  });
});

describe('shortTitle', () => {
  it('leaves a 48-char title untouched', () => {
    const title = 'x'.repeat(48);
    expect(shortTitle(title)).toBe(title);
  });

  it('cuts a 49-char title to 47 chars plus an ellipsis', () => {
    const title = 'x'.repeat(49);
    expect(shortTitle(title)).toBe(`${'x'.repeat(47)}…`);
  });
});

// jsdom computes no layout, so the rule that keeps the marquee track from widening the page is
// asserted from the CSS source: an implicit `auto` grid column sizes to the track's max-content
// (measured 10389px on the fpj board with 20 events), and `minmax(0, 1fr)` is what pins it.
describe('ticker layout', () => {
  it('the .app grid column is minmax(0, 1fr), so the nowrap track cannot widen the page', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/\.app\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  });
});
