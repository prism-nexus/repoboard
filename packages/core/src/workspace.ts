/**
 * RCB-153 slice 1 (+ slice 2 split): the pure workspace functions (part of W5) — no filesystem, no
 * `Store`. The member registry that actually OPENS a member's board lives server-side
 * (`packages/server/src/workspace.ts`, W3) since opening one is I/O; everything here just
 * formats already-gathered facts, exactly like the rest of this package (§0.5).
 *
 * `resolveCardRef` (W4) itself now lives in the leaf module `card-ref.ts` — `phases.ts` needs it
 * too (a WORKSPACE card's `gate:` value resolves the same way), and importing IT from here would
 * close a cycle (this file imports `state.ts`, which imports `phases.ts`). Re-exported below so no
 * existing import of it from `workspace.js` (or `@repoboard/core`) needs to change.
 */
import type { ResolveCardRefResult, WorkspaceBoardRef } from './card-ref.js';
import { resolveCardRef } from './card-ref.js';
import { formatLeaseLine, liveLeases } from './leases.js';
import { OWNER_QUEUE_PLACEHOLDER, renderOwnerQueue } from './state.js';
import type { Card, LeasesDoc } from './types.js';

export type { ResolveCardRefResult, WorkspaceBoardRef };
export { resolveCardRef };

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
