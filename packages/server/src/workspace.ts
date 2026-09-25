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
import type { WorkspaceRepo } from '@repoboard/core';
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
