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

// ---- RCB-65: a verb per Event.type ------------------------------------------------------------
describe('Ticker verbs (RCB-65)', () => {
  function setup() {
    const store = testStore();
    store.setFun(false);
    snapshot(store, [card('RCB-9', 'todo', { title: 'Fix the watcher' })]);
    renderApp(store);
    return store;
  }

  it('a create line reads "created <id> <title> in <to>"', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'create', from: null, to: 'backlog' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('created RCB-9 Fix the watcher in backlog');
  });

  it('an update line reads "updated <id> <title>", no arrow (from === to)', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'update', from: 'todo', to: 'todo' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('updated RCB-9 Fix the watcher');
    expect(ticker).not.toHaveTextContent('→');
  });

  it('an ask line reads "asked on <id> <title>"', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'ask', from: 'todo', to: 'todo' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('asked on RCB-9 Fix the watcher');
    expect(ticker).not.toHaveTextContent('→');
  });

  it('a decide line without a letter reads "decided <id> <title>", no arrow', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'decide', from: 'todo', to: 'todo' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('decided RCB-9 Fix the watcher');
    expect(ticker).not.toHaveTextContent('→');
  });

  it('a decide line with a letter reads "decided <id> <title> → <letter>"', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'decide', from: 'todo', to: 'todo', letter: 'A' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('decided RCB-9 Fix the watcher → A');
  });

  it('an archive line reads "archived <id> <title>"; the literal `to` ("archive") is not printed', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'archive', from: 'todo', to: 'archive' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('archived RCB-9 Fix the watcher');
  });

  it('a lease line for a new holder reads "took <resource>"; no card title', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({
          type: 'lease',
          cardId: null,
          resource: 'vitest-lock',
          from: null,
          to: 'claude/builder',
        }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('took vitest-lock');
    expect(ticker?.querySelector('.ticker__title')).toBeNull();
  });

  it('a lease line for `to: "released"` reads "released <resource>"; no card title', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({
          type: 'lease',
          cardId: null,
          resource: 'vitest-lock',
          from: 'claude/builder',
          to: 'released',
        }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('released vitest-lock');
    expect(ticker?.querySelector('.ticker__title')).toBeNull();
  });

  it('a window line reads "added window <to> on <resource>"; no card title', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({
          type: 'window',
          cardId: null,
          resource: 'vitest-lock',
          from: null,
          to: 'cold4 gate',
        }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('added window cold4 gate on vitest-lock');
    expect(ticker?.querySelector('.ticker__title')).toBeNull();
  });

  it('a columns line reads "set columns → <to>" (comma-joined ids); no card title', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({
          type: 'columns',
          cardId: null,
          from: 'backlog,decide,todo,doing,done',
          to: 'backlog,decide,todo,doing,done,archive',
        }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('set columns → backlog,decide,todo,doing,done,archive');
    expect(ticker?.querySelector('.ticker__title')).toBeNull();
  });

  it('a lease event with no `resource` renders empty, never the literal "undefined"', () => {
    const store = setup();
    act(() =>
      store.dispatch({
        type: 'event',
        event: moveEvent({ type: 'lease', cardId: null, from: null, to: 'claude/builder' }),
      }),
    );
    const ticker = document.querySelector('.ticker');
    expect(ticker).toHaveTextContent('took');
    expect(ticker).not.toHaveTextContent('undefined');
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
