/**
 * P8.2 (plan §5 P8.2, §11 O9): `.repoboard/leases.yml` — who holds a resource, and the windows
 * during which one is claimed. `takeLease`/`releaseLease`/`addWindow` are the only writers;
 * `checkResource`/`staleLeases`/`isStale` are pure readers; `pruneWindows` runs on write, never
 * on read (locked decision 2).
 */
import { describe, expect, it } from 'vitest';
import {
  addWindow,
  checkResource,
  isStale,
  parseLeases,
  pruneWindows,
  releaseLease,
  resolveTimeSpec,
  serializeLeases,
  staleLeases,
  takeLease,
} from '../src/leases.js';
import type { LeasesDoc } from '../src/types.js';

const NOW = new Date('2026-09-17T18:50:00Z');
const actor = 'claude/ops';

function empty(): LeasesDoc {
  return { leases: [], windows: [] };
}

describe('parseLeases / serializeLeases round-trip', () => {
  it('an empty file yields no leases, no windows', () => {
    const r = parseLeases('');
    expect(r).toEqual({ ok: true, doc: { leases: [], windows: [] } });
  });

  it("round-trips the brief's own example, unknown keys kept", () => {
    const text = [
      'leases:',
      '  - resource: vitest-lock',
      '    holder: claude/ops',
      '    since: 2026-09-17T18:50:00Z',
      '    until: 2026-09-17T19:30:00Z',
      '    note: cold4 gate',
      '    priority: high', // unknown key
      'windows:',
      '  - resource: vitest-lock',
      '    start: 2026-09-17T18:50:00Z',
      '    end: 2026-09-17T19:30:00Z',
      '    name: cold4 gate',
      '',
    ].join('\n');
    const r = parseLeases(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.leases[0]).toEqual({
      resource: 'vitest-lock',
      holder: 'claude/ops',
      since: '2026-09-17T18:50:00Z',
      until: '2026-09-17T19:30:00Z',
      note: 'cold4 gate',
      priority: 'high',
    });
    const out = serializeLeases(r.doc);
    expect(parseLeases(out)).toEqual(r);
    expect(
      serializeLeases(parseLeases(out).ok ? (parseLeases(out) as { doc: LeasesDoc }).doc : empty()),
    ).toBe(out);
  });

  it('invalid YAML is an error, never a throw', () => {
    const r = parseLeases('leases: [');
    expect(r.ok).toBe(false);
  });

  it('a non-mapping document is refused', () => {
    expect(parseLeases('- just\n- a\n- list').ok).toBe(false);
  });
});

describe('takeLease', () => {
  it('takes a free resource', () => {
    const r = takeLease(empty(), { resource: 'vitest-lock' }, { actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.leases).toEqual([
      { resource: 'vitest-lock', holder: actor, since: '2026-09-17T18:50:00Z' },
    ]);
    expect(r.event).toEqual({
      ts: '2026-09-17T18:50:00Z',
      actor,
      type: 'lease',
      cardId: null,
      resource: 'vitest-lock',
      from: null,
      to: actor,
    });
    expect(r.warnings).toEqual([]);
  });

  it('the same holder renews: since is kept, until is replaced', () => {
    const first = takeLease(
      empty(),
      { resource: 'r', until: '2026-09-17T19:00:00Z' },
      { actor, now: NOW },
    );
    if (!first.ok) throw new Error(first.error);
    const later = new Date('2026-09-17T18:55:00Z');
    const renewed = takeLease(
      first.doc,
      { resource: 'r', until: '2026-09-17T20:00:00Z' },
      { actor, now: later },
    );
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.doc.leases).toEqual([
      {
        resource: 'r',
        holder: actor,
        since: '2026-09-17T18:50:00Z',
        until: '2026-09-17T20:00:00Z',
      },
    ]);
  });

  it('renewing with no --until clears it (until replaced, not merged)', () => {
    const first = takeLease(
      empty(),
      { resource: 'r', until: '2026-09-17T19:00:00Z' },
      { actor, now: NOW },
    );
    if (!first.ok) throw new Error(first.error);
    const renewed = takeLease(first.doc, { resource: 'r' }, { actor, now: NOW });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.doc.leases[0]?.until).toBeUndefined();
  });

  it('a live lease held by another holder is a conflict naming the holder and until', () => {
    const first = takeLease(
      empty(),
      { resource: 'r', until: '2026-09-17T19:00:00Z' },
      { actor, now: NOW },
    );
    if (!first.ok) throw new Error(first.error);
    const conflict = takeLease(first.doc, { resource: 'r' }, { actor: 'claude/fix', now: NOW });
    expect(conflict).toEqual({
      ok: false,
      error:
        '"r" is held by claude/ops until 2026-09-17T19:00:00Z (pass --force to take it anyway)',
    });
  });

  it('--force overrides a conflict and the event/warnings say so', () => {
    const first = takeLease(
      empty(),
      { resource: 'r', until: '2026-09-17T19:00:00Z' },
      { actor, now: NOW },
    );
    if (!first.ok) throw new Error(first.error);
    const forced = takeLease(
      first.doc,
      { resource: 'r', force: true },
      { actor: 'claude/fix', now: NOW },
    );
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.doc.leases).toEqual([
      { resource: 'r', holder: 'claude/fix', since: '2026-09-17T18:50:00Z' },
    ]);
    expect(forced.warnings).toEqual([
      'forced: took "r" from claude/ops (was held until 2026-09-17T19:00:00Z)',
    ]);
    expect(forced.event.from).toBe('claude/ops');
    expect(forced.event.to).toBe('claude/fix');
  });

  it('a stale lease is taken fresh, no conflict, no force needed', () => {
    const first = takeLease(
      empty(),
      { resource: 'r', until: '2026-09-17T18:00:00Z' }, // already past NOW
      { actor, now: new Date('2026-09-17T17:00:00Z') },
    );
    if (!first.ok) throw new Error(first.error);
    const r = takeLease(first.doc, { resource: 'r' }, { actor: 'claude/fix', now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.leases).toEqual([
      { resource: 'r', holder: 'claude/fix', since: '2026-09-17T18:50:00Z' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('an empty resource is refused', () => {
    expect(takeLease(empty(), { resource: '  ' }, { actor, now: NOW })).toEqual({
      ok: false,
      error: 'resource must not be empty',
    });
  });
});

describe('releaseLease', () => {
  it('the holder releases cleanly', () => {
    const taken = takeLease(empty(), { resource: 'r' }, { actor, now: NOW });
    if (!taken.ok) throw new Error(taken.error);
    const r = releaseLease(taken.doc, { resource: 'r' }, { actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.leases).toEqual([]);
    expect(r.event).toEqual({
      ts: '2026-09-17T18:50:00Z',
      actor,
      type: 'lease',
      cardId: null,
      resource: 'r',
      from: actor,
      to: 'released',
    });
  });

  it('a non-holder is refused, naming the holder', () => {
    const taken = takeLease(empty(), { resource: 'r' }, { actor, now: NOW });
    if (!taken.ok) throw new Error(taken.error);
    expect(releaseLease(taken.doc, { resource: 'r' }, { actor: 'claude/fix', now: NOW })).toEqual({
      ok: false,
      error: '"r" is held by claude/ops, not claude/fix (pass --force to release it anyway)',
    });
  });

  it("--force releases a non-holder's lease, with a warning", () => {
    const taken = takeLease(empty(), { resource: 'r' }, { actor, now: NOW });
    if (!taken.ok) throw new Error(taken.error);
    const r = releaseLease(
      taken.doc,
      { resource: 'r', force: true },
      { actor: 'claude/fix', now: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.leases).toEqual([]);
    expect(r.warnings).toEqual(['forced: released "r" held by claude/ops']);
  });

  it('releasing a resource with no lease at all is refused', () => {
    expect(releaseLease(empty(), { resource: 'r' }, { actor, now: NOW })).toEqual({
      ok: false,
      error: 'no lease is held on "r"',
    });
  });
});

describe('stale detection at the boundary', () => {
  it('until < now is stale', () => {
    const lease = {
      resource: 'r',
      holder: actor,
      since: NOW.toISOString(),
      until: '2026-09-17T18:49:59Z',
    };
    expect(isStale(lease, NOW)).toBe(true);
  });

  it('until === now is live, not stale', () => {
    const lease = {
      resource: 'r',
      holder: actor,
      since: NOW.toISOString(),
      until: '2026-09-17T18:50:00Z',
    };
    expect(isStale(lease, NOW)).toBe(false);
  });

  it('until absent is always live', () => {
    const lease = { resource: 'r', holder: actor, since: NOW.toISOString() };
    expect(isStale(lease, NOW)).toBe(false);
  });

  it('staleLeases lists exactly the stale ones', () => {
    const doc: LeasesDoc = {
      leases: [
        { resource: 'a', holder: actor, since: NOW.toISOString(), until: '2026-09-17T18:00:00Z' },
        { resource: 'b', holder: actor, since: NOW.toISOString(), until: '2026-09-17T19:00:00Z' },
      ],
      windows: [],
    };
    expect(staleLeases(doc, NOW).map((l) => l.resource)).toEqual(['a']);
  });
});

describe('pruneWindows: only on write, never on read', () => {
  it('drops a window whose end is in the past', () => {
    const doc: LeasesDoc = {
      leases: [],
      windows: [
        { resource: 'r', start: '2026-09-17T10:00:00Z', end: '2026-09-17T11:00:00Z', name: 'old' },
        { resource: 'r', start: '2026-09-17T18:00:00Z', end: '2026-09-17T19:00:00Z', name: 'now' },
      ],
    };
    const pruned = pruneWindows(doc, NOW);
    expect(pruned.windows.map((w) => w.name)).toEqual(['now']);
  });

  it('a window ending exactly at now is kept (end is inclusive here, pruning is not checkResource)', () => {
    const doc: LeasesDoc = {
      leases: [],
      windows: [
        { resource: 'r', start: '2026-09-17T18:00:00Z', end: '2026-09-17T18:50:00Z', name: 'edge' },
      ],
    };
    expect(pruneWindows(doc, NOW).windows).toHaveLength(1);
  });

  it('parseLeases itself never prunes: an expired window survives a read', () => {
    const text = [
      'windows:',
      '  - resource: r',
      '    start: 2026-09-01T00:00:00Z',
      '    end: 2026-09-02T00:00:00Z',
      '    name: long gone',
      '',
    ].join('\n');
    const r = parseLeases(text);
    expect(r.ok && r.doc.windows).toHaveLength(1);
  });
});

describe('checkResource: inside / outside / edge', () => {
  const doc: LeasesDoc = {
    leases: [],
    windows: [
      {
        resource: 'vitest-lock',
        start: '2026-09-17T18:50:00Z',
        end: '2026-09-17T19:30:00Z',
        name: 'cold4 gate',
      },
    ],
  };

  it('before the window is clear', () => {
    expect(checkResource(doc, 'vitest-lock', new Date('2026-09-17T18:49:59Z'))).toEqual({
      clear: true,
    });
  });

  it('at start (inclusive) is inside', () => {
    const r = checkResource(doc, 'vitest-lock', new Date('2026-09-17T18:50:00Z'));
    expect(r).toEqual({
      clear: false,
      reasons: ['inside cold4 gate 2026-09-17T18:50:00Z–2026-09-17T19:30:00Z vitest-lock'],
    });
  });

  it('inside the window', () => {
    expect(checkResource(doc, 'vitest-lock', new Date('2026-09-17T19:00:00Z')).clear).toBe(false);
  });

  it('at end (exclusive) is clear', () => {
    expect(checkResource(doc, 'vitest-lock', new Date('2026-09-17T19:30:00Z'))).toEqual({
      clear: true,
    });
  });

  it('after the window is clear', () => {
    expect(checkResource(doc, 'vitest-lock', new Date('2026-09-17T19:30:01Z'))).toEqual({
      clear: true,
    });
  });

  it('a different resource is unaffected', () => {
    expect(checkResource(doc, 'other', new Date('2026-09-17T19:00:00Z'))).toEqual({ clear: true });
  });

  it('a live lease also makes it not clear, with the held-by reason', () => {
    const leased: LeasesDoc = {
      leases: [
        {
          resource: 'vitest-lock',
          holder: 'claude/ops',
          since: NOW.toISOString(),
          until: '2026-09-17T20:00:00Z',
        },
      ],
      windows: [],
    };
    expect(checkResource(leased, 'vitest-lock', NOW)).toEqual({
      clear: false,
      reasons: ['held by claude/ops until 2026-09-17T20:00:00Z'],
    });
  });

  it('a stale lease does not block', () => {
    const leased: LeasesDoc = {
      leases: [
        {
          resource: 'vitest-lock',
          holder: 'claude/ops',
          since: '2026-09-17T10:00:00Z',
          until: '2026-09-17T11:00:00Z',
        },
      ],
      windows: [],
    };
    expect(checkResource(leased, 'vitest-lock', NOW)).toEqual({ clear: true });
  });

  it('a lease with no until never blocks... unless still live (it always is)', () => {
    const leased: LeasesDoc = {
      leases: [{ resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-17T10:00:00Z' }],
      windows: [],
    };
    expect(checkResource(leased, 'vitest-lock', NOW)).toEqual({
      clear: false,
      reasons: ['held by claude/ops until —'],
    });
  });
});

describe('addWindow', () => {
  it('appends a window', () => {
    const r = addWindow(
      empty(),
      {
        resource: 'r',
        start: '2026-09-17T18:50:00Z',
        end: '2026-09-17T19:30:00Z',
        name: 'cold4 gate',
      },
      { actor, now: NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.windows).toEqual([
      {
        resource: 'r',
        start: '2026-09-17T18:50:00Z',
        end: '2026-09-17T19:30:00Z',
        name: 'cold4 gate',
      },
    ]);
    expect(r.event).toEqual({
      ts: '2026-09-17T18:50:00Z',
      actor,
      type: 'window',
      cardId: null,
      resource: 'r',
      from: null,
      to: 'cold4 gate',
    });
  });

  it('end must be after start', () => {
    expect(
      addWindow(
        empty(),
        {
          resource: 'r',
          start: '2026-09-17T19:30:00Z',
          end: '2026-09-17T18:50:00Z',
          name: 'backwards',
        },
        { actor, now: NOW },
      ),
    ).toEqual({ ok: false, error: 'end must be after start' });
  });

  it('end equal to start is refused too', () => {
    expect(
      addWindow(
        empty(),
        {
          resource: 'r',
          start: '2026-09-17T19:30:00Z',
          end: '2026-09-17T19:30:00Z',
          name: 'zero-length',
        },
        { actor, now: NOW },
      ).ok,
    ).toBe(false);
  });
});

describe('resolveTimeSpec: relative and ISO', () => {
  it('+90m is 90 minutes after now', () => {
    expect(resolveTimeSpec('+90m', NOW)).toEqual({ ok: true, iso: '2026-09-17T20:20:00Z' });
  });

  it('+2h is 2 hours after now', () => {
    expect(resolveTimeSpec('+2h', NOW)).toEqual({ ok: true, iso: '2026-09-17T20:50:00Z' });
  });

  it('an ISO datetime passes through normalized', () => {
    expect(resolveTimeSpec('2026-09-17T19:30:00.000Z', NOW)).toEqual({
      ok: true,
      iso: '2026-09-17T19:30:00Z',
    });
  });

  it('garbage is refused', () => {
    expect(resolveTimeSpec('soon', NOW).ok).toBe(false);
  });
});
