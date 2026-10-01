import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('card WS message', () => {
  it('moves the card element to the new status column', () => {
    const store = testStore();
    const c = card('RB-7', 'todo');
    snapshot(store, [c, card('RB-8', 'backlog')]);
    renderApp(store);

    const el = () => screen.getByTestId('card-RB-7');
    expect(el().closest('[data-column]')?.getAttribute('data-column')).toBe('todo');

    act(() =>
      store.dispatch({
        type: 'card',
        card: { ...c, status: 'review', updated: '2026-09-02T23:00:00Z' },
      }),
    );
    expect(el().closest('[data-column]')?.getAttribute('data-column')).toBe('review');
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(2);
  });

  it('removes a card on card:removed and adds an unseen card on card', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    act(() => store.dispatch({ type: 'card', card: card('RB-2', 'doing') }));
    expect(
      screen.getByTestId('card-RB-2').closest('[data-column]')?.getAttribute('data-column'),
    ).toBe('doing');
    act(() => store.dispatch({ type: 'card:removed', id: 'RB-1' }));
    expect(screen.queryByTestId('card-RB-1')).toBeNull();
  });
});
