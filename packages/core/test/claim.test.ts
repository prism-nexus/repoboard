/**
 * RCB-197 (slice A): `decideSeatClaim` — one test per branch of the decision, in the order the
 * function decides them. Pure: every test hands in the whole measured situation.
 * RCB-198 (slice A): `decideSeatWrite` — the holder-only rule for a seat's down, update and
 * `log --as <seat>` writes, one test per rule.
 */
import { describe, expect, it } from 'vitest';
import {
  decideSeatClaim,
  decideSeatWrite,
  type SeatClaim,
  type SeatClaimInput,
  type SeatWriteDecision,
  type SeatWriteInput,
} from '../src/claim.js';
import type { HolderLiveness, SeatHolder } from '../src/holder.js';
import type { SeatUpConflict } from '../src/seat.js';

const STARTED = 'Tue Sep 29 12:34:56 2026';

/** The pane that holds the lease: pid, host and session all known — the audit must leak none. */
const HOLDER: SeatHolder = {
  pane: 'A7B21234-AAAA',
  session: 'sess-holder-1',
  start: STARTED,
  host: 'mac-mini',
  pid: 4242,
};

/** The pane asking: a different pane, a different pid. */
const CALLER: SeatHolder = {
  pane: '0460BBBB-CCCC',
  session: 'sess-caller-9',
  start: 'Tue Sep 29 13:00:00 2026',
  host: 'mac-mini',
  pid: 5000,
};

const ALIVE: HolderLiveness = { state: 'alive' };

/** A standing UP bullet, held through a lease by `HOLDER`, that the caller has no claim to. */
const HELD: SeatClaimInput = {
  seat: 'builder',
  callerLabel: '0460 · acme',
  caller: CALLER,
  bulletStatus: 'UP',
  lease: {
    holder: HOLDER,
    since: '2026-09-30T00:32:00Z',
    liveness: ALIVE,
    label: 'A7B2 · acme builder',
  },
  legacy: null,
  callerHolds: [],
  from: null,
  force: false,
};

const CONFLICT: SeatUpConflict = { stamp: '2026-09-21 22:32Z', minutesAgo: 5, source: 'UP' };
const BULLET = '- **[acme] builder: UP 2026-09-21 22:32Z.** in the middle of a card';

/** No lease at all — the old window rule decides, through `legacy`. */
const LEGACY: SeatClaimInput = {
  ...HELD,
  lease: null,
  legacy: { conflict: CONFLICT, windowMinutes: 30, bullet: BULLET },
};

/** The `error` of a refusal; fails the test (rather than returning `undefined`) on an ok. */
function errorOf(claim: SeatClaim): string {
  if (claim.ok) throw new Error(`expected a refusal, got ${JSON.stringify(claim)}`);
  return claim.error;
}

describe('decideSeatClaim: the --from rule (RCB-197)', () => {
  it('refuses --from naming the seat being claimed', () => {
    const claim = decideSeatClaim({ ...HELD, from: 'builder', callerHolds: ['builder'] });
    expect(errorOf(claim)).toContain('--from builder');
    expect(errorOf(claim)).toContain('being claimed');
  });

  it('refuses --from for a seat the caller does not hold', () => {
    const claim = decideSeatClaim({ ...HELD, from: 'ops', callerHolds: ['planner'] });
    expect(errorOf(claim)).toContain('--from ops');
    expect(errorOf(claim)).toContain('not a seat you hold');
    expect(errorOf(claim)).toContain('you are 0460 · acme');
  });

  it('refuses --from when the caller holds nothing at all', () => {
    expect(decideSeatClaim({ ...HELD, from: 'ops', callerHolds: [] }).ok).toBe(false);
  });

  it('GUARD (--from rule): a pane that holds another UP seat is refused, naming it and --from <Y>', () => {
    const claim = decideSeatClaim({ ...HELD, callerHolds: ['planner'] });
    const error = errorOf(claim);
    expect(error).toContain('0460 · acme');
    expect(error).toContain('already holds planner');
    expect(error).toContain('--from planner');
    expect(error).toContain('to move it to builder');
  });

  it('GUARD (--from rule): --force does NOT bypass it — over a dead holder, a standing UP bullet, or none', () => {
    const dead: HolderLiveness = { state: 'dead', reason: 'no-process' };
    for (const input of [
      HELD,
      { ...HELD, lease: { ...(HELD.lease as NonNullable<typeof HELD.lease>), liveness: dead } },
      LEGACY,
      { ...HELD, bulletStatus: 'DOWN' as const },
      { ...HELD, bulletStatus: null },
    ]) {
      const claim = decideSeatClaim({ ...input, callerHolds: ['planner'], force: true });
      expect(errorOf(claim)).toContain('--from planner');
    }
  });

  it('refuses when the pane holds several other seats, naming each; --from moves only one', () => {
    const claim = decideSeatClaim({ ...HELD, callerHolds: ['planner', 'ops'] });
    const error = errorOf(claim);
    expect(error).toContain('planner, ops');
    expect(error).toContain('--from moves one seat');
    expect(error).toContain('stand all but one of them down first');
  });

  it('refuses --from Y when the pane also holds Z, naming Z and saying to stand it down first', () => {
    const claim = decideSeatClaim({ ...HELD, from: 'planner', callerHolds: ['planner', 'ops'] });
    const error = errorOf(claim);
    expect(error).toContain('also holds ops');
    expect(error).not.toContain('holds planner');
    expect(error).toContain('stand ops down first');
  });

  it('--from Y with Y the only other seat held: passes the rule, and release is Y', () => {
    const claim = decideSeatClaim({
      ...HELD,
      bulletStatus: 'DOWN',
      from: 'planner',
      callerHolds: ['planner'],
    });
    expect(claim).toEqual({ ok: true, release: 'planner', audit: null });
  });

  it('`seat` itself among callerHolds is not "another seat" — ignored', () => {
    const claim = decideSeatClaim({ ...HELD, bulletStatus: 'DOWN', callerHolds: ['builder'] });
    expect(claim).toEqual({ ok: true, release: null, audit: null });
  });

  it('is decided BEFORE the bullet: a bad --from is refused even when the seat is free', () => {
    expect(decideSeatClaim({ ...HELD, bulletStatus: null, from: 'ops' }).ok).toBe(false);
    expect(decideSeatClaim({ ...HELD, bulletStatus: 'DOWN', callerHolds: ['ops'] }).ok).toBe(false);
  });
});

describe('decideSeatClaim: a seat that is not UP (RCB-197)', () => {
  it('a DOWN bullet is taken, no audit', () => {
    expect(decideSeatClaim({ ...HELD, bulletStatus: 'DOWN' })).toEqual({
      ok: true,
      release: null,
      audit: null,
    });
  });

  it('no bullet at all is taken, no audit', () => {
    expect(decideSeatClaim({ ...HELD, bulletStatus: null })).toEqual({
      ok: true,
      release: null,
      audit: null,
    });
  });

  it('a stale lease under a DOWN bullet is not a conflict', () => {
    expect(decideSeatClaim({ ...HELD, bulletStatus: 'DOWN', force: false }).ok).toBe(true);
  });
});

describe('decideSeatClaim: no lease — the old window rule (RCB-197)', () => {
  it('no legacy conflict: taken, no audit', () => {
    expect(decideSeatClaim({ ...LEGACY, legacy: null })).toEqual({
      ok: true,
      release: null,
      audit: null,
    });
  });

  it('--force over a legacy conflict: taken, audited with the standing bullet', () => {
    expect(decideSeatClaim({ ...LEGACY, force: true })).toEqual({
      ok: true,
      release: null,
      audit: { title: 'seat --up --force over a standing UP bullet', text: BULLET },
    });
  });

  it("a legacy conflict without --force: today's refusal, byte for byte, no trailing newline", () => {
    const error = errorOf(decideSeatClaim(LEGACY));
    expect(error).toBe(
      'seat builder is already UP (UP 5 min ago (stamped 2026-09-21 22:32Z), window 30 min):\n' +
        `  ${BULLET}\n` +
        'another session holds this seat. If it is dead, re-run with --force (audited in the log).',
    );
    expect(error.endsWith('\n')).toBe(false);
  });

  it('the legacy refusal words the fresh source through describeSeatUpConflict', () => {
    const logged: SeatUpConflict = { stamp: null, minutesAgo: 10, source: 'log' };
    const error = errorOf(
      decideSeatClaim({
        ...LEGACY,
        legacy: { conflict: logged, windowMinutes: 45, bullet: BULLET },
      }),
    );
    expect(error).toContain('already UP (logged 10 min ago, window 45 min):');
  });
});

describe('decideSeatClaim: a leased seat (RCB-197)', () => {
  it('the same holder (same pane, new session after /clear): taken, no --force, no audit', () => {
    const me: SeatHolder = { ...HOLDER, session: 'sess-after-clear', pid: 9999, start: 'later' };
    expect(decideSeatClaim({ ...HELD, caller: me })).toEqual({
      ok: true,
      release: null,
      audit: null,
    });
  });

  it('the same holder wins over a dead reading — no audit for taking your own seat back', () => {
    const dead: HolderLiveness = { state: 'dead', reason: 'no-process' };
    const claim = decideSeatClaim({
      ...HELD,
      caller: { ...HOLDER },
      lease: { ...(HELD.lease as NonNullable<typeof HELD.lease>), liveness: dead },
    });
    expect(claim).toEqual({ ok: true, release: null, audit: null });
  });

  it('a dead holder (no process): taken over without --force, audited with label, since, liveness', () => {
    const claim = decideSeatClaim({
      ...HELD,
      lease: {
        ...(HELD.lease as NonNullable<typeof HELD.lease>),
        liveness: { state: 'dead', reason: 'no-process' },
      },
    });
    expect(claim).toEqual({
      ok: true,
      release: null,
      audit: {
        title: 'seat --up over a dead holder',
        text: 'A7B2 · acme builder (UP 2026-09-30 00:32Z) — dead: no process',
      },
    });
  });

  it('a dead holder (pid reused) is taken over too', () => {
    const claim = decideSeatClaim({
      ...HELD,
      lease: {
        ...(HELD.lease as NonNullable<typeof HELD.lease>),
        liveness: { state: 'dead', reason: 'pid-reused' },
      },
    });
    expect(claim.ok).toBe(true);
    expect(claim.ok && claim.audit?.text).toContain('dead: pid reused');
  });

  it('a live holder with --force: taken, audited as a live-holder override', () => {
    expect(decideSeatClaim({ ...HELD, force: true })).toEqual({
      ok: true,
      release: null,
      audit: {
        title: 'seat --up --force over a live holder',
        text: 'A7B2 · acme builder (UP 2026-09-30 00:32Z) — alive',
      },
    });
  });

  it('an UNKNOWN holder with --force: same override audit, carrying why it was unknown', () => {
    const claim = decideSeatClaim({
      ...HELD,
      force: true,
      lease: {
        ...(HELD.lease as NonNullable<typeof HELD.lease>),
        liveness: { state: 'unknown', reason: 'no-start' },
      },
    });
    expect(claim).toEqual({
      ok: true,
      release: null,
      audit: {
        title: 'seat --up --force over a live holder',
        text: 'A7B2 · acme builder (UP 2026-09-30 00:32Z) — unknown: no start',
      },
    });
  });

  it('a live holder without --force: refused, naming the holder, its since and who you are', () => {
    expect(errorOf(decideSeatClaim(HELD))).toBe(
      'builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme' +
        ' — if it is dead, re-run with --force (audited in the log)',
    );
  });

  it('an UNKNOWN holder without --force: refused, with the liveness in parentheses', () => {
    const error = errorOf(
      decideSeatClaim({
        ...HELD,
        lease: {
          ...(HELD.lease as NonNullable<typeof HELD.lease>),
          liveness: { state: 'unknown', reason: 'other-host' },
        },
      }),
    );
    expect(error).toBe(
      'builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme' +
        ' (unknown: other host) — if it is dead, re-run with --force (audited in the log)',
    );
  });

  it('a lease decides, not legacy: a conflicting legacy reading is ignored when a lease exists', () => {
    const claim = decideSeatClaim({
      ...HELD,
      legacy: { conflict: CONFLICT, windowMinutes: 30, bullet: BULLET },
      force: true,
    });
    expect(claim.ok && claim.audit?.title).toBe('seat --up --force over a live holder');
  });

  it('a `since` that does not parse is shown as written, not made up', () => {
    const error = errorOf(
      decideSeatClaim({
        ...HELD,
        lease: { ...(HELD.lease as NonNullable<typeof HELD.lease>), since: 'yesterday-ish' },
      }),
    );
    expect(error).toContain('(UP yesterday-ish)');
  });
});

describe('decideSeatClaim: the audit never carries a pid, host or session (RCB-197)', () => {
  it('holds for every audited branch and for the refusal', () => {
    const lease = HELD.lease as NonNullable<typeof HELD.lease>;
    const outputs: string[] = [];
    for (const claim of [
      decideSeatClaim({ ...HELD, force: true }),
      decideSeatClaim({
        ...HELD,
        lease: { ...lease, liveness: { state: 'dead', reason: 'no-process' } },
      }),
      decideSeatClaim({
        ...HELD,
        lease: { ...lease, liveness: { state: 'unknown', reason: 'no-pid' } },
        force: true,
      }),
      decideSeatClaim(HELD),
    ]) {
      outputs.push(claim.ok ? `${claim.audit?.title} ${claim.audit?.text}` : claim.error);
    }
    for (const text of outputs) {
      expect(text).not.toContain('4242');
      expect(text).not.toContain('mac-mini');
      expect(text).not.toContain('sess-holder-1');
      expect(text).not.toContain('sess-caller-9');
      expect(text).not.toContain('5000');
    }
  });
});

describe('decideSeatClaim: release (RCB-197)', () => {
  it('is `from` on every ok — a move writes the old seat DOWN whatever route the claim took', () => {
    const lease = HELD.lease as NonNullable<typeof HELD.lease>;
    const move = { from: 'planner', callerHolds: ['planner'] };
    const oks = [
      decideSeatClaim({ ...HELD, ...move, bulletStatus: null }),
      decideSeatClaim({ ...HELD, ...move, bulletStatus: 'DOWN' }),
      decideSeatClaim({ ...LEGACY, ...move, legacy: null }),
      decideSeatClaim({ ...LEGACY, ...move, force: true }),
      decideSeatClaim({ ...HELD, ...move, caller: { ...HOLDER } }),
      decideSeatClaim({
        ...HELD,
        ...move,
        lease: { ...lease, liveness: { state: 'dead', reason: 'no-process' } },
      }),
      decideSeatClaim({ ...HELD, ...move, force: true }),
    ];
    for (const claim of oks) {
      expect(claim.ok && claim.release).toBe('planner');
    }
  });

  it('is null on every ok when no --from was given', () => {
    const oks = [
      decideSeatClaim({ ...HELD, bulletStatus: null }),
      decideSeatClaim({ ...LEGACY, force: true }),
      decideSeatClaim({ ...HELD, force: true }),
    ];
    for (const claim of oks) {
      expect(claim.ok && claim.release).toBeNull();
    }
  });

  it('a refused claim releases nothing — there is no release on an error', () => {
    expect(decideSeatClaim({ ...HELD, from: 'planner', callerHolds: ['planner'] }).ok).toBe(false);
  });
});

/** The `error` of a refused write; fails the test (rather than returning `undefined`) on an ok. */
function writeErrorOf(decision: SeatWriteDecision): string {
  if (decision.ok) throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`);
  return decision.error;
}

/** A leased seat the caller (a different pane) does not hold, written with the `down` verb. */
const WRITE: SeatWriteInput = {
  seat: 'builder',
  verb: 'down',
  callerLabel: '0460 · acme',
  caller: CALLER,
  lease: { holder: HOLDER, since: '2026-09-30T00:32:00Z', label: 'A7B2 · acme builder' },
  force: false,
};

/** `WRITE`'s lease, for spreading with one field changed. */
const WRITE_LEASE = WRITE.lease as NonNullable<SeatWriteInput['lease']>;

describe('decideSeatWrite: holder-only seat writes (RCB-198)', () => {
  it('rule 1: no lease (a legacy bullet) — anyone may write it, no audit', () => {
    expect(decideSeatWrite({ ...WRITE, lease: null })).toEqual({ ok: true, audit: null });
  });

  it('rule 1: --force with no lease is NOT audited — nothing was overridden', () => {
    for (const verb of ['down', 'update', 'log'] as const) {
      expect(decideSeatWrite({ ...WRITE, verb, lease: null, force: true })).toEqual({
        ok: true,
        audit: null,
      });
    }
  });

  it('rule 2: the holder itself writes — ok, no audit', () => {
    expect(decideSeatWrite({ ...WRITE, caller: { ...HOLDER } })).toEqual({ ok: true, audit: null });
  });

  it('rule 2: the same pane in a different session (after /clear) is the holder — ok, no audit', () => {
    const me: SeatHolder = { ...HOLDER, session: 'sess-after-clear', pid: 9999, start: 'later' };
    expect(decideSeatWrite({ ...WRITE, caller: me })).toEqual({ ok: true, audit: null });
  });

  it('rule 2: no pane on either side, same host + pid + start is the holder — ok, no audit', () => {
    const holder: SeatHolder = { ...HOLDER, pane: null };
    const me: SeatHolder = { ...holder, session: 'sess-after-clear' };
    expect(decideSeatWrite({ ...WRITE, caller: me, lease: { ...WRITE_LEASE, holder } })).toEqual({
      ok: true,
      audit: null,
    });
  });

  it('rule 2: no pane, same pid but a different start time is NOT the holder — refused (a recycled pid)', () => {
    const holder: SeatHolder = { ...HOLDER, pane: null };
    const me: SeatHolder = { ...holder, start: 'Tue Sep 29 23:59:59 2026' };
    const decision = decideSeatWrite({ ...WRITE, caller: me, lease: { ...WRITE_LEASE, holder } });
    expect(writeErrorOf(decision)).toContain('you are 0460 · acme');
  });

  it('GUARD (the web door): an all-null caller never matches a lease — refused without --force', () => {
    const web: SeatHolder = { pane: null, session: null, start: null, host: null, pid: null };
    const bareHolder: SeatHolder = { ...HOLDER, pane: null, host: null, pid: null, start: null };
    for (const holder of [HOLDER, bareHolder]) {
      const decision = decideSeatWrite({
        ...WRITE,
        callerLabel: 'web',
        caller: web,
        lease: { ...WRITE_LEASE, holder },
      });
      expect(writeErrorOf(decision)).toContain('you are web');
    }
  });

  it('rule 3: --force over another holder — ok, audited with the exact text', () => {
    expect(decideSeatWrite({ ...WRITE, force: true })).toEqual({
      ok: true,
      audit: {
        title: 'seat --down --force over another holder',
        text: 'builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); written by 0460 · acme',
      },
    });
  });

  it('rule 3: the audit title names the verb — the seat down, the seat update, log --as <seat>', () => {
    const titles = (['down', 'update', 'log'] as const).map((verb) => {
      const decision = decideSeatWrite({ ...WRITE, verb, force: true });
      return decision.ok ? decision.audit?.title : undefined;
    });
    expect(titles).toEqual([
      'seat --down --force over another holder',
      'seat --update --force over another holder',
      'log --as builder --force over another holder',
    ]);
  });

  it('rule 2 wins over --force: the holder forcing its own write is not audited', () => {
    expect(decideSeatWrite({ ...WRITE, caller: { ...HOLDER }, force: true })).toEqual({
      ok: true,
      audit: null,
    });
  });

  it('rule 4: another pane without --force — refused, both labels, the exact text, no trailing newline', () => {
    const error = writeErrorOf(decideSeatWrite(WRITE));
    expect(error).toBe(
      'builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme' +
        ' — use --force to write it anyway (audited in the log)',
    );
    expect(error.endsWith('\n')).toBe(false);
  });

  it('rule 4: every verb is refused the same way (the verb only words the audit)', () => {
    const errors = (['down', 'update', 'log'] as const).map((verb) =>
      writeErrorOf(decideSeatWrite({ ...WRITE, verb })),
    );
    expect(new Set(errors).size).toBe(1);
  });

  it('a dead holder is still the holder: the input has no liveness, so an old lease still refuses', () => {
    const lease = { ...WRITE_LEASE, since: '2020-01-01T00:00:00Z' };
    expect(writeErrorOf(decideSeatWrite({ ...WRITE, lease }))).toContain('(UP 2020-01-01 00:00Z)');
  });

  it('a `since` that does not parse is shown as written, not made up', () => {
    const lease = { ...WRITE_LEASE, since: 'yesterday-ish' };
    expect(writeErrorOf(decideSeatWrite({ ...WRITE, lease }))).toContain('(UP yesterday-ish)');
  });

  it('the refusal and the audit carry labels only — never a pid, host or session', () => {
    const outputs: string[] = [];
    for (const decision of [
      decideSeatWrite(WRITE),
      decideSeatWrite({ ...WRITE, force: true }),
      decideSeatWrite({ ...WRITE, verb: 'log', force: true }),
    ]) {
      outputs.push(
        decision.ok ? `${decision.audit?.title} ${decision.audit?.text}` : decision.error,
      );
    }
    for (const text of outputs) {
      expect(text).not.toContain('4242');
      expect(text).not.toContain('mac-mini');
      expect(text).not.toContain('sess-holder-1');
      expect(text).not.toContain('sess-caller-9');
      expect(text).not.toContain('5000');
    }
  });
});
