import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createMockTransport } from './mock/index.js';
import { repoKeyFromLocation } from './repo-key.js';
import { createStore } from './store.js';
import './styles.css';
import type { TransportHandlers } from './wire.js';
import { connectWs, defaultWsUrl } from './ws.js';

const mock = Boolean(import.meta.env.VITE_MOCK);
// RCB-43 slice 3: `store.connect()` always passes the path it wants (`/ws` or the repo-scoped
// `/api/repos/<key>/ws`, from `repo-key.ts`'s `wsPath`) as this factory's second argument; the
// real socket turns that path into a full `ws(s)://` URL, the mock ignores it.
const factory = mock
  ? createMockTransport({ tick: 4000 })
  : (handlers: TransportHandlers, url?: string) =>
      connectWs(handlers, defaultWsUrl(window.location, url));
const store = createStore(factory, {
  repoKey: repoKeyFromLocation(window.location),
  prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
});
store.connect();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
