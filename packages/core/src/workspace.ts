/**
 * RCB-153 slice 1: the pure workspace functions (W4, part of W5) — no filesystem, no `Store`. The
 * member registry that actually OPENS a member's board lives server-side
 * (`packages/server/src/workspace.ts`, W3) since opening one is I/O; everything here just
 * resolves ids and formats already-gathered facts, exactly like the rest of this package (§0.5).
 */
import { formatLeaseLine, liveLeases } from './leases.js';
import { OWNER_QUEUE_PLACEHOLDER, renderOwnerQueue } from './state.js';
import type { Card, LeasesDoc } from './types.js';

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

/** One member's cards for OWNER QUEUE aggregation — `cards: null` marks a `workspace-member-missing`
 * member, whose key still shows up in the rendered section (`(missing)`), never silently dropped. */
export interface WorkspaceOwnerQueueMember {
  key: string;
  cards: readonly Card[] | null;
}

/**
 * W5: the EXTRA (member) OWNER QUEUE lines, `[<key>] `-prefixed, `repos:` order — what
 * `renderState`'s `workspace.ownerQueueLines` takes alongside the workspace's own `openDecisions`
 * (every caller already passes those; this only ever adds MEMBER lines on top). A member with
 * nothing open contributes no line; a missing member always contributes exactly one,
 * `[<key>] (missing)`, so `state` still shows it rather than silently dropping it.
 */
export function workspaceOwnerQueueLines(members: readonly WorkspaceOwnerQueueMember[]): string[] {
  const lines: string[] = [];
  for (const { key, cards } of members) {
    if (cards === null) {
      lines.push(`[${key}] (missing)`);
      continue;
    }
    const body = renderOwnerQueue(cards);
    if (body === OWNER_QUEUE_PLACEHOLDER) continue;
    for (const line of body.split('\n')) lines.push(`[${key}] ${line}`);
  }
  return lines;
}

/** One member's `leases.yml`, already loaded, for LEASES aggregation. A missing member has no
 * leases to show (its `(missing)` already appears once, under OWNER QUEUE — W5 does not ask for a
 * second one here). */
export interface WorkspaceLeasesMember {
  key: string;
  leases: LeasesDoc;
}

/** W5: the EXTRA (member) LEASES lines, `[<key>] `-prefixed, live leases only, `repos:` order —
 * what `renderState`'s `workspace.leaseLines` takes alongside the workspace's own `leasesDoc`. */
export function workspaceLeaseLines(
  members: readonly WorkspaceLeasesMember[],
  now: Date,
): string[] {
  const lines: string[] = [];
  for (const { key, leases } of members) {
    for (const lease of liveLeases(leases, now)) {
      lines.push(`[${key}] ${formatLeaseLine(lease, now)}`);
    }
  }
  return lines;
}
