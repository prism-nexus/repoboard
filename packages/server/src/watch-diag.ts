/**
 * RCB-157: an opt-in diagnostic recorder for the card-store watcher, off unless
 * `REPOBOARD_WATCH_DIAG=1` (CI sets it — see `.github/workflows/ci.yml`). CI (Node 24) twice timed
 * out in `waitForEvent` waiting for a `"card"` event that was never emitted — the watcher event
 * was MISSED, not late — and the failure does not reproduce off CI. With the flag on, `store.ts`
 * records the watcher's lifecycle per store root here, and `test/helpers.ts`'s `waitForEvent`
 * dumps the rows for the timed-out root on timeout, so the next real miss prints a trace instead
 * of a bare "timed out" message. Flag off: zero behaviour change (see each call site's `d &&`/
 * `if (d)` guard).
 */

/** `[Date.now(), kind, ...fields]` — `fields` vary by `kind`; see each `record` call site. */
export type WatchDiagRow = [number, string, ...unknown[]];

export interface WatchDiag {
  record(root: string, kind: string, ...fields: unknown[]): void;
  rows(root: string): WatchDiagRow[];
  dump(root: string): string;
}

/** Rows are kept per store `root` in a `Map`; past `maxPerRoot` the OLDEST row for that root is
 * dropped, so a long-running watcher's trace stays bounded to its most recent activity. */
export function createWatchDiag(maxPerRoot = 500): WatchDiag {
  const byRoot = new Map<string, WatchDiagRow[]>();
  return {
    record(root, kind, ...fields) {
      let rows = byRoot.get(root);
      if (!rows) {
        rows = [];
        byRoot.set(root, rows);
      }
      rows.push([Date.now(), kind, ...fields]);
      if (rows.length > maxPerRoot) rows.splice(0, rows.length - maxPerRoot);
    },
    rows(root) {
      return byRoot.get(root) ?? [];
    },
    dump(root) {
      const rows = byRoot.get(root) ?? [];
      const header = `RB157 DIAG root=${root} node=${process.version} rows=${rows.length} now=${Date.now()}`;
      return [header, ...rows.map((row) => JSON.stringify(row))].join('\n');
    },
  };
}

/** A recorder iff `env.REPOBOARD_WATCH_DIAG === '1'` — any other value (unset, `'0'`, `'true'`,
 * anything else) is inert, `null`. */
export function watchDiagFromEnv(env: Record<string, string | undefined>): WatchDiag | null {
  return env.REPOBOARD_WATCH_DIAG === '1' ? createWatchDiag() : null;
}

/** Module state, seeded once from `process.env` below. `store.ts` and `test/helpers.ts` read it
 * through `getWatchDiag()`; tests override it with `setWatchDiag()` (e.g. to force it on
 * regardless of env, or to reset it to `null` in `afterEach`). */
let current: WatchDiag | null = watchDiagFromEnv(process.env);

export function getWatchDiag(): WatchDiag | null {
  return current;
}

export function setWatchDiag(d: WatchDiag | null): void {
  current = d;
}
