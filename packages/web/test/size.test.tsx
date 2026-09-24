/**
 * RCB-67: the size chip (`CardItem`), the Drawer's size select, the `visibleCards`/
 * `columnsWithCards` selectors (`store.ts`), and `BoardTools` (filter + sort).
 */
import { defaultBoardConfig } from '@repoboard/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SIZE_TITLE } from '../src/components/CardItem.jsx';
import { createMockTransport } from '../src/mock/index.js';
import { columnsWithCards, createStore, STORAGE_SORT, visibleCards } from '../src/store.js';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const config = defaultBoardConfig(); // backlog, decide, todo, doing, done{done:true}

describe('CardItem: title', () => {
  it('RCB-139: the title button carries `title` equal to the full (300-char) card title', () => {
    const longTitle = 'x'.repeat(300);
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { title: longTitle })]);
    renderApp(store);
    const titleButton = within(screen.getByTestId('card-RB-1')).getByText(longTitle, {
      selector: '.card__title',
    });
    expect(titleButton).toHaveAttribute('title', longTitle);
  });
});

describe('CardItem: size chip', () => {
  it('shows the size and the scale sentence as its title', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { size: 'M' })]);
    renderApp(store);
    const chip = screen.getByTestId('size-RB-1');
    expect(chip).toHaveClass('chip--size');
    expect(chip).toHaveTextContent('M');
    expect(chip).toHaveAttribute('title', SIZE_TITLE.M);
  });

  it('a card without size renders NO .chip--size anywhere', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo'), card('RB-2', 'doing', { labels: ['x'] })]);
    renderApp(store);
    expect(document.querySelectorAll('.chip--size')).toHaveLength(0);
  });
});

describe('Drawer: size select', () => {
  it('sends {size: "L"} then {size: null} through store.updateCard (card:update on the wire)', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { size: 'S' })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const select = screen.getByTestId('size-select') as HTMLSelectElement;
    expect(select.value).toBe('S');

    fireEvent.change(select, { target: { value: 'L' } });
    expect(store.sent).toContainEqual({
      type: 'card:update',
      id: 'RB-1',
      patch: { size: 'L' },
    });

    fireEvent.change(select, { target: { value: '' } });
    expect(store.sent).toContainEqual({
      type: 'card:update',
      id: 'RB-1',
      patch: { size: null },
    });
  });
});

describe('visibleCards', () => {
  it('[] returns every card, same order, unchanged', () => {
    const cards = [card('RB-1', 'todo', { size: 'S' }), card('RB-2', 'todo')];
    const result = visibleCards(cards, []);
    expect(result).toEqual(cards);
  });

  it("['S'] hides M and unsized cards", () => {
    const s = card('RB-1', 'todo', { size: 'S' });
    const m = card('RB-2', 'todo', { size: 'M' });
    const unsized = card('RB-3', 'todo');
    expect(visibleCards([s, m, unsized], ['S'])).toEqual([s]);
  });
});

describe('columnsWithCards: sortBy', () => {
  it("'size' orders S, M, L, XL, then unsized, ties broken by updated desc", () => {
    const xl = card('RB-1', 'todo', { size: 'XL', updated: '2026-09-01T00:00:00Z' });
    const s = card('RB-2', 'todo', { size: 'S', updated: '2026-09-01T00:00:00Z' });
    const unsized = card('RB-3', 'todo', { updated: '2026-09-05T00:00:00Z' });
    const mNewer = card('RB-4', 'todo', { size: 'M', updated: '2026-09-03T00:00:00Z' });
    const mOlder = card('RB-5', 'todo', { size: 'M', updated: '2026-09-02T00:00:00Z' });
    const cols = columnsWithCards(config, [xl, s, unsized, mNewer, mOlder], 'size');
    const todo = cols.find((c) => c.id === 'todo');
    expect(todo?.cards.map((c) => c.id)).toEqual(['RB-2', 'RB-4', 'RB-5', 'RB-1', 'RB-3']);
  });

  it("'updated' (default parameter) is byte-identical to the two-arg call", () => {
    const a = card('RB-1', 'todo', { updated: '2026-09-01T00:00:00Z' });
    const b = card('RB-2', 'todo', { updated: '2026-09-05T00:00:00Z' });
    const twoArg = columnsWithCards(config, [a, b]);
    const threeArg = columnsWithCards(config, [a, b], 'updated');
    expect(threeArg).toEqual(twoArg);
  });
});

describe('BoardTools', () => {
  it('toggling a size filters the board and shows "n of m cards"; "all" clears it', () => {
    const store = testStore();
    snapshot(store, [
      card('RB-1', 'todo', { size: 'S' }),
      card('RB-2', 'todo', { size: 'M' }),
      card('RB-3', 'todo'),
    ]);
    renderApp(store);
    expect(screen.queryByTestId('size-filter-all')).toBeNull();
    expect(screen.queryByText(/of 3 cards/)).toBeNull();

    fireEvent.click(screen.getByTestId('size-filter-S'));
    expect(screen.getByTestId('size-filter-S')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 of 3 cards')).toBeInTheDocument();
    expect(screen.queryByTestId('card-RB-2')).toBeNull();
    expect(screen.queryByTestId('card-RB-3')).toBeNull();
    expect(screen.getByTestId('card-RB-1')).toBeInTheDocument();

    const all = screen.getByTestId('size-filter-all');
    fireEvent.click(all);
    expect(screen.queryByTestId('size-filter-all')).toBeNull();
    expect(screen.getByTestId('card-RB-2')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-3')).toBeInTheDocument();
  });

  it('sort toggle persists to localStorage (STORAGE_SORT)', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const store1 = createStore(createMockTransport({ tick: null }), { storage });
    expect(store1.getState().sortBy).toBe('updated');
    store1.setSortBy('size');
    expect(mem.get(STORAGE_SORT)).toBe('size');

    // A fresh store reading the same storage picks up the persisted choice.
    const store2 = createStore(createMockTransport({ tick: null }), { storage });
    expect(store2.getState().sortBy).toBe('size');
  });

  it('with nothing toggled, the Board DOM has 0 hidden cards (every card renders)', () => {
    const store = testStore();
    snapshot(store, [
      card('RB-1', 'todo', { size: 'S' }),
      card('RB-2', 'doing', { size: 'M' }),
      card('RB-3', 'done'),
    ]);
    renderApp(store);
    expect(screen.getByTestId('card-RB-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-2')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-3')).toBeInTheDocument();
    expect(within(screen.getByTestId('board')).queryAllByTestId(/^card-/)).toHaveLength(3);
  });
});
