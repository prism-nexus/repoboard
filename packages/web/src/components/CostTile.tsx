/**
 * P8.4: "cold context" — one tile on the Map view header (locked decision 5): bytes/≈tokens of
 * what a cold agent loads. Fetched directly from `GET /api/cost` on mount, the same K7 pattern
 * `Drawer.tsx`'s `useRefs` uses for `GET /api/cards/:id/refs` — this is not board state, so it
 * does not need to travel through the WS snapshot the way cards/leases/state do. Click opens a
 * drawer-styled panel with the full table (`formatCostTable`'s data, rendered as a real table).
 */
import type { CostReport } from '@repoboard/core';
import { useEffect, useState } from 'react';
import { useStore } from '../hooks.js';
import { formatBytes } from '../map/model.js';
import { apiPath } from '../repo-key.js';

type CostState =
  | { kind: 'loading' }
  | { kind: 'ok'; report: CostReport }
  | { kind: 'error'; message: string };

function useCost(): CostState {
  const store = useStore();
  const repoKey = store.getState().repoKey;
  const [state, setState] = useState<CostState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    const url = apiPath('/api/cost', repoKey);
    const load = async (): Promise<CostState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const report = (await res.json()) as CostReport;
      return { kind: 'ok', report };
    };
    load()
      .catch(
        (e: unknown): CostState => ({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [repoKey]);
  return state;
}

function formatApproxTokens(n: number): string {
  if (n < 1000) return `≈${n} tok`;
  return `≈${(n / 1000).toFixed(1)}k tok`;
}

interface TileProps {
  onOpen: () => void;
}

/** `cold context ≈10.2k tok · CLAUDE.md 5.0 KB ✓` (✗ in the warning color when OVER). */
export function CostTile({ onOpen }: TileProps) {
  const state = useCost();
  if (state.kind !== 'ok') return null;
  const { report } = state;
  const claudeMd =
    report.claudeMdBytes === null
      ? 'CLAUDE.md absent'
      : `CLAUDE.md ${formatBytes(report.claudeMdBytes)}`;
  return (
    <button
      type="button"
      className="cost-tile"
      onClick={onOpen}
      data-testid="cost-tile"
      title="Cold context: what a cold agent loads before it does anything. Click for the table."
    >
      cold context {formatApproxTokens(report.totalTokensApprox)} · {claudeMd}{' '}
      <span
        className={report.over ? 'cost-tile__mark cost-tile__mark--over' : 'cost-tile__mark'}
        data-testid="cost-tile-mark"
      >
        {report.over ? '✗' : '✓'}
      </span>
    </button>
  );
}

interface PanelProps {
  onClose: () => void;
}

/** The full table, drawer-styled (locked decision 5: "click → the table in the Drawer"). */
export function CostPanel({ onClose }: PanelProps) {
  const state = useCost();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="drawer cost-panel" data-testid="cost-panel">
      <div className="drawer__bar">
        <h3 className="rail__h">Cold context</h3>
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {state.kind === 'loading' ? <p className="muted">Loading…</p> : null}
      {state.kind === 'error' ? <p className="rail__empty">{state.message}</p> : null}
      {state.kind === 'ok' ? <CostTable report={state.report} /> : null}
    </aside>
  );
}

function CostTable({ report }: { report: CostReport }) {
  return (
    <>
      <table className="cost-table mono" data-testid="cost-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Bytes</th>
            <th>≈tok</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((e) => (
            <tr key={e.file}>
              <td>{e.file}</td>
              <td>{e.bytes}</td>
              <td>{formatApproxTokens(e.bytes).replace(' tok', '')}</td>
              <td>{e.why}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>total</td>
            <td>{report.totalBytes}</td>
            <td>{formatApproxTokens(report.totalTokensApprox).replace(' tok', '')}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <p
        className={
          report.over ? 'cost-panel__verdict cost-panel__verdict--over' : 'cost-panel__verdict'
        }
      >
        {report.claudeMdBytes === null
          ? 'CLAUDE.md — absent'
          : `CLAUDE.md ${report.claudeMdBytes} of budget ${report.budget} — ${report.over ? 'OVER' : 'OK'}`}
      </p>
      {report.mcpServers.length > 0 ? (
        <p className="muted">
          MCP servers: {report.mcpServers.join(', ')} ({report.mcpNote})
        </p>
      ) : null}
      <p className="muted">≈tok is an estimate: bytes / 4.</p>
    </>
  );
}
