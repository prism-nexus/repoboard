import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { type Card, findColumn, isActive } from '@repoboard/core';
import { useCallback, useMemo, useState } from 'react';
import { CardItem } from '../components/CardItem.jsx';
import { Column } from '../components/Column.jsx';
import { Confetti } from '../components/Confetti.jsx';
import { useArrivals, useBoardState, useNow, useStore } from '../hooks.js';
import { type ColumnCards, columnsWithCards, type Store } from '../store.js';

/** Where a drop lands: a column id, or the column of the card it was dropped on. */
export function resolveDropStatus(
  overId: string | number | null | undefined,
  columns: ColumnCards[],
): string | null {
  if (overId === null || overId === undefined) return null;
  const id = String(overId);
  if (columns.some((c) => c.id === id)) return id;
  for (const col of columns) if (col.cards.some((c) => c.id === id)) return col.id;
  return null;
}

/** The drop handler (P3.2): resolve the target column and send `card:move` through the store. */
export function handleDragEnd(store: Store, ev: Pick<DragEndEvent, 'active' | 'over'>): void {
  const state = store.getState();
  const columns = columnsWithCards(state.config, state.cards);
  const status = resolveDropStatus(ev.over?.id, columns);
  if (!status) return;
  store.moveCard(String(ev.active.id), status);
}

/**
 * P7.2: the Board tab for a repo that has no `.repoboard/`. It names `repoboard init` as a
 * command the user runs, and offers no control that would make the server write into the repo —
 * read-only is the feature (plan §5 P7.2, O7), not a default that a button could undo.
 */
function NoBoard({ onShowMap }: { onShowMap: () => void }) {
  return (
    <div className="board board--noboard" data-testid="no-board">
      <div className="noboard">
        <h2 className="noboard__title">This project has no board</h2>
        <p>
          repoboard is serving it <strong>map-only</strong>. The treemap, churn heat and import
          graph all work; there are no columns because there is no <code>.repoboard/</code>
          directory here.
        </p>
        <p>To make one, run this in the project yourself:</p>
        <pre className="noboard__cmd">repoboard init</pre>
        <p>
          The server will not run it for you. Serving a repo never creates, moves or writes anything
          inside it.
        </p>
        <p className="muted">
          Already ran <code>repoboard init</code>? Restart <code>repoboard serve</code> — a board
          that appears while the server is running is not picked up.
        </p>
        <button type="button" className="toggle" onClick={onShowMap}>
          Show the map
        </button>
      </div>
    </div>
  );
}

export function Board() {
  const store = useStore();
  const { config, cards, fun, selectedId, pinned, hasBoard } = useBoardState();
  const now = useNow();
  const columns = useMemo(() => columnsWithCards(config, cards), [config, cards]);
  const [dragging, setDragging] = useState<Card | null>(null);

  const columnIndex = useCallback((s: string) => columns.findIndex((c) => c.id === s), [columns]);
  const isActiveColumn = useCallback(
    (s: string) => (config ? findColumn(config, s)?.active === true : false),
    [config],
  );
  const isDoneColumn = useCallback(
    (s: string) => (config ? findColumn(config, s)?.done === true : false),
    [config],
  );
  const arrivals = useArrivals(cards, columnIndex, isActiveColumn, isDoneColumn);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (ev: DragStartEvent) =>
    setDragging(cards.find((c) => c.id === ev.active.id) ?? null);
  const onDragEnd = (ev: DragEndEvent) => {
    setDragging(null);
    handleDragEnd(store, ev);
  };
  const open = useCallback((id: string) => store.select(id), [store]);
  const pin = useCallback((id: string) => store.togglePin(id), [store]);
  const hover = useCallback((id: string | null) => store.setHover(id), [store]);
  const showMap = useCallback(() => store.setView('map'), [store]);

  const doneOrigin = useMemo(() => {
    if (arrivals.doneBurst === 0 || typeof document === 'undefined') return null;
    const doneCol = columns.find((c) => c.done);
    const el = doneCol ? document.querySelector(`[data-column="${doneCol.id}"]`) : null;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + 40 } : null;
  }, [arrivals.doneBurst, columns]);

  if (!hasBoard) return <NoBoard onShowMap={showMap} />;
  if (!config) {
    return <div className="board board--empty">Waiting for the board…</div>;
  }
  const nowDate = new Date(now);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className={`board ${selectedId ? 'board--drawer' : ''}`} data-testid="board">
        {columns.map((col) => (
          <Column key={col.id} column={col}>
            {col.cards.map((card) => (
              <CardItem
                key={card.id}
                card={card}
                active={isActive(card, config, nowDate)}
                arrival={arrivals.byId.get(card.id)}
                fun={fun}
                onOpen={open}
                pinned={pinned.includes(card.id)}
                onPin={pin}
                onHover={hover}
              />
            ))}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={fun ? undefined : null}>
        {dragging ? (
          <CardItem
            card={dragging}
            active={isActive(dragging, config, nowDate)}
            fun={fun}
            onOpen={open}
            overlay
          />
        ) : null}
      </DragOverlay>
      {fun ? <Confetti burst={arrivals.doneBurst} origin={doneOrigin} /> : null}
    </DndContext>
  );
}
