import { isActive } from '@repoboard/core';
import { useCallback, useEffect, useMemo } from 'react';
import { Drawer } from './components/Drawer.jsx';
import { LogTimeline } from './components/LogTimeline.jsx';
import { NowStrip } from './components/NowStrip.jsx';
import { Ticker } from './components/Ticker.jsx';
import { Toasts } from './components/Toasts.jsx';
import { TopBar } from './components/TopBar.jsx';
import { StoreContext, useBoardState, useNow, useStore } from './hooks.js';
import { columnsWithCards, type Store } from './store.js';
import { Board } from './views/Board.jsx';
import { MapView } from './views/Map.jsx';

export function App({ store }: { store: Store }) {
  return (
    <StoreContext.Provider value={store}>
      <Shell />
    </StoreContext.Provider>
  );
}

function Shell() {
  const store = useStore();
  const state = useBoardState();
  const now = useNow();

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);
  useEffect(() => {
    document.documentElement.dataset.fun = state.fun ? '1' : '0';
  }, [state.fun]);

  const selected = state.selectedId
    ? state.cards.find((c) => c.id === state.selectedId)
    : undefined;
  const columns = useMemo(
    () => columnsWithCards(state.config, state.cards),
    [state.config, state.cards],
  );
  const close = useCallback(() => store.select(null), [store]);
  const showOnMap = useCallback(
    (id: string) => {
      if (!store.getState().pinned.includes(id)) store.togglePin(id);
      store.select(null);
      store.setView('map');
    },
    [store],
  );

  return (
    <div className="app">
      <TopBar
        config={state.config}
        siblings={state.siblings}
        repo={state.repo}
        connected={state.connected}
        fun={state.fun}
        theme={state.theme}
        view={state.view}
        onView={store.setView}
        onFun={store.setFun}
        onTheme={store.setTheme}
      />
      <NowStrip leases={state.leases} now={now} />
      <div className="status-row">
        <Ticker events={state.events} fun={state.fun} now={now} />
        <LogTimeline log={state.log} now={now} />
      </div>
      {state.everConnected && !state.connected ? (
        <div className="banner" role="alert">
          Disconnected from the server. Reconnecting… the board shows the last state it saw.
        </div>
      ) : null}
      <main className="main">{state.view === 'board' ? <Board /> : <MapView />}</main>
      {selected && state.config ? (
        <Drawer
          card={selected}
          columns={columns}
          active={isActive(selected, state.config, new Date(now))}
          now={now}
          onClose={close}
          onMove={store.moveCard}
          onUpdate={store.updateCard}
          onShowOnMap={showOnMap}
          onDecide={store.decideCard}
        />
      ) : null}
      <Toasts toasts={state.toasts} onDismiss={store.dismissToast} />
    </div>
  );
}
