/**
 * P8.3 (plan §5 P8.3, §11 O9): `.repoboard/STATE.md` — parse/render/setStateSection, and
 * `checkFindings`, the pure half of `repoboard check`.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import type { LogBlock } from '../src/repolog.js';
import type { StateDoc } from '../src/state.js';
import {
  checkFindings,
  exitCodeForFindings,
  initialStateText,
  OWNER_QUEUE_PLACEHOLDER,
  ownerQueueLine,
  parseState,
  renderOwnerQueue,
  renderState,
  SECTION_PLACEHOLDER,
  setStateSection,
} from '../src/state.js';
import type { Card, LeasesDoc } from '../src/types.js';
import { sampleCard } from './helpers.js';

const NOW = new Date('2026-09-17T21:00:00Z');
const ACTOR = 'claude/p8-3';

function decidedCard(): Card {
  return sampleCard({ id: 'RB-20', decision: undefined });
}

function askedCard(id: string, question: string, letters: string[]): Card {
  return sampleCard({
    id,
    status: 'decide',
    decision: {
      question,
      options: letters.map((letter) => ({ letter, text: letter })),
      askedBy: 'claude/coordinator',
      askedAt: '2026-09-17T20:00:00Z',
      returnTo: 'doing',
      chosen: null,
      words: null,
      decidedBy: null,
      decidedAt: null,
    },
  });
}

describe('initialStateText', () => {
  it('is a fresh page with every section a placeholder, stamped now', () => {
    const text = initialStateText({ now: NOW, actor: ACTOR });
    const parsed = parseState(text);
    expect(parsed).toEqual({
      ok: true,
      doc: {
        stamp: '2026-09-17T21:00:00Z',
        actor: ACTOR,
        sections: {
          live: SECTION_PLACEHOLDER,
          lastLandings: SECTION_PLACEHOLDER,
          seats: SECTION_PLACEHOLDER,
        },
      },
    });
    expect(text).toContain(`## OWNER QUEUE\n\n${OWNER_QUEUE_PLACEHOLDER}`);
  });
});

describe('parseState / renderState round-trip', () => {
  it('round-trips a hand-written page, generated OWNER QUEUE substituted on render', () => {
    const text = initialStateText({ now: NOW, actor: ACTOR });
    const parsed = parseState(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rendered = renderState(parsed.doc.sections, [], {
      now: new Date(Date.parse(parsed.doc.stamp)),
      actor: parsed.doc.actor,
    });
    expect(rendered).toBe(text);
  });

  it('OWNER QUEUE is generated from cards that need a decision, not from the file', () => {
    const text = [
      '# STATE',
      '',
      '**Written 2026-09-17T20:00:00Z by claude/ops.**',
      '',
      '## LIVE',
      '',
      'Tree is dev.',
      '',
      '## LAST LANDINGS',
      '',
      'K117 landed.',
      '',
      '## OWNER QUEUE',
      '',
      '_(generated from open decisions)_',
      '',
      '## SEATS',
      '',
      'ops watching.',
    ].join('\n');
    const parsed = parseState(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.sections.live).toBe('Tree is dev.');
    const openCards = [askedCard('RCB-40', 'sync-issues column?', ['A', 'B']), decidedCard()];
    const rendered = renderState(parsed.doc.sections, openCards, {
      now: new Date(Date.parse(parsed.doc.stamp)),
      actor: parsed.doc.actor,
    });
    expect(rendered).toContain('RCB-40 · sync-issues column? · [A B]');
    expect(rendered).not.toContain('_(generated from open decisions)_');
    // Every other section is untouched.
    expect(rendered).toContain('Tree is dev.');
    expect(rendered).toContain('K117 landed.');
    expect(rendered).toContain('ops watching.');
  });

  it('missing the stamp line is an error, never a throw', () => {
    expect(parseState('# STATE\n\n## LIVE\n\nx\n').ok).toBe(false);
  });

  it('a missing section is named in the error', () => {
    const text = [
      '# STATE',
      '',
      '**Written 2026-09-17T20:00:00Z by claude/ops.**',
      '',
      '## LIVE',
      '',
      'x',
    ].join('\n');
    const r = parseState(text);
    expect(r).toEqual({ ok: false, error: 'STATE.md is missing the "## LAST LANDINGS" section' });
  });

  it('sections out of order are refused', () => {
    const text = [
      '# STATE',
      '',
      '**Written 2026-09-17T20:00:00Z by claude/ops.**',
      '',
      '## SEATS',
      '',
      'x',
      '',
      '## LIVE',
      '',
      'y',
      '',
      '## LAST LANDINGS',
      '',
      'z',
      '',
      '## OWNER QUEUE',
      '',
      '_(generated from open decisions)_',
    ].join('\n');
    expect(parseState(text).ok).toBe(false);
  });
});

describe('ownerQueueLine / renderOwnerQueue', () => {
  it('one line per open card, letters bracketed, omitted when there are none', () => {
    const withLetters = askedCard('RCB-40', 'sync-issues column?', ['A', 'B']);
    expect(ownerQueueLine(withLetters)).toBe('RCB-40 · sync-issues column? · [A B]');
    const noLetters = askedCard('RCB-41', 'ship now?', []);
    expect(ownerQueueLine(noLetters)).toBe('RCB-41 · ship now?');
  });

  it('the placeholder when nothing is open', () => {
    expect(renderOwnerQueue([decidedCard()])).toBe(OWNER_QUEUE_PLACEHOLDER);
    expect(renderOwnerQueue([])).toBe(OWNER_QUEUE_PLACEHOLDER);
  });

  it('a decided card never appears in the queue', () => {
    const card = askedCard('RCB-42', 'q', ['A']);
    const decided: Card = {
      ...card,
      decision: {
        ...(card.decision as NonNullable<Card['decision']>),
        chosen: 'A',
        decidedAt: '2026-09-17T20:05:00Z',
        decidedBy: 'web',
      },
    };
    expect(renderOwnerQueue([decided])).toBe(OWNER_QUEUE_PLACEHOLDER);
  });
});

describe('setStateSection: restamps and touches nothing else', () => {
  it('replaces exactly one section, other sections byte-identical, stamp updated', () => {
    const before = initialStateText({ now: new Date('2026-09-17T18:00:00Z'), actor: 'claude/ops' });
    const res = setStateSection(before, 'live', 'Tree is dev = origin/main.', {
      now: NOW,
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsedBefore = parseState(before);
    const parsedAfter = parseState(res.text);
    expect(parsedBefore.ok && parsedAfter.ok).toBe(true);
    if (!parsedBefore.ok || !parsedAfter.ok) return;
    expect(parsedAfter.doc.sections.live).toBe('Tree is dev = origin/main.');
    // Untouched sections render identically to before — the byte-compare the brief demands.
    expect(parsedAfter.doc.sections.lastLandings).toBe(parsedBefore.doc.sections.lastLandings);
    expect(parsedAfter.doc.sections.seats).toBe(parsedBefore.doc.sections.seats);
    expect(res.text).toContain('## LAST LANDINGS\n\n_(nothing recorded yet)_');
    expect(res.text).toContain('## SEATS\n\n_(nothing recorded yet)_');
    // The stamp moved.
    expect(parsedAfter.doc.stamp).toBe('2026-09-17T21:00:00Z');
    expect(parsedAfter.doc.actor).toBe(ACTOR);
    expect(parsedBefore.doc.stamp).toBe('2026-09-17T18:00:00Z');
  });

  it('trims the given body', () => {
    const before = initialStateText({ now: NOW, actor: ACTOR });
    const res = setStateSection(before, 'seats', '  ops watching.  \n', { now: NOW, actor: ACTOR });
    expect(res.ok && res.text.includes('## SEATS\n\nops watching.')).toBe(true);
  });

  it('an unparseable file is refused, naming what is wrong', () => {
    const res = setStateSection('not a state file', 'live', 'x', { now: NOW, actor: ACTOR });
    expect(res.ok).toBe(false);
  });

  it('the OWNER QUEUE placeholder on disk is never replaced by setStateSection', () => {
    const before = initialStateText({ now: NOW, actor: ACTOR });
    const res = setStateSection(before, 'live', 'x', { now: NOW, actor: ACTOR });
    expect(res.ok && res.text).toContain(OWNER_QUEUE_PLACEHOLDER);
  });
});

// ---- checkFindings -------------------------------------------------------------------------

function emptyLeases(): LeasesDoc {
  return { leases: [], windows: [] };
}

function stateAt(iso: string): StateDoc {
  const text = initialStateText({ now: new Date(iso), actor: 'claude/ops' });
  const parsed = parseState(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc;
}

describe('checkFindings', () => {
  const config = defaultBoardConfig();

  it('the ok case: nothing wrong yields no findings', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const findings = checkFindings({
      state,
      logs: [],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
  });

  it('stale-state: STATE stamp older than the newest log file (by mtime)', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T19:00:00Z'), blocks: [] }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([
      {
        kind: 'stale-state',
        level: 'error',
        message: 'stale-state: STATE.md stamp is older than the newest log entry',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });

  it('stale-state also fires from the newest ##### header time, not just mtime', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const blocks: LogBlock[] = [{ seat: 'OPS', ts: '2026-09-17T19:30:00Z', title: 'x', text: 'y' }];
    const findings = checkFindings({
      state,
      // mtime is OLDER than the state stamp, but the header inside is NEWER — the "whichever is
      // later" half of locked decision 4.
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T17:00:00Z'), blocks }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(true);
  });

  it('no logs at all means STATE cannot be stale', () => {
    const state = stateAt('2020-01-01T00:00:00Z');
    const findings = checkFindings({
      state,
      logs: [],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('a fresh STATE stamp (after the newest log) is not stale', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T18:00:00Z'), blocks: [] }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('a null state (no STATE.md) is stale whenever any log exists', () => {
    const findings = checkFindings({
      state: null,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T18:00:00Z'), blocks: [] }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(true);
  });

  it('active-without-lease: a card in an active column, assignee holds no live lease — warning-grade', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = sampleCard({
      id: 'RB-5',
      status: 'doing',
      assignee: 'claude/ops',
      updated: NOW.toISOString(),
    });
    const findings = checkFindings({
      state,
      logs: [],
      cards: [card],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([
      {
        kind: 'active-without-lease',
        level: 'warning',
        message: 'active-without-lease: RB-5 (claude/ops) holds no live lease',
      },
    ]);
    // Warning-grade: default exit is 0, --strict makes it 1.
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(1);
  });

  it('active-without-lease does not fire when the assignee holds any live lease', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = sampleCard({
      id: 'RB-5',
      status: 'doing',
      assignee: 'claude/ops',
      updated: NOW.toISOString(),
    });
    const leases: LeasesDoc = {
      leases: [{ resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-17T20:00:00Z' }],
      windows: [],
    };
    const findings = checkFindings({ state, logs: [], cards: [card], config, leases, now: NOW });
    expect(findings.some((f) => f.kind === 'active-without-lease')).toBe(false);
  });

  it('active-without-lease does not fire for a card outside an active column, or with no assignee', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const inTodo = sampleCard({ id: 'RB-6', status: 'todo', assignee: 'claude/ops' });
    const noAssignee = sampleCard({
      id: 'RB-7',
      status: 'doing',
      assignee: undefined,
      updated: NOW.toISOString(),
    });
    const findings = checkFindings({
      state,
      logs: [],
      cards: [inTodo, noAssignee],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'active-without-lease')).toBe(false);
  });

  it('stale-lease: one finding per stale lease, error-grade', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const leases: LeasesDoc = {
      leases: [
        {
          resource: 'r',
          holder: 'claude/ops',
          since: '2026-09-17T10:00:00Z',
          until: '2026-09-17T11:00:00Z',
        },
      ],
      windows: [],
    };
    const findings = checkFindings({ state, logs: [], cards: [], config, leases, now: NOW });
    expect(findings).toEqual([
      {
        kind: 'stale-lease',
        level: 'error',
        message: 'stale-lease: r held by claude/ops until 2026-09-17T11:00:00Z',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });

  it('needs-decision: a count, informational, never fails even with --strict', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const cards = [askedCard('RCB-40', 'q1', ['A']), askedCard('RCB-41', 'q2', [])];
    const findings = checkFindings({
      state,
      logs: [],
      cards,
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([
      {
        kind: 'needs-decision',
        level: 'info',
        message: 'needs-decision: 2 cards waiting on the owner',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(0);
  });

  it('needs-decision emits nothing when the count is zero', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const findings = checkFindings({
      state,
      logs: [],
      cards: [decidedCard()],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([]);
  });
});

describe('exitCodeForFindings', () => {
  it('no findings is 0 regardless of strict', () => {
    expect(exitCodeForFindings([], false)).toBe(0);
    expect(exitCodeForFindings([], true)).toBe(0);
  });

  it('an info-only finding never blocks', () => {
    const findings = [{ kind: 'needs-decision', level: 'info', message: 'x' } as const];
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(0);
  });
});
