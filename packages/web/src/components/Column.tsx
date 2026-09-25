import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { type ReactNode, useMemo } from 'react';
import type { ColumnCards } from '../store.js';

interface Props {
  column: ColumnCards;
  children: ReactNode;
  /** P8.5: present only for the `done` column — "archive older than 14d". */
  onArchive?: () => void;
  /**
   * RCB-108: the WIP-adjusted count (plan parents excluded by default) — `Board` computes this
   * against the FULL board, a parent's steps can sit in a different column. Omitted, this falls
   * back to `column.cards.length`, so a column with no parent in it renders byte-identical to
   * before RCB-108.
   */
  wipCount?: number;
}

export function Column({ column, children, onArchive, wipCount }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' } });
  // RCB-151: a fresh array every render made `SortableContext`'s `items` referentially unstable,
  // which defeats memoizing the `CardItem`s inside it. Same ids in the same order every time
  // `column.cards` itself doesn't change.
  const items = useMemo(() => column.cards.map((c) => c.id), [column.cards]);
  const rawCount = column.cards.length;
  const count = wipCount ?? rawCount;
  const excludedParents = rawCount - count;
  const breached = column.wip !== undefined && count > column.wip;
  const cls = [
    'column',
    column.active ? 'column--active' : '',
    column.done ? 'column--done' : '',
    column.unconfigured ? 'column--unconfigured' : '',
    isOver ? 'column--over' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={cls} data-column={column.id} aria-label={column.title}>
      <header className="column__head">
        <h2 className="column__title">{column.title}</h2>
        <span
          className={`column__count ${breached ? 'column__count--breach' : ''}`}
          title={
            breached
              ? `WIP limit ${column.wip} exceeded`
              : column.wip
                ? `WIP limit ${column.wip}`
                : undefined
          }
        >
          {count}
          {column.wip !== undefined ? ` / ${column.wip}` : ''}
        </span>
        {column.unconfigured ? <span className="column__note">not in board.yml</span> : null}
        {column.wip !== undefined && excludedParents >= 1 ? (
          <span
            className="column__note"
            title={`${excludedParents} parent${excludedParents === 1 ? '' : 's'} not counted`}
          >
            parents not counted
          </span>
        ) : null}
        {column.done && onArchive ? (
          <button
            type="button"
            className="column__archive"
            title="Move done cards older than 14 days to .repoboard/archive/"
            onClick={onArchive}
          >
            archive older than 14d
          </button>
        ) : null}
      </header>
      <div ref={setNodeRef} className="column__cards">
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
        {rawCount === 0 ? <p className="column__empty">Drop a card here</p> : null}
      </div>
    </section>
  );
}
