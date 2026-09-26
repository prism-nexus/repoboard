/**
 * RCB-153 slice 1 (W4, part of W5): the pure workspace functions — no filesystem, no `Store`.
 */
import { describe, expect, it } from 'vitest';
import type { Card, LeasesDoc } from '../src/types.js';
import {
  resolveCardRef,
  type WorkspaceBoardRef,
  workspaceLeaseLines,
  workspaceOwnerQueueLines,
  workspaceSeatLines,
} from '../src/workspace.js';
import { sampleCard } from './helpers.js';

const NOW = new Date('2026-09-25T18:00:00Z');

function askedCard(id: string, question: string, letters: string[]): Card {
  return sampleCard({
    id,
    status: 'decide',
    decision: {
      question,
      options: letters.map((letter) => ({ letter, text: letter })),
      askedBy: 'claude/coordinator',
      askedAt: '2026-09-25T17:00:00Z',
      returnTo: 'doing',
      chosen: null,
      words: null,
      decidedBy: null,
      decidedAt: null,
    },
  });
}

// ---- resolveCardRef (W4) --------------------------------------------------------------------

describe('resolveCardRef', () => {
  const workspace: WorkspaceBoardRef = { key: null, prefix: 'WS' };
  const aa: WorkspaceBoardRef = { key: 'aa', prefix: 'AA' };
  const bb: WorkspaceBoardRef = { key: 'bb', prefix: 'BB' };
  const boards = [workspace, aa, bb];

  it('the workspace prefix wins first, even over a member that would otherwise match', () => {
    // A member sharing the WORKSPACE's own prefix — workspace-first (W4), asserted directly
    // (§4 control 4's "workspace card with prefix AA wins over the member").
    const clashing = [{ key: null, prefix: 'AA' }, aa, bb];
    expect(resolveCardRef('AA-1', clashing)).toEqual({ ok: true, key: null, id: 'AA-1' });
  });

  it('a bare id resolves to the one member whose prefix matches', () => {
    expect(resolveCardRef('AA-1', boards)).toEqual({ ok: true, key: 'aa', id: 'AA-1' });
    expect(resolveCardRef('BB-7', boards)).toEqual({ ok: true, key: 'bb', id: 'BB-7' });
  });

  it('a shared member prefix is an error naming both keys, and <key>:ID still resolves', () => {
    const clashing = [workspace, aa, { key: 'aa2', prefix: 'AA' }];
    const res = resolveCardRef('AA-1', clashing);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an error');
    expect(res.error).toContain('aa');
    expect(res.error).toContain('aa2');
    expect(resolveCardRef('aa:AA-1', clashing)).toEqual({ ok: true, key: 'aa', id: 'AA-1' });
    expect(resolveCardRef('aa2:AA-1', clashing)).toEqual({ ok: true, key: 'aa2', id: 'AA-1' });
  });

  it('<key>:<id> is always accepted for a known key, whatever the id looks like', () => {
    expect(resolveCardRef('bb:BB-1', boards)).toEqual({ ok: true, key: 'bb', id: 'BB-1' });
  });

  it('an unknown key, or an id with no matching board, is an error', () => {
    expect(resolveCardRef('cc:BB-1', boards).ok).toBe(false);
    expect(resolveCardRef('ZZ-9', boards).ok).toBe(false);
    expect(resolveCardRef('not-a-card-id', boards).ok).toBe(false);
  });
});

// ---- workspaceOwnerQueueLines / workspaceLeaseLines (W5) ------------------------------------

describe('workspaceOwnerQueueLines', () => {
  it('one line per member card that needs a decision, [<key>]-prefixed, repos: order', () => {
    const lines = workspaceOwnerQueueLines([
      { key: 'aa', cards: [askedCard('AA-1', 'ship now?', ['A', 'B'])] },
      { key: 'bb', cards: [askedCard('BB-1', 'merge?', [])] },
    ]);
    expect(lines).toEqual(['[aa] AA-1 · ship now? · [A B]', '[bb] BB-1 · merge?']);
  });

  it('a member with nothing open contributes no line at all', () => {
    expect(workspaceOwnerQueueLines([{ key: 'aa', cards: [sampleCard({ id: 'AA-1' })] }])).toEqual(
      [],
    );
  });

  it('a missing member (cards: null) always contributes exactly one (missing) line', () => {
    expect(workspaceOwnerQueueLines([{ key: 'aa', cards: null }])).toEqual(['[aa] (missing)']);
  });
});

describe('workspaceLeaseLines', () => {
  function leasesDoc(leases: LeasesDoc['leases']): LeasesDoc {
    return { leases, windows: [] };
  }

  it('one line per LIVE member lease, [<key>]-prefixed; a stale one is dropped', () => {
    const lines = workspaceLeaseLines(
      [
        {
          key: 'aa',
          leases: leasesDoc([
            { resource: 'vitest-lock', holder: 'claude/a', since: '2026-09-25T17:00:00Z' },
            {
              resource: 'stale-one',
              holder: 'claude/old',
              since: '2026-09-25T10:00:00Z',
              until: '2026-09-25T11:00:00Z',
            },
          ]),
        },
        { key: 'bb', leases: leasesDoc([]) },
      ],
      NOW,
    );
    expect(lines).toEqual(['[aa] vitest-lock · claude/a · since 17:00Z · until —']);
  });

  it('no live leases anywhere is an empty array, not a placeholder line', () => {
    expect(workspaceLeaseLines([{ key: 'aa', leases: leasesDoc([]) }], NOW)).toEqual([]);
  });
});

describe('workspaceSeatLines (RCB-160 slice 2)', () => {
  it('one line per member SEATS bullet, re-keyed, repos: order', () => {
    const lines = workspaceSeatLines([
      { key: 'aa', seats: '- **[repoboard] builder: UP 2026-09-18 21:00Z.** on RCB-1' },
      { key: 'bb', seats: '- **ops: UP 2026-09-18 21:00Z.** watching' },
    ]);
    expect(lines).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z.** on RCB-1',
      '- **[bb] ops: UP 2026-09-18 21:00Z.** watching',
    ]);
  });

  it('a missing member (seats: null) contributes nothing', () => {
    expect(workspaceSeatLines([{ key: 'aa', seats: null }])).toEqual([]);
  });

  it('a placeholder SEATS section contributes nothing', () => {
    expect(workspaceSeatLines([{ key: 'aa', seats: '_(nothing recorded yet)_' }])).toEqual([]);
  });
});
