/**
 * RCB-195 (slice A of RCB-194): who holds a seat. A SEATS bullet names a seat but not the pane
 * that holds it, so a seat's UP/DOWN went wrong seven ways (RCB-194). This file is the PURE half:
 * who am I (from an env record the caller hands in), how a holder is encoded as one line, the
 * short human label (`1D3F · rcb builder`) and nothing else. Reading `process.env`, `os.hostname()`,
 * the parent pid and the process start time (`ps -o lstart=`) is the caller's job (the CLI and MCP
 * entry, slice B) — core stays I/O-free (§0.5), so nothing here touches `process` or a clock.
 */

/**
 * RCB-195: the env vars that name the terminal pane, first non-empty wins. iTerm2's
 * `ITERM_SESSION_ID` (`w1t0p0:<uuid>`) survives `/clear`, which the Claude session id does not —
 * hence it leads; `TERM_SESSION_ID` is Terminal.app's; `CLAUDE_CODE_SESSION_ID` is the last resort
 * and the only one that is not a pane (owner decision C: outside iTerm the session id stands in,
 * nothing more). `board.yml`'s `seats.identityEnv` replaces this list wholesale (`boardIdentityEnv`).
 */
export const DEFAULT_IDENTITY_ENV: readonly string[] = [
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
];

/**
 * RCB-195: who holds a seat. Every field is a missing-answer `null` rather than a guess: a
 * process with no pane env has `pane: null`, never `''`, and never a pid that merely looks right.
 */
export interface SeatHolder {
  /** The terminal pane's id (the part of the env value after its last `:`). */
  pane: string | null;
  /** `CLAUDE_CODE_SESSION_ID` — changes on `/clear`, so it never decides "same holder" alone. */
  session: string | null;
  /** The process start time as the caller measured it (`ps -o lstart=`); with `pid` it tells a
   *  live holder from a recycled pid (RCB-194 P2). Opaque here: passed through, never parsed. */
  start: string | null;
  host: string | null;
  pid: number | null;
}

/** What the caller measured about the process — the only inputs `holderIdentity` cannot get from `env`. */
export interface HolderIdentityInput {
  /** `boardIdentityEnv(config)`; absent = `DEFAULT_IDENTITY_ENV`. */
  identityEnv?: readonly string[];
  /** `process.ppid` — the holder pid when `CLAUDE_PID` is not set. `null` = the caller has none. */
  ppid: number | null;
  host: string | null;
  start: string | null;
}

/** A trimmed, non-empty env value, else `null` — the ONE reading of "this variable is set". */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

/** A positive safe integer from a string of digits, else `null` (`'0'`, `'-3'`, `'12x'`, `'1.5'`). */
function positiveInt(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * RCB-195: who am I, from `env` alone.
 *
 * - `pane`: the FIRST variable in `identityEnv` order whose trimmed value is non-empty, taking the
 *   part after its LAST `:` (iTerm's `w1t0p0:<uuid>` is the uuid; a bare uuid is itself). A value
 *   with nothing after the colon (`w1t0p0:`) names no pane, so that variable is skipped too.
 * - `session`: `CLAUDE_CODE_SESSION_ID`, whatever `identityEnv` says.
 * - `pid`: `CLAUDE_PID` when it is a positive integer, else `ppid` (itself only when a positive
 *   integer). A `CLAUDE_PID` of `0`, `abc` or `1.5` is not a pid and is not guessed into one.
 * - `host` / `start`: passed through.
 *
 * Every absent answer is `null`, never `''`. An empty `identityEnv` finds no pane — the caller's
 * config schema refuses it (`min(1)`), so this is inert rather than an error.
 */
export function holderIdentity(
  env: Readonly<Record<string, string | undefined>>,
  input: HolderIdentityInput,
): SeatHolder {
  let pane: string | null = null;
  for (const name of input.identityEnv ?? DEFAULT_IDENTITY_ENV) {
    const value = envValue(env, name);
    if (value === null) continue;
    const candidate = value.slice(value.lastIndexOf(':') + 1).trim();
    if (candidate === '') continue;
    pane = candidate;
    break;
  }
  const claudePid = envValue(env, 'CLAUDE_PID');
  const pid =
    (claudePid !== null ? positiveInt(claudePid) : null) ??
    (input.ppid !== null ? positiveInt(String(input.ppid)) : null);
  return {
    pane,
    session: envValue(env, 'CLAUDE_CODE_SESSION_ID'),
    start: input.start,
    host: input.host,
    pid,
  };
}

/** The fixed field order of `formatHolder` — the ONE list `formatHolder` and `parseHolder` share. */
const HOLDER_KEYS = ['pane', 'session', 'pid', 'start', 'host'] as const;

/** `%`, `;` and `=` are the encoding's own punctuation, so a VALUE never carries them raw. */
function encodeHolderValue(value: string): string {
  return value.replace(/[%;=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Inverts `encodeHolderValue` in ONE pass, so `%253B` is the text `%3B`, not `;`. */
function decodeHolderValue(value: string): string {
  return value.replace(/%(25|3B|3D)/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * RCB-195: one holder as one stable line — `pane=…;session=…;pid=…;start=…;host=…`, in that fixed
 * order, a `null` (or empty) field omitted, `%` `;` `=` in a value percent-encoded (`%25` `%3B`
 * `%3D`). Stable on purpose: the same holder is compared by this string, and a start time such as
 * `Tue Sep 29 12:34:56 2026` or a host with a `;` in it must not shift its neighbours.
 */
export function formatHolder(h: SeatHolder): string {
  const parts: string[] = [];
  for (const key of HOLDER_KEYS) {
    const value = h[key];
    if (value === null || value === '') continue;
    parts.push(`${key}=${encodeHolderValue(String(value))}`);
  }
  return parts.join(';');
}

/**
 * RCB-195: `formatHolder`'s inverse. An absent (or empty) key is `null`; an unknown key, and a
 * segment with no `=`, are ignored; a `pid` that is not a positive integer is `null`; a key given
 * twice takes its last value. Never throws — a garbage line is just an all-`null` holder.
 */
export function parseHolder(text: string): SeatHolder {
  const raw = new Map<string, string>();
  for (const segment of text.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    raw.set(segment.slice(0, eq), decodeHolderValue(segment.slice(eq + 1)));
  }
  const field = (key: (typeof HOLDER_KEYS)[number]): string | null => {
    const value = raw.get(key);
    return value === undefined || value === '' ? null : value;
  };
  const pid = field('pid');
  return {
    pane: field('pane'),
    session: field('session'),
    start: field('start'),
    host: field('host'),
    pid: pid !== null ? positiveInt(pid) : null,
  };
}

/** A pane id's short form at `width` characters, uppercased — the one place the tag is cut. */
function tagOf(pane: string, width: number): string {
  return pane.slice(0, width).toUpperCase();
}

/**
 * RCB-195: the first 4 characters of `pane`, uppercased (`A7B2`), widened to 6 (`A7B2A3`) ONLY when
 * another, DIFFERENT pane (compared case-insensitively) shares those 4 — two panes whose ids merely
 * differ in letter case are the same pane and never widen it. `otherPanes` is the live holders'
 * panes; it may contain `pane` itself, which is not a collision. Two different panes that agree on
 * all 6 stay ambiguous — the tag is a label for humans, the full pane id is what identifies.
 */
export function paneTag(pane: string, otherPanes: readonly string[]): string {
  const own = pane.toUpperCase();
  const collides = otherPanes.some(
    (other) => other.toUpperCase() !== own && tagOf(other, 4) === tagOf(pane, 4),
  );
  return tagOf(pane, collides ? 6 : 4);
}

/** RCB-195: `<tag> · <shortName> <seat>` — `1D3F · rcb builder`, the label a bullet and a refusal carry. */
export function holderLabel(tag: string, shortName: string, seat: string): string {
  return `${tag} · ${shortName} ${seat}`;
}

/** Case-insensitive text equality — the ONE comparison a host name or a pane id is judged by. */
function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * RCB-197: what the caller measured, NOW, about a RECORDED holder's pid — the only inputs
 * `holderLiveness` cannot get from the recorded `SeatHolder`. Every field is a missing-answer
 * `null` when the caller could not measure it, never a guess.
 */
export interface HolderProbe {
  /** This machine's hostname, to be compared with the recorded holder's. */
  host: string | null;
  /** `kill(pid, 0)` on the recorded pid: `alive` = it returned, `eperm` = the process exists but
   *  is not ours (still alive), `esrch` = no such process. `null` = not probed. */
  signal: 'alive' | 'eperm' | 'esrch' | null;
  /** The start time of whatever process holds that pid now (`ps -o lstart=`), in the same format
   *  as the recorded `SeatHolder.start`. Opaque: compared for equality, never parsed. */
  start: string | null;
}

/**
 * RCB-197: what `holderLiveness` concluded. `unknown` is its own answer, not a soft `alive`: a
 * holder that cannot be measured is neither taken over as dead nor trusted as live.
 */
export type HolderLiveness =
  | { state: 'alive' }
  | { state: 'dead'; reason: 'no-process' | 'pid-reused' }
  | { state: 'unknown'; reason: 'other-host' | 'no-pid' | 'no-signal' | 'no-start' };

/**
 * RCB-197 (RCB-194 P2): is the RECORDED holder still running? Pure — the caller probes (`kill -0`,
 * `ps -o lstart=`) and hands the result in as `probe`. The first rule that applies wins, in this
 * order:
 *
 * 1. a host missing on either side, or different (case-insensitive) → `unknown: other-host` — a
 *    pid means nothing on another machine, and holders never leave this one (RCB-194 P1);
 * 2. no recorded pid → `unknown: no-pid`;
 * 3. signal `esrch` → `dead: no-process`;
 * 4. no signal → `unknown: no-signal`;
 * 5. a start time missing on either side → `unknown: no-start` — a live pid alone cannot tell the
 *    holder from a recycled pid, so it is not called alive;
 * 6. the two start times differ → `dead: pid-reused` (the pid is alive, but it is not the holder);
 * 7. otherwise `alive` (`eperm` counts as alive).
 */
export function holderLiveness(recorded: SeatHolder, probe: HolderProbe): HolderLiveness {
  if (recorded.host === null || probe.host === null || !equalFold(recorded.host, probe.host)) {
    return { state: 'unknown', reason: 'other-host' };
  }
  if (recorded.pid === null) return { state: 'unknown', reason: 'no-pid' };
  if (probe.signal === 'esrch') return { state: 'dead', reason: 'no-process' };
  if (probe.signal === null) return { state: 'unknown', reason: 'no-signal' };
  if (recorded.start === null || probe.start === null) {
    return { state: 'unknown', reason: 'no-start' };
  }
  if (recorded.start !== probe.start) return { state: 'dead', reason: 'pid-reused' };
  return { state: 'alive' };
}

/**
 * RCB-197: `holderLiveness`'s answer as one phrase — `alive`, `dead: no process`,
 * `unknown: other host` — the ONE place it is worded, so a refusal and an audit block never
 * re-derive it. The reason is its own identifier with `-` read as a space.
 */
export function describeLiveness(l: HolderLiveness): string {
  return l.state === 'alive' ? 'alive' : `${l.state}: ${l.reason.replace(/-/g, ' ')}`;
}

/**
 * RCB-197: are `a` and `b` the same holder? Yes when both panes are known and equal
 * (case-insensitive) — a new session in the same pane after `/clear` is the same seat — OR when
 * both hosts are known and equal (case-insensitive), both pids are known and equal, AND both start
 * times are known and equal (RCB-194 P2: outside iTerm the pane falls back to the session id, which
 * changes on `/clear` while `CLAUDE_PID` survives). The start time is what keeps a recycled pid
 * from passing as the holder, so it is required, not merely compared: two `null` start times are
 * NOT the same holder (a pid with no start time to check it against is a guess). A `null` pane on
 * either side never matches on the pane clause.
 */
export function sameHolder(a: SeatHolder, b: SeatHolder): boolean {
  if (a.pane !== null && b.pane !== null && equalFold(a.pane, b.pane)) return true;
  return (
    a.host !== null &&
    b.host !== null &&
    equalFold(a.host, b.host) &&
    a.pid !== null &&
    a.pid === b.pid &&
    a.start !== null &&
    a.start === b.start
  );
}

/**
 * RCB-197: guard for the `--pane <asserted>` flag — `null` (ok) only when `asserted` is 4 or 6
 * characters with no whitespace AND `pane` (this process's own pane id) is known AND `pane`'s
 * first `asserted.length` characters equal it (case-insensitive); else the exact error to surface
 * verbatim, naming both what was asserted and what this pane is. A restart paste-in carries the
 * pane it was written for, and this is what stops it landing in another one. Pure; no argument
 * can weaken it. RCB-207: `youAre` (the label `seat whoami` prints for this pane) only ends the
 * MISMATCH refusal with `; you are <youAre>`, as every other seat refusal does — it changes no
 * verdict, only the words, and omitted the refusal is the same text as before.
 */
export function checkPaneAssertion(
  pane: string | null,
  asserted: string,
  youAre?: string,
): string | null {
  if (!/^(?:\S{4}|\S{6})$/.test(asserted)) {
    return `seat: --pane needs the first 4 (or 6) characters of the pane id, no spaces — got "${asserted}"`;
  }
  if (pane === null) {
    return `seat: --pane ${asserted} asserted, but this process has no pane id (no pane env is set)`;
  }
  if (!equalFold(pane.slice(0, asserted.length), asserted)) {
    return (
      `seat: --pane ${asserted} does not match this pane (${tagOf(pane, asserted.length)})` +
      (youAre === undefined ? '' : `; you are ${youAre}`)
    );
  }
  return null;
}

/**
 * RCB-197: the stand-down text written for the seat a pane leaves when it claims another
 * (the `--from <old>` move) — the same pane moved to seat `to`. Carries the `in-flight:` and
 * `owes:` lines `checkDownFields` demands (pointing at `to`, which now holds whatever the old seat
 * had), so the move is one locked write that needs no hand-typed stand-down.
 */
export function seatMovedText(to: string): string {
  return [`moved to ${to} in the same pane`, `in-flight: see ${to}`, `owes: see ${to}`].join('\n');
}

/**
 * RCB-199: the tag a holder with no pane is shown by — in a refusal, an audit block and `seat
 * whoami`, never in a bullet (a bullet with no pane carries no label). The ONE spelling of it.
 */
export const NO_PANE_TAG = '(no pane)';

/**
 * RCB-197 / RCB-199: one recorded `seat:<name>` lease as read under `seats.yml`'s lock — the
 * holder parsed back, when it took the seat, and whether its process is still that process
 * (`holderLiveness`, decided from what the caller probed). Moved here from the store so the pure
 * side can name it; the store's own copy is structurally the same type.
 */
export interface SeatLeaseView {
  seat: string;
  holder: SeatHolder;
  since: string;
  liveness: HolderLiveness;
}

/**
 * RCB-199: a `SeatLeaseView` with the pane tag and label it is DISPLAYED by. Both are `null` when
 * the holder has no pane — a missing answer, never a guessed tag.
 */
export interface SeatHolderInfo extends SeatLeaseView {
  tag: string | null;
  label: string | null;
}

/**
 * RCB-199: each of `views` with its `tag` and `label`, same order. A tag is `paneTag(pane, …)`
 * against the panes of the OTHER views only, and only those whose liveness is not `dead` — a dead
 * holder is not a live one, so it never widens a live holder's tag (the same rule
 * `seatHolderLeases` applies when it writes a bullet's label). A view with no pane has `tag` and
 * `label` `null`; otherwise `label` is `holderLabel(tag, shortName, seat)`.
 */
export function seatHolderInfos(
  views: readonly SeatLeaseView[],
  shortName: string,
): SeatHolderInfo[] {
  return views.map((view, i) => {
    const pane = view.holder.pane;
    if (pane === null) return { ...view, tag: null, label: null };
    const others = views.flatMap((other, j) =>
      j === i || other.liveness.state === 'dead' || other.holder.pane === null
        ? []
        : [other.holder.pane],
    );
    const tag = paneTag(pane, others);
    return { ...view, tag, label: holderLabel(tag, shortName, view.seat) };
  });
}

/** RCB-199: what `seatWhoami` answers — which seat(s) the asking pane holds, and how to label it. */
export interface SeatWhoami {
  /** This pane's tag (`1D3F`), or `NO_PANE_TAG` when the process has no pane. */
  tag: string;
  /** The first seat held by this holder, file order; `null` = it holds none. */
  seat: string | null;
  /** Every further seat this holder also holds, file order — a pane holding two is a finding, not a guess. */
  alsoHolds: string[];
  /** `holderLabel(tag, shortName, seat)`, or exactly `<tag> · no seat` when `seat` is `null`. */
  label: string;
}

/**
 * RCB-199: which seat does `me` hold? Held = every entry of `holders` that `sameHolder` says is
 * `me`, in file order, liveness ignored (a dead record of my own pane is still what the file says
 * I hold). `seat` is the first, `alsoHolds` the rest. `tag` is `NO_PANE_TAG` when `me` has no pane,
 * else `paneTag(me.pane, …)` against the panes of the non-dead `holders` (`me`'s own entry is not
 * a collision). A pane that holds nothing is `<tag> · no seat`, never a made-up seat name.
 */
export function seatWhoami(
  me: SeatHolder,
  holders: readonly SeatLeaseView[],
  shortName: string,
): SeatWhoami {
  const held = holders.filter((h) => sameHolder(h.holder, me)).map((h) => h.seat);
  const seat = held[0] ?? null;
  const tag =
    me.pane === null
      ? NO_PANE_TAG
      : paneTag(
          me.pane,
          holders.flatMap((h) =>
            h.liveness.state === 'dead' || h.holder.pane === null ? [] : [h.holder.pane],
          ),
        );
  return {
    tag,
    seat,
    alsoHolds: held.slice(1),
    label: seat === null ? `${tag} · no seat` : holderLabel(tag, shortName, seat),
  };
}
