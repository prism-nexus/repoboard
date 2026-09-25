/**
 * RCB-151 step 3: a column above `VIRTUALIZE_AT` (150, `Board.tsx`) mounts only the rows near the
 * `.board` scroller's visible area, not every card — 400 cards in one column, well past the
 * threshold. `board-memo`/`dnd`/`move`/`size`/`search`/`phases`/`columns`/`archive`/`decisions`/
 * `refs`/`board-scroll` have no column that big, so they stay on the plain path and are NOT edited
 * here (the brief's Must-hold: a column at/below 150 renders byte-for-byte what it did before).
 *
 * jsdom has no layout: every `getBoundingClientRect()` is `{top: 0, ...}`, so the column's
 * measured `colTop` is 0 and `.board`'s `clientHeight` reads 0 (`VirtualRows.tsx` falls back to
 * 600, same as `useSize.ts`'s DEFAULT_SIZE fallback). `scrollTop` is forced via
 * `Object.defineProperty` (design's own note) because jsdom's native setter does not persist a
 * value past its (zero) scrollable extent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBoardConfig } from '@repoboard/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const STYLES_PATH = join(__dirname, '..', 'src', 'styles.css');

const avatarRenders = new Map<string, number>();

vi.mock('../src/components/Avatar.jsx', () => ({
  Avatar: ({ assignee }: { assignee: string }) => {
    avatarRenders.set(assignee, (avatarRenders.get(assignee) ?? 0) + 1);
    return <span data-testid={`avatar-${assignee}`} />;
  },
}));

beforeEach(() => avatarRenders.clear());

/** 400 cards in `todo`, one column, well above `VIRTUALIZE_AT` (150). Same `updated` on every
 * one (ties in `columnsWithCards`' sort are stable, so column order stays creation order — this
 * is what lets a test assert on `card-<i>` by its numeric index). */
function manyCards(n = 400) {
  return Array.from({ length: n }, (_, i) => card(String(i), 'todo', { assignee: 'X' }));
}

/** Await one real animation frame — `VirtualRows.tsx` batches its scroll handler to one update
 * per frame (jsdom's `requestAnimationFrame`, `pretendToBeVisual` on by default, is real, not a
 * vitest fake timer, so this is an actual (short) wait, not a no-op). That only guarantees the
 * frame ran, though, not that the resulting re-render has committed: the rAF callback's
 * `setRange` runs outside React's `act()`, and React 18 schedules the render it triggers as a
 * Scheduler task rather than applying it synchronously. Callers still need `waitFor` around the
 * post-scroll assertions. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('column virtualization above 150 cards (RCB-151 step 3)', () => {
  it('(a) mounts only the rows near the top of a 400-card column', () => {
    const store = testStore();
    snapshot(store, manyCards(), defaultBoardConfig());
    renderApp(store);

    const rendered = screen.getAllByTestId(/^card-/);
    expect(rendered.length).toBeLessThan(60);
    expect(screen.getByTestId('card-0')).toBeInTheDocument();
    expect(screen.queryByTestId('card-399')).not.toBeInTheDocument();
  });

  it('(b) scrolling the board moves the mounted window', async () => {
    const store = testStore();
    snapshot(store, manyCards(), defaultBoardConfig());
    renderApp(store);
    expect(screen.getByTestId('card-0')).toBeInTheDocument();

    const board = screen.getByTestId('board');
    Object.defineProperty(board, 'scrollTop', { value: 20000, configurable: true });
    fireEvent.scroll(board);
    await nextFrame();

    // `waitFor` (not a bare assertion): the rAF's `setRange` commits outside `act()`, so without
    // this the assertions below can run before React has applied the re-render `nextFrame`
    // scheduled — a real deferred update, not a timing bug in the test itself.
    await waitFor(() => {
      expect(screen.queryByTestId('card-0')).not.toBeInTheDocument();
      // colTop is 0 in jsdom (see file header), clientHeight falls back to 600: the window is
      // `[20000 - 600, 20000 + 600 + 600]` — row 320 (63px a row) sits well inside it.
      expect(screen.getByTestId('card-320')).toBeInTheDocument();
    });
  });

  it('(c) the dragged card stays mounted when it scrolls out of the window', async () => {
    const store = testStore();
    snapshot(store, manyCards(), defaultBoardConfig());
    renderApp(store);

    const dragged = screen.getByTestId('card-0');
    fireEvent.focus(dragged);
    // dnd-kit's KeyboardSensor activator (`onKeyDown`, keyboardCodes.start) picks this up off
    // `sortable.listeners` and calls the DndContext's `onDragStart` — `Board.tsx` then keeps
    // `dragging.id` ('0') as `activeId` regardless of the scroll window.
    fireEvent.keyDown(dragged, { code: 'Space' });

    // Proof the drag actually started, not just that card-0 happens to still be mounted: dnd-kit's
    // `useDraggable` (under `useSortable`, CardItem.tsx's `sortable.attributes`) sets
    // `aria-pressed="true"` on the sortable element once `isDragging` is true. Without this, a
    // scroll listener that silently never attached (this brief's bug) would leave the window
    // — and card-0 — exactly where it started; the `waitFor` below already proves the window
    // itself moved (card-320 mounts), so this is what proves card-0 surviving is the PIN at work
    // and not just an inert scroll listener that never moved anything.
    expect(dragged).toHaveAttribute('aria-pressed', 'true');

    const board = screen.getByTestId('board');
    Object.defineProperty(board, 'scrollTop', { value: 20000, configurable: true });
    fireEvent.scroll(board);
    await nextFrame();

    // Proves the window actually moved before asserting the pin: `waitFor` because the rAF's
    // `setRange` commits outside `act()` (see `nextFrame`'s doc above).
    await waitFor(() => {
      expect(within(board).getByTestId('card-320')).toBeInTheDocument();
    });

    // *** This is the assertion RCB-151 step 3's second control must break: drop `activeId` from
    // the pinned set in VirtualRows.tsx (the `if (activeId !== null) { … }` block) and this card,
    // now out of the [19400, 21200]-ish window, unmounts along with every other off-screen card. ***
    // Queried through `within(board)`, not the bare `screen`: once the drag starts, `Board.tsx`'s
    // `DragOverlay` (rendered outside `.board`) mounts a second CardItem with the same testid, so
    // `screen.getByTestId('card-0')` here matches both and throws "Found multiple elements".
    expect(within(board).getByTestId('card-0')).toBeInTheDocument();
  });

  it('(d) a sort toggle re-renders the window, not all 400 cards', () => {
    const store = testStore();
    snapshot(store, manyCards(), defaultBoardConfig());
    renderApp(store);
    expect(avatarRenders.get('X')).toBeLessThan(60); // the initial mount

    fireEvent.click(screen.getByTestId('sort-size'));

    // *** This is the assertion RCB-151 step 3's first control must break: with
    // `VIRTUALIZE_AT = Infinity`, the column never virtualizes, so the sort re-renders (and (a)
    // mounts) all 400 Avatars, not under 60. ***
    expect(avatarRenders.get('X')).toBeLessThan(60);
    expect(screen.getAllByTestId(/^card-/).length).toBeLessThan(60);
  });

  it('a virtual row is positioned absolutely against its column-relative box', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const box = css.match(/^\.virtual-rows \{[^}]*\}/m);
    const row = css.match(/^\.virtual-row \{[^}]*\}/m);
    expect(box).not.toBeNull();
    expect(box?.[0]).toContain('position: relative');
    expect(row).not.toBeNull();
    expect(row?.[0]).toContain('position: absolute');
  });
});
