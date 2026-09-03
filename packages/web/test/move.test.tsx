import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('card WS message', () => {
  it('moves the card element to the new status column', () => {
    const store = testStore();
    const c = card('RCB-7', 'todo');
    snapshot(store, [c, card('RCB-8', 'backlog')]);
    renderApp(store);

    const el = () => screen.getByTestId('card-RCB-7');
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
    snapshot(store, [card('RCB-1', 'todo')]);
    renderApp(store);
    act(() => store.dispatch({ type: 'card', card: card('RCB-2', 'doing') }));
    expect(
      screen.getByTestId('card-RCB-2').closest('[data-column]')?.getAttribute('data-column'),
    ).toBe('doing');
    act(() => store.dispatch({ type: 'card:removed', id: 'RCB-1' }));
    expect(screen.queryByTestId('card-RCB-1')).toBeNull();
  });
});
