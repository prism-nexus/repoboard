/**
 * RCB-147: `visibleCards`' query rule (`store.ts`) and the board's search box (`BoardTools.tsx`,
 * wired in `Board.tsx`).
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { visibleCards } from '../src/store.js';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('visibleCards: query', () => {
  it('empty query returns every card (unconfigured is inert)', () => {
    const cards = [card('RB-1', 'todo'), card('RB-2', 'todo')];
    expect(visibleCards(cards, [], '')).toEqual(cards);
    expect(visibleCards(cards, [], '   ')).toEqual(cards);
  });

  it('matches a term against the id', () => {
    const a = card('RB-1', 'todo');
    const b = card('RB-2', 'todo');
    expect(visibleCards([a, b], [], 'rb-1')).toEqual([a]);
  });

  it('matches a term against a label, case-insensitively', () => {
    const a = card('RB-1', 'todo', { labels: ['Frontend'] });
    const b = card('RB-2', 'todo', { labels: ['backend'] });
    expect(visibleCards([a, b], [], 'FRONT')).toEqual([a]);
  });

  it('two whitespace-separated terms are AND-ed (each must match, not necessarily the same field)', () => {
    const a = card('RB-1', 'todo', { title: 'Fix the login bug', labels: ['urgent'] });
    const b = card('RB-2', 'todo', { title: 'Fix the login bug' });
    const c = card('RB-3', 'todo', { title: 'Something else', labels: ['urgent'] });
    expect(visibleCards([a, b, c], [], 'login urgent')).toEqual([a]);
  });
});

describe('BoardTools: search box', () => {
  it('typing narrows the DOM to matching cards and shows "n of m cards"; Escape restores all', () => {
    const store = testStore();
    snapshot(store, [
      card('RB-1', 'todo', { title: 'Fix login' }),
      card('RB-2', 'todo', { title: 'Add export' }),
      card('RB-3', 'todo', { title: 'Fix export' }),
    ]);
    renderApp(store);
    const box = screen.getByTestId('board-search') as HTMLInputElement;

    fireEvent.change(box, { target: { value: 'fix' } });
    expect(screen.getByText('2 of 3 cards')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-3')).toBeInTheDocument();
    expect(screen.queryByTestId('card-RB-2')).toBeNull();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(screen.queryByText(/of 3 cards/)).toBeNull();
    expect(screen.getByTestId('card-RB-2')).toBeInTheDocument();
  });

  it('a size filter and a query intersect (neither alone gives this result)', () => {
    const store = testStore();
    // 'login' matches RB-1 and RB-2, but only RB-1 is size S; size S alone would also keep RB-3.
    // Only the intersection of both rules narrows to RB-1 alone.
    snapshot(store, [
      card('RB-1', 'todo', { title: 'Fix login', size: 'S' }),
      card('RB-2', 'todo', { title: 'Fix login', size: 'M' }),
      card('RB-3', 'todo', { title: 'Fix db', size: 'S' }),
    ]);
    renderApp(store);
    fireEvent.click(screen.getByTestId('size-filter-S'));
    fireEvent.change(screen.getByTestId('board-search'), { target: { value: 'login' } });

    expect(screen.getByText('1 of 3 cards')).toBeInTheDocument();
    expect(screen.getByTestId('card-RB-1')).toBeInTheDocument();
    expect(screen.queryByTestId('card-RB-2')).toBeNull();
    expect(screen.queryByTestId('card-RB-3')).toBeNull();
  });
});
