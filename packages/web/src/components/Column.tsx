import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { ReactNode } from 'react';
import type { ColumnCards } from '../store.js';

interface Props {
  column: ColumnCards;
  children: ReactNode;
}

export function Column({ column, children }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' } });
  const count = column.cards.length;
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
      </header>
      <div ref={setNodeRef} className="column__cards">
        <SortableContext
          items={column.cards.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          {children}
        </SortableContext>
        {count === 0 ? <p className="column__empty">Drop a card here</p> : null}
      </div>
    </section>
  );
}
