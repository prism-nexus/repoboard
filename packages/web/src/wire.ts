/** Wire contract, verbatim from BUILD-PLAN §3. The web never assumes more than this. */
import type {
  BoardConfig,
  Card,
  CardPatch,
  DecisionOption,
  Event,
  GateMemberFacts,
  Lease,
  RepoSnapshot,
  Sibling,
  StateSections,
  SystemsDoc,
  Window,
} from '@repoboard/core';

/**
 * P8.2: the whole of `.repoboard/leases.yml` plus which resources are currently stale and the
 * server's own clock, so a client renders staleness without trusting its own. Same shape as
 * `GET /api/leases`.
 */
export interface LeasesPayload {
  leases: Lease[];
  windows: Window[];
  stale: string[];
  now: string;
}

/**
 * P8.3: `GET /api/state`'s shape, and the `state` half of the WS snapshot. OWNER QUEUE is
 * generated fresh server-side from cards that need a decision every time this is sent — but the
 * web recomputes its OWN display list from the live `cards` it already has (P8.1's `needsDecision`
 * + `ownerQueueLine`), so a `card` message updating a decision does not need a fresh `state`
 * broadcast to stay accurate; `ownerQueue`/`text` here are for a plain HTTP/CLI/MCP caller.
 * `stamp`/`sections`/etc. are all `null` before any STATE.md exists.
 */
export interface StatePayload {
  stamp: string | null;
  actor: string | null;
  sections: StateSections | null;
  ownerQueue: Array<{ id: string; question: string; options: DecisionOption[] }>;
  text: string | null;
}

/** P8.3: one `.repoboard/log/<date>.md` file — the `log` half of the WS snapshot and messages. */
export interface LogPayload {
  date: string;
  text: string;
}

/**
 * RCB-97/98: `GET /api/systems`'s whole payload, and the `systems` half of the WS snapshot/message.
 * `exists: false` means no `systems.yml` at all (`doc: null`, `errors: []`, inert per plan §3.1);
 * `exists: true` with `doc: null` means the file is there but failed to parse (`errors` non-empty).
 */
export interface SystemsPayload {
  doc: SystemsDoc | null;
  errors: string[];
  exists: boolean;
}

/**
 * RCB-110: `GET /api/systems/:id/tests`'s payload — one entry per pointer, whether it resolves to
 * a source file (`files` non-null) or not, plus a provenance sentence and the one-line summary
 * the drawer shows collapsed.
 *
 * RCB-113: `measured` rides beside it — source B, % lines covered per pointer from the gate's own
 * coverage report, with its own provenance (the report's path and mtime) since it can go stale
 * independently of the static `source` above it.
 */
export interface SystemTestsPayload {
  pointers: { pointer: string; tests: string[] | null; reason: string | null }[];
  files: number | null;
  source: string;
  line: string;
  measured: {
    pointers: { pointer: string; pct: number | null; reason: string | null }[];
    pct: number | null;
    source: string;
    line: string;
  };
}

/**
 * P7.2: `hasBoard` is false when the served root has no `.repoboard/` — map-only mode. It is
 * optional here because it is an additive field: a payload without it is one that predates P7.2,
 * and the safe reading of "absent" is "there is a board", which shows everything rather than
 * silently hiding the board (CLAUDE.md: an unconfigured rule must be inert, not dangerous).
 *
 * P8.2: `leases` on the snapshot is optional the same way — absent means "no leases, no windows",
 * never a crash, so a mock or a pre-P8.2 payload still renders (the Now strip's quiet line).
 *
 * P8.3: `state`/`log` are optional the same way — absent means "nothing yet", never a crash.
 *
 * RCB-154: `gateMembers` is optional the same way `leases` is — absent means "no workspace member
 * boards", the same default `blockedReason`/`rollup` in `@repoboard/core` fall back to on their
 * own ([]), so a payload without it (or a repo switch, which resets the whole snapshot) renders
 * exactly like today.
 */
export type ServerMessage =
  | {
      type: 'snapshot';
      board: {
        config: BoardConfig;
        cards: Card[];
        hasBoard?: boolean;
        /** RCB-42: the merged (board.yml + `--sibling` flags) list. Optional the same way
         * `hasBoard` is — absent means "no siblings", never a crash on an older payload. */
        siblings?: Sibling[];
      };
      repo: RepoSnapshot | null;
      leases?: LeasesPayload;
      /** RCB-98: optional the same way `leases`/`state`/`log` are — absent means "nothing yet". */
      systems?: SystemsPayload;
      state?: StatePayload;
      log?: LogPayload;
      /** RCB-154: a WORKSPACE's opened member boards, gathered server-side — see the header note. */
      gateMembers?: GateMemberFacts[];
    }
  | { type: 'card'; card: Card }
  | { type: 'card:removed'; id: string }
  | { type: 'repo'; repo: RepoSnapshot }
  | { type: 'event'; event: Event }
  /**
   * RCB-41: the server already emits this on a live `board.yml` edit (`store.ts`'s
   * `loadConfig`/`emit('config', …)`, broadcast in `http.ts`'s `onConfig`) — this type was never
   * declared on the wire contract, so the web silently dropped it. Declaring it here is what lets
   * the store pick up a live rename (or any other config change) without waiting for a reconnect.
   *
   * RCB-42: `siblings` rides along on the same broadcast — a live board.yml edit can change the
   * file's own `siblings:` list, and the merge (with this process's `--sibling` flags) is
   * recomputed server-side every time, never by the web.
   */
  | { type: 'config'; config: BoardConfig; siblings?: Sibling[] }
  | { type: 'leases'; leases: LeasesPayload }
  | ({ type: 'systems' } & SystemsPayload)
  | { type: 'state'; state: StatePayload }
  | { type: 'log'; date: string; text: string }
  /**
   * RCB-69: the server already sends these for a refused (`error`) or warned (`warning`)
   * `card:move`/`card:update` (`repo-context.ts`'s `onClientMessage`) — declaring them here is
   * what lets the store react immediately instead of waiting for the echo timeout's generic
   * "did not reach disk" toast. `id` is the pending card id the request named (empty string when
   * the server could not tell, e.g. an unparseable message) and `message` is the server's own
   * sentence, shown verbatim.
   */
  | { type: 'error'; id: string; message: string }
  | { type: 'warning'; id: string; message: string }
  /** RCB-154: a live update to the workspace's opened member boards (e.g. a member's own board.yml
   * or cards changed) — the store replaces `state.gateMembers` wholesale, same as `leases`. */
  | { type: 'gateMembers'; members: GateMemberFacts[] };

/**
 * RCB-43 slice 3: one entry of `GET /api/repos`, mirroring `packages/server/src/http.ts`'s
 * `RepoEntry` — not imported, since the web never depends on `@repoboard/server`.
 */
export interface RepoEntry {
  key: string;
  root: string;
  name: string;
  hasBoard: boolean;
  open: boolean;
  scanned: boolean;
}

/** RCB-43 slice 3: `GET /api/repos`'s whole payload, fetched once by the store into `state.repos`. */
export interface ReposPayload {
  primary: string;
  repos: RepoEntry[];
}

export type ClientMessage =
  | { type: 'card:move'; id: string; status: string }
  | { type: 'card:update'; id: string; patch: CardPatch };

export interface Transport {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  onMessage(msg: ServerMessage): void;
  onConnected(connected: boolean): void;
}

/**
 * Something that opens a connection: the real socket (ws.ts) or the mock (mock/). RCB-43 slice 3:
 * the optional second argument is the path to connect to — `'/ws'` for the primary or the
 * repo-scoped `'/api/repos/<key>/ws'` (`repo-key.ts`'s `wsPath`), which `store.ts`'s `connect()`
 * always passes. A single-argument factory (the mock) simply ignores it and keeps working.
 */
export type TransportFactory = (handlers: TransportHandlers, url?: string) => Transport;

export function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}
