/**
 * RCB-151: `CardItem` is wrapped in `memo` and every prop `Board.tsx` builds for it is
 * referentially/value-stable across a render that changes only `selectedId` (see `Board.tsx`'s
 * `phaseById`/`parentIds` memos and its `useCallback`-wrapped handlers). This guards that the
 * memoization actually skips work for a card whose own data did not change, by counting renders
 * of the (mocked) `Avatar` a card's `CardItem` renders.
 */
import { defaultBoardConfig } from '@repoboard/core';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const avatarRenders = new Map<string, number>();

vi.mock('../src/components/Avatar.jsx', () => ({
  Avatar: ({ assignee }: { assignee: string }) => {
    avatarRenders.set(assignee, (avatarRenders.get(assignee) ?? 0) + 1);
    return <span data-testid={`avatar-${assignee}`} />;
  },
}));

describe('CardItem memoization (RCB-151)', () => {
  it('a card whose own props did not change is not re-rendered when another card is selected', () => {
    const store = testStore();
    // ~6 cards in one column ('todo' — not the active/done column, so `active` stays false for
    // all of them and can't itself be a source of prop instability), each with a distinct
    // assignee so the mock's per-assignee counter can tell them apart. Same size on all of them:
    // the size-filter toggle below then hides none of them ("no card's neighbour").
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const cards = ids.map((id) => card(id, 'todo', { assignee: id, size: 'S' }));
    snapshot(store, cards, defaultBoardConfig());
    renderApp(store);

    expect(avatarRenders.get('B')).toBe(1); // mount

    // Open card A: click its title. Only `selectedId` changes — B's own CardItem props (card,
    // active, arrival, fun, onOpen, pinned, onPin, onHover, phase) are every one of them
    // referentially/value-stable across this render, so a memoized CardItem must skip
    // re-rendering B entirely, and its (unmemoized) Avatar mock must not run again either.
    fireEvent.click(screen.getByTitle('Card A'));
    // *** This is the assertion the control (removing `memo`) must break. *** Without `memo`,
    // `CardItem` is a plain function: React calls it again on every Board re-render regardless of
    // prop equality, so B's Avatar mock fires a second time and this count becomes 2.
    expect(avatarRenders.get('B')).toBe(1);

    // Also toggle a size filter that hides no card (every card here is size S) — a further, real
    // interaction, deliberately NOT re-asserted on: `columnsWithCards`/`visibleCards` build a
    // fresh `Card[]` on every call regardless of whether the resulting set changed, so this
    // gives dnd-kit's `SortableContext` a new `items` array and a new context value even though
    // nothing became visible/hidden. `useSortable` (called from inside `CardItem`) subscribes to
    // that context directly via `useContext`, and a context update reaches every consumer
    // regardless of `memo` — `memo` only blocks a re-render driven by the parent passing
    // unchanged props, not one driven by a context the component itself subscribes to. So every
    // card's `CardItem`, B included, legitimately re-renders here whether or not `memo` is
    // present; that is pre-existing dnd-kit behaviour, not something this card touches, and
    // asserting flat avatar counts across it would fail regardless of the fix.
    fireEvent.click(screen.getByTestId('size-filter-S'));
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(6);
  });
});
