/**
 * RCB-153 slice 1 (W1, W3): the workspace member registry. `store.ts` is already ~2000 lines
 * (pointer, brief), so this sits beside it rather than growing it further.
 *
 * Opening a member is lazy (only on first `open`/`openAll`), memoised (one `CardStore` per key for
 * the life of this `Workspace`), and read-only: `openStore(..., {watch:false})`'s `load()` only
 * reads files, so a member's tree is never written to just by being opened (W3 — "opening a member
 * creates NOTHING in it: no `.repoboard/local`, no log dir, no gate file"). A `root` that does not
 * exist, or exists but has no `.repoboard/`, is not an error here either — the returned store
 * simply has `hasBoard === false`, exactly `openStore`'s existing map-only contract for any such
 * root. Callers (`cmdState`/`cmdCheck`) decide what a missing member means to them.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  Card,
  Finding,
  GateMemberFacts,
  LeasesDoc,
  SeatRow,
  WorkspaceBoardRef,
  WorkspaceRepo,
} from '@repoboard/core';
import { boardDisplayName, listSeats, resolveCardRef } from '@repoboard/core';
import { type CardStore, openStore } from './store.js';

/** `~` alone, or `~/…`, expands to the user's home directory; anything else passes through
 * untouched (an absolute path stays absolute, a relative one stays relative). */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** W1: `repos[].root` is relative to the WORKSPACE board's own root, or absolute, `~` expanded
 * first (an already-absolute `~/…` path stays absolute either way, so the order never matters). */
export function resolveMemberRoot(workspaceRoot: string, root: string): string {
  const expanded = expandHome(root);
  return isAbsolute(expanded) ? expanded : resolve(workspaceRoot, expanded);
}

/** One configured member, root already resolved (`resolveMemberRoot`) — never a raw `repos[]`
 * entry past construction, so nothing downstream re-does the relative/`~` resolution. */
export interface WorkspaceMember {
  key: string;
  root: string;
  writes?: 'cards';
}

export interface OpenedWorkspaceMember extends WorkspaceMember {
  store: CardStore;
}

export class Workspace {
  readonly members: readonly WorkspaceMember[];
  private readonly opened = new Map<string, Promise<CardStore>>();

  constructor(
    workspaceRoot: string,
    repos: readonly WorkspaceRepo[],
    private readonly now?: () => Date,
  ) {
    this.members = repos.map((r) => ({
      key: r.key,
      root: resolveMemberRoot(workspaceRoot, r.root),
      writes: r.writes,
    }));
  }

  /** `undefined` only when `key` names no configured member. Memoised: the second call for the
   * same `key` returns the SAME open (in-flight or resolved), never opens twice. */
  open(key: string): Promise<CardStore> | undefined {
    const member = this.members.find((m) => m.key === key);
    if (!member) return undefined;
    let p = this.opened.get(key);
    if (!p) {
      p = openStore(member.root, { watch: false, now: this.now });
      this.opened.set(key, p);
    }
    return p;
  }

  /** Every configured member, opened (memoised) in `repos:` order. */
  async openAll(): Promise<OpenedWorkspaceMember[]> {
    const out: OpenedWorkspaceMember[] = [];
    for (const m of this.members) {
      const opening = this.open(m.key);
      if (!opening) continue; // unreachable: `m` came from `this.members` itself
      out.push({ ...m, store: await opening });
    }
    return out;
  }

  /**
   * RCB-153 slice 2, W5: the ONE function that decides whether a member may be WRITTEN to — every
   * card write verb goes through this, never checking `writes:` itself. Throws the EXACT W5
   * refusal text when the member's `writes:` is absent (`board.yml` never granted it — O7's
   * "listing a repo is consent to read it; `writes: cards` is the explicit ask to write"), so
   * every write verb reports the same wording. Opening only happens once that check passes, so a
   * refused write never even opens the member's store.
   */
  async storeForWrite(key: string): Promise<CardStore> {
    const member = this.members.find((m) => m.key === key);
    if (!member) throw new Error(`unknown workspace member "${key}"`);
    if (member.writes !== 'cards') {
      throw new Error(`member ${key} is read-only (set writes: cards in board.yml)`);
    }
    const opening = this.open(key);
    if (!opening) throw new Error(`unknown workspace member "${key}"`); // unreachable, found above
    return opening;
  }
}

/**
 * RCB-153 slice 3b (W7): one member resolved, or an error — the shape MCP's `fail()` wants,
 * never a thrown `UserError` (that convention is `cli.ts`'s own, not this leaf module's).
 */
export type ResolvedWorkspaceTarget =
  | { ok: true; store: CardStore; id: string }
  | { ok: false; error: string };

export interface OpenedWorkspace {
  workspace: Workspace;
  opened: readonly OpenedWorkspaceMember[];
  boards: readonly WorkspaceBoardRef[];
}

/**
 * W3/W4: open every configured member and build the `boards` list `resolveCardRef` needs to
 * resolve a ref by prefix — `cli.ts`'s own (private) `openWorkspace` does the identical thing for
 * the CLI's card verbs; this is the same shape, exported so MCP (`mcp.ts`, which cannot import a
 * private function from `cli.ts`) can share it instead of re-deriving the rule.
 *
 * `null` when `store` carries no `repos:` — the "not a workspace" case every caller must treat
 * identically to a plain board (byte-identical output, the hard constraint every slice of this
 * card keeps).
 *
 * MCP is long-lived (`serveMcp` opens the top-level store once, watched, for the whole process),
 * but a MEMBER opened once and reused would go stale the moment its file changes on disk — nothing
 * here refreshes it after `load()`. So every MCP tool that needs a workspace calls this FRESH, once
 * per tool invocation (never memoised across calls): a new `Workspace`, opened again each time, is
 * strictly cheaper to get right than a long-lived one with its own invalidation logic, and a member
 * board is small enough that re-reading it per call is not a cost worth avoiding.
 */
export async function openWorkspaceBoards(
  root: string,
  store: CardStore,
  now?: () => Date,
): Promise<OpenedWorkspace | null> {
  const repos = store.config.repos ?? [];
  if (repos.length === 0) return null;
  const workspace = new Workspace(root, repos, now);
  const opened = await workspace.openAll();
  const boards: WorkspaceBoardRef[] = [
    { key: null, prefix: store.config.prefix },
    ...opened
      .filter((m) => m.store.hasBoard)
      .map((m) => ({ key: m.key, prefix: m.store.config.prefix })),
  ];
  return { workspace, opened, boards };
}

/** W4: resolve `id` for a READ card verb (`get_card`) — `ws: null` (not a workspace) returns
 * `store`/`id` untouched, so a plain board never calls `resolveCardRef` at all (byte-identical to
 * before this card). */
export function resolveWorkspaceCardRef(
  store: CardStore,
  ws: OpenedWorkspace | null,
  id: string,
): ResolvedWorkspaceTarget {
  if (!ws) return { ok: true, store, id };
  const resolved = resolveCardRef(id, ws.boards);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.key === null) return { ok: true, store, id: resolved.id };
  const member = ws.opened.find((m) => m.key === resolved.key);
  // Unreachable: `resolved.key` only ever names a board that came from `ws.boards`, which is
  // itself built from `ws.opened` above — there is no key `resolveCardRef` could return here that
  // is not already one of `ws.opened`'s own keys.
  if (!member) return { ok: false, error: `unknown workspace member "${resolved.key}"` };
  return { ok: true, store: member.store, id: resolved.id };
}

/**
 * W4/W5: resolve `id` for a WRITE card verb (`move_card`/`update_card`/`add_note`/`ask_owner`/
 * `record_decision`/`append_log`) — same resolution as `resolveWorkspaceCardRef`, but a member
 * target must ALSO clear `Workspace.storeForWrite`, the ONE function that checks `writes: cards`
 * (this function never checks it itself).
 */
export async function resolveWorkspaceWriteTarget(
  store: CardStore,
  ws: OpenedWorkspace | null,
  id: string,
): Promise<ResolvedWorkspaceTarget> {
  if (!ws) return { ok: true, store, id };
  const resolved = resolveCardRef(id, ws.boards);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.key === null) return { ok: true, store, id: resolved.id };
  try {
    const memberStore = await ws.workspace.storeForWrite(resolved.key);
    return { ok: true, store: memberStore, id: resolved.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * RCB-153 gate (W4/W5), moved here from `cli.ts` (RCB-154): `opened`'s members as `gateState`'s
 * member FACTS — raw `cards`/`config`, never a verdict this function itself computed. A missing
 * member (`hasBoard: false`) contributes nothing to resolve against (W3: a finding elsewhere, not
 * a crash here).
 */
export function gateMemberFacts(opened: readonly OpenedWorkspaceMember[]): GateMemberFacts[] {
  return opened
    .filter((m) => m.store.hasBoard)
    .map((m) => ({
      key: m.key,
      prefix: m.store.config.prefix,
      cards: m.store.list(),
      config: m.store.config,
    }));
}

/**
 * RCB-154: `store`'s own gate-member facts — `[]` when `store.config.repos` is absent/empty (not
 * a workspace, or a member with no repos of its own), else `gateMemberFacts` of every configured
 * member, opened fresh (never memoised across calls, same reasoning as `openWorkspaceBoards`).
 * The one function every caller that needs "the members of the board whose cards I am reading"
 * calls instead of re-deriving the `repos.length > 0 ? gateMemberFacts(...) : []` shape by hand.
 */
export async function workspaceGateMembers(
  store: CardStore,
  now?: () => Date,
): Promise<GateMemberFacts[]> {
  const repos = store.config.repos ?? [];
  if (repos.length === 0) return [];
  return gateMemberFacts(await new Workspace(store.root, repos, now).openAll());
}

/**
 * W5: `check`'s member loop — split out of `cmdCheck` (RCB-153 slice 3b) so MCP's `check` tool can
 * run the identical aggregation instead of a second copy of it. A root with no `.repoboard/` is
 * one `workspace-member-missing` error finding naming the key and the resolved path; otherwise the
 * member's own `check` runs (the SAME `checkFindings`/`store.check` every board runs) and every one
 * of its findings is prefixed `[<key>] `. `cmdCheck`'s own output is unchanged by this split — same
 * loop, same ordering, only moved.
 *
 * RCB-154: each member's OWN gate-member facts (`workspaceGateMembers(m.store, now)` — a member
 * that is itself a nested workspace resolves its own `gate:` fields against ITS OWN configured
 * members, never the top workspace's) are passed into that member's `check`, the same REQUIRED
 * `members` argument every `store.check` call now takes.
 */
export async function checkMembers(
  opened: readonly OpenedWorkspaceMember[],
  strict: boolean,
  now?: () => Date,
): Promise<Finding[]> {
  const memberFindings: Finding[] = [];
  for (const { key, root: memberRoot, store } of opened) {
    if (!store.hasBoard) {
      memberFindings.push({
        kind: 'workspace-member-missing',
        level: 'error',
        message: `workspace-member-missing: [${key}] ${memberRoot} has no .repoboard/ (repos: in board.yml)`,
      });
      continue;
    }
    // RCB-160 slice 2: the member's own display name (board.yml `name:`, else its folder — same
    // rule its SEATS bullets and log headers already prefix themselves with, slice 1) can differ
    // from the `key` the WORKSPACE uses for it — surfaced here, before that member's own findings,
    // so a reader sees why `state`'s `[<key>] …` SEATS lines say something other than what the
    // member itself calls itself.
    const displayName = boardDisplayName(store.config, memberRoot);
    if (displayName !== key) {
      memberFindings.push({
        kind: 'workspace-key-name-mismatch',
        level: 'warning',
        message:
          `workspace-key-name-mismatch: [${key}] board name is "${displayName}" (board.yml ` +
          `name, else folder); its SEATS and log headers say [${displayName}], workspace state ` +
          `says [${key}]`,
      });
    }
    const members = await workspaceGateMembers(store, now);
    const outcome = await store.check(strict, members);
    for (const f of outcome.findings) {
      memberFindings.push({ ...f, message: `[${key}] ${f.message}` });
    }
  }
  return memberFindings;
}

/**
 * W5: `state --json`'s `repos:` field — split out of `cmdState` (RCB-153 slice 3b) so MCP
 * `get_state`'s analogous aggregate (no `repo` given, at a workspace) can share it. Generic over
 * the row shape so this leaf module never imports `card-query.ts`'s `ownerQueue` or `mcp.ts`'s
 * `liveLeaseRows` itself — either import would risk a cycle (`mcp.ts` needs `Workspace` from this
 * file for W7); both current callers (`cmdState`, MCP `get_state`) already import those functions
 * for their own top-level fields, so passing them through here costs nothing.
 */
export function memberStateRepos<Q, L>(
  opened: readonly OpenedWorkspaceMember[],
  toOwnerQueue: (cards: readonly Card[]) => Q[],
  toLeaseRows: (doc: LeasesDoc, now: Date) => L[],
  now: Date,
): Record<string, { ownerQueue: Q[]; leases: L[]; seats: SeatRow[]; missing?: true }> {
  const out: Record<string, { ownerQueue: Q[]; leases: L[]; seats: SeatRow[]; missing?: true }> =
    {};
  for (const { key, store } of opened) {
    out[key] = store.hasBoard
      ? {
          ownerQueue: toOwnerQueue(store.list()),
          leases: toLeaseRows(store.leases(), now),
          // RCB-160 slice 2: the SAME `listSeats` `seat list` uses — bare names, never `[key]`- or
          // `[repo]`-prefixed (this is the `--json` field, not the rendered SEATS text).
          seats: listSeats(store.state()?.sections.seats ?? ''),
        }
      : { ownerQueue: [], leases: [], seats: [], missing: true };
  }
  return out;
}
