/**
 * RCB-67: filter the board to one or more sizes, and choose whether the un-parented lane sorts
 * by `updated` (today's default) or by size. `sizeFilter` never persists (a card hidden by a
 * stale filter after a reload is a trap); `sortBy` does, like `theme` (`store.ts#STORAGE_SORT`).
 */
import type { Size } from '@repoboard/core';
import type { SortBy } from '../store.js';

const SIZES: readonly Size[] = ['S', 'M', 'L', 'XL'];

interface Props {
  sizeFilter: readonly Size[];
  sortBy: SortBy;
  /** Cards visible under the current filter, and the total on the board — shown as "n of m
   * cards" only while a size is picked, since that is when the two differ. */
  visible: number;
  total: number;
  onToggleSize: (size: Size) => void;
  onClearSizeFilter: () => void;
  onSetSortBy: (sortBy: SortBy) => void;
}

export function BoardTools({
  sizeFilter,
  sortBy,
  visible,
  total,
  onToggleSize,
  onClearSizeFilter,
  onSetSortBy,
}: Props) {
  const filtered = sizeFilter.length > 0;
  return (
    <div className="board-tools" data-testid="board-tools">
      <span
        className="board-tools__group"
        title="Show only cards of these sizes (unsized cards are hidden while a size is picked)"
      >
        <span className="board-tools__label">Size:</span>
        {SIZES.map((size) => (
          <button
            key={size}
            type="button"
            className={`toggle ${sizeFilter.includes(size) ? 'toggle--on' : ''}`}
            aria-pressed={sizeFilter.includes(size)}
            data-testid={`size-filter-${size}`}
            onClick={() => onToggleSize(size)}
          >
            {size}
          </button>
        ))}
        {filtered ? (
          <button
            type="button"
            className="toggle"
            data-testid="size-filter-all"
            onClick={onClearSizeFilter}
          >
            all
          </button>
        ) : null}
      </span>
      <span className="board-tools__group">
        <span className="board-tools__label">Sort:</span>
        <button
          type="button"
          className={`toggle ${sortBy === 'updated' ? 'toggle--on' : ''}`}
          aria-pressed={sortBy === 'updated'}
          data-testid="sort-updated"
          onClick={() => onSetSortBy('updated')}
        >
          updated
        </button>
        <button
          type="button"
          className={`toggle ${sortBy === 'size' ? 'toggle--on' : ''}`}
          aria-pressed={sortBy === 'size'}
          data-testid="sort-size"
          onClick={() => onSetSortBy('size')}
        >
          size
        </button>
      </span>
      {filtered ? (
        <span className="board-tools__count">
          {visible} of {total} cards
        </span>
      ) : null}
    </div>
  );
}
