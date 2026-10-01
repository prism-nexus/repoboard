/**
 * RCB-176: the Flow view's selection as a URL — `?view=flow&system=<id>` or
 * `?view=flow&conn=<from>,<to>[,<id>]` — so a link can open a system or a connection. Ids are
 * `[a-z0-9-]+` (systems, and a connection's optional `id`), which is also what keeps the comma a
 * safe separator. The Flow view reads it once, on mount, and writes it with `replaceState` on
 * every selection change (never `pushState`: a click through the diagram is not history).
 *
 * The string functions here are pure; only `writeFlowUrl` / `clearFlowUrl` touch `window`.
 */

export type FlowSelection =
  | { kind: 'system'; id: string }
  /** `id` is the connection row's own `id`, `null` when it has none. */
  | { kind: 'conn'; from: string; to: string; id: string | null };

const ID = /^[a-z0-9-]+$/;

/** The selection a `location.search` names, or `null`. Anything that is not a well-formed id
 * (or, for `conn`, two or three of them) is ignored, never half-read. `conn` wins if both are
 * present and valid — the view only ever writes one. Whether the ids EXIST is the caller's check. */
export function parseFlowSelection(search: string): FlowSelection | null {
  const params = new URLSearchParams(search);
  const conn = params.get('conn');
  if (conn !== null) {
    const parts = conn.split(',');
    const [from, to, id] = parts;
    if (
      (parts.length === 2 || parts.length === 3) &&
      from !== undefined &&
      to !== undefined &&
      parts.every((p) => ID.test(p))
    ) {
      return { kind: 'conn', from, to, id: id ?? null };
    }
  }
  const system = params.get('system');
  if (system !== null && ID.test(system)) return { kind: 'system', id: system };
  return null;
}

/** `params` as a search string: `''` when empty, else `?…`. The comma is written as itself, not
 * `%2C` — `URLSearchParams` would escape it, and the link reads better with it plain. */
function searchOf(params: URLSearchParams): string {
  const text = params.toString().replace(/%2C/gi, ',');
  return text === '' ? '' : `?${text}`;
}

/** `current` (a `location.search`) with the Flow view's three keys set for `selection`: `view=flow`
 * always, `system` / `conn` only for a selection. Every other key (`repo` …) is kept. */
export function flowSearch(current: string, selection: FlowSelection | null): string {
  const params = new URLSearchParams(current);
  params.set('view', 'flow');
  params.delete('system');
  params.delete('conn');
  if (selection?.kind === 'system') params.set('system', selection.id);
  if (selection?.kind === 'conn') {
    params.set(
      'conn',
      [selection.from, selection.to, ...(selection.id === null ? [] : [selection.id])].join(','),
    );
  }
  return searchOf(params);
}

/** `current` without the Flow view's keys (`view` only when it is `flow`). Everything else stays. */
export function clearedFlowSearch(current: string): string {
  const params = new URLSearchParams(current);
  if (params.get('view') === 'flow') params.delete('view');
  params.delete('system');
  params.delete('conn');
  return searchOf(params);
}

function replaceSearch(next: (current: string) => string): void {
  try {
    const { pathname, search, hash } = window.location;
    const nextSearch = next(search);
    if (nextSearch === search) return;
    window.history.replaceState(window.history.state, '', `${pathname}${nextSearch}${hash}`);
  } catch {
    // No `window`/`history` here, or the browser refused: the URL is a convenience, not state.
  }
}

/** Mirror `selection` into the address bar (`null`: the Flow view is open with nothing selected). */
export function writeFlowUrl(selection: FlowSelection | null): void {
  replaceSearch((current) => flowSearch(current, selection));
}

/** The Flow view is gone: take its keys back out of the address bar. */
export function clearFlowUrl(): void {
  replaceSearch(clearedFlowSearch);
}

/** The selection in the address bar right now (`null` outside a browser). */
export function readFlowUrl(): FlowSelection | null {
  try {
    return parseFlowSelection(window.location.search);
  } catch {
    return null;
  }
}
