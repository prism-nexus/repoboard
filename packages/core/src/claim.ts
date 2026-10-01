/**
 * RCB-197 (slice A): the seat claim, decided. `seat --up` used to decide on cached state outside
 * any lock (RCB-194: two panes both believed they held a seat); the decision now runs INSIDE the
 * seats-file + STATE locks and is this one pure function. The caller (slice B) reads the lease, the
 * bullet and the sightings under the locks, probes the recorded holder's pid, hands all of it in,
 * and acts on the answer — core stays I/O-free (§0.5), so nothing here touches `process` or a clock.
 *
 * Its own file rather than `holder.ts` because it needs `describeSeatUpConflict` from `seat.ts`,
 * and `seat.ts -> board.ts -> holder.ts` already exists: `holder.ts` importing `seat.ts` would
 * close a cycle. Only `index.ts` imports this file.
 */
import { describeLiveness, type HolderLiveness, type SeatHolder, sameHolder } from './holder.js';
import { describeSeatUpConflict, type SeatUpConflict } from './seat.js';
import { toIso } from './time.js';

/** Everything `decideSeatClaim` decides on — all of it measured by the caller, under the locks. */
export interface SeatClaimInput {
  /** The seat being claimed, bare (`builder`, not `[rcb] builder`). */
  seat: string;
  /** How this pane is shown to humans, e.g. `0460 · acme` — the "you are …" of a refusal. */
  callerLabel: string;
  caller: SeatHolder;
  /** The seat's standing bullet's status; `null` = no bullet. */
  bulletStatus: 'UP' | 'DOWN' | null;
  /** The recorded holder in `.repoboard/local/seats.yml`, with what the caller measured about its
   *  pid. `since` is the lease's ISO stamp; `label` the holder's human label (`A7B2 · acme builder`).
   *  `null` = no lease (no local layer, or nobody ever claimed it through the new path). */
  lease: {
    holder: SeatHolder;
    since: string;
    liveness: HolderLiveness;
    label: string;
  } | null;
  /** Today's window rule (`seatUpConflict`), consulted only when `lease` is `null`; `bullet` is the
   *  standing bullet's text. `null` = the rule found no conflict. */
  legacy: { conflict: SeatUpConflict; windowMinutes: number; bullet: string } | null;
  /** The OTHER seats this pane holds UP right now. `seat` itself in here is ignored. */
  callerHolds: readonly string[];
  /** `--from <seat>`: the seat this pane is leaving for `seat`; `null` = none given. */
  from: string | null;
  /** `--force`. It overrides a held seat, never the `--from` rule. */
  force: boolean;
}

/**
 * `ok`: take the seat. `release` is the seat to write DOWN (`seatMovedText`) in the same locked
 * write — always the caller's own `from`, `null` when none was given. `audit`, when non-null, is
 * the log block to append (`title` and `text`) before the takeover; it never carries a pid, host
 * or session, only the holder's label, its `since` and its liveness. `error` is the exact refusal
 * text, with no trailing newline (the caller adds its own).
 */
export type SeatClaim =
  | { ok: true; release: string | null; audit: { title: string; text: string } | null }
  | { ok: false; error: string };

/** `YYYY-MM-DD HH:MMZ` of an ISO `since`; a `since` that does not parse is shown as written. */
function stampOf(since: string): string {
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return since;
  const iso = toIso(at);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * RCB-197: may `caller` claim `seat`, and what must the same locked write also do? The first rule
 * that applies wins, in this order:
 *
 * 1. `from` is `seat` → refused; `from` is not a seat the caller holds → refused.
 * 2. The caller holds another UP seat besides `from` → refused, naming each (a pane moves ONE
 *    seat per claim). `force` does NOT bypass this — it is about the caller, not the seat.
 * 3. The standing bullet is not UP → ok.
 * 4. No lease → the old window rule: no `legacy` conflict → ok; `force` → ok, audited with the
 *    standing bullet; else refused with today's text (`seat --up`'s pre-RCB-197 refusal, verbatim).
 * 5. The lease's holder is the caller (`sameHolder`) → ok, no audit — a fresh session in the same
 *    pane after `/clear` is the same seat.
 * 6. The holder is dead → ok, audited.
 * 7. The holder is alive or unknown: `force` → ok, audited; else refused, naming the holder, its
 *    `since` and — when unknown — why liveness could not be told.
 *
 * `release` is `from` on every ok. One function, no argument that could weaken rule 1 or 2.
 */
export function decideSeatClaim(input: SeatClaimInput): SeatClaim {
  const { seat, callerLabel, caller, bulletStatus, lease, legacy, callerHolds, from, force } =
    input;
  const refuse = (error: string): SeatClaim => ({ ok: false, error });
  const allow = (audit: { title: string; text: string } | null): SeatClaim => ({
    ok: true,
    release: from,
    audit,
  });

  if (from === seat) {
    return refuse(
      `seat: --from ${from} names the seat being claimed; --from is the OTHER seat this pane leaves`,
    );
  }
  if (from !== null && !callerHolds.includes(from)) {
    return refuse(`seat: --from ${from} is not a seat you hold (you are ${callerLabel})`);
  }
  const others = callerHolds.filter((held) => held !== seat && held !== from);
  const [firstOther] = others;
  if (firstOther !== undefined) {
    const names = others.join(', ');
    const bypass = '(--force does not bypass this)';
    if (from === null && others.length === 1) {
      return refuse(
        `seat: ${callerLabel} already holds ${firstOther} — re-run with --from ${firstOther} ` +
          `to move it to ${seat} ${bypass}`,
      );
    }
    const how =
      from === null
        ? 'stand all but one of them down first, then re-run with --from <that one>'
        : `stand ${names} down first`;
    return refuse(
      `seat: ${callerLabel} ${from === null ? 'already' : 'also'} holds ${names} — ` +
        `--from moves one seat: ${how} ${bypass}`,
    );
  }

  if (bulletStatus !== 'UP') return allow(null);

  if (lease === null) {
    if (legacy === null) return allow(null);
    if (force) {
      return allow({
        title: 'seat --up --force over a standing UP bullet',
        text: legacy.bullet,
      });
    }
    return refuse(
      `seat ${seat} is already UP (${describeSeatUpConflict(legacy.conflict)}, ` +
        `window ${legacy.windowMinutes} min):\n` +
        `  ${legacy.bullet}\n` +
        'another session holds this seat. If it is dead, re-run with --force (audited in the log).',
    );
  }

  if (sameHolder(lease.holder, caller)) return allow(null);

  const since = stampOf(lease.since);
  const liveness = describeLiveness(lease.liveness);
  // The audit names the holder by label, when it started and what was known of it — never its
  // pid, host or session (those are local facts; the log is git-tracked).
  const heldBy = `${lease.label} (UP ${since}) — ${liveness}`;
  if (lease.liveness.state === 'dead') {
    return allow({ title: 'seat --up over a dead holder', text: heldBy });
  }
  if (force) return allow({ title: 'seat --up --force over a live holder', text: heldBy });
  return refuse(
    `${seat} is held by ${lease.label} (UP ${since}); you are ${callerLabel}` +
      (lease.liveness.state === 'unknown' ? ` (${liveness})` : '') +
      ' — if it is dead, re-run with --force (audited in the log)',
  );
}

/** The verbs that write a seat's bullet or its log as that seat: `seat --down`, `seat --update`, `log --as <seat>`. */
export type SeatWriteVerb = 'down' | 'update' | 'log';

/** Everything `decideSeatWrite` decides on — all of it measured by the caller, under the locks. */
export interface SeatWriteInput {
  /** The seat being written, bare (`builder`, not `[rcb] builder`). */
  seat: string;
  verb: SeatWriteVerb;
  /** How this pane is shown to humans, e.g. `0460 · acme` — the "you are …" of a refusal. */
  callerLabel: string;
  caller: SeatHolder;
  /** The recorded holder in `.repoboard/local/seats.yml`: `since` is the lease's ISO stamp, `label`
   *  the holder's human label (`A7B2 · acme builder`). `null` = no lease (a legacy bullet, or no
   *  local layer). No liveness — a dead holder is still the holder. */
  lease: { holder: SeatHolder; since: string; label: string } | null;
  /** `--force`. It overrides another holder, never a seat nobody holds. */
  force: boolean;
}

/**
 * `ok`: write. `audit`, when non-null, is the log block to append (`title` and `text`) with the
 * write; it carries only labels — never a pid, host or session. `error` is the exact refusal text,
 * with no trailing newline (the caller adds its own).
 */
export type SeatWriteDecision =
  | { ok: true; audit: { title: string; text: string } | null }
  | { ok: false; error: string };

/**
 * RCB-198 (RCB-194: a pane wrote another pane's seat): may `caller` write `seat`'s bullet or log
 * as it (`seat --down`, `seat --update`, `log --as <seat>`)? The first rule that applies wins, in
 * this order:
 *
 * 1. No lease → ok, no audit: a legacy bullet (or no local layer) is writable by anyone until it
 *    is next claimed. `force` here is NOT audited — nothing was overridden.
 * 2. The lease's holder is the caller (`sameHolder`) → ok, no audit.
 * 3. `force` → ok, audited (`<verb> --force over another holder`) with the holder's label, its
 *    `since` and who wrote it.
 * 4. Refused, naming both labels and the holder's `since`.
 *
 * No liveness is consulted: a dead holder is still the holder — a seat is freed only by `--up`'s
 * takeover or a `--down` by its holder. An all-`null` caller (serve's HTTP door, "web") never
 * matches a lease — `sameHolder` refuses null panes and null start times — so it needs `--force`;
 * nothing here special-cases it. Error and audit carry labels only, never a pid, host or session.
 * This is the ONE place the holder-only rule lives; no argument can weaken it but `force`, which
 * is itself audited.
 */
export function decideSeatWrite(input: SeatWriteInput): SeatWriteDecision {
  const { seat, verb, callerLabel, caller, lease, force } = input;
  if (lease === null) return { ok: true, audit: null };
  if (sameHolder(lease.holder, caller)) return { ok: true, audit: null };

  const heldBy = `${seat} is held by ${lease.label} (UP ${stampOf(lease.since)})`;
  if (force) {
    const via =
      verb === 'down' ? 'seat --down' : verb === 'update' ? 'seat --update' : `log --as ${seat}`;
    return {
      ok: true,
      audit: {
        title: `${via} --force over another holder`,
        text: `${heldBy}; written by ${callerLabel}`,
      },
    };
  }
  return {
    ok: false,
    error: `${heldBy}; you are ${callerLabel} — use --force to write it anyway (audited in the log)`,
  };
}
