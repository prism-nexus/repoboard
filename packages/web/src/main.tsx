import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createMockTransport } from './mock/index.js';
import { createStore } from './store.js';
import './styles.css';
import { connectWs } from './ws.js';

const mock = Boolean(import.meta.env.VITE_MOCK);
const factory = mock ? createMockTransport({ tick: 4000 }) : connectWs;
const store = createStore(factory, {
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
