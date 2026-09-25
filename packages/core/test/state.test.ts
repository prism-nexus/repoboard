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
  OWNER_QUEUE_FILE_PLACEHOLDER,
  OWNER_QUEUE_PLACEHOLDER,
  ownerQueueLine,
  parseState,
  renderOwnerQueue,
  renderState,
  SECTION_PLACEHOLDER,
  seatOwnerQueueDriftFindings,
  setStateSection,
  splitLandings,
  systemsFindings,
  trimLandings,
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

/** RCB-52: an open owner task — same shape as `askedCard`, but `kind: 'task'` and no options. */
function askedTaskCard(id: string, question: string): Card {
  return sampleCard({
    id,
    status: 'decide',
    decision: {
      question,
      kind: 'task',
      options: [],
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
    // RCB-118: the ON-DISK file writes the FILE placeholder, never the DISPLAY one — a raw-file
    // reader must never mistake "not stored here" for "queue is empty".
    expect(text).toContain(`## OWNER QUEUE\n\n${OWNER_QUEUE_FILE_PLACEHOLDER}`);
    expect(text).not.toContain(OWNER_QUEUE_PLACEHOLDER);
  });
});

describe('parseState / renderState round-trip', () => {
  it(
    'round-trips a hand-written page: every section but OWNER QUEUE identical; RCB-118: OWNER ' +
      'QUEUE differs even with no open decisions — file says "not stored here", display says "empty"',
    () => {
      const text = initialStateText({ now: NOW, actor: ACTOR });
      const parsed = parseState(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const rendered = renderState(parsed.doc.sections, [], {
        now: new Date(Date.parse(parsed.doc.stamp)),
        actor: parsed.doc.actor,
      });
      expect(text).toContain(OWNER_QUEUE_FILE_PLACEHOLDER);
      expect(rendered).toContain(OWNER_QUEUE_PLACEHOLDER);
      expect(rendered).not.toBe(text);
      // Every OTHER byte is identical — only the OWNER QUEUE body differs between the two.
      expect(rendered.replace(OWNER_QUEUE_PLACEHOLDER, '')).toBe(
        text.replace(OWNER_QUEUE_FILE_PLACEHOLDER, ''),
      );
    },
  );

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

  it('RCB-118: a file carrying the OLD on-disk placeholder still parses (never a stale-format refusal)', () => {
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
      OWNER_QUEUE_PLACEHOLDER,
      '',
      '## SEATS',
      '',
      'ops watching.',
    ].join('\n');
    const parsed = parseState(text);
    expect(parsed).toEqual({
      ok: true,
      doc: {
        stamp: '2026-09-17T20:00:00Z',
        actor: 'claude/ops',
        sections: {
          live: 'Tree is dev.',
          lastLandings: 'K117 landed.',
          seats: 'ops watching.',
        },
      },
    });
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

  it('RCB-52: an owner task renders "<id> · owner: <text>" — no letters bracket', () => {
    const task = askedTaskCard('RCB-9', 'buy the domain');
    expect(ownerQueueLine(task)).toBe('RCB-9 · owner: buy the domain');
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
    expect(res.ok && res.text).toContain(OWNER_QUEUE_FILE_PLACEHOLDER);
  });
});

// ---- STATE convergence C1: a multi-line body round-trips byte-identical ---------------------
// (fpj `docs/STATE-CONVERGENCE-BRIEF.md` locked decision 1 / control C1.) The fpj lane table is
// a markdown table with pipes and a `|---|` row; a bullet list; a line with **bold** and
// `backticks`; and — the case that catches a per-LINE `.trim()` regression, which a
// whole-section `.trim()` would not — a nested bullet with intentional leading spaces.
const LANE_LIVE_BODY = `| Lane | Holder | Window |
|---|---|---|
| repoboard-tree | claude/p8-6 | 12:10Z-12:40Z closed |
| vitest-lock | none | — |

- fpj STATE convergence: repoboard half in \`p8-6-logdir\`
- fpj half tracked separately
  - nested: STATE.md becomes a three-line pointer

Tree is dev = origin/main. **Do not** hand-edit \`.repoboard/STATE.md\`.`;

describe('setStateSection: multi-line body round-trip pin (C1)', () => {
  it('a markdown table + bullets + nested bullet + bold/backticks round-trips byte-identical', () => {
    const before = initialStateText({ now: new Date('2026-09-18T09:00:00Z'), actor: 'claude/ops' });
    const parsedBefore = parseState(before);
    expect(parsedBefore.ok).toBe(true);
    if (!parsedBefore.ok) return;

    const res = setStateSection(before, 'live', LANE_LIVE_BODY, { now: NOW, actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const parsedAfter = parseState(res.text);
    expect(parsedAfter.ok).toBe(true);
    if (!parsedAfter.ok) return;

    // The pin: the LIVE body — table, pipes, |---| row, bullets, nested-bullet leading spaces,
    // bold and backticks all intact — comes back byte-identical.
    expect(parsedAfter.doc.sections.live).toBe(LANE_LIVE_BODY.trim());
    // The other two sections' bytes are untouched by a write to a third section.
    expect(parsedAfter.doc.sections.lastLandings).toBe(parsedBefore.doc.sections.lastLandings);
    expect(parsedAfter.doc.sections.seats).toBe(parsedBefore.doc.sections.seats);
  });

  it('control: the pin is sensitive — a body missing one pipe does not round-trip to the original', () => {
    const before = initialStateText({ now: new Date('2026-09-18T09:00:00Z'), actor: 'claude/ops' });
    // Remove exactly one pipe from the second table row.
    const perturbed = LANE_LIVE_BODY.replace(
      '| repoboard-tree | claude/p8-6 | 12:10Z-12:40Z closed |',
      '| repoboard-tree  claude/p8-6 | 12:10Z-12:40Z closed |',
    );
    expect(perturbed).not.toBe(LANE_LIVE_BODY); // the perturbation itself applied

    const res = setStateSection(before, 'live', perturbed, { now: NOW, actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsedAfter = parseState(res.text);
    expect(parsedAfter.ok).toBe(true);
    if (!parsedAfter.ok) return;

    // A round-trip of the PERTURBED body must not equal the ORIGINAL correct body — proving the
    // pin above would actually catch this corruption rather than passing vacuously.
    expect(parsedAfter.doc.sections.live).not.toBe(LANE_LIVE_BODY);
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

  it('NOT stale when the stamp and the log mtime fall in the same second — the stamp has second resolution, mtime has ms', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T18:00:00Z') + 850, blocks: [] }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([]);
  });

  it('stale when the log mtime is in the NEXT second after the stamp', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T18:00:01Z'), blocks: [] }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.map((f) => f.kind)).toEqual(['stale-state']);
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

  it('NOT stale when the newest ##### header time EQUALS the stamp to the second', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const blocks: LogBlock[] = [{ seat: 'OPS', ts: '2026-09-17T18:00:00Z', title: 'x', text: 'y' }];
    const findings = checkFindings({
      state,
      // mtime does not exceed the header's second either, so only the header-equals-stamp case
      // is under test.
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T18:00:00Z'), blocks }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(false);
  });

  it('stale when the newest ##### header time is one second AFTER the stamp', () => {
    const state = stateAt('2026-09-17T18:00:00Z');
    const blocks: LogBlock[] = [{ seat: 'OPS', ts: '2026-09-17T18:00:01Z', title: 'x', text: 'y' }];
    const findings = checkFindings({
      state,
      // mtime is OLDER than the state stamp, so only the header time can trigger this.
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

  it('future-stamp: a block stamped 5 min ahead of the clock is ignored for stale-state and reported as a warning (RCB-90)', () => {
    const state = stateAt('2026-09-17T21:00:00Z'); // == NOW
    const blocks: LogBlock[] = [
      { seat: 'BUILDER', ts: '2026-09-17T21:05:00Z', title: 'x', text: 'y' },
    ];
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T20:00:00Z'), blocks }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    // This is the control: with the future-stamp ignore reverted in `newestLogMoment`, the block's
    // 21:05:00 header becomes "newest" against a 21:00:00 stamp, and this assertion fails.
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(false);
    const future = findings.filter((f) => f.kind === 'future-stamp');
    expect(future).toHaveLength(1);
    expect(future[0]?.level).toBe('warning');
    expect(future[0]?.message).toContain('2026-09-17');
    expect(future[0]?.message).toContain('BUILDER 2026-09-17T21:05:00Z');
    expect(future[0]?.message).toContain('300 s ahead');
  });

  it('future-stamp does not swallow real staleness (RCB-90)', () => {
    const state = stateAt('2026-09-17T20:50:00Z'); // 10 min before NOW
    const blocks: LogBlock[] = [
      { seat: 'OPS', ts: '2026-09-17T20:55:00Z', title: 'x', text: 'y' }, // 5 min before NOW
    ];
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T20:50:00Z'), blocks }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'stale-state')).toBe(true);
    expect(findings.some((f) => f.kind === 'future-stamp')).toBe(false);
  });

  it('future-stamp respects the 60s tolerance: a block 30s ahead is not a future-stamp and compares normally', () => {
    const state = stateAt('2026-09-17T21:00:00Z'); // == NOW
    const blocks: LogBlock[] = [
      { seat: 'OPS', ts: '2026-09-17T21:00:30Z', title: 'x', text: 'y' }, // 30s ahead of NOW
    ];
    const findings = checkFindings({
      state,
      logs: [{ date: '2026-09-17', mtimeMs: Date.parse('2026-09-17T20:00:00Z'), blocks }],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'future-stamp')).toBe(false);
    // within tolerance, so it counts toward "newest" like any other header — the STATE stamp
    // (21:00:00) is 30 real seconds behind it, so stale-state fires normally.
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

describe(
  'seat-owner-queue-drift (RCB-130, owner: fpj STATE.md 2026-09-25 01:56Z — a coordinator ' +
    'bullet hand-typed "OWNER QUEUE = FPJ-86, FPJ-119" 3.5 h stale)',
  () => {
    const config = defaultBoardConfig();

    it('a bullet with no OWNER QUEUE text at all: nothing', () => {
      const bullets = [{ name: 'coordinator', text: '- **coordinator**: routes work' }];
      expect(seatOwnerQueueDriftFindings(bullets, ['RCB-1'])).toEqual([]);
    });

    it('OWNER QUEUE mentioned but with no id-shaped token (e.g. "none"): nothing — there is no LIST to compare', () => {
      const bullets = [{ name: 'coordinator', text: 'owes: OWNER QUEUE = none' }];
      expect(seatOwnerQueueDriftFindings(bullets, [])).toEqual([]);
      expect(seatOwnerQueueDriftFindings(bullets, ['RCB-1'])).toEqual([]);
    });

    it('the hand-typed set EQUALS the generated set: nothing', () => {
      const bullets = [{ name: 'coordinator', text: 'owes: OWNER QUEUE = FPJ-86, FPJ-119' }];
      expect(seatOwnerQueueDriftFindings(bullets, ['FPJ-86', 'FPJ-119'])).toEqual([]);
    });

    it('same set, different order: still nothing — the comparison is order-insensitive', () => {
      const bullets = [{ name: 'coordinator', text: 'owes: OWNER QUEUE = FPJ-86, FPJ-119' }];
      expect(seatOwnerQueueDriftFindings(bullets, ['FPJ-119', 'FPJ-86'])).toEqual([]);
    });

    it(
      'REPRODUCTION: the hand-typed set has an id (FPJ-86) the generated queue no longer has ' +
        '(decided) — one warning-grade finding, the exact message',
      () => {
        const bullets = [
          { name: 'coordinator', text: 'stood down\nowes: RCB-1 OWNER QUEUE = FPJ-86, FPJ-119' },
        ];
        const findings = seatOwnerQueueDriftFindings(bullets, ['FPJ-119']);
        expect(findings).toEqual([
          {
            kind: 'seat-owner-queue-drift',
            level: 'warning',
            message:
              'seat-owner-queue-drift: coordinator bullet says OWNER QUEUE = FPJ-86, FPJ-119; ' +
              'generated: FPJ-119 — seats print open decisions; drop the hand line',
          },
        ]);
      },
    );

    it('the generated queue is empty: message says "generated: none"', () => {
      const bullets = [{ name: 'ops', text: 'owes: OWNER QUEUE = RCB-9' }];
      const findings = seatOwnerQueueDriftFindings(bullets, []);
      expect(findings[0]?.message).toContain('generated: none');
    });

    it('one finding per bullet — only the drifting bullet fires, the matching one does not', () => {
      const bullets = [
        { name: 'coordinator', text: 'owes: OWNER QUEUE = RCB-1' }, // drifted
        { name: 'ops', text: 'owes: OWNER QUEUE = RCB-1, RCB-2' }, // matches
      ];
      const findings = seatOwnerQueueDriftFindings(bullets, ['RCB-1', 'RCB-2']);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('coordinator bullet');
    });

    it('wired into checkFindings via CheckInput.seatBullets — warning-grade: blocks only with --strict', () => {
      const state = stateAt('2026-09-17T21:00:00Z');
      const findings = checkFindings({
        state,
        logs: [],
        cards: [askedCard('FPJ-119', 'q', ['A'])],
        config,
        leases: emptyLeases(),
        now: NOW,
        seatBullets: [{ name: 'coordinator', text: 'owes: OWNER QUEUE = FPJ-86, FPJ-119' }],
      });
      const drift = findings.filter((f) => f.kind === 'seat-owner-queue-drift');
      expect(drift).toHaveLength(1);
      expect(drift[0]?.level).toBe('warning');
      expect(exitCodeForFindings(findings, false)).toBe(0);
      expect(exitCodeForFindings(findings, true)).toBe(1);
    });

    it('CheckInput.seatBullets absent (older caller, or none gathered): inert, never a finding', () => {
      const state = stateAt('2026-09-17T21:00:00Z');
      const findings = checkFindings({
        state,
        logs: [],
        cards: [],
        config,
        leases: emptyLeases(),
        now: NOW,
      });
      expect(findings.some((f) => f.kind === 'seat-owner-queue-drift')).toBe(false);
    });
  },
);

describe('checkFindings: local (RCB-83)', () => {
  const config = defaultBoardConfig();
  const state = stateAt('2026-09-17T21:00:00Z');

  function base() {
    return {
      state,
      logs: [],
      cards: [],
      config,
      leases: emptyLeases(),
      now: NOW,
    };
  }

  it('absent local: no finding — an unconfigured local layer is inert, not dangerous', () => {
    const findings = checkFindings(base());
    expect(findings).toEqual([]);
  });

  it('null local: no finding, same as absent', () => {
    const findings = checkFindings({ ...base(), local: null });
    expect(findings).toEqual([]);
  });

  it('not yet a git repo (isRepo false): no finding, even if the other fields look alarming', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: false, hasRemote: false, dirty: true, ahead: 3 },
    });
    expect(findings).toEqual([]);
  });

  it('clean, no remote: local-no-remote only, informational', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: false, dirty: false, ahead: null },
    });
    expect(findings).toEqual([
      {
        kind: 'local-no-remote',
        level: 'info',
        message: 'local: no remote — repoboard local init --remote <url>',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(0);
  });

  it('dirty, has remote: local-unsynced (uncommitted), warning — blocks only with --strict', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: true, dirty: true, ahead: 0 },
    });
    expect(findings).toEqual([
      {
        kind: 'local-unsynced',
        level: 'warning',
        message: 'local: uncommitted changes in .repoboard/local/ — repoboard local sync',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(1);
  });

  it('clean but ahead of origin: local-unsynced (ahead) names the count', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: true, dirty: false, ahead: 2 },
    });
    expect(findings).toEqual([
      {
        kind: 'local-unsynced',
        level: 'warning',
        message: 'local: 2 ahead of origin — repoboard local sync',
      },
    ]);
  });

  it('clean, zero ahead, has remote: no finding at all', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: true, dirty: false, ahead: 0 },
    });
    expect(findings).toEqual([]);
  });

  it('dirty AND no remote: both findings fire', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: false, dirty: true, ahead: null },
    });
    expect(findings.map((f) => f.kind).sort()).toEqual(['local-no-remote', 'local-unsynced']);
  });

  // RCB-128: an opt-out ack (`local.yml`: `remote: none`) silences local-no-remote; without it
  // the line still prints — a forgotten backup is still caught.
  it('acked, no remote: local-no-remote is absent', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: false, dirty: false, ahead: null, remoteAck: true },
    });
    expect(findings).toEqual([]);
  });

  it('not acked, no remote: local-no-remote still present (the control for the case above)', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: false, dirty: false, ahead: null, remoteAck: false },
    });
    expect(findings.map((f) => f.kind)).toEqual(['local-no-remote']);
  });

  it('remote AND ack: local-no-remote absent either way — a remote alone already silences it', () => {
    const findings = checkFindings({
      ...base(),
      local: { isRepo: true, hasRemote: true, dirty: false, ahead: 0, remoteAck: true },
    });
    expect(findings).toEqual([]);
  });
});

describe('checkFindings: needs-ask (RCB-69, FPJ-28)', () => {
  const config = defaultBoardConfig(); // decide{decision:true}

  it('fires for a never-asked card sitting in a decision:true column', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = sampleCard({ id: 'RB-30', status: 'decide', decision: undefined });
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
        kind: 'needs-ask',
        level: 'warning',
        message:
          'needs-ask: RB-30 is in "decide" with no open ask (repoboard card ask RB-30 ' +
          '"<question>" [--option "A <text>"]... | --task)',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(1);
  });

  it('fires for a DECIDED card sitting in a decision:true column — the FPJ-28 case', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = askedCard('RCB-40', 'sync-issues column?', ['A', 'B']);
    const decided: Card = {
      ...card,
      status: 'decide', // moved back into decide with no open ask, exactly FPJ-28
      decision: {
        ...(card.decision as NonNullable<Card['decision']>),
        chosen: 'A',
        decidedBy: 'human/matt',
        decidedAt: '2026-09-17T19:09:00Z',
      },
    };
    const findings = checkFindings({
      state,
      logs: [],
      cards: [decided],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === 'needs-ask')).toEqual([
      {
        kind: 'needs-ask',
        level: 'warning',
        message:
          'needs-ask: RCB-40 is in "decide" with no open ask (repoboard card ask RCB-40 ' +
          '"<question>" [--option "A <text>"]... | --task)',
      },
    ]);
  });

  it('does not fire for an OPEN ask in a decision:true column', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = askedCard('RCB-41', 'ship now?', ['A']);
    const findings = checkFindings({
      state,
      logs: [],
      cards: [card],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'needs-ask')).toBe(false);
  });

  it('does not fire for a decided card outside a decision:true column', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const card = decidedCard(); // status 'todo' (sampleCard default), no decision block
    const findings = checkFindings({
      state,
      logs: [],
      cards: [card],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'needs-ask')).toBe(false);
  });
});

describe('checkFindings: gated-steps (RCB-68)', () => {
  const config = defaultBoardConfig();

  it('fires an info finding, count and message, when N cards are blocked', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const gateTarget = sampleCard({ id: 'RB-9', status: 'todo', decision: undefined });
    const blocked = sampleCard({ id: 'RB-10', status: 'todo', decision: undefined, gate: 'RB-9' });
    const findings = checkFindings({
      state,
      logs: [],
      cards: [gateTarget, blocked],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([
      {
        kind: 'gated-steps',
        level: 'info',
        message: 'gated-steps: 1 card blocked on a gate (repoboard card list shows BLOCKED)',
      },
    ]);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(0);
  });

  it('pluralizes for more than one', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const blockedA = sampleCard({ id: 'RB-10', status: 'todo', decision: undefined, gate: 'x' });
    const blockedB = sampleCard({ id: 'RB-11', status: 'todo', decision: undefined, gate: 'y' });
    const findings = checkFindings({
      state,
      logs: [],
      cards: [blockedA, blockedB],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings).toEqual([
      {
        kind: 'gated-steps',
        level: 'info',
        message: 'gated-steps: 2 cards blocked on a gate (repoboard card list shows BLOCKED)',
      },
    ]);
  });

  it('absent at zero blocked cards, and never changes the exit code', () => {
    const state = stateAt('2026-09-17T21:00:00Z');
    const clear = sampleCard({ id: 'RB-5', status: 'todo', decision: undefined });
    const findings = checkFindings({
      state,
      logs: [],
      cards: [clear],
      config,
      leases: emptyLeases(),
      now: NOW,
    });
    expect(findings.some((f) => f.kind === 'gated-steps')).toBe(false);
    // Even a stale-lease (error-grade) alongside a gated step keeps exitCode governed only by
    // the error, never by gated-steps — this is a separate check from the "absent" one above,
    // but stays here to keep both facts about the finding's grade together.
    const leases = {
      leases: [
        {
          resource: 'r',
          holder: 'h',
          since: '2026-09-17T10:00:00Z',
          until: '2026-09-17T11:00:00Z',
        },
      ],
      windows: [],
    };
    const withStaleLease = checkFindings({
      state,
      logs: [],
      cards: [sampleCard({ id: 'RB-10', status: 'todo', decision: undefined, gate: 'z' })],
      config,
      leases,
      now: NOW,
    });
    expect(withStaleLease.some((f) => f.kind === 'gated-steps')).toBe(true);
    expect(exitCodeForFindings(withStaleLease, true)).toBe(1); // from stale-lease, not gated-steps
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

describe('systems findings (RCB-97)', () => {
  const config = defaultBoardConfig();
  const base = {
    state: stateAt('2026-09-17T21:00:00Z'),
    logs: [],
    cards: [],
    config,
    leases: emptyLeases(),
    now: NOW,
  };

  it('input.systems absent — no systems-* finding', () => {
    const findings = checkFindings(base);
    expect(findings.some((f) => f.kind === 'systems-invalid' || f.kind === 'systems-stale')).toBe(
      false,
    );
  });

  it('input.systems null — no systems-* finding (unconfigured is inert)', () => {
    const findings = checkFindings({ ...base, systems: null });
    expect(findings.some((f) => f.kind === 'systems-invalid' || f.kind === 'systems-stale')).toBe(
      false,
    );
  });

  it('1 parse error — exact message, error level', () => {
    const findings = systemsFindings({ errors: ['bad row'], stale: [] });
    expect(findings).toEqual([
      {
        kind: 'systems-invalid',
        level: 'error',
        message: 'systems-invalid: .repoboard/systems.yml: bad row',
      },
    ]);
  });

  it('1 parse error via checkFindings — exitCodeForFindings 1 without --strict', () => {
    const findings = checkFindings({ ...base, systems: { errors: ['bad row'], stale: [] } });
    expect(findings).toContainEqual({
      kind: 'systems-invalid',
      level: 'error',
      message: 'systems-invalid: .repoboard/systems.yml: bad row',
    });
    expect(exitCodeForFindings(findings, false)).toBe(1);
  });

  it('3 parse errors — message names only the first, "(+2 more)" for the rest', () => {
    const findings = systemsFindings({ errors: ['first', 'second', 'third'], stale: [] });
    expect(findings).toEqual([
      {
        kind: 'systems-invalid',
        level: 'error',
        message: 'systems-invalid: .repoboard/systems.yml: first (+2 more)',
      },
    ]);
  });

  it('2 stale detected ids — exact warning message', () => {
    const findings = systemsFindings({ errors: [], stale: ['worker', 'sendgrid'] });
    expect(findings).toEqual([
      {
        kind: 'systems-stale',
        level: 'warning',
        message:
          'systems-stale: 2 detected row(s) no longer yielded by their source: worker, sendgrid',
      },
    ]);
  });

  it('stale-only via checkFindings — exit 0 without --strict, 1 with --strict', () => {
    const findings = checkFindings({
      ...base,
      systems: { errors: [], stale: ['worker', 'sendgrid'] },
    });
    expect(findings.some((f) => f.kind === 'systems-stale')).toBe(true);
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(1);
  });
});

describe('checkFindings: untracked-cards (RCB-119)', () => {
  const config = defaultBoardConfig();
  const base = {
    state: stateAt('2026-09-17T21:00:00Z'),
    logs: [],
    cards: [],
    config,
    leases: emptyLeases(),
    now: NOW,
  };

  it('empty list — no finding', () => {
    const findings = checkFindings({ ...base, untrackedCards: [] });
    expect(findings.some((f) => f.kind === 'untracked-cards')).toBe(false);
  });

  it('null — no finding, same as absent (not a git repo, or ungathered)', () => {
    const withNull = checkFindings({ ...base, untrackedCards: null });
    const withoutField = checkFindings(base);
    expect(withNull.some((f) => f.kind === 'untracked-cards')).toBe(false);
    expect(withoutField.some((f) => f.kind === 'untracked-cards')).toBe(false);
  });

  it('2 ids — one warning naming both ids and actors', () => {
    const findings = checkFindings({
      ...base,
      untrackedCards: [
        { id: 'RB-5', actor: 'web' },
        { id: 'RB-6', actor: 'web' },
      ],
    });
    expect(findings).toContainEqual({
      kind: 'untracked-cards',
      level: 'warning',
      message: 'untracked-cards: 2 card file(s) not in git — RB-5 (web), RB-6 (web)',
    });
  });

  it('12 ids — lists the first 10, then "…+2 more"', () => {
    const untrackedCards = Array.from({ length: 12 }, (_, i) => ({
      id: `RB-${i + 1}`,
      actor: 'web',
    }));
    const findings = checkFindings({ ...base, untrackedCards });
    const shownIds = untrackedCards
      .slice(0, 10)
      .map((c) => `${c.id} (${c.actor})`)
      .join(', ');
    expect(findings).toContainEqual({
      kind: 'untracked-cards',
      level: 'warning',
      message: `untracked-cards: 12 card file(s) not in git — ${shownIds}, …+2 more`,
    });
  });

  it('actor null — rendered as "?"', () => {
    const findings = checkFindings({
      ...base,
      untrackedCards: [{ id: 'RB-9', actor: null }],
    });
    expect(findings).toContainEqual({
      kind: 'untracked-cards',
      level: 'warning',
      message: 'untracked-cards: 1 card file(s) not in git — RB-9 (?)',
    });
  });

  it('with the finding present: exitCodeForFindings is 0 without --strict, 1 with --strict', () => {
    const findings = checkFindings({
      ...base,
      untrackedCards: [{ id: 'RB-5', actor: 'web' }],
    });
    expect(exitCodeForFindings(findings, false)).toBe(0);
    expect(exitCodeForFindings(findings, true)).toBe(1);
  });
});

describe('splitLandings / trimLandings (RCB-92)', () => {
  // 4 entries: a 2-line preamble (stays attached to entry 1), entry 1 is multi-line with a
  // nested `- ` bullet (fpj's `-38. **K101…` shape), entry 2 is the `0. ` style, entries 3–4 are
  // the plain `1. `/`2. ` style. Blank-line separated, exactly as `.repoboard/STATE.md` renders.
  const body = [
    'Some preamble line one.',
    'Some preamble line two.',
    '',
    '-38. **K101 fixed the thing**',
    '    - detail bullet under it',
    '    more text on the same entry',
    '',
    '0. K117 voice stuff landed',
    '',
    '1. Lane scripts landed',
    '',
    '2. Something else landed',
  ].join('\n');

  it('splitLandings finds 4 entries, preamble attached to the first', () => {
    const entries = splitLandings(body);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toContain('Some preamble line one.');
    expect(entries[0]).toContain('Some preamble line two.');
    expect(entries[0]).toContain('-38. **K101 fixed the thing**');
    expect(entries[0]).toContain('- detail bullet under it');
    expect(entries[1]).toBe('0. K117 voice stuff landed');
    expect(entries[2]).toBe('1. Lane scripts landed');
    expect(entries[3]).toBe('2. Something else landed');
  });

  it('SECTION_PLACEHOLDER splits to no entries', () => {
    expect(splitLandings(SECTION_PLACEHOLDER)).toEqual([]);
  });

  it('a body with no start line is one entry', () => {
    expect(splitLandings('just prose, no numbered entries')).toEqual([
      'just prose, no numbered entries',
    ]);
  });

  it('trimLandings(body, 2): kept has 2, archived has the other 2 verbatim, invariant holds', () => {
    const { kept, archived } = trimLandings(body, 2);
    expect(splitLandings(kept)).toHaveLength(2);
    expect(archived).toHaveLength(2);
    expect(archived[0]).toBe('1. Lane scripts landed');
    expect(archived[1]).toBe('2. Something else landed');
    // Invariant: nothing lost, nothing reordered.
    expect([...splitLandings(kept), ...archived].join('\n\n')).toBe(body.trim());
  });

  it('keep=10 (more than the entry count): archived is empty, kept is everything', () => {
    const { kept, archived } = trimLandings(body, 10);
    expect(archived).toEqual([]);
    expect(splitLandings(kept)).toHaveLength(4);
  });

  it('keep=0: archived is every entry, kept is empty', () => {
    const { kept, archived } = trimLandings(body, 0);
    expect(kept).toBe('');
    expect(archived).toHaveLength(4);
  });

  it('keep < 0 throws a plain Error', () => {
    expect(() => trimLandings(body, -1)).toThrow(Error);
  });
});
