/**
 * RCB-43 slice 3: the ONE base-path rule. Every fetch the web makes and the WS URL it opens go
 * through this file — nowhere else decides how a repo key turns a path into a scoped one. See
 * `docs/RCB-43-MULTIROOT-BRIEF.md` §"Slice 3 — detailed brief".
 *
 * A `key` of `null` means "the primary" (today's single-repo behaviour, unchanged): every
 * function here treats `null` as "no prefix", never as an error.
 */

/** `?repo=<key>` from the URL, decoded and trimmed. Absent or present-but-empty reads as `null`
 * — the same "no repo chosen" state, never a distinction the caller has to make twice. */
export function repoKeyFromLocation(loc: Pick<Location, 'search'>): string | null {
  const raw = new URLSearchParams(loc.search).get('repo');
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `key` null → `path` unchanged (today's behaviour, exactly). Otherwise `/api/x` becomes
 * `/api/repos/<key>/x`. Throws when `path` does not start with `/api/` — a call site pointed at
 * the wrong kind of path is a bug to fail loudly on, not a silent hit on the primary.
 */
export function apiPath(path: string, key: string | null): string {
  if (!path.startsWith('/api/')) {
    throw new Error(`apiPath: expected a path starting with "/api/", got ${JSON.stringify(path)}`);
  }
  if (key === null) return path;
  return `/api/repos/${encodeURIComponent(key)}${path.slice('/api'.length)}`;
}

/** `'/ws'` for the primary (or no key), `'/api/repos/<key>/ws'` otherwise. */
export function wsPath(key: string | null): string {
  return key === null ? '/ws' : `/api/repos/${encodeURIComponent(key)}/ws`;
}

/**
 * Where to `window.location.assign(...)` to switch to `key` — a real navigation, not an in-place
 * transport swap (the store holds too much live state to re-point safely; a reload is honest).
 * The primary's URL is the plain one: `key === primaryKey` (or `null`) strips the query entirely.
 */
export function locationForRepo(key: string | null, primaryKey: string): string {
  return key === null || key === primaryKey ? '' : `?repo=${encodeURIComponent(key)}`;
}
