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
import {
  type Card,
  type Column as ColumnConfig,
  findColumn,
  isActive,
  isPlanParent,
  rollup,
  type Size,
  stepsOf,
  WIP_COUNTS_PARENTS,
} from '@repoboard/core';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { BoardTools } from '../components/BoardTools.jsx';
import { CardItem } from '../components/CardItem.jsx';
import { Column } from '../components/Column.jsx';
import { ColumnEditor } from '../components/ColumnEditor.jsx';
import { Confetti } from '../components/Confetti.jsx';
import { StatePanel } from '../components/StatePanel.jsx';
import { useArrivals, useBoardState, useNow, useStore } from '../hooks.js';
import {
  type ColumnCards,
  columnsWithCards,
  gateChipText,
  type Lane,
  lanesFor,
  phaseInfoFor,
  type SortBy,
  type Store,
  visibleCards,
} from '../store.js';

/** The parent's id for a lane: the parent Card's own id when it exists, else the id read off the
 * lane's first step (an orphan lane) — `undefined` only for the always-present un-parented lane. */
function laneParentId(lane: Lane): string | undefined {
  return lane.parent ? lane.parent.id : lane.cards[0]?.parent;
}

/**
 * RCB-108: the WIP-adjusted count for a column's SHOWN cards (`colCards`, already run through the
 * size filter) — a plan parent doesn't count by default (`WIP_COUNTS_PARENTS`). Parent-ness is
 * judged against `cards`, the FULL board (same reasoning as the RCB-67 comment above on
 * `laneColumns`): a step hidden by the size filter must not flip whether its parent counts.
 */
function wipCountFor(colCards: Card[], cards: readonly Card[]): number {
  if (WIP_COUNTS_PARENTS) return colCards.length;
  return colCards.filter((c) => !isPlanParent(c, cards)).length;
}

/** RCB-108: a lane-chain chip's class — `done` in a `done: true` column, `here` in THIS column
 * (the column the chain itself is rendered in), plain otherwise. */
function laneStepClass(
  step: Card,
  columnId: string,
  isDoneColumn: (status: string) => boolean,
): string {
  if (isDoneColumn(step.status)) return 'lane__step lane__step--done';
  if (step.status === columnId) return 'lane__step lane__step--here';
  return 'lane__step';
}

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

/** Scroll a column into view horizontally — StatePanel's owner-queue links use this. */
function scrollColumnIntoView(columnId: string): void {
  if (typeof document === 'undefined') return;
  document
    .querySelector(`[data-column="${columnId}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

export function Board() {
  const store = useStore();
  const {
    config,
    cards,
    fun,
    selectedId,
    pinned,
    hasBoard,
    state,
    log,
    sizeFilter,
    sortBy,
    query,
    unreachable,
  } = useBoardState();
  const now = useNow();
  const decideColumnId = useMemo(
    () => config?.columns.find((c) => c.decision === true)?.id ?? null,
    [config],
  );
  // RCB-67: `lanesFor`, `phaseInfoFor`, `rollup`, `useArrivals` and the DragOverlay below all
  // keep receiving the FULL `cards` — a gate or a parent can point at a card hidden by the size
  // filter, and the facts do not change because a card is filtered out of view. Only the columns
  // (what actually renders) are built from the filtered/sorted set.
  const shown = useMemo(() => visibleCards(cards, sizeFilter, query), [cards, sizeFilter, query]);
  const columns = useMemo(() => columnsWithCards(config, shown, sortBy), [config, shown, sortBy]);
  // RCB-68: swimlanes within each column. `cards` is reordered to the lanes' own DOM order —
  // the SortableContext inside `<Column>` builds its `items` from `column.cards`, so this is
  // what keeps drag-and-drop's idea of "DOM order" in sync with what's actually rendered below.
  const laneColumns = useMemo(
    () =>
      columns.map((col) => {
        const lanes = lanesFor(col.cards, cards);
        return { ...col, cards: lanes.flatMap((l) => l.cards), lanes };
      }),
    [columns, cards],
  );
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
  const archiveDone = useCallback(() => void store.archiveDone(), [store]);
  const saveColumns = useCallback((cols: ColumnConfig[]) => store.saveColumns(cols), [store]);
  const open = useCallback((id: string) => store.select(id), [store]);
  const pin = useCallback((id: string) => store.togglePin(id), [store]);
  const hover = useCallback((id: string | null) => store.setHover(id), [store]);
  const showMap = useCallback(() => store.setView('map'), [store]);
  const toggleSize = useCallback((size: Size) => store.toggleSize(size), [store]);
  const clearSizeFilter = useCallback(() => store.clearSizeFilter(), [store]);
  const setSortBy = useCallback((s: SortBy) => store.setSortBy(s), [store]);
  const setQuery = useCallback((q: string) => store.setQuery(q), [store]);

  const doneOrigin = useMemo(() => {
    if (arrivals.doneBurst === 0 || typeof document === 'undefined') return null;
    const doneCol = columns.find((c) => c.done);
    const el = doneCol ? document.querySelector(`[data-column="${doneCol.id}"]`) : null;
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + 40 } : null;
  }, [arrivals.doneBurst, columns]);

  if (!hasBoard) return <NoBoard onShowMap={showMap} />;
  if (!config) {
    if (unreachable) {
      const host =
        typeof window !== 'undefined' && window.location.host
          ? window.location.host
          : 'this address';
      return (
        <div className="board board--empty" role="alert">
          Can't reach the repoboard server at {host}. Is <code>repoboard serve</code> running? Still
          retrying…
        </div>
      );
    }
    return <div className="board board--empty">Waiting for the board…</div>;
  }
  const nowDate = new Date(now);
  return (
    <div className="board-view">
      <StatePanel
        state={state}
        cards={cards}
        decideColumnId={decideColumnId}
        onGoToDecide={scrollColumnIntoView}
        log={log}
        now={now}
      />
      <ColumnEditor config={config} cards={cards} onSave={saveColumns} />
      <BoardTools
        sizeFilter={sizeFilter}
        sortBy={sortBy}
        query={query}
        visible={shown.length}
        total={cards.length}
        onToggleSize={toggleSize}
        onClearSizeFilter={clearSizeFilter}
        onSetSortBy={setSortBy}
        onSetQuery={setQuery}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className={`board ${selectedId ? 'board--drawer' : ''}`} data-testid="board">
          {laneColumns.map((col) => (
            <Column
              key={col.id}
              column={col}
              wipCount={wipCountFor(col.cards, cards)}
              onArchive={col.done ? archiveDone : undefined}
            >
              {col.lanes.map((lane) => {
                const parentId = laneParentId(lane);
                const parentRollup = lane.parent ? rollup(lane.parent, cards, config) : null;
                return (
                  <Fragment key={parentId ?? `${col.id}-noparent`}>
                    {parentId ? (
                      <div className="lane__head" data-testid={`lane-${parentId}`}>
                        <button
                          type="button"
                          className="lane__open"
                          onClick={() => open(parentId)}
                          title={`Open ${parentId}`}
                        >
                          {parentId}
                        </button>
                        <span className="lane__title">
                          {lane.parent ? lane.parent.title : '(no such card)'}
                        </span>
                        {parentRollup ? (
                          <span className="lane__rollup">
                            {parentRollup.done}/{parentRollup.total} done
                            {parentRollup.blockedOn
                              ? ` · blocked on ${gateChipText(parentRollup.blockedOn)}`
                              : ''}
                          </span>
                        ) : null}
                        {lane.parent ? (
                          <div className="lane__chain" data-testid={`lane-chain-${parentId}`}>
                            {stepsOf(lane.parent.id, cards).map((step, i) => (
                              <Fragment key={step.id}>
                                {i > 0 ? <span className="lane__chain-arrow">→</span> : null}
                                <span
                                  className={laneStepClass(step, col.id, isDoneColumn)}
                                  title={`${step.id} · ${step.status}`}
                                >
                                  {step.phase ?? step.id}
                                </span>
                              </Fragment>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {lane.cards.map((card) => (
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
                        phase={phaseInfoFor(card, cards, config)}
                      />
                    ))}
                  </Fragment>
                );
              })}
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
    </div>
  );
}
