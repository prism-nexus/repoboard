/**
 * P7.2: a repo with no `.repoboard/` opens map-only. The Board tab explains itself instead of
 * showing five empty columns, and it offers no control that would make the server write a board
 * into someone else's repo — read-only is the feature (plan §5 P7.2, O7).
 */
import { defaultBoardConfig } from '@repoboard/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('map-only mode (hasBoard: false)', () => {
  it('shows the explanation, names `repoboard init`, and renders no columns', () => {
    const store = testStore();
    snapshot(store, [], defaultBoardConfig(), false);
    store.setView('board');
    renderApp(store);

    const panel = screen.getByTestId('no-board');
    expect(screen.queryByTestId('board')).toBeNull();
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(panel.textContent).toContain('repoboard init');
    expect(panel.textContent).toMatch(/never creates, moves or writes anything inside it/);
    // Out of scope, and the copy says so: a board created while serving needs a restart.
    expect(panel.textContent).toMatch(/Restart/);
  });

  it('offers no button that would create a board', () => {
    const store = testStore();
    snapshot(store, [], defaultBoardConfig(), false);
    store.setView('board');
    renderApp(store);

    const names = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim());
    expect(names).not.toEqual(expect.arrayContaining([expect.stringMatching(/init|create/i)]));
    // The only control inside the panel is navigation to the map.
    const inPanel = Array.from(screen.getByTestId('no-board').querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(inPanel).toEqual(['Show the map']);
  });

  it('makes Map the default tab, but a reconnect does not yank the user off Board', () => {
    const store = testStore();
    snapshot(store, [], defaultBoardConfig(), false);
    expect(store.getState().view).toBe('map');
    renderApp(store);
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');

    store.setView('board');
    snapshot(store, [], defaultBoardConfig(), false); // a reconnect snapshot
    expect(store.getState().view).toBe('board');
  });

  it('an empty but initialised board is a normal empty board, not the panel', () => {
    const store = testStore();
    const config = defaultBoardConfig();
    snapshot(store, [], config, true);
    renderApp(store);

    expect(screen.queryByTestId('no-board')).toBeNull();
    expect(screen.getAllByRole('region')).toHaveLength(config.columns.length);
    expect(store.getState().view).toBe('board');
  });

  it('a payload with no hasBoard at all still renders the board (additive field, inert)', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);

    expect(store.getState().hasBoard).toBe(true);
    expect(screen.queryByTestId('no-board')).toBeNull();
    expect(screen.getByTestId('board')).toBeTruthy();
  });
});
