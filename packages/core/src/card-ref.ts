/**
 * RCB-153 slice 2: `resolveCardRef` (W4), split out of `workspace.ts` (still re-exported from
 * there — no caller-visible change) into its OWN leaf module. Reason: `phases.ts` needs this
 * function too (a WORKSPACE card's `gate:` value resolves by the same prefix rule), and
 * `workspace.ts` imports from `state.ts`, which imports `blockedReason` from `phases.ts` — so
 * `phases.ts` importing `workspace.ts` would close a cycle (workspace → state → phases →
 * workspace). This file imports NOTHING from core (pure id-shape matching over already-loaded
 * data), so both `workspace.ts` and `phases.ts` can depend on it with no cycle either way.
 */

/** One board's key + prefix, as `resolveCardRef` needs to know it. `key: null` is the workspace's
 * own board (checked first, W4); every member carries its own `repos[].key`. */
export interface WorkspaceBoardRef {
  key: string | null;
  prefix: string;
}

export type ResolveCardRefResult =
  | { ok: true; key: string | null; id: string }
  | { ok: false; error: string };

const CARD_REF_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;
/** The same member-key shape `WorkspaceRepoSchema` enforces (`board.ts`). */
const KEYED_REF_SHAPE = /^([a-z0-9][a-z0-9-]*):(.+)$/;

/**
 * W4: resolve a card ref typed at a workspace root. Pure — `boards` is already-loaded data (the
 * workspace's own prefix plus every member's), never read from disk here.
 *
 * `<key>:<id>` is ALWAYS accepted, regardless of any prefix collision, once `key` names a known
 * board. A bare `<PREFIX>-<n>` checks the workspace's OWN prefix first (`key: null` wins any
 * collision with a member); failing that, exactly one member's prefix must match — zero is "no
 * such board", more than one is an error naming every colliding key and suggesting `<key>:<ref>`.
 */
export function resolveCardRef(
  ref: string,
  boards: readonly WorkspaceBoardRef[],
): ResolveCardRefResult {
  const keyed = KEYED_REF_SHAPE.exec(ref);
  if (keyed) {
    const key = keyed[1] as string;
    const id = keyed[2] as string;
    const board = boards.find((b) => b.key === key);
    if (!board) return { ok: false, error: `unknown workspace member "${key}"` };
    return { ok: true, key, id };
  }
  const m = CARD_REF_SHAPE.exec(ref);
  if (!m) {
    return {
      ok: false,
      error: `"${ref}" is not a card id (expected <PREFIX>-<n> or <key>:<PREFIX>-<n>)`,
    };
  }
  const prefix = m[1] as string;
  const workspace = boards.find((b) => b.key === null);
  if (workspace && workspace.prefix === prefix) return { ok: true, key: null, id: ref };
  const matches = boards.filter((b) => b.key !== null && b.prefix === prefix);
  if (matches.length === 0) {
    return { ok: false, error: `no board with prefix "${prefix}" in this workspace` };
  }
  if (matches.length > 1) {
    const keys = matches.map((b) => b.key).join(', ');
    return {
      ok: false,
      error: `prefix "${prefix}" is shared by ${keys} — use <key>:${ref} to disambiguate`,
    };
  }
  const only = matches[0];
  return { ok: true, key: only ? only.key : null, id: ref };
}
