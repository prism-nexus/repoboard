import { defaultBoardConfig } from '@repoboard/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { columnsWithCards } from '../src/store.js';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

describe('columns from config', () => {
  it('renders one column per config column, in order, with the configured titles', () => {
    const store = testStore();
    const config = defaultBoardConfig();
    snapshot(store, [card('RB-1', 'todo')], config);
    renderApp(store);
    const board = screen.getByTestId('board');
    const sections = within(board).getAllByRole('region');
    expect(sections).toHaveLength(config.columns.length);
    expect(sections.map((s) => s.getAttribute('data-column'))).toEqual(
      config.columns.map((c) => c.id),
    );
    expect(sections.map((s) => within(s).getByRole('heading', { level: 2 }).textContent)).toEqual([
      'Backlog',
      'To do',
      'Doing',
      'Review',
      'Done',
    ]);
  });

  it('shows count / wip and marks a WIP breach', () => {
    const store = testStore();
    snapshot(store, [
      card('RB-1', 'doing'),
      card('RB-2', 'doing'),
      card('RB-3', 'doing'),
      card('RB-4', 'doing'),
    ]);
    renderApp(store);
    const doing = screen.getByRole('region', { name: 'Doing' });
    const count = within(doing).getByText('4 / 3');
    expect(count.className).toContain('column__count--breach');
  });

  it('sorts cards by updated desc and keeps unknown statuses visible', () => {
    const cols = columnsWithCards(defaultBoardConfig(), [
      card('RB-1', 'todo', { updated: '2026-09-02T21:00:00Z' }),
      card('RB-2', 'todo', { updated: '2026-09-02T23:00:00Z' }),
      card('RB-9', 'limbo'),
    ]);
    expect(cols.find((c) => c.id === 'todo')?.cards.map((c) => c.id)).toEqual(['RB-2', 'RB-1']);
    const limbo = cols.at(-1);
    expect(limbo?.id).toBe('limbo');
    expect(limbo?.unconfigured).toBe(true);
  });
});
