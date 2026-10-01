/**
 * RCB-67: filter the board to one or more sizes, and choose whether the un-parented lane sorts
 * by `updated` (today's default) or by size. `sizeFilter` never persists (a card hidden by a
 * stale filter after a reload is a trap); `sortBy` does, like `theme` (`store.ts#STORAGE_SORT`).
 *
 * RCB-147: a free-text search box narrows further, same non-persistence reasoning as
 * `sizeFilter` — see `State.query`'s doc comment.
 */
import type { Size } from '@repoboard/core';
import { useEffect, useRef } from 'react';
import type { SortBy } from '../store.js';

const SIZES: readonly Size[] = ['S', 'M', 'L', 'XL'];

/** Elements `/` must NOT hijack focus away from. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface Props {
  sizeFilter: readonly Size[];
  sortBy: SortBy;
  query: string;
  /** Cards visible under the current filter, and the total on the board — shown as "n of m
   * cards" while a size is picked or a query is active, since that is when the two differ. */
  visible: number;
  total: number;
  onToggleSize: (size: Size) => void;
  onClearSizeFilter: () => void;
  onSetSortBy: (sortBy: SortBy) => void;
  onSetQuery: (query: string) => void;
}

export function BoardTools({
  sizeFilter,
  sortBy,
  query,
  visible,
  total,
  onToggleSize,
  onClearSizeFilter,
  onSetSortBy,
  onSetQuery,
}: Props) {
  const filtered = sizeFilter.length > 0 || query.trim() !== '';
  const inputRef = useRef<HTMLInputElement>(null);

  // RCB-147: '/' focuses the search box from anywhere on the page, unless focus is already in a
  // typing target (input/textarea/select/contenteditable) — a document-level keydown listener,
  // added on mount and removed on unmount (the effect's cleanup), same lifecycle as any other
  // window-level listener in this codebase.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== '/' || isTypingTarget(document.activeElement)) return;
      ev.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="board-tools" data-testid="board-tools">
      <input
        ref={inputRef}
        type="search"
        className="board-tools__search"
        placeholder="Filter: title, id, label"
        aria-label="Filter cards"
        data-testid="board-search"
        value={query}
        onChange={(ev) => onSetQuery(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') onSetQuery('');
        }}
      />
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
        {sizeFilter.length > 0 ? (
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
