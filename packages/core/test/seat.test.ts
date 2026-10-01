/**
 * RCB-48: `seat.ts` — the cold-start bundle. `findSeatLine`'s whole-word bullet match,
 * `seatBundle`'s next-card and coordinator-omission rules, `renderSeatBundle`'s fixed sections
 * with placeholders for every missing part.
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { type SeatLeaseView, seatHolderInfos } from '../src/holder.js';
import {
  checkDownFields,
  checkFieldCounts,
  describeSeatUpConflict,
  findSeatLine,
  formatSeatBullet,
  keySeatBullets,
  listSeats,
  normalizeSeatName,
  parseSeatFields,
  parseSeatHolderLabel,
  parseSeatStamp,
  renderSeatBundle,
  renderSeatList,
  replaceSeatBullet,
  rewriteSeatBulletBody,
  type SeatBundle,
  type SeatSighting,
  seatBulletTexts,
  seatBundle,
  seatLabel,
  seatListRows,
  seatSightings,
  seatUpConflict,
} from '../src/seat.js';
import { SECTION_PLACEHOLDER } from '../src/state.js';
import type { SystemsSummary } from '../src/systems-surface.js';
import type { Card, LeasesDoc } from '../src/types.js';

const NOW = new Date('2026-09-18T21:00:00Z');

const SEATS = [
  '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1',
  '  continuation line here',
  '- **ops**: watching things',
  '- **coordinator**: routes work',
].join('\n');

function card(overrides: Partial<Card> & { id: string }): Card {
  return {
    title: 'a card',
    status: 'todo',
    created: '2026-09-18T20:00:00Z',
    updated: '2026-09-18T20:00:00Z',
    body: '',
    ...overrides,
  };
}

describe('findSeatLine', () => {
  it('matches the bullet whose first line contains name as a whole word (a)', () => {
    const line = findSeatLine(SEATS, 'builder');
    expect(line).not.toBeNull();
    expect(line?.startsWith('- **repoboard builder')).toBe(true);
  });

  it('matches the coordinator bullet (b)', () => {
    const line = findSeatLine(SEATS, 'coordinator');
    expect(line).toBe('- **coordinator**: routes work');
  });

  it('"ordinator" matches nothing — whole word only (c)', () => {
    expect(findSeatLine(SEATS, 'ordinator')).toBeNull();
  });

  it('keeps continuation lines in the returned bullet text', () => {
    const line = findSeatLine(SEATS, 'builder');
    expect(line).toContain('continuation line here');
    expect(line).toBe(
      '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1\n  continuation line here',
    );
  });

  it('a placeholder section (no "- " line) yields null', () => {
    expect(findSeatLine(SECTION_PLACEHOLDER, 'builder')).toBeNull();
  });

  it('no match anywhere yields null', () => {
    expect(findSeatLine(SEATS, 'nonexistent')).toBeNull();
  });
});

describe('findSeatLine: label pass (RCB-48 dogfood fix, 2026-09-18 21:07Z)', () => {
  // This repo's real SEATS shape: the coordinator's bullet is prose-heavy and genuinely says
  // "the builder's" and "each builder" — whole-word "builder" hits, in the FIRST bullet, ahead of
  // the actual builder bullet. The label pass must see past that.
  const REAL_SHAPE = [
    '- **coordinator (shared with acme): UP 2026-09-18 20:2xZ, cold-started from ' +
      'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
      "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
      'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
      'card, restamp.',
    '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
  ].join('\n');

  it("C4 (control): `builder` returns the actual builder bullet, not the coordinator's prose mention", () => {
    const line = findSeatLine(REAL_SHAPE, 'builder');
    expect(line).toBe(
      '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
    );
  });

  it('fallback: a plain "label: text" bullet with no bold still matches on the label', () => {
    expect(findSeatLine('- ops: on the run', 'ops')).toBe('- ops: on the run');
  });
});

/**
 * RCB-168: pass 2 of `locateSeatBullet` (name anywhere in the first line) is for LEGACY unstamped
 * bullets only. On the workspace board the ONLY bullet is the coordinator's, stamped, and its
 * prose says "[repoboard] builder told to stand down" — a seat with no bullet of its own (`builder`)
 * used to get THAT bullet back from `findSeatLine` and have it REPLACED by `replaceSeatBullet`.
 * Control: restore pass 2 to `wordRe.test(stripBulletRepoPrefix(firstLine))` with no
 * `parseSeatStamp` skip and the `findSeatLine`, `replaceSeatBullet` and mixed-board tests below
 * fail; the coordinator-own-bullet and legacy-intent tests pass either way (they guard the
 * label pass and the legacy pass 2 against an over-correction).
 */
describe('RCB-168: a seat with no bullet never takes over a stamped bullet that merely mentions it', () => {
  const COORD_BULLET = [
    '- **[workspace] coordinator: UP 2026-09-27 23:14Z.** UP 23:14Z, cold-started from SEATS. ' +
      '[repoboard] builder told to stand down after RCB-160 slice 2; [acme] ops still watching.',
    '  in-flight: sonnet RCB-160 slice 3 (workspace view)',
    '  owes: verify RCB-160 by content on origin/main; restamp',
  ].join('\n');

  it('findSeatLine: `builder` finds nothing — the only bullet is the coordinator\'s, stamped, and names "builder" only in its prose', () => {
    expect(findSeatLine(COORD_BULLET, 'builder')).toBeNull();
    // Another seat merely mentioned in the prose is equally not owned by this bullet.
    expect(findSeatLine(COORD_BULLET, 'ops')).toBeNull();
  });

  it('replaceSeatBullet (the `--down` path): APPENDS a new builder bullet; the coordinator bullet is byte-identical afterwards', () => {
    const down = formatSeatBullet(
      'builder',
      'DOWN',
      'standing down',
      new Date('2026-09-29T10:00:00Z'),
      'workspace',
    );
    const result = replaceSeatBullet(COORD_BULLET, 'builder', down);
    expect(result).toBe(`${COORD_BULLET}\n${down}`);
    expect(result.startsWith(COORD_BULLET)).toBe(true);
    // Both bullets are now addressable, each by its own label.
    expect(findSeatLine(result, 'coordinator')).toBe(COORD_BULLET);
    expect(findSeatLine(result, 'builder')).toBe(down);
  });

  it('the coordinator still finds and replaces its OWN bullet on that board (label pass unchanged)', () => {
    expect(findSeatLine(COORD_BULLET, 'coordinator')).toBe(COORD_BULLET);
    const fresh = formatSeatBullet(
      'coordinator',
      'UP',
      'restamped',
      new Date('2026-09-29T10:00:00Z'),
      'workspace',
    );
    expect(replaceSeatBullet(COORD_BULLET, 'coordinator', fresh)).toBe(fresh);
  });

  it('legacy intent kept: an UNSTAMPED bullet whose label misses the name but whose first line mentions it is still found by pass 2', () => {
    const section = [
      '- **night crew**: builder holds RCB-9',
      '- **coordinator**: routes work',
    ].join('\n');
    expect(findSeatLine(section, 'builder')).toBe('- **night crew**: builder holds RCB-9');
    expect(replaceSeatBullet(section, 'builder', 'X')).toBe(
      ['X', '- **coordinator**: routes work'].join('\n'),
    );
  });

  it('mixed board: pass 2 skips the stamped bullet and lands on the unstamped legacy one behind it', () => {
    const section = [COORD_BULLET, '- **night crew**: builder holds RCB-9'].join('\n');
    expect(findSeatLine(section, 'builder')).toBe('- **night crew**: builder holds RCB-9');
  });
});

/**
 * RCB-196: `locateSeatBullet`'s pass 1 is an EXACT match on the bullet's own seat name (stamped:
 * `SEAT_BULLET_RE` group 2; unstamped: `bulletLabel`), so `builder` no longer owns `builder-2`
 * (`-` is a `\b` boundary), `web builder` or the `UP`/date/holder words of anyone's stamp.
 * Control: restore the whole function to `\b<name>\b` over `bulletLabel` for every bullet and (a),
 * (b) and (c) fail — (a) returns builder-2's bullet, (b) returns the `web builder` bullet, (c) hits
 * the stamp's `UP`/`2026`/`rcb` — while (d) and (e) pass either way (they guard the exact pass's
 * folding and the legacy passes against an over-correction). (f) and (g) pin the RCB-172 heal case:
 * a stamped bullet's name goes through `normalizeSeatName` with its OWN `[repo]` prefix as the
 * board, so `[repoboard] repoboard builder` is `builder` (f) but `[repoboard] repoboard builder-2`
 * and an unprefixed `repoboard builder` are not (g); drop that normalization and (f) fails.
 */
describe('RCB-196: exact seat-name match', () => {
  const B2 = '- **[r] builder-2: UP 2026-09-30 01:00Z · 1D3F · rcb builder-2.** on RCB-9';
  const B1 = '- **[r] builder: UP 2026-09-30 01:05Z.** on RCB-8';

  it('(a) `builder` is the builder bullet even when builder-2 comes first; the builder-2 bullet is byte-identical after a replace', () => {
    const section = [B2, B1].join('\n');
    expect(findSeatLine(section, 'builder')).toBe(B1);
    expect(findSeatLine(section, 'builder-2')).toBe(B2);

    const down = formatSeatBullet(
      'builder',
      'DOWN',
      'standing down',
      new Date('2026-09-30T02:00:00Z'),
      'r',
    );
    const result = replaceSeatBullet(section, 'builder', down);
    expect(result).toBe([B2, down].join('\n'));
    expect(result.startsWith(B2)).toBe(true);
  });

  it('(a) with only a builder-2 bullet, `builder` finds nothing and a replace appends', () => {
    expect(findSeatLine(B2, 'builder')).toBeNull();
    const up = formatSeatBullet('builder', 'UP', 'x', new Date('2026-09-30T02:00:00Z'), 'r');
    expect(replaceSeatBullet(B2, 'builder', up)).toBe([B2, up].join('\n'));
  });

  it('(b) a stamped `web builder` bullet is not `builder`: find is null, replace appends', () => {
    const web = '- **[r] web builder: UP 2026-09-30 01:00Z.** on the dashboard';
    expect(findSeatLine(web, 'builder')).toBeNull();
    const up = formatSeatBullet('builder', 'UP', 'x', new Date('2026-09-30T02:00:00Z'), 'r');
    const result = replaceSeatBullet(web, 'builder', up);
    expect(result).toBe([web, up].join('\n'));
    expect(findSeatLine(web, 'web builder')).toBe(web);
  });

  it("(c) words of the stamp — status, date, holder label, the board's short name — are not a seat name", () => {
    const bullet = '- **builder: UP 2026-09-30 01:00Z · 1D3F · rcb builder.** x';
    for (const word of ['up', 'UP', '2026', '2026-09-30', '1D3F', 'rcb', 'rcb builder', 'z']) {
      expect(findSeatLine(bullet, word), word).toBeNull();
    }
    expect(findSeatLine(bullet, 'builder')).toBe(bullet);
  });

  it('(d) the typed name is folded — case, edge and inner whitespace — the bullet is not rewritten', () => {
    const down = '- **[r] builder: DOWN 2026-09-30 01:00Z.** in-flight: none';
    expect(findSeatLine(down, '  Builder ')).toBe(down);
    expect(findSeatLine(down, 'BUILDER')).toBe(down);
    const spaced = '- **[r] web  builder: UP 2026-09-30 01:00Z.** x';
    expect(findSeatLine(spaced, 'Web   Builder')).toBe(spaced);
    expect(findSeatLine(spaced, 'webbuilder')).toBeNull();
  });

  it('(e) legacy kept: an unstamped `- **builder (own terminal)**: x` is found by `builder`; an unstamped `rebuilder` is not', () => {
    const own = '- **builder (own terminal)**: x';
    expect(findSeatLine(own, 'builder')).toBe(own);
    expect(replaceSeatBullet(own, 'builder', 'X')).toBe('X');
    const re = '- **rebuilder**: x';
    expect(findSeatLine(re, 'builder')).toBeNull();
    expect(replaceSeatBullet(re, 'builder', 'X')).toBe(`${re}\nX`);
  });

  it('(e) an exact unstamped label beats an earlier unstamped legacy hit', () => {
    const section = ['- **builder (own terminal)**: x', '- **builder**: y'].join('\n');
    expect(findSeatLine(section, 'builder')).toBe('- **builder**: y');
  });

  it('(f) RCB-172 heal case: a stamped `[repoboard] repoboard builder` bullet is found by `builder` and REPLACED, never appended beside', () => {
    const legacy = '- **[repoboard] repoboard builder: UP 2026-09-02 22:41Z.** old';
    const coord = '- **[repoboard] coordinator: UP 2026-09-02 22:00Z.** routing';
    expect(findSeatLine(legacy, 'builder')).toBe(legacy);
    // The board word is folded case-insensitively, exactly as `normalizeSeatName` does.
    const cased = '- **[Repoboard] repoboard builder: UP 2026-09-02 22:41Z.** old';
    expect(findSeatLine(cased, 'builder')).toBe(cased);

    const fresh = formatSeatBullet(
      'builder',
      'UP',
      'new',
      new Date('2026-09-02T23:26:00Z'),
      'repoboard',
    );
    expect(fresh).toBe('- **[repoboard] builder: UP 2026-09-02 23:26Z.** new');
    expect(replaceSeatBullet(legacy, 'builder', fresh)).toBe(fresh);
    expect(replaceSeatBullet([coord, legacy].join('\n'), 'builder', fresh)).toBe(
      [coord, fresh].join('\n'),
    );
  });

  it('(g) `[repoboard] repoboard builder-2` stamped is builder-2, not `builder`; an UNPREFIXED `repoboard builder` is not `builder` either', () => {
    const two = '- **[repoboard] repoboard builder-2: UP 2026-09-02 22:41Z.** other';
    expect(findSeatLine(two, 'builder')).toBeNull();
    expect(findSeatLine(two, 'builder-2')).toBe(two);
    const fresh = formatSeatBullet(
      'builder',
      'UP',
      'x',
      new Date('2026-09-02T23:26:00Z'),
      'repoboard',
    );
    expect(replaceSeatBullet(two, 'builder', fresh)).toBe([two, fresh].join('\n'));

    const bare = '- **repoboard builder: UP 2026-09-02 22:41Z.** old';
    expect(findSeatLine(bare, 'builder')).toBeNull();
    expect(findSeatLine(bare, 'repoboard builder')).toBe(bare);
  });

  it('a stamped exact match beats an earlier unstamped legacy hit; the legacy passes still find their own unstamped bullet next to a stamped one', () => {
    const legacy = '- **night crew**: builder holds RCB-9';
    expect(findSeatLine([legacy, B1].join('\n'), 'builder')).toBe(B1);
    expect(findSeatLine([B1, legacy].join('\n'), 'crew')).toBe(legacy);
  });
});

describe('seatBundle: nextCard', () => {
  it('C1: the card assigned to this seat wins over the first todo card in list order', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'builder', title: 'assigned to builder' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it('falls back to the first todo card (list order) when none is assigned to this seat', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'ops', title: 'assigned to someone else' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('first-todo');
  });

  it('no todo card at all: null, reason null', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'doing', title: 'in progress' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardReason).toBeNull();
  });

  it('the assignee match is case-insensitive', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'todo', assignee: 'BUILDER' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it(
    'RCB-57 B1 control fixture: an OLDER low-priority todo listed FIRST loses to a NEWER ' +
      'high-priority todo listed second (both unassigned)',
    () => {
      const cards: Card[] = [
        card({
          id: 'RCB-1',
          status: 'todo',
          priority: 'low',
          created: '2026-09-01T00:00:00Z',
          title: 'older, low priority',
        }),
        card({
          id: 'RCB-2',
          status: 'todo',
          priority: 'high',
          created: '2026-09-18T00:00:00Z',
          title: 'newer, high priority',
        }),
      ];
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: null,
        ownBlock: null,
        coordinatorBlock: null,
        cards,
      });
      expect(bundle.nextCard?.id).toBe('RCB-2');
      expect(bundle.nextCardReason).toBe('priority');
      const rendered = renderSeatBundle(bundle, NOW);
      expect(rendered).toContain('(first high-priority todo)');
    },
  );

  it('two `high` cards: the first in list order wins (stability)', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', priority: 'high', title: 'first high' }),
      card({ id: 'RCB-2', status: 'todo', priority: 'high', title: 'second high' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('a `medium` listed after an unset-priority card wins over it', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'unset priority, listed first' }),
      card({ id: 'RCB-2', status: 'todo', priority: 'medium', title: 'medium, listed second' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('a todo card assigned to ANOTHER seat is skipped even if high priority and listed first', () => {
    const cards: Card[] = [
      card({
        id: 'RCB-1',
        status: 'todo',
        priority: 'high',
        assignee: 'ops',
        title: 'high priority but assigned to ops',
      }),
      card({ id: 'RCB-2', status: 'todo', priority: 'low', title: 'low, unassigned' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('priority');
  });

  it('`assigned` still beats a higher-priority unassigned card', () => {
    const cards: Card[] = [
      card({
        id: 'RCB-1',
        status: 'todo',
        priority: 'high',
        title: 'high priority, unassigned',
      }),
      card({ id: 'RCB-2', status: 'todo', assignee: 'builder', title: 'assigned to builder' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-2');
    expect(bundle.nextCardReason).toBe('assigned');
  });

  it('nothing prioritised: reason is `first-todo`, render shows the no-priority string', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', title: 'first, unset' }),
      card({ id: 'RCB-2', status: 'todo', title: 'second, unset' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard?.id).toBe('RCB-1');
    expect(bundle.nextCardReason).toBe('first-todo');
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('(first todo; nothing assigned, nothing prioritised)');
  });

  it('renders the exact "Next card" lines for a `medium`-priority pick', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', priority: 'medium', title: 'the medium one' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('RCB-1  todo  the medium one\n(first medium-priority todo)');
  });
});

describe("seatBundle: nextCard follows a parent's steps (RCB-103)", () => {
  const config = defaultBoardConfig();

  it(
    '(1) parent in doing assigned to builder; PH.0 done, PH.1 gated on PH.0 (clear), PH.2 gated ' +
      'on PH.1 — Next = PH.1, reason parent-step, gateBy = "<PH.0 id> (done)"',
    () => {
      const cards: Card[] = [
        card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
        card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
        card({
          id: 'RCB-95',
          status: 'backlog',
          parent: 'RCB-80',
          phase: 'PH.1',
          gate: 'RCB-94',
          title: 'PH.1',
        }),
        card({
          id: 'RCB-96',
          status: 'backlog',
          parent: 'RCB-80',
          phase: 'PH.2',
          gate: 'RCB-95',
          title: 'PH.2',
        }),
        card({ id: 'RCB-97', status: 'todo', title: 'first todo, unassigned' }),
      ];
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: null,
        ownBlock: null,
        coordinatorBlock: null,
        cards,
        config,
      });
      expect(bundle.nextCard?.id).toBe('RCB-95');
      expect(bundle.nextCardReason).toBe('parent-step');
      expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: 'RCB-94 (done)' });
    },
  );

  it('(2) PH.1 blocked (gate on a backlog card) is skipped; PH.2 with no gate is picked, gateBy null', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-98', status: 'backlog', title: 'still backlog, blocks PH.1' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-98',
        title: 'PH.1',
      }),
      card({ id: 'RCB-96', status: 'backlog', parent: 'RCB-80', phase: 'PH.2', title: 'PH.2' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-96');
    expect(bundle.nextCardReason).toBe('parent-step');
    expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: null });
  });

  it('(3) every step done or blocked: falls through to the assigned todo card, as before', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-98', status: 'backlog', title: 'still backlog, blocks PH.1' }),
      card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-98',
        title: 'PH.1',
      }),
      card({ id: 'RCB-99', status: 'todo', assignee: 'builder', title: 'fallback todo' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-99');
    expect(bundle.nextCardReason).toBe('assigned');
    expect(bundle.nextCardStep).toBeNull();
  });

  it('(4) a clear step assigned to `ops` is skipped for `builder`; the next clear step wins', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        assignee: 'ops',
        title: 'PH.1, assigned to ops',
      }),
      card({ id: 'RCB-96', status: 'backlog', parent: 'RCB-80', phase: 'PH.2', title: 'PH.2' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-96');
    expect(bundle.nextCardReason).toBe('parent-step');
    expect(bundle.nextCardStep).toEqual({ parentId: 'RCB-80', gateBy: null });
  });

  it('(5) parent assigned to someone else is ignored entirely; first-todo rule applies', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'ops', title: 'someone else’s plan' }),
      card({ id: 'RCB-95', status: 'backlog', parent: 'RCB-80', phase: 'PH.1', title: 'PH.1' }),
      card({ id: 'RCB-99', status: 'todo', title: 'first todo, unassigned' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    expect(bundle.nextCard?.id).toBe('RCB-99');
    expect(bundle.nextCardReason).toBe('first-todo');
    expect(bundle.nextCardStep).toBeNull();
  });

  it('(6) render text contains "(next unblocked step of RCB-80 — gate RCB-94 (done))"', () => {
    const cards: Card[] = [
      card({ id: 'RCB-80', status: 'doing', assignee: 'builder', title: 'the parent plan' }),
      card({ id: 'RCB-94', status: 'done', parent: 'RCB-80', phase: 'PH.0', title: 'PH.0' }),
      card({
        id: 'RCB-95',
        status: 'backlog',
        parent: 'RCB-80',
        phase: 'PH.1',
        gate: 'RCB-94',
        title: 'PH.1',
      }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
      config,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('(next unblocked step of RCB-80 — gate RCB-94 (done))');
  });
});

describe('seatBundle: coordinator section', () => {
  it('C2: coordinatorBlock is forced null when name IS the coordinator, even if one was gathered', () => {
    const gathered = {
      date: '2026-09-18',
      block: { seat: 'COORDINATOR', ts: NOW.toISOString(), title: 't', text: 'x' },
    };
    const bundle = seatBundle({
      name: 'coordinator',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: gathered,
      cards: [],
    });
    expect(bundle.coordinatorBlock).toBeNull();
  });

  it(
    'C2: the rendered bundle has exactly one "Last block — COORDINATOR" heading for the ' +
      'coordinator seat (its own; the separate coordinator section is omitted)',
    () => {
      const bundle = seatBundle({
        name: 'coordinator',
        now: NOW,
        seatsSection: SEATS, // RCB-140: non-solo, so every section renders
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      const rendered = renderSeatBundle(bundle, NOW);
      const headingCount = (rendered.match(/^## Last block — COORDINATOR$/gm) ?? []).length;
      expect(headingCount).toBe(1);
    },
  );

  it('a non-coordinator seat keeps its coordinatorBlock and the section', () => {
    const gathered = {
      date: '2026-09-18',
      block: { seat: 'COORDINATOR', ts: NOW.toISOString(), title: 't', text: 'x' },
    };
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: gathered,
      cards: [],
    });
    expect(bundle.coordinatorBlock).toEqual(gathered);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Last block — COORDINATOR');
  });
});

describe('seatBundle: openDecisions', () => {
  it('reuses needsDecision — only cards with an open decision appear, in list order', () => {
    const open = card({
      id: 'RCB-3',
      decision: {
        question: 'pick one',
        options: [],
        askedBy: 'coordinator',
        askedAt: '2026-09-18T20:00:00Z',
        returnTo: null,
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    const decided = card({
      id: 'RCB-4',
      decision: {
        question: 'already answered',
        options: [],
        askedBy: 'coordinator',
        askedAt: '2026-09-18T20:00:00Z',
        returnTo: null,
        chosen: null,
        words: 'yes',
        decidedBy: 'owner',
        decidedAt: '2026-09-18T20:30:00Z',
      },
    });
    const plain = card({ id: 'RCB-5' });
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [decided, open, plain],
    });
    expect(bundle.openDecisions.map((c) => c.id)).toEqual(['RCB-3']);
  });
});

function decisionCard(id: string): Card {
  return card({
    id,
    status: 'backlog',
    decision: {
      question: 'pick one',
      options: [],
      askedBy: 'coordinator',
      askedAt: '2026-09-18T20:00:00Z',
      returnTo: null,
      chosen: null,
      words: null,
      decidedBy: null,
      decidedAt: null,
    },
  });
}

describe('seatBundle: nextCardEmpty (RCB-118)', () => {
  it('non-null with distinct counts: 1 todo for another seat, 2 gated, 3 awaiting the owner', () => {
    const cards: Card[] = [
      card({ id: 'RCB-1', status: 'todo', assignee: 'ops', title: 'not mine' }),
      card({ id: 'RCB-2', status: 'doing', gate: 'RCB-999', title: 'gated a' }),
      card({ id: 'RCB-3', status: 'doing', gate: 'RCB-998', title: 'gated b' }),
      decisionCard('RCB-4'),
      decisionCard('RCB-5'),
      decisionCard('RCB-6'),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardEmpty).toEqual({ todoForOthers: 1, gated: 2, awaitingOwner: 3 });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      '(no todo card for builder — 1 todo assigned to other seats · 2 gated · 3 waiting on the owner)',
    );
  });

  it('an all-zero empty board: nextCardEmpty is all zeros, printed as 0 not omitted', () => {
    const cards: Card[] = [];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).toBeNull();
    expect(bundle.nextCardEmpty).toEqual({ todoForOthers: 0, gated: 0, awaitingOwner: 0 });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      '(no todo card for builder — 0 todo assigned to other seats · 0 gated · 0 waiting on the owner)',
    );
  });

  it('null when a next card exists — the empty-board question does not apply', () => {
    const cards: Card[] = [card({ id: 'RCB-1', status: 'todo', title: 'first todo, unassigned' })];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.nextCard).not.toBeNull();
    expect(bundle.nextCardEmpty).toBeNull();
  });

  it('RCB-154: `gated` resolves a gate on a MEMBER card — done member card clears, todo one stays gated', () => {
    const cards: Card[] = [
      card({ id: 'RCB-2', status: 'doing', gate: 'MB-1', title: 'gated on a done member card' }),
      card({ id: 'RCB-3', status: 'doing', gate: 'MB-2', title: 'gated on a todo member card' }),
    ];
    const members = [
      {
        key: 'm',
        prefix: 'MB',
        cards: [card({ id: 'MB-1', status: 'done' }), card({ id: 'MB-2', status: 'todo' })],
        config: { ...defaultBoardConfig(), prefix: 'MB' },
      },
    ];
    const input = {
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    };
    const withMembers = seatBundle({ ...input, members });
    expect(withMembers.nextCard).toBeNull();
    expect(withMembers.nextCardEmpty).toEqual({ todoForOthers: 0, gated: 1, awaitingOwner: 0 });
    // No member facts: both gates read "(no such card)" — the pre-RCB-154 count.
    expect(seatBundle(input).nextCardEmpty).toEqual({
      todoForOthers: 0,
      gated: 2,
      awaitingOwner: 0,
    });
  });
});

describe('renderSeatBundle: placeholders for every missing part', () => {
  it('an entirely empty bundle renders a one-line placeholder per section, never an empty section', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: false,
      repo: null,
      holder: null,
      holderError: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('solo board');
    expect(rendered).toContain('## In flight / owes');
    expect(rendered).toContain('in-flight: (none recorded)');
    expect(rendered).toContain('owes: (none recorded)');
    expect(rendered).toContain('## SEATS line');
    expect(rendered).toContain('(no SEATS line mentions ops)');
    expect(rendered).toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).toContain('(no .repoboard/local/RIG.md — run repoboard local init)');
    expect(rendered).toContain('## Last block — OPS');
    expect(rendered).toContain('(no log block for ops)');
    expect(rendered).toContain('## Last block — COORDINATOR');
    expect(rendered).toContain('(no log block for coordinator)');
    expect(rendered).toContain('## Next card');
    expect(rendered).toContain('(no todo card)');
    expect(rendered).toContain('## Open decisions');
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('(none)');
  });

  it('a first-todo (unassigned) next card prints "(first todo; nothing assigned, nothing prioritised)"', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: card({ id: 'RCB-1', title: 'do this' }),
      nextCardReason: 'first-todo',
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: false,
      repo: null,
      holder: null,
      holderError: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('RCB-1  todo  do this');
    expect(rendered).toContain('(first todo; nothing assigned, nothing prioritised)');
  });
});

describe('seatBundle: solo (RCB-140)', () => {
  it('no SEATS section at all: solo is true', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
  });

  it('a SEATS section with no bullets in it: solo is true (reverting this line to a section with a bullet must fail)', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: 'Owner tasks elsewhere: nothing to see here',
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
  });

  it('a SEATS section with at least one bullet: solo is false', () => {
    const bundle = seatBundle({
      name: 'ops',
      now: NOW,
      seatsSection: SEATS,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(false);
  });
});

describe('renderSeatBundle: a solo board drops the placeholder sections (RCB-140)', () => {
  it('solo, every part missing: the solo line prints; the five placeholder sections are gone; Next card and Open decisions still print', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: null,
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: true,
      repo: null,
      holder: null,
      holderError: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      'solo board — seats, the log and leases apply once more than one agent runs (repoboard init --practices)',
    );
    expect(rendered).not.toContain('## In flight / owes');
    expect(rendered).not.toContain('## SEATS line');
    expect(rendered).not.toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).not.toContain('## Last block — OPS');
    expect(rendered).not.toContain('## Last block — COORDINATOR');
    expect(rendered).not.toContain('(none recorded)');
    expect(rendered).not.toContain('(no SEATS line mentions ops)');
    expect(rendered).not.toContain('(no .repoboard/local/RIG.md — run repoboard local init)');
    expect(rendered).not.toContain('(no log block for ops)');
    expect(rendered).not.toContain('(no log block for coordinator)');
    expect(rendered).toContain('## Next card');
    expect(rendered).toContain('(no todo card)');
    expect(rendered).toContain('## Open decisions');
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('(none)');
  });

  it('solo but with an ownBlock: the Last block section still prints (reverting `!b.solo || b.ownBlock !== null` to `!b.solo` alone must fail)', () => {
    const bundle: SeatBundle = {
      name: 'ops',
      seatsLine: null,
      ownBlock: {
        date: '2026-09-18',
        block: {
          seat: 'OPS',
          ts: '2026-09-18T20:00:00Z',
          title: 'watching things',
          text: 'watching things',
        },
      },
      coordinatorBlock: null,
      nextCard: null,
      nextCardReason: null,
      nextCardStep: null,
      openDecisions: [],
      answeredNotAck: [],
      nextCardEmpty: null,
      rig: null,
      inFlight: null,
      owes: null,
      systems: null,
      leases: [],
      solo: true,
      repo: null,
      holder: null,
      holderError: null,
    };
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain(
      'solo board — seats, the log and leases apply once more than one agent runs (repoboard init --practices)',
    );
    expect(rendered).toContain('## Last block — OPS');
    expect(rendered).toContain('watching things');
    expect(rendered).not.toContain('## In flight / owes');
    expect(rendered).not.toContain('## SEATS line');
    expect(rendered).not.toContain('## Rig (.repoboard/local/RIG.md)');
    expect(rendered).not.toContain('## Last block — COORDINATOR');
  });
});

describe('seatBundle: rig (RCB-83)', () => {
  it('carries input.rig through untouched', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop\n\n## Build\npnpm build\n',
    });
    expect(bundle.rig).toBe('# RIG — laptop\n\n## Build\npnpm build\n');
  });

  it('defaults to null when input.rig is absent', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.rig).toBeNull();
  });

  it('renders the rig text after the SEATS line, before the last-block sections', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop',
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const seatsIdx = rendered.indexOf('## SEATS line');
    const rigIdx = rendered.indexOf('## Rig (.repoboard/local/RIG.md)');
    const lastBlockIdx = rendered.indexOf('## Last block');
    expect(seatsIdx).toBeGreaterThanOrEqual(0);
    expect(rigIdx).toBeGreaterThan(seatsIdx);
    expect(lastBlockIdx).toBeGreaterThan(rigIdx);
    expect(rendered).toContain('# RIG — laptop');
  });
});

describe('replaceSeatBullet / formatSeatBullet (RCB-58)', () => {
  const THREE = [
    '- **coordinator**: routes work',
    '- **repoboard builder (its own terminal)**: on RCB-1',
    '  continuation one',
    '  continuation two',
    '- **ops**: watching things',
  ].join('\n');

  it('test 1: replaces ONLY the builder bullet; coordinator and ops bullets are byte-identical, all 3 old builder lines gone', () => {
    const result = replaceSeatBullet(THREE, 'builder', 'X');
    expect(result).toBe(
      ['- **coordinator**: routes work', 'X', '- **ops**: watching things'].join('\n'),
    );
  });

  it('test 2a: appends as the last bullet when the seat has none yet', () => {
    const twoBullets = ['- **coordinator**: routes work', '- **ops**: watching things'].join('\n');
    const result = replaceSeatBullet(twoBullets, 'builder', 'X');
    expect(result).toBe(
      ['- **coordinator**: routes work', '- **ops**: watching things', 'X'].join('\n'),
    );
  });

  it('test 2b: a placeholder section becomes just the bullet', () => {
    expect(replaceSeatBullet(SECTION_PLACEHOLDER, 'builder', 'X')).toBe('X');
  });

  it('test 3: label-pass precedence — the coordinator prose-mentions "the builder" ahead of the builder\'s own bullet, but the builder\'s own is the one replaced (RCB-48 dogfood case)', () => {
    const REAL_SHAPE = [
      '- **coordinator (shared with acme): UP 2026-09-18 20:2xZ, cold-started from ' +
        'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
        "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
        'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
        'card, restamp.',
      '- **repoboard builder (its own terminal)**: UP; landed tonight RCB-47 00aae0a and RCB-52 552fb2e.',
    ].join('\n');
    const result = replaceSeatBullet(REAL_SHAPE, 'builder', 'X');
    expect(result).toBe(
      [
        '- **coordinator (shared with acme): UP 2026-09-18 20:2xZ, cold-started from ' +
          'SEATS on both boards.** Verified: `main` 405cab5 = `origin/main`; the only uncommitted ' +
          "change is the builder's RCB-47 card move (doing, lease live) — the builder commits it " +
          'with its landing. Routine: verify each builder sha by content on origin/main, move the ' +
          'card, restamp.',
        'X',
      ].join('\n'),
    );
  });

  it('test 4: formatSeatBullet produces the exact bullet text, with a 2-line continuation indented', () => {
    const bullet = formatSeatBullet(
      'repoboard builder',
      'DOWN',
      'x\ny',
      new Date('2026-09-19T01:55:00Z'),
    );
    expect(bullet).toBe('- **repoboard builder: DOWN 2026-09-19 01:55Z.** x\n  y');
  });

  it('test 5: round trip — format → replace → findSeatLine returns exactly the new bullet', () => {
    const bullet = formatSeatBullet(
      'builder',
      'UP',
      'holding RCB-58',
      new Date('2026-09-19T02:00:00Z'),
    );
    const replaced = replaceSeatBullet(THREE, 'builder', bullet);
    expect(findSeatLine(replaced, 'builder')).toBe(bullet);
  });

  describe('RCB-130: an unindented "- in-flight:"/"- owes:" continuation is folded, not orphaned', () => {
    // REPRODUCTION (candidate B): a hand-edit that types a continuation as its own "- " item
    // instead of indenting it. Before the `bulletSpans` fix, this line started a NEW span with no
    // owner label, and `replaceSeatBullet` left it sitting right after the freshly replaced
    // bullet — the "coordinator's SEATS bullet carried TWO in-flight/owes pairs" shape.
    const HAND_EDITED = [
      '- **coordinator: UP 2026-09-24 22:00Z.** doing X',
      '  in-flight: sonnet A',
      '  owes: RCB-1',
      '- in-flight: sonnet B',
      '  owes: RCB-2 OWNER QUEUE = ACME-86, ACME-119',
      '- **ops**: watching things',
    ].join('\n');

    it('findSeatLine folds the stray "- in-flight:"/"- owes:" pair into the coordinator bullet', () => {
      const line = findSeatLine(HAND_EDITED, 'coordinator');
      expect(line).toBe(
        [
          '- **coordinator: UP 2026-09-24 22:00Z.** doing X',
          '  in-flight: sonnet A',
          '  owes: RCB-1',
          '- in-flight: sonnet B',
          '  owes: RCB-2 OWNER QUEUE = ACME-86, ACME-119',
        ].join('\n'),
      );
      // The unrelated "- Owner tasks elsewhere: …"-shaped bullet ("- **ops**…") is NOT folded in —
      // only a stray field line is.
      expect(line).not.toContain('ops');
    });

    it(
      'the control: replaceSeatBullet removes the stray pair along with the rest of the ' +
        'coordinator bullet — it does NOT survive as an orphan bullet after the replace (revert ' +
        'the `STRAY_FIELD_BULLET_RE` check in `bulletSpans` to make this fail)',
      () => {
        const fresh = formatSeatBullet(
          'coordinator',
          'UP',
          'doing Y',
          new Date('2026-09-25T01:56:00Z'),
        );
        const replaced = replaceSeatBullet(HAND_EDITED, 'coordinator', fresh);
        expect(replaced).toBe(
          ['- **coordinator: UP 2026-09-25 01:56Z.** doing Y', '- **ops**: watching things'].join(
            '\n',
          ),
        );
        expect(replaced).not.toContain('in-flight: sonnet B');
        expect(replaced).not.toContain('OWNER QUEUE');
      },
    );

    it('a stray field line with NO open bullet ahead of it still starts its own span (nothing to fold into) — replaceSeatBullet appends after it rather than dropping it', () => {
      const noPriorBullet = ['- in-flight: sonnet B', '  owes: RCB-2'].join('\n');
      const replaced = replaceSeatBullet(noPriorBullet, 'ops', 'X');
      expect(replaced).toBe(['- in-flight: sonnet B', '  owes: RCB-2', 'X'].join('\n'));
    });

    it('an unrelated bullet that merely STARTS with "in-flight"/"owes" text but is not the exact field shape is untouched', () => {
      const section = [
        '- **coordinator**: routes work',
        '- in-flight-notes: some card mentions this word, not a field line',
      ].join('\n');
      // Two separate bullets, not folded — the stray-line rule only matches the exact
      // "in-flight:"/"owes:" shape, not a merely similar-looking label.
      const line = findSeatLine(section, 'coordinator');
      expect(line).toBe('- **coordinator**: routes work');
    });
  });
});

describe('seatBulletTexts (RCB-130)', () => {
  it('one entry per top-level bullet, name + whole text, in section order', () => {
    const entries = seatBulletTexts(SEATS);
    expect(entries).toEqual([
      {
        name: 'repoboard builder (its own terminal, no autonomy)',
        text: '- **repoboard builder (its own terminal, no autonomy)**: on RCB-1\n  continuation line here',
      },
      { name: 'ops', text: '- **ops**: watching things' },
      { name: 'coordinator', text: '- **coordinator**: routes work' },
    ]);
  });

  it('a malformed (unstamped) bullet still gets an entry, unlike listSeats', () => {
    const section = '- Owner tasks elsewhere: whatever';
    expect(seatBulletTexts(section)).toEqual([
      { name: 'Owner tasks elsewhere', text: '- Owner tasks elsewhere: whatever' },
    ]);
    expect(listSeats(section)).toEqual([]);
  });

  it('no bullets at all (a placeholder section) -> []', () => {
    expect(seatBulletTexts('_(nothing recorded yet)_')).toEqual([]);
  });
});

describe('parseSeatStamp / seatUpConflict (RCB-87)', () => {
  const NOW87 = new Date('2026-09-21T22:37:00Z');

  it('(1) a formatted UP bullet 5 min old, window 30 -> conflict, minutesAgo 5', () => {
    const at = new Date(NOW87.getTime() - 5 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    expect(parseSeatStamp(bullet)).toEqual({ status: 'UP', at });
    expect(seatUpConflict(bullet, NOW87, 30, [])).toEqual({
      stamp: '2026-09-21 22:32Z',
      minutesAgo: 5,
      source: 'UP',
    });
  });

  it('(2) UP 31 min old, window 30 -> no conflict', () => {
    const at = new Date(NOW87.getTime() - 31 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    expect(seatUpConflict(bullet, NOW87, 30, [])).toBeNull();
  });

  it('(3) DOWN 1 min old -> no conflict, --down is never guarded', () => {
    const at = new Date(NOW87.getTime() - 60_000);
    const bullet = formatSeatBullet('ops', 'DOWN', 'stood down', at);
    expect(parseSeatStamp(bullet)).toEqual({ status: 'DOWN', at });
    expect(seatUpConflict(bullet, NOW87, 30, [])).toBeNull();
  });

  it('(4) a stamp with a non-digit (18:0xZ) parses with at null; conflict null', () => {
    const bullet = '- **ops: UP 2026-09-21 18:0xZ.** watching things';
    expect(parseSeatStamp(bullet)).toEqual({ status: 'UP', at: null });
    expect(seatUpConflict(bullet, NOW87, 30, [])).toBeNull();
  });

  it('(5) a non-seat bullet is not a seat bullet at all', () => {
    expect(parseSeatStamp('- Owner tasks elsewhere: whatever')).toBeNull();
  });

  it('(6) a future stamp (clock skew) still counts as a conflict', () => {
    const at = new Date(NOW87.getTime() + 5 * 60_000);
    const bullet = formatSeatBullet('ops', 'UP', 'watching things', at);
    const conflict = seatUpConflict(bullet, NOW87, 30, []);
    expect(conflict).not.toBeNull();
    expect(conflict?.stamp).toBe('2026-09-21 22:42Z');
  });
});

/**
 * RCB-169: `--up` refuses on a FRESH sighting, not only a fresh UP stamp. `--update` keeps the UP
 * stamp on purpose, so a seat UP for a day that updated its bullet / logged five minutes ago used
 * to look stale and a second session's `--up` overwrote it (a member board, 2026-09-29: ops' `in-flight:`
 * line erased).
 *
 * Control: make `seatUpConflict` ignore `sightings` (drop the `for (const s of sightings)` loop)
 * — (1), (3), (4) and (5) fail (they expect a refusal from a sighting alone); (2), (6) and (7)
 * pass either way (they guard the allowed side). Opposite direction: treat every sighting as
 * fresh regardless of `windowMinutes` — (2) and the 31-min case in (8) fail.
 */
describe('seatUpConflict + seatSightings: liveness beyond the UP stamp (RCB-169)', () => {
  const NOW169 = new Date('2026-09-29T12:00:00Z');
  const ago = (min: number): Date => new Date(NOW169.getTime() - min * 60_000);
  // UP 21 h ago — far outside the 30 min window on its own.
  const OLD_UP = formatSeatBullet('ops', 'UP', 'watching things', ago(21 * 60), 'acme');
  const iso = (d: Date): string => d.toISOString().replace('.000Z', 'Z');

  it('(1) UP 21 h ago + a log block 5 min ago -> refused, and the source is the log', () => {
    const sightings = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(5)),
      state: null,
    });
    const conflict = seatUpConflict(OLD_UP, NOW169, 30, sightings);
    expect(conflict).toEqual({ stamp: '2026-09-28 15:00Z', minutesAgo: 5, source: 'log' });
    expect(conflict && describeSeatUpConflict(conflict)).toBe('logged 5 min ago');
  });

  it('(2) UP 21 h ago + nothing recent (newest log block 45 min ago, no STATE) -> allowed', () => {
    const sightings = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(45)),
      state: null,
    });
    expect(seatUpConflict(OLD_UP, NOW169, 30, sightings)).toBeNull();
    // and with no sightings gathered at all
    expect(seatUpConflict(OLD_UP, NOW169, 30, [])).toBeNull();
  });

  it('(3) STATE written 5 min ago BY THIS SEAT (bare or [board]-prefixed, any case) -> refused, naming STATE and the actor', () => {
    for (const actor of ['ops', '[acme] ops', 'OPS', '[ACME] ops']) {
      const sightings = seatSightings({
        seat: 'ops',
        boardName: 'acme',
        lastLogTs: null,
        state: { stamp: iso(ago(5)), actor },
      });
      const conflict = seatUpConflict(OLD_UP, NOW169, 30, sightings);
      expect(conflict?.source).toBe('STATE');
      expect(conflict?.minutesAgo).toBe(5);
      expect(conflict && describeSeatUpConflict(conflict)).toBe(
        `STATE written 5 min ago by ${actor}`,
      );
    }
  });

  it('(4) STATE written 5 min ago by ANOTHER seat -> allowed; so is one by a seat of another board', () => {
    for (const actor of ['builder', '[acme] builder', '[repoboard] ops', 'coordinator (ops)']) {
      const sightings = seatSightings({
        seat: 'ops',
        boardName: 'acme',
        lastLogTs: null,
        state: { stamp: iso(ago(5)), actor },
      });
      expect(sightings).toEqual([]);
      expect(seatUpConflict(OLD_UP, NOW169, 30, sightings)).toBeNull();
    }
  });

  it('(5) the FRESHEST of UP stamp / log / STATE names the source; ties go UP, then log, then STATE', () => {
    const upFresh = formatSeatBullet('ops', 'UP', 'x', ago(3), 'acme');
    const both = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(10)),
      state: { stamp: iso(ago(20)), actor: 'ops' },
    });
    // UP 3 min ago beats a log at 10 and STATE at 20
    expect(seatUpConflict(upFresh, NOW169, 30, both)).toMatchObject({
      source: 'UP',
      minutesAgo: 3,
    });
    // an old UP: the log (10 min) beats STATE (20 min)
    expect(seatUpConflict(OLD_UP, NOW169, 30, both)).toMatchObject({
      source: 'log',
      minutesAgo: 10,
    });
    // STATE alone, when it is the newest of the two
    const stateNewer = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(25)),
      state: { stamp: iso(ago(2)), actor: 'ops' },
    });
    expect(seatUpConflict(OLD_UP, NOW169, 30, stateNewer)).toMatchObject({
      source: 'STATE',
      minutesAgo: 2,
      actor: 'ops',
    });
    // tie: log and STATE at the same instant -> log
    const tie = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(4)),
      state: { stamp: iso(ago(4)), actor: 'ops' },
    });
    expect(seatUpConflict(OLD_UP, NOW169, 30, tie)?.source).toBe('log');
  });

  it('(5b) moments within a minute are ONE event: the source named is UP, then log, then STATE — a `--up` restamps STATE seconds after its own minute-truncated UP stamp', () => {
    const at = (iso169: string): SeatSighting => ({
      source: 'STATE',
      at: new Date(iso169),
      actor: 'ops',
    });
    // UP stamp 11:55Z (11:55:00), STATE 11:55:10 by the same `--up` -> named UP, not STATE
    const upBullet = formatSeatBullet('ops', 'UP', 'x', new Date('2026-09-29T11:55:20Z'), 'acme');
    expect(seatUpConflict(upBullet, NOW169, 30, [at('2026-09-29T11:55:10Z')])).toEqual({
      stamp: '2026-09-29 11:55Z',
      minutesAgo: 5,
      source: 'UP',
    });
    // a log and the STATE restamp that follows it by milliseconds -> named log
    const log = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: '2026-09-29T11:50:00Z',
      state: { stamp: '2026-09-29T11:50:00.400Z', actor: 'ops' },
    });
    expect(seatUpConflict(OLD_UP, NOW169, 30, log)).toMatchObject({ source: 'log' });
    // exactly 60 s apart is still one event (-> log); 61 s apart the STATE write is its own (-> STATE)
    const gap = (ms: number) =>
      seatSightings({
        seat: 'ops',
        boardName: 'acme',
        lastLogTs: '2026-09-29T11:50:00Z',
        state: {
          stamp: new Date(Date.parse('2026-09-29T11:50:00Z') + ms).toISOString(),
          actor: 'ops',
        },
      });
    expect(seatUpConflict(OLD_UP, NOW169, 30, gap(60_000))?.source).toBe('log');
    expect(seatUpConflict(OLD_UP, NOW169, 30, gap(61_000))).toMatchObject({
      source: 'STATE',
      minutesAgo: 9,
    });
  });

  it('(6) a DOWN bullet is never a conflict, however fresh the log (a seat logs, THEN stands down)', () => {
    const down = formatSeatBullet('ops', 'DOWN', 'stood down', ago(2), 'acme');
    const sightings = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(1)),
      state: { stamp: iso(ago(1)), actor: 'ops' },
    });
    expect(sightings).toHaveLength(2);
    expect(seatUpConflict(down, NOW169, 30, sightings)).toBeNull();
    // no bullet at all: nothing to hold
    expect(seatUpConflict(null, NOW169, 30, sightings)).toBeNull();
  });

  it('(7) a log `ts` that does not parse, or has no time / no zone, contributes NOTHING; a bad STATE stamp too', () => {
    expect(
      seatSightings({
        seat: 'ops',
        boardName: 'acme',
        lastLogTs: '2026-09-29 11:5xZ',
        state: { stamp: 'not-a-date', actor: 'ops' },
      }),
    ).toEqual([]);
    // a date-only heading (parses as midnight UTC) and a zoneless one (host-local time) are not
    // moments either — only date + time + zone counts
    for (const ts of ['2026-09-29', '2026-09-29 11:55', '2026-09-29T11:55']) {
      expect(seatSightings({ seat: 'ops', boardName: 'acme', lastLogTs: ts, state: null })).toEqual(
        [],
      );
    }
    // the hand-written shapes that DO carry all three are kept: space instead of T, `(addendum)`
    for (const ts of [
      '2026-09-29 11:55Z',
      '2026-09-29T11:55:00Z',
      '2026-09-29 11:55Z (addendum)',
    ]) {
      expect(
        seatSightings({ seat: 'ops', boardName: 'acme', lastLogTs: ts, state: null }),
      ).toHaveLength(1);
    }
    // an empty seat name never matches an (empty-after-strip) actor
    expect(
      seatSightings({
        seat: '',
        boardName: 'acme',
        lastLogTs: null,
        state: { stamp: iso(ago(1)), actor: '[acme]' },
      }),
    ).toEqual([]);
  });

  it('(8) the window still applies to a sighting: exactly 30 min ago refuses, 31 min allows', () => {
    const at = (min: number) =>
      seatSightings({ seat: 'ops', boardName: 'acme', lastLogTs: iso(ago(min)), state: null });
    expect(seatUpConflict(OLD_UP, NOW169, 30, at(30))?.source).toBe('log');
    expect(seatUpConflict(OLD_UP, NOW169, 30, at(31))).toBeNull();
  });

  it('(9) an UP bullet whose stamp does not parse (`18:0xZ`) is refused on a fresh sighting alone (stamp null), allowed without one', () => {
    const redacted = '- **[acme] ops: UP 2026-09-28 18:0xZ.** watching things';
    const sightings = seatSightings({
      seat: 'ops',
      boardName: 'acme',
      lastLogTs: iso(ago(5)),
      state: null,
    });
    const conflict = seatUpConflict(redacted, NOW169, 30, sightings);
    expect(conflict).toEqual({ stamp: null, minutesAgo: 5, source: 'log' });
    expect(seatUpConflict(redacted, NOW169, 30, [])).toBeNull();
  });

  it('(10) describeSeatUpConflict words each source', () => {
    expect(
      describeSeatUpConflict({ stamp: '2026-09-29 11:55Z', minutesAgo: 5, source: 'UP' }),
    ).toBe('UP 5 min ago (stamped 2026-09-29 11:55Z)');
    expect(describeSeatUpConflict({ stamp: null, minutesAgo: 5, source: 'UP' })).toBe(
      'UP 5 min ago',
    );
    expect(describeSeatUpConflict({ stamp: null, minutesAgo: 5, source: 'log' })).toBe(
      'logged 5 min ago',
    );
    expect(
      describeSeatUpConflict({ stamp: null, minutesAgo: 5, source: 'STATE', actor: 'ops' }),
    ).toBe('STATE written 5 min ago by ops');
  });
});

/**
 * RCB-172: one seat, one name. `seat "repoboard builder" --up` made `[repoboard] repoboard builder`
 * and `seat "[repoboard] builder"` made `[repoboard] [repoboard] builder` — agents type the prefix
 * the bullet carries. Every entry point normalizes through `normalizeSeatName`.
 *
 * Control (bypass): make `normalizeSeatName` return `{ ok: true, name: raw.trim(), label }` — (1),
 * (3) and (7) are the three axes that fail (three spellings stay three names, another board's
 * prefix is accepted, three bullets — 7's own last assertion pins the measured raw count, 3).
 * Opposite direction: strip ANY leading `[…]` instead of erroring on another board's — (3) fails;
 * strip a leading `<board>` even with nothing after it — (2) fails.
 */
describe('normalizeSeatName / seatLabel (RCB-172)', () => {
  const BOARD = 'repoboard';

  it('(1) the spellings of one seat all normalize to the SAME name and label', () => {
    for (const raw of [
      'builder',
      'repoboard builder',
      '[repoboard] builder',
      '[repoboard] repoboard builder',
      '  [repoboard]   builder  ',
      'REPOBOARD builder',
      '[Repoboard] builder',
    ]) {
      expect(normalizeSeatName(raw, BOARD), raw).toEqual({
        ok: true,
        name: 'builder',
        label: '[repoboard] builder',
      });
    }
  });

  it('(2) only a whole leading word is stripped: a seat that IS the board name, or merely starts with it, is left alone', () => {
    for (const raw of [
      'repoboard',
      '[repoboard] repoboard',
      'repoboardbuilder',
      'repoboard-builder',
      'repoboard/builder',
      'claude/p8-3',
      'the repoboard builder',
    ]) {
      const res = normalizeSeatName(raw, BOARD);
      expect(res.ok, raw).toBe(true);
      expect(res.ok && res.name, raw).toBe(raw.replace(/^\[repoboard\] /, ''));
    }
  });

  it("(3) another board's bracket prefix is an error naming that — never stripped, never accepted", () => {
    for (const raw of ['[acme] ops', '[acme] repoboard ops', '[repoboard-x] builder']) {
      const res = normalizeSeatName(raw, BOARD);
      expect(res.ok, raw).toBe(false);
      expect(!res.ok && res.error, raw).toMatch(
        /that prefix names another board \(this board is "repoboard"\)/,
      );
    }
  });

  it('(4) empty, or nothing left once the prefix is removed, is an error', () => {
    for (const raw of ['', '   ', '[repoboard]', '[repoboard]   ']) {
      expect(normalizeSeatName(raw, BOARD).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('(5) no board name known: nothing is stripped (inert), but a leading `[` is still refused', () => {
    expect(normalizeSeatName('repoboard builder', '')).toEqual({
      ok: true,
      name: 'repoboard builder',
      label: 'repoboard builder',
    });
    expect(normalizeSeatName('[x] ops', '').ok).toBe(false);
  });

  it("(6) seatLabel is the ONE label: formatSeatBullet's bold span carries it, and findSeatLine finds the bullet by the bare name", () => {
    expect(seatLabel('ops', 'acme')).toBe('[acme] ops');
    for (const none of [undefined, null, '', '  ']) expect(seatLabel('ops', none)).toBe('ops');
    const bullet = formatSeatBullet('builder', 'UP', 'x', NOW, 'repoboard');
    expect(bullet.startsWith(`- **${seatLabel('builder', 'repoboard')}: UP `)).toBe(true);
    const res = normalizeSeatName('[repoboard] builder', BOARD);
    expect(res.ok && res.label).toBe(seatLabel('builder', 'repoboard'));
    expect(findSeatLine(bullet, 'builder')).toBe(bullet);
  });

  it('(7) three spellings written in turn leave ONE bullet — bare, [board]-prefixed, board-word-prefixed', () => {
    const write = (section: string, raw: string): string => {
      const res = normalizeSeatName(raw, BOARD);
      if (!res.ok) throw new Error(res.error);
      return replaceSeatBullet(
        section,
        res.name,
        formatSeatBullet(res.name, 'UP', 'x', NOW, BOARD),
      );
    };
    let section = SECTION_PLACEHOLDER;
    for (const raw of ['builder', '[repoboard] builder', 'repoboard builder']) {
      section = write(section, raw);
    }
    expect(listSeats(section).map((r) => r.name)).toEqual(['builder']);
    expect(section).toBe(formatSeatBullet('builder', 'UP', 'x', NOW, BOARD));
    // ... where the RAW names (measured: 3 bullets) are the bug this card fixes
    let raw3 = SECTION_PLACEHOLDER;
    for (const raw of ['builder', '[repoboard] builder', 'repoboard builder']) {
      raw3 = replaceSeatBullet(raw3, raw, formatSeatBullet(raw, 'UP', 'x', NOW, BOARD));
    }
    expect(listSeats(raw3)).toHaveLength(3);
  });

  it('(8) a STATE stamp by the legacy spellings of this seat still counts as this seat (RCB-169 x RCB-172)', () => {
    const at = new Date('2026-09-29T11:55:00Z');
    for (const actor of ['builder', '[repoboard] builder', 'repoboard builder']) {
      const sightings = seatSightings({
        seat: 'builder',
        boardName: BOARD,
        lastLogTs: null,
        state: { stamp: at.toISOString(), actor },
      });
      expect(
        sightings.map((x) => x.source),
        actor,
      ).toEqual(['STATE']);
    }
  });
});

describe('rewriteSeatBulletBody (RCB-88)', () => {
  const NOW88 = new Date('2026-09-02T22:41:10Z');

  it("(1) keeps the label/status/stamp, replaces the body — 'a' becomes 'b'", () => {
    const bullet = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten).not.toBeNull();
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 22:41Z.** b');
    expect(rewritten?.status).toBe('UP');
    expect(rewritten?.stamp).toBe('2026-09-02 22:41Z');
  });

  it('(2) a DOWN bullet keeps DOWN', () => {
    const bullet = formatSeatBullet('ops', 'DOWN', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten?.status).toBe('DOWN');
    expect(rewritten?.bullet).toBe('- **ops: DOWN 2026-09-02 22:41Z.** b');
  });

  it('(3) a stamp with a non-digit (18:0xZ) is kept verbatim', () => {
    const bullet = '- **ops: UP 2026-09-02 18:0xZ.** a';
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten?.stamp).toBe('2026-09-02 18:0xZ');
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 18:0xZ.** b');
  });

  it("(4) text 'x\\ny' becomes a continuation line 'x\\n  y'", () => {
    const bullet = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(bullet, 'x\ny');
    expect(rewritten?.bullet).toBe('- **ops: UP 2026-09-02 22:41Z.** x\n  y');
  });

  it('(5) a non-seat bullet is not a seat bullet at all -> null', () => {
    expect(rewriteSeatBulletBody('- Owner tasks elsewhere: whatever', 'b')).toBeNull();
  });

  it('(6) round-trip: findSeatLine finds it, parseSeatStamp gives the ORIGINAL at', () => {
    const original = formatSeatBullet('ops', 'UP', 'a', NOW88);
    const rewritten = rewriteSeatBulletBody(original, 'b');
    expect(rewritten).not.toBeNull();
    if (rewritten === null) return;
    expect(findSeatLine(rewritten.bullet, 'ops')).toBe(rewritten.bullet);
    expect(parseSeatStamp(rewritten.bullet)?.at).toEqual(parseSeatStamp(original)?.at);
  });
});

describe('RCB-89 in-flight/owes + listSeats', () => {
  const DOWN_ERR =
    'seat --down needs an "in-flight:" line (subagent ids, Monitor ids, worktree, lock holder — ' +
    'or none) and an "owes:" line';

  describe('parseSeatFields', () => {
    it('a 3-line DOWN bullet with both present', () => {
      const bullet = formatSeatBullet(
        'ops',
        'DOWN',
        'stood down\nin-flight: sonnet A, Monitor 123\nowes: RCB-1',
        NOW,
      );
      expect(bullet.split('\n')).toHaveLength(3);
      expect(parseSeatFields(bullet)).toEqual({
        inFlight: 'sonnet A, Monitor 123',
        owes: 'RCB-1',
      });
    });

    it('an UP bullet with neither -> both null', () => {
      const bullet = formatSeatBullet('ops', 'UP', 'watching things', NOW);
      expect(parseSeatFields(bullet)).toEqual({ inFlight: null, owes: null });
    });

    it("owes: with an empty value -> '', not null (present but empty is not missing)", () => {
      const bullet = formatSeatBullet('ops', 'DOWN', 'stood down\nin-flight: none\nowes:', NOW);
      expect(parseSeatFields(bullet)).toEqual({ inFlight: 'none', owes: '' });
    });
  });

  describe('checkDownFields', () => {
    it('both lines present -> null', () => {
      expect(checkDownFields('x\nin-flight: none\nowes: RCB-1')).toBeNull();
    });

    it('missing in-flight -> the exact error', () => {
      expect(checkDownFields('x\nowes: RCB-1')).toBe(DOWN_ERR);
    });

    it('missing owes -> the exact error', () => {
      expect(checkDownFields('x\nin-flight: none')).toBe(DOWN_ERR);
    });
  });

  describe('checkFieldCounts (RCB-130)', () => {
    it('at most one of each -> null', () => {
      expect(checkFieldCounts('x\nin-flight: a\nowes: b')).toBeNull();
    });

    it('no fields at all -> null (this guard is count-only, never a presence guard)', () => {
      expect(checkFieldCounts('just prose, no fields')).toBeNull();
    });

    it(
      'REPRODUCTION (STATE.md of a member board, 2026-09-25 01:56Z): a --down text carrying TWO in-flight/owes ' +
        'pairs — before this guard, checkDownFields let it straight through as "ok"',
      () => {
        const text =
          'stood down\nin-flight: sonnet A\nowes: RCB-1\nin-flight: sonnet B\nowes: RCB-2 OWNER QUEUE = ACME-86, ACME-119';
        expect(checkFieldCounts(text)).toBe(
          'seat: text has 2 "in-flight:" lines and 2 "owes:" lines — one of each, at most',
        );
        // The control: reverting `checkDownFields` to skip `checkFieldCounts` (or reverting this
        // function to always return null) makes checkDownFields "ok" this shape again.
        expect(checkDownFields(text)).not.toBeNull();
      },
    );

    it('two in-flight, one owes -> names only the over count', () => {
      expect(checkFieldCounts('x\nin-flight: a\nin-flight: b\nowes: c')).toBe(
        'seat: text has 2 "in-flight:" lines — one of each, at most',
      );
    });

    it('one in-flight, three owes -> names only the over count', () => {
      expect(checkFieldCounts('x\nin-flight: a\nowes: b\nowes: c\nowes: d')).toBe(
        'seat: text has 3 "owes:" lines — one of each, at most',
      );
    });
  });

  describe('checkDownFields calls checkFieldCounts first (RCB-130)', () => {
    it('both present but in-flight doubled -> the count error, not null', () => {
      const text = 'x\nin-flight: a\nin-flight: b\nowes: c';
      expect(checkDownFields(text)).toBe(
        'seat: text has 2 "in-flight:" lines — one of each, at most',
      );
    });
  });

  describe('listSeats', () => {
    const section = [
      formatSeatBullet('coordinator', 'UP', 'routing work', NOW),
      formatSeatBullet('builder', 'DOWN', 'stood down\nin-flight: sonnet B\nowes: RCB-2', NOW),
      '- Owner tasks elsewhere: whatever',
    ].join('\n');

    it('2 rows — the non-seat bullet is skipped, never an error; builder carries its in-flight', () => {
      const rows = listSeats(section);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        name: 'coordinator',
        status: 'UP',
        stamp: '2026-09-18 21:00Z',
        inFlight: null,
      });
      expect(rows[1]).toEqual({
        name: 'builder',
        status: 'DOWN',
        stamp: '2026-09-18 21:00Z',
        inFlight: 'sonnet B',
      });
    });

    it('renderSeatList: exact text, columns padded to the widest value', () => {
      // RCB-199: the header gained PANE, LABEL and LIVE; with no holder information all three are `-`.
      const rendered = renderSeatList(seatListRows(section));
      expect(rendered).toBe(
        'NAME         STATUS  STAMP              PANE  LABEL  LIVE  IN-FLIGHT\n' +
          'coordinator  UP      2026-09-18 21:00Z  -     -      -     -\n' +
          'builder      DOWN    2026-09-18 21:00Z  -     -      -     sonnet B\n',
      );
    });

    it('renderSeatList: no rows -> one placeholder line', () => {
      expect(renderSeatList([])).toBe('(no seat bullets in SEATS)\n');
    });
  });

  describe('seatListRows / renderSeatList with holders (RCB-199)', () => {
    const STARTED = 'Tue Sep 29 12:34:56 2026';

    /** A recorded lease as the store reads it, its liveness already decided. */
    function lease(
      seat: string,
      pane: string | null,
      state: 'alive' | 'dead' | 'unknown',
    ): SeatLeaseView {
      return {
        seat,
        holder: { pane, session: null, start: STARTED, host: 'mac-mini', pid: 4242 },
        since: '2026-09-18T20:00:00Z',
        liveness:
          state === 'alive'
            ? { state: 'alive' }
            : state === 'dead'
              ? { state: 'dead', reason: 'no-process' }
              : { state: 'unknown', reason: 'other-host' },
      };
    }

    // A non-seat bullet FIRST, so a row/bullet mix-up (the label of one seat on another) shows.
    const section = [
      '- Owner tasks elsewhere: whatever',
      formatSeatBullet(
        'coordinator',
        'UP',
        'routing work',
        NOW,
        undefined,
        '1D3F · rcb coordinator',
      ),
      formatSeatBullet(
        'builder',
        'UP',
        'building\nin-flight: sonnet B\nowes: RCB-2',
        NOW,
        undefined,
        'A7B2 · rcb builder',
      ),
      formatSeatBullet('ops', 'DOWN', 'stood down\nin-flight: none\nowes: nothing', NOW),
    ].join('\n');

    // `Builder` is capitalised on purpose: the join is case-insensitive. `ops` has no lease.
    const holders = seatHolderInfos(
      [lease('Builder', 'A7B21234', 'dead'), lease('coordinator', '1D3F9999', 'alive')],
      'rcb',
    );

    it('joins each row to the holder of its seat (case-insensitive); label is the bullet own', () => {
      expect(seatListRows(section, holders)).toEqual([
        {
          name: 'coordinator',
          status: 'UP',
          stamp: '2026-09-18 21:00Z',
          inFlight: null,
          label: '1D3F · rcb coordinator',
          tag: '1D3F',
          live: { state: 'alive' },
        },
        {
          name: 'builder',
          status: 'UP',
          stamp: '2026-09-18 21:00Z',
          inFlight: 'sonnet B',
          label: 'A7B2 · rcb builder',
          tag: 'A7B2',
          live: { state: 'dead', reason: 'no-process' },
        },
        {
          name: 'ops',
          status: 'DOWN',
          stamp: '2026-09-18 21:00Z',
          inFlight: 'none',
          label: null,
          tag: null,
          live: null,
        },
      ]);
    });

    it('no holders (the default) is inert: listSeats rows, plus the bullet labels, tag and live null', () => {
      const plain = seatListRows(section);
      expect(plain).toEqual(seatListRows(section, []));
      expect(
        plain.map((r) => ({
          name: r.name,
          status: r.status,
          stamp: r.stamp,
          inFlight: r.inFlight,
        })),
      ).toEqual(listSeats(section));
      expect(plain.map((r) => r.label)).toEqual([
        '1D3F · rcb coordinator',
        'A7B2 · rcb builder',
        null,
      ]);
      expect(plain.map((r) => r.tag)).toEqual([null, null, null]);
      expect(plain.map((r) => r.live)).toEqual([null, null, null]);
    });

    it('a holder whose seat is not on the board joins nothing; a section with no seat bullets has no rows', () => {
      const stray = seatHolderInfos([lease('reviewer', 'ABCD0000', 'alive')], 'rcb');
      expect(seatListRows(section, stray).map((r) => r.tag)).toEqual([null, null, null]);
      expect(seatListRows('- Owner tasks elsewhere: whatever', holders)).toEqual([]);
    });

    it('a holder with no pane joins with tag null but its liveness kept', () => {
      const rows = seatListRows(section, seatHolderInfos([lease('ops', null, 'unknown')], 'rcb'));
      expect(rows[2]).toMatchObject({
        name: 'ops',
        tag: null,
        live: { state: 'unknown', reason: 'other-host' },
      });
    });

    it('renderSeatList: PANE, LABEL and LIVE columns, then a "!" line for the dead holder only', () => {
      expect(renderSeatList(seatListRows(section, holders))).toBe(
        'NAME         STATUS  STAMP              PANE  LABEL                   LIVE              IN-FLIGHT\n' +
          'coordinator  UP      2026-09-18 21:00Z  1D3F  1D3F · rcb coordinator  alive             -\n' +
          'builder      UP      2026-09-18 21:00Z  A7B2  A7B2 · rcb builder      dead: no process  sonnet B\n' +
          'ops          DOWN    2026-09-18 21:00Z  -     -                       -                 none\n' +
          '! builder UP: holder A7B2 is dead: no process\n',
      );
    });

    it('renderSeatList: an unknown holder shows in LIVE but gets no "!" line; a dead holder with no pane is "(no pane)"', () => {
      const rows = seatListRows(
        section,
        seatHolderInfos(
          [lease('ops', null, 'dead'), lease('builder', 'A7B21234', 'unknown')],
          'rcb',
        ),
      );
      expect(renderSeatList(rows)).toBe(
        'NAME         STATUS  STAMP              PANE  LABEL                   LIVE                 IN-FLIGHT\n' +
          'coordinator  UP      2026-09-18 21:00Z  -     1D3F · rcb coordinator  -                    -\n' +
          'builder      UP      2026-09-18 21:00Z  A7B2  A7B2 · rcb builder      unknown: other host  sonnet B\n' +
          'ops          DOWN    2026-09-18 21:00Z  -     -                       dead: no process     none\n' +
          '! ops DOWN: holder (no pane) is dead: no process\n',
      );
    });

    it('renderSeatList: several dead holders get one "!" line each, in row order', () => {
      const rows = seatListRows(
        section,
        seatHolderInfos(
          [lease('ops', 'ABCD0000', 'dead'), lease('coordinator', '1D3F9999', 'dead')],
          'rcb',
        ),
      );
      const lines = renderSeatList(rows).split('\n');
      expect(lines.filter((l) => l.startsWith('!'))).toEqual([
        '! coordinator UP: holder 1D3F is dead: no process',
        '! ops DOWN: holder ABCD is dead: no process',
      ]);
    });
  });

  describe('renderSeatBundle: In flight / owes section', () => {
    it('sits FIRST, before ## SEATS line', () => {
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: [
          formatSeatBullet('builder', 'DOWN', 'stood down\nin-flight: none\nowes: RCB-1', NOW),
        ].join('\n'),
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      expect(bundle.inFlight).toBe('none');
      expect(bundle.owes).toBe('RCB-1');
      const rendered = renderSeatBundle(bundle, NOW);
      const inFlightIdx = rendered.indexOf('## In flight / owes');
      const seatsIdx = rendered.indexOf('## SEATS line');
      const firstHeadingIdx = rendered.indexOf('## ');
      expect(inFlightIdx).toBeGreaterThan(0);
      expect(inFlightIdx).toBe(firstHeadingIdx);
      expect(seatsIdx).toBeGreaterThan(inFlightIdx);
      expect(rendered).toContain('in-flight: none');
      expect(rendered).toContain('owes: RCB-1');
    });
  });
});

describe('systems line (RCB-97)', () => {
  const summary: SystemsSummary = {
    systems: 3,
    connections: 2,
    envs: 'dev+prod',
    line: 'Systems: 3 systems, 2 connections, dev+prod — repoboard systems',
  };

  it('seatBundle carries input.systems through, null when absent', () => {
    const withSummary = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      systems: summary,
    });
    expect(withSummary.systems).toEqual(summary);

    const without = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(without.systems).toBeNull();
  });

  it('with a summary: exactly one line, starting "Systems:", right after "owes:"', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      systems: summary,
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const lines = rendered.split('\n');
    const owesIdx = lines.findIndex((l) => l.startsWith('owes:'));
    expect(owesIdx).toBeGreaterThanOrEqual(0);
    expect(lines[owesIdx + 1]).toBe(summary.line);
    expect(lines.filter((l) => l.startsWith('Systems:'))).toEqual([summary.line]);
  });

  it('without a summary: output contains no "Systems:" line', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('Systems:');
  });
});

/** A card whose decision has already been answered, `decision` built directly (not via
 * `askDecision`/`decide`) so each test controls `decidedAt`/`decidedBy` and the body's
 * `## Log`/`## Notes` bullets exactly. */
function answeredCard(
  id: string,
  opts: { decidedBy: string; decidedAt: string; chosen?: string | null; body?: string },
): Card {
  return card({
    id,
    body: opts.body ?? '',
    decision: {
      question: 'Ship it?',
      options: [{ letter: 'A', text: 'yes' }],
      askedBy: 'claude/coordinator',
      askedAt: '2026-09-24T18:00:00Z',
      returnTo: null,
      chosen: opts.chosen ?? 'A',
      words: null,
      decidedBy: opts.decidedBy,
      decidedAt: opts.decidedAt,
    },
  });
}

describe('seatBundle: answeredNotAck (RCB-129)', () => {
  it('an answered, unacknowledged decision appears in answeredNotAck and the render block', () => {
    const cards = [
      answeredCard('RCB-1', { decidedBy: 'owner', decidedAt: '2026-09-24T18:19:51Z' }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.answeredNotAck).toHaveLength(1);
    expect(bundle.answeredNotAck[0]).toMatchObject({ id: 'RCB-1', acknowledged: false });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('RCB-1 · Ship it? → A: yes (decided 2026-09-24T18:19:51Z by owner)');
  });

  it('a ## Notes line after decidedAt by another actor (card note) acknowledges it — drops out', () => {
    const cards = [
      answeredCard('RCB-1', {
        decidedBy: 'owner',
        decidedAt: '2026-09-24T18:19:51Z',
        body: '\n## Notes\n- 2026-09-24T18:26:00Z builder — ack\n',
      }),
    ];
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards,
    });
    expect(bundle.answeredNotAck).toEqual([]);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Answered, not acknowledged');
    expect(rendered).toContain('(none)');
  });

  it('no answered decisions at all: the block prints (none)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.answeredNotAck).toEqual([]);
    const rendered = renderSeatBundle(bundle, NOW);
    const idx = rendered.indexOf('## Answered, not acknowledged');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(rendered.slice(idx)).toContain('(none)');
  });
});

describe('leases surfaced in seat <name> (RCB-131)', () => {
  function leasesDoc(...leases: LeasesDoc['leases']): LeasesDoc {
    return { leases, windows: [] };
  }

  it('seatBundle carries only LIVE leases through — a stale one is excluded', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc(
        { resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
        {
          resource: 'dev-server',
          holder: 'claude/builder',
          since: '2026-09-18T10:00:00Z',
          until: '2026-09-18T11:00:00Z', // stale: before NOW (21:00Z)
        },
      ),
    });
    expect(bundle.leases).toEqual([
      { resource: 'vitest-lock', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
    ]);
  });

  it('defaults to [] when input.leases is absent — no live leases, not a throw', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.leases).toEqual([]);
  });

  it('renders "## Leases" right after "## SEATS line", before "## Rig", one line per live lease', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: SEATS, // RCB-140: non-solo, so every section renders
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      rig: '# RIG — laptop',
      leases: leasesDoc({
        resource: 'vitest-lock',
        holder: 'claude/ops',
        since: '2026-09-18T20:00:00Z',
        until: '2026-09-18T21:30:00Z',
        note: 'running the suite',
      }),
    });
    const rendered = renderSeatBundle(bundle, NOW);
    const seatsIdx = rendered.indexOf('## SEATS line');
    const leasesIdx = rendered.indexOf('## Leases');
    const rigIdx = rendered.indexOf('## Rig');
    expect(seatsIdx).toBeGreaterThanOrEqual(0);
    expect(leasesIdx).toBeGreaterThan(seatsIdx);
    expect(rigIdx).toBeGreaterThan(leasesIdx);
    expect(rendered).toContain(
      'vitest-lock · claude/ops · since 20:00Z · until 21:30Z · "running the suite"',
    );
  });

  it('suffixes " (yours)" when the lease holder matches the seat name, case-insensitive/trimmed', () => {
    const bundle = seatBundle({
      name: ' Builder ',
      now: NOW,
      seatsSection: SEATS,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc(
        { resource: 'dev-server', holder: 'builder', since: '2026-09-18T20:00:00Z' },
        { resource: 'lane-a', holder: 'claude/ops', since: '2026-09-18T20:00:00Z' },
      ),
    });
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('dev-server · builder · since 20:00Z · until — (yours)');
    expect(rendered).toContain('lane-a · claude/ops · since 20:00Z · until —');
    expect(rendered).not.toContain('lane-a · claude/ops · since 20:00Z · until — (yours)');
  });

  it(
    'no live leases: "(no live leases)", never an empty section — the control: reverting this ' +
      'line to `renderLeaseLines(b.leases, now)` with an unfiltered stale lease must fail',
    () => {
      const bundle = seatBundle({
        name: 'builder',
        now: NOW,
        seatsSection: SEATS,
        ownBlock: null,
        coordinatorBlock: null,
        cards: [],
      });
      const rendered = renderSeatBundle(bundle, NOW);
      expect(rendered).toContain('## Leases\n(no live leases)');
    },
  );

  it('solo board with no live leases: the "## Leases" section is dropped, like the other placeholders (RCB-140)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
    });
    expect(bundle.solo).toBe(true);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).not.toContain('## Leases');
  });

  it('solo board WITH a live lease: the "## Leases" section still prints (mirrors ownBlock/rig)', () => {
    const bundle = seatBundle({
      name: 'builder',
      now: NOW,
      seatsSection: null,
      ownBlock: null,
      coordinatorBlock: null,
      cards: [],
      leases: leasesDoc({
        resource: 'dev-server',
        holder: 'claude/ops',
        since: '2026-09-18T20:00:00Z',
      }),
    });
    expect(bundle.solo).toBe(true);
    const rendered = renderSeatBundle(bundle, NOW);
    expect(rendered).toContain('## Leases');
    expect(rendered).toContain('dev-server · claude/ops · since 20:00Z · until —');
  });
});

/**
 * RCB-160: automatic from the board — `formatSeatBullet`/`rewriteSeatBulletBody` write a
 * `[repo] ` prefix INSIDE the bold span, ahead of the seat name; every reader that derives a
 * label/name (`findSeatLine`'s `locateSeatBullet`, `parseSeatStamp`, `listSeats`) must strip it
 * back out, so a repo name can never be mistaken for a seat's own name.
 */
describe('RCB-160: the [repo] prefix on a SEATS bullet', () => {
  it('(1) formatSeatBullet writes a `[repo] ` prefix inside the bold span, ahead of the name', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'holding RCB-160', NOW, 'repoboard');
    expect(bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160');
  });

  it('(2) an old, unprefixed bullet still parses exactly as before — findSeatLine finds it, parseSeatStamp reads it', () => {
    const seats = [
      '- **coordinator**: routes work',
      '- **builder: UP 2026-09-18 21:00Z.** holding RCB-1',
    ].join('\n');
    const line = findSeatLine(seats, 'builder');
    expect(line).toBe('- **builder: UP 2026-09-18 21:00Z.** holding RCB-1');
    expect(parseSeatStamp(line ?? '')).toEqual({
      status: 'UP',
      at: new Date('2026-09-18T21:00:00Z'),
    });
  });

  it('(3) `seat repoboard` does not match a bullet merely PREFIXED `[repoboard]` — the label is stripped before the match', () => {
    const seats = [
      '- **coordinator**: routes work',
      '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ].join('\n');
    expect(findSeatLine(seats, 'repoboard')).toBeNull();
    // The real seat still matches, prefix and all.
    expect(findSeatLine(seats, 'builder')).toBe(
      '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    );
  });

  it("a prefixed bullet's NAME (listSeats) is the bare seat name, never the repo", () => {
    const seats = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    const rows = listSeats(seats);
    expect(rows).toEqual([
      { name: 'builder', status: 'UP', stamp: '2026-09-18 21:00Z', inFlight: null },
    ]);
  });

  it("rewriteSeatBulletBody: omitting `repo` keeps the bullet's own existing prefix byte-for-byte", () => {
    const bullet = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** a';
    const res = rewriteSeatBulletBody(bullet, 'b');
    expect(res?.bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** b');
  });

  it('rewriteSeatBulletBody: passing `repo` replaces whatever prefix (if any) was there', () => {
    const bullet = '- **builder: UP 2026-09-18 21:00Z.** a';
    const res = rewriteSeatBulletBody(bullet, 'b', 'repoboard');
    expect(res?.bullet).toBe('- **[repoboard] builder: UP 2026-09-18 21:00Z.** b');
  });
});

/**
 * RCB-160 slice 2: `keySeatBullets` is what the WORKSPACE view uses to show a member's SEATS
 * bullets under the `repos[].key` OWNER QUEUE/LEASES already print — never under whatever the
 * member calls itself (slice 1's own `[repo] ` prefix).
 */
describe('keySeatBullets (RCB-160 slice 2)', () => {
  it('replace: an existing `[x] ` prefix is REPLACED by `[key] `', () => {
    const seats = '- **[repoboard] builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    expect(keySeatBullets(seats, 'aa')).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ]);
  });

  it('insert: an unprefixed bold bullet gets `[key] ` right after `- **`', () => {
    const seats = '- **builder: UP 2026-09-18 21:00Z.** holding RCB-160';
    expect(keySeatBullets(seats, 'aa')).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z.** holding RCB-160',
    ]);
  });

  it('insert: an unprefixed, non-bold bullet gets `[key] ` right after `- `', () => {
    expect(keySeatBullets('- ops: watching things', 'aa')).toEqual(['- [aa] ops: watching things']);
  });

  it('continuation lines: whole bullet text kept, only the FIRST line is re-prefixed', () => {
    const seats = [
      '- **builder: UP 2026-09-18 21:00Z.** on RCB-1',
      '  continuation line here',
    ].join('\n');
    expect(keySeatBullets(seats, 'aa')).toEqual([
      ['- **[aa] builder: UP 2026-09-18 21:00Z.** on RCB-1', '  continuation line here'].join('\n'),
    ]);
  });

  it('one entry per top-level bullet, in section order', () => {
    expect(keySeatBullets(SEATS, 'aa')).toEqual([
      [
        '- **[aa] repoboard builder (its own terminal, no autonomy)**: on RCB-1',
        '  continuation line here',
      ].join('\n'),
      '- **[aa] ops**: watching things',
      '- **[aa] coordinator**: routes work',
    ]);
  });

  it('placeholder: a section with no "- " line -> []', () => {
    expect(keySeatBullets(SECTION_PLACEHOLDER, 'aa')).toEqual([]);
  });
});

/**
 * RCB-195 (slice A of RCB-194): a SEATS bullet carries WHO holds the seat as a short label —
 * `- **[r] name: UP <stamp> · 1D3F · rcb builder.** text`. Everything written before this card has
 * no label and must parse, list, find and rewrite exactly as it did.
 */
describe('RCB-195: the holder label on a SEATS bullet', () => {
  const LABEL = '1D3F · rcb builder';
  const OPS_LABEL = '0A1F · rcb ops';

  it('(1) formatSeatBullet writes ` · <label>` after the stamp, inside the bold span', () => {
    expect(formatSeatBullet('builder', 'UP', 'holding RCB-195', NOW, undefined, LABEL)).toBe(
      '- **builder: UP 2026-09-18 21:00Z · 1D3F · rcb builder.** holding RCB-195',
    );
  });

  it('(2) with a `[repo] ` prefix as well: the prefix leads the name, the label follows the stamp', () => {
    expect(formatSeatBullet('builder', 'DOWN', 'x\ny', NOW, 'repoboard', LABEL)).toBe(
      '- **[repoboard] builder: DOWN 2026-09-18 21:00Z · 1D3F · rcb builder.** x\n  y',
    );
  });

  it('(3) no label — undefined, null, empty or blank — writes exactly the bullet it always did', () => {
    const plain = formatSeatBullet('builder', 'UP', 'x', NOW);
    expect(plain).toBe('- **builder: UP 2026-09-18 21:00Z.** x');
    for (const none of [undefined, null, '', '  \n ', '***']) {
      expect(formatSeatBullet('builder', 'UP', 'x', NOW, undefined, none), String(none)).toBe(
        plain,
      );
    }
  });

  it('(4) a label cannot break the bullet: `*` is dropped and whitespace collapsed', () => {
    const bullet = formatSeatBullet(
      'builder',
      'UP',
      'x',
      NOW,
      undefined,
      ' 1D3F **·**\n rcb   builder ',
    );
    expect(bullet).toBe('- **builder: UP 2026-09-18 21:00Z · 1D3F · rcb builder.** x');
    expect(parseSeatHolderLabel(bullet)).toBe(LABEL);
  });

  it('(5) parseSeatHolderLabel: the label of a labeled bullet, with or without a `[repo] ` prefix', () => {
    expect(
      parseSeatHolderLabel(formatSeatBullet('builder', 'UP', 'x', NOW, undefined, LABEL)),
    ).toBe(LABEL);
    expect(
      parseSeatHolderLabel(formatSeatBullet('builder', 'UP', 'x', NOW, 'repoboard', LABEL)),
    ).toBe(LABEL);
  });

  it('(5) parseSeatHolderLabel: null for an unlabeled bullet, a hand-written one, a non-seat bullet', () => {
    expect(parseSeatHolderLabel(formatSeatBullet('builder', 'UP', 'x', NOW))).toBeNull();
    expect(
      parseSeatHolderLabel(
        '- **coordinator (shared): UP 2026-09-18 20:2xZ, cold-started from SEATS.** Verified',
      ),
    ).toBeNull();
    expect(parseSeatHolderLabel('- Owner tasks elsewhere: whatever')).toBeNull();
    expect(parseSeatHolderLabel('')).toBeNull();
  });

  it('(5) parseSeatHolderLabel reads the FIRST line only, and survives a stamp that fails to parse', () => {
    const later = '- **builder: UP 2026-09-18 21:00Z.** text\n  · 1D3F · rcb builder.** more';
    expect(parseSeatHolderLabel(later)).toBeNull();
    const bad = '- **ops: UP 2026-09-02 18:0xZ · 0A1F · rcb ops.** a';
    expect(parseSeatHolderLabel(bad)).toBe(OPS_LABEL);
    expect(parseSeatStamp(bad)).toEqual({ status: 'UP', at: null });
  });

  it('(6) parseSeatStamp reads a labeled bullet exactly as an unlabeled one', () => {
    const labeled = formatSeatBullet('builder', 'UP', 'x', NOW, undefined, LABEL);
    expect(parseSeatStamp(labeled)).toEqual({ status: 'UP', at: NOW });
    const down = formatSeatBullet('builder', 'DOWN', 'x', NOW, 'repoboard', LABEL);
    expect(parseSeatStamp(down)).toEqual({ status: 'DOWN', at: NOW });
  });

  it('(7) round trip WITHOUT a label: format -> replace -> find returns the bullet, label null', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'holding RCB-195', NOW);
    const replaced = replaceSeatBullet(SEATS, 'builder', bullet);
    expect(findSeatLine(replaced, 'builder')).toBe(bullet);
    expect(parseSeatHolderLabel(findSeatLine(replaced, 'builder') ?? '')).toBeNull();
  });

  it('(7) round trip WITH a label: format -> replace -> find returns the bullet, label intact', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'holding RCB-195', NOW, undefined, LABEL);
    const replaced = replaceSeatBullet(SEATS, 'builder', bullet);
    expect(findSeatLine(replaced, 'builder')).toBe(bullet);
    expect(parseSeatHolderLabel(findSeatLine(replaced, 'builder') ?? '')).toBe(LABEL);
    // The other bullets are untouched, byte for byte.
    expect(findSeatLine(replaced, 'ops')).toBe('- **ops**: watching things');
  });

  it('(8) rewriteSeatBulletBody keeps the label byte-for-byte and replaces only the body', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'a', NOW, undefined, LABEL);
    const rewritten = rewriteSeatBulletBody(bullet, 'b');
    expect(rewritten?.bullet).toBe('- **builder: UP 2026-09-18 21:00Z · 1D3F · rcb builder.** b');
    expect(rewritten?.status).toBe('UP');
    expect(rewritten?.stamp).toBe('2026-09-18 21:00Z');
    expect(parseSeatHolderLabel(rewritten?.bullet ?? '')).toBe(LABEL);
  });

  it('(8) rewriteSeatBulletBody keeps the label through a `[repo] ` change, a DOWN bullet and a multi-line body', () => {
    const bullet = formatSeatBullet('builder', 'DOWN', 'a', NOW, 'repoboard', LABEL);
    expect(rewriteSeatBulletBody(bullet, 'x\ny')?.bullet).toBe(
      '- **[repoboard] builder: DOWN 2026-09-18 21:00Z · 1D3F · rcb builder.** x\n  y',
    );
    expect(rewriteSeatBulletBody(bullet, 'b', 'other')?.bullet).toBe(
      '- **[other] builder: DOWN 2026-09-18 21:00Z · 1D3F · rcb builder.** b',
    );
  });

  it('(8) rewriteSeatBulletBody keeps a label of any shape and an unparseable stamp verbatim', () => {
    expect(rewriteSeatBulletBody('- **ops: DOWN 2026-09-18 21:00Z · web.** a', 'b')?.bullet).toBe(
      '- **ops: DOWN 2026-09-18 21:00Z · web.** b',
    );
    const bad = '- **ops: UP 2026-09-02 18:0xZ · 0A1F · rcb ops.** a';
    expect(rewriteSeatBulletBody(bad, 'b')?.bullet).toBe(
      '- **ops: UP 2026-09-02 18:0xZ · 0A1F · rcb ops.** b',
    );
  });

  it('(8) rewriteSeatBulletBody never adds a label to a bullet that had none', () => {
    const bullet = formatSeatBullet('builder', 'UP', 'a', NOW);
    expect(rewriteSeatBulletBody(bullet, 'b')?.bullet).toBe(
      '- **builder: UP 2026-09-18 21:00Z.** b',
    );
  });

  describe('two labeled bullets, both found', () => {
    const builderBullet = formatSeatBullet(
      'builder',
      'UP',
      'on RCB-195\nin-flight: sonnet A\nowes: none',
      NOW,
      undefined,
      LABEL,
    );
    const opsBullet = formatSeatBullet(
      'ops',
      'DOWN',
      'stood down\nin-flight: none\nowes: RCB-9',
      NOW,
      undefined,
      OPS_LABEL,
    );
    const section = [builderBullet, opsBullet].join('\n');

    it('(9) findSeatLine finds `builder` and `ops`, each its own whole bullet', () => {
      expect(findSeatLine(section, 'builder')).toBe(builderBullet);
      expect(findSeatLine(section, 'ops')).toBe(opsBullet);
    });

    it('(9) listSeats names, statuses, stamps and in-flight are the ones the bullets say', () => {
      expect(listSeats(section)).toEqual([
        { name: 'builder', status: 'UP', stamp: '2026-09-18 21:00Z', inFlight: 'sonnet A' },
        { name: 'ops', status: 'DOWN', stamp: '2026-09-18 21:00Z', inFlight: 'none' },
      ]);
    });

    it('(9) replaceSeatBullet on one seat leaves the other labeled bullet byte-identical', () => {
      const next = formatSeatBullet('ops', 'UP', 'back', NOW, undefined, OPS_LABEL);
      expect(replaceSeatBullet(section, 'ops', next)).toBe([builderBullet, next].join('\n'));
    });
  });

  it('(10) parseSeatFields reads an in-flight on the FIRST line, after the label', () => {
    const bullet = formatSeatBullet('ops', 'UP', 'in-flight: sonnet B', NOW, undefined, OPS_LABEL);
    expect(bullet).toBe('- **ops: UP 2026-09-18 21:00Z · 0A1F · rcb ops.** in-flight: sonnet B');
    expect(parseSeatFields(bullet)).toEqual({ inFlight: 'sonnet B', owes: null });
  });

  it("(11) the label's words are never the seat's name: `rcb` and `builder` in a label match nothing", () => {
    const labeled = formatSeatBullet('ops', 'UP', 'x', NOW, 'repoboard', '1D3F · builder ops');
    expect(findSeatLine(labeled, 'builder')).toBeNull();
    expect(findSeatLine(labeled, 'repoboard')).toBeNull();
    expect(findSeatLine(labeled, 'ops')).toBe(labeled);
    const short = formatSeatBullet('builder', 'UP', 'x', NOW, undefined, LABEL);
    expect(findSeatLine(short, 'rcb')).toBeNull();
    expect(findSeatLine(short, 'builder')).toBe(short);
  });

  it("(11) a seat with no bullet of its own is not handed another seat's, and gets its own appended", () => {
    const coordinator = formatSeatBullet(
      'coordinator',
      'UP',
      'routing',
      NOW,
      undefined,
      '1D3F · builder coordinator',
    );
    expect(findSeatLine(coordinator, 'builder')).toBeNull();
    const mine = formatSeatBullet('builder', 'UP', 'mine', NOW, undefined, LABEL);
    expect(replaceSeatBullet(coordinator, 'builder', mine)).toBe([coordinator, mine].join('\n'));
  });

  it('(12) a labeled bullet with a `[repo] ` prefix lists under its bare seat name', () => {
    const section = formatSeatBullet('builder', 'UP', 'x', NOW, 'repoboard', LABEL);
    expect(listSeats(section)).toEqual([
      { name: 'builder', status: 'UP', stamp: '2026-09-18 21:00Z', inFlight: null },
    ]);
  });

  it('(13) keySeatBullets re-prefixes a labeled bullet and leaves the label alone', () => {
    const section = formatSeatBullet('builder', 'UP', 'x', NOW, 'repoboard', LABEL);
    expect(keySeatBullets(section, 'aa')).toEqual([
      '- **[aa] builder: UP 2026-09-18 21:00Z · 1D3F · rcb builder.** x',
    ]);
  });
});

describe('seatBundle: the holder (RCB-199)', () => {
  const base = {
    now: NOW,
    seatsSection: SEATS,
    ownBlock: null,
    coordinatorBlock: null,
    cards: [] as Card[],
  };

  const lease = (seat: string, pane: string | null): SeatLeaseView => ({
    seat,
    holder: { pane, session: null, start: 'Tue Sep 29 12:34:56 2026', host: 'mac-mini', pid: 4242 },
    since: '2026-09-18T20:00:00Z',
    liveness: { state: 'alive' },
  });

  const holders = seatHolderInfos(
    [lease('builder', 'A7B21234'), lease('coordinator', '1D3F9999')],
    'rcb',
  );

  it('no holders gathered (the default) -> holder null, holderError null', () => {
    const bundle = seatBundle({ ...base, name: 'builder' });
    expect(bundle.holder).toBeNull();
    expect(bundle.holderError).toBeNull();
  });

  it('the holder of the seat, whole (tag, label, liveness), matched by name', () => {
    const bundle = seatBundle({ ...base, name: 'builder', holders });
    expect(bundle.holder).toEqual(holders[0]);
    expect(bundle.holder).toMatchObject({
      seat: 'builder',
      tag: 'A7B2',
      label: 'A7B2 · rcb builder',
      liveness: { state: 'alive' },
    });
  });

  it('the name is trimmed and compared case-insensitively', () => {
    expect(seatBundle({ ...base, name: '  Coordinator ', holders }).holder?.seat).toBe(
      'coordinator',
    );
  });

  it('a seat nobody holds -> holder null, even when other seats have holders', () => {
    expect(seatBundle({ ...base, name: 'ops', holders }).holder).toBeNull();
  });

  it('holderError is passed through untouched, and does not invent a holder', () => {
    const bundle = seatBundle({ ...base, name: 'builder', holderError: 'seats.yml: bad yaml' });
    expect(bundle.holderError).toBe('seats.yml: bad yaml');
    expect(bundle.holder).toBeNull();
  });

  it('renderSeatBundle prints exactly what it printed before — the holder is not rendered', () => {
    const without = renderSeatBundle(seatBundle({ ...base, name: 'builder' }), NOW);
    const withHolder = renderSeatBundle(
      seatBundle({ ...base, name: 'builder', holders, holderError: 'x' }),
      NOW,
    );
    expect(withHolder).toBe(without);
  });
});
