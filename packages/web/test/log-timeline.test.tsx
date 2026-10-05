/**
 * P8.3, locked decision 7: the daily log as a timeline — newest block first, a seat avatar, the
 * title, and an expand-for-text disclosure. RCB-66: it is now the LOG row's body in `StatePanel`
 * (closed by default), so every test opens the row first. RCB-218: the row's label names the day
 * when the payload is not today's, and each block carries a ▲ ▼ ✓ • mark (each test below that
 * is new names its CONTROL — the perturbation of the source that makes it fail; none was run,
 * the brief forbids any runner, the gating seat watches each fail).
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logBlockKind, logDayLabel } from '../src/components/LogTimeline.jsx';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') }));
afterEach(() => vi.useRealTimers());

function openLog() {
  fireEvent.click(screen.getByRole('button', { name: /^LOG/ }));
}

/**
 * RCB-143: a real click on `<summary>` toggles `.open` synchronously in jsdom but fires the
 * `toggle` event itself on a later task (measured directly against jsdom 30, outside vitest: the
 * event lands after several microtask ticks, not on one) — which `onToggle` depends on. Setting
 * `.open` and dispatching `toggle` directly exercises the same handler synchronously, so a plain
 * (non-`async`) test can assert on the result immediately after.
 */
function openBlock(details: Element) {
  (details as HTMLDetailsElement).open = true;
  fireEvent(details, new Event('toggle'));
}

const LOG_TEXT = [
  '# Log — 2026-09-02',
  '',
  '##### OPS 2026-09-02T18:00:00Z: armed the fires',
  '',
  'Five waiters set.',
  '',
  '##### BUILDER 2026-09-02T18:30:00Z: K117 landed',
  '',
  'Two copy lines shipped.',
  '',
].join('\n');

describe('LogTimeline', () => {
  it('with no log payload at all, reads as "no log entries today" once the row is open', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no log arg
    renderApp(store);
    openLog();
    expect(screen.getByTestId('log-timeline')).toHaveTextContent('no log entries today');
  });

  it('orders blocks newest first', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const summaries = timeline.querySelectorAll('.log-timeline__summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveTextContent('BUILDER');
    expect(summaries[0]).toHaveTextContent('K117 landed');
    expect(summaries[1]).toHaveTextContent('OPS');
    expect(summaries[1]).toHaveTextContent('armed the fires');
  });

  // RCB-62 (finding 3): MEASURED first (before this fix) — `relTime` itself returns `''` on
  // `Date.parse` NaN (unchanged), and this test's failure, pre-fix, showed the RENDERED result
  // for a redacted sibling stamp was `''` (blank), not the card's suspected "Invalid Date" — so
  // the bug is "blank", not "Invalid Date"; the fix is the same either way: show it verbatim.
  it('a redacted sibling stamp is shown VERBATIM, never blank and never "Invalid Date"', () => {
    const store = testStore();
    const text = [
      '# Log — 2026-09-18',
      '',
      '##### OPS 2026-09-18 21:4xZ: hand-written by the sibling',
      '',
      'text',
      '',
    ].join('\n');
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-18',
      text,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const when = timeline.querySelector('.log-timeline__when');
    expect(when?.textContent).toBe('2026-09-18 21:4xZ');
    expect(when?.textContent).not.toBe('');
    expect(when?.textContent).not.toContain('Invalid Date');
  });

  it('a parseable ISO stamp still renders the relative "…ago" form', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const whens = [...timeline.querySelectorAll('.log-timeline__when')].map((n) => n.textContent);
    expect(whens.some((t) => t?.endsWith('ago') || t === 'just now')).toBe(true);
  });

  it('the full text is inside a <details> disclosure, collapsed by default', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const items = timeline.querySelectorAll('details.log-timeline__item');
    expect(items).toHaveLength(2);
    for (const item of items) expect((item as HTMLDetailsElement).open).toBe(false);
  });

  // RCB-143: pins `LogTimeline.tsx`'s `open ? <div className="log-timeline__text" ... /> : null` —
  // reverting that to always render the body (the pre-fix `<pre>`) puts 'Five waiters set.' in the
  // DOM before any toggle, and this assertion catches it.
  it("a closed block's body markup is not in the DOM before the toggle", () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    expect(timeline.querySelector('.log-timeline__text')).toBeNull();
    expect(timeline).not.toHaveTextContent('Five waiters set.');
  });

  // RCB-143: pins `LogTimeline.tsx`'s `dangerouslySetInnerHTML={{ __html: renderNote(b.text) }}` —
  // reverting to the plain-text `<pre>` leaves the literal `**bold**` / backtick text with no
  // `<strong>`/`<code>` element at all, so this assertion catches it.
  it('a block body with **bold** and `code` renders <strong> and <code> once opened', () => {
    const store = testStore();
    const text = [
      '# Log — 2026-09-02',
      '',
      '##### OPS 2026-09-02T18:00:00Z: markdown block',
      '',
      'a **bold** word and `a code span`.',
      '',
    ].join('\n');
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const item = timeline.querySelector('details.log-timeline__item');
    expect(item).not.toBeNull();
    openBlock(item as Element);
    const body = timeline.querySelector('.log-timeline__text');
    expect(body?.querySelector('strong')?.textContent).toBe('bold');
    expect(body?.querySelector('code')?.textContent).toBe('a code span');
  });

  // RCB-143: pins the sanitizer step of that same `renderNote` call — DOMPurify strips the
  // `<script>` element and the `onerror` attribute before the HTML ever reaches
  // `dangerouslySetInnerHTML`. Reverting to raw, unsanitized markdown-to-HTML (no DOMPurify pass)
  // leaves the `<script>` element and/or the `onerror` attribute in the DOM, so this catches it.
  it('a <script>/onerror payload in a block body does not reach the DOM', () => {
    const store = testStore();
    const text = [
      '# Log — 2026-09-02',
      '',
      '##### OPS 2026-09-02T18:00:00Z: hostile block',
      '',
      '<script>window.__pwned = true;</script><img src="x" onerror="window.__pwned = true">',
      '',
    ].join('\n');
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const item = timeline.querySelector('details.log-timeline__item');
    expect(item).not.toBeNull();
    openBlock(item as Element);
    const body = timeline.querySelector('.log-timeline__text');
    expect(body?.querySelector('script')).toBeNull();
    expect(body?.innerHTML).not.toContain('onerror');
  });

  // RCB-66: the LOG row head shows the count (and, when non-zero, the newest block's "when") so a
  // closed row still tells the viewer whether there is anything today.
  it('the LOG row head reads "no log entries today" with no payload', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no log arg
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('no log entries today');
  });

  it('the LOG row head reads "2 blocks today" with two blocks', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('2 blocks today');
  });
});

// ---- RCB-218: the day the LOG row is showing, and a mark per block -------------------------------

const MARKS_LOG = [
  '# Log — 2026-09-02',
  '',
  '##### BUILDER 2026-09-02T09:00:00Z: brief dispatched to a subagent',
  '',
  'text',
  '',
  '##### BUILDER 2026-09-02T09:10:00Z: RB-9 LANDED 7e2c118: the guard scans every commit',
  '',
  'text',
  '',
  '##### BUILDER 2026-09-02T09:20:00Z: DOWN at the context line: RB-9 landed',
  '',
  'text',
  '',
  '##### BUILDER 2026-09-02T09:30:00Z: UP (A7B2): RB-10 next',
  '',
  'text',
  '',
].join('\n');

describe('logBlockKind', () => {
  // CONTROL: in LogTimeline.tsx change `LOG_KIND_RE.up` to `/UP/` — "BACKUP", "UP-TO-DATE" and
  // "SETUP" read as a seat coming up and the `other` rows fail; drop the `(?<![\w-])` look-behind on
  // `down` — "COUNTDOWN" reads as ▼.
  it.each([
    ['UP (A7B2): RB-10 next', 'up'],
    ['DOWN at the context line: RB-9 landed', 'down'],
    ['RB-9 LANDED 7e2c118: the guard', 'landed'],
    ['brief dispatched to a subagent', 'other'],
    ['set up the rig', 'other'], // lower-case: prose, not a seat coming up
    ['BACKUP finished', 'other'],
    ['UP-TO-DATE check', 'other'],
    ['COUNTDOWN started', 'other'],
    ['', 'other'],
  ])('%j is %s', (title, kind) => {
    expect(logBlockKind(title)).toBe(kind);
  });

  // CONTROL: in LogTimeline.tsx `logBlockKind` check the kinds in a fixed order (up, down, landed
  // with early returns) instead of by position — the second row reads ▲ and this fails.
  it('a title naming more than one is the one whose keyword comes first', () => {
    expect(logBlockKind('DOWN: RB-9 LANDED')).toBe('down');
    expect(logBlockKind('RB-9 LANDED, builder UP')).toBe('landed');
    expect(logBlockKind('UP: finishing what LANDED earlier')).toBe('up');
  });
});

describe('logDayLabel', () => {
  const now = Date.parse('2026-09-02T22:41:10Z');

  // CONTROL: in LogTimeline.tsx `logDayLabel` delete the `yesterday` branch — the second row fails;
  // delete the first `date === …` comparison — the first row fails.
  it('today, yesterday, or the date itself', () => {
    expect(logDayLabel('2026-09-02', now)).toBe('today');
    expect(logDayLabel('2026-09-01', now)).toBe('yesterday');
    expect(logDayLabel('2026-08-30', now)).toBe('2026-08-30');
    expect(logDayLabel(undefined, now)).toBe('today');
  });

  it('a day across a month boundary is still "yesterday"', () => {
    expect(logDayLabel('2026-08-31', Date.parse('2026-09-01T00:30:00Z'))).toBe('yesterday');
  });
});

describe('the LOG row names the day when it is not today', () => {
  // CONTROL: in StatePanel.tsx replace `${day}` in `logMeta` with the literal `today` — the
  // "yesterday" and the date rows fail.
  it('yesterday: "N blocks yesterday · <age>"', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-01',
      text: LOG_TEXT.replaceAll('2026-09-02', '2026-09-01'),
    });
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('2 blocks yesterday');
    expect(head).not.toHaveTextContent('today');
    // The newest block (18:30 yesterday) is 28h11m before the pinned 22:41 clock.
    expect(head).toHaveTextContent('28h ago');
  });

  it('an older day: "N blocks on <date> · <age>"', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-08-30',
      text: LOG_TEXT.replaceAll('2026-09-02', '2026-08-30'),
    });
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('2 blocks on 2026-08-30');
    // 18:30 on the 30th to 22:41 on the 2nd: 76h11m, which `relTime` rounds to 3 days.
    expect(head).toHaveTextContent('3d ago');
  });

  it('today keeps its old wording', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: LOG_TEXT,
    });
    renderApp(store);
    const head = screen.getByRole('button', { name: /^LOG/ });
    expect(head).toHaveTextContent('2 blocks today');
  });
});

describe('a mark per block', () => {
  // CONTROL: in LogTimeline.tsx render `LOG_MARK.other` for every block — only • appears.
  it('▲ for UP, ▼ for DOWN, ✓ for LANDED, • for the rest — newest block first', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: MARKS_LOG,
    });
    renderApp(store);
    openLog();
    const marks = [...screen.getByTestId('log-timeline').querySelectorAll('.log-timeline__mark')];
    expect(marks.map((m) => m.textContent)).toEqual(['▲', '▼', '✓', '•']);
    expect(marks.map((m) => m.getAttribute('data-kind'))).toEqual([
      'up',
      'down',
      'landed',
      'other',
    ]);
  });
});

describe('a row is a grid: mark · time · seat · title (RCB-223)', () => {
  // CONTROL: in LogTimeline.tsx move the `.log-timeline__when` span back after the title — the
  // class order assertion fails (the old ragged layout); drop `log-timeline__summary` from the
  // `<summary>` — the CSS grid never applies and the first assertion fails; replace the mark span
  // with `LOG_MARK.other` — the marks assertion fails; delete `onToggle` — the expand assertion fails.
  it("each row's cells run mark, time, seat, title; the marks and the expand still work", () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, undefined, {
      date: '2026-09-02',
      text: MARKS_LOG,
    });
    renderApp(store);
    openLog();
    const timeline = screen.getByTestId('log-timeline');
    const summaries = [...timeline.querySelectorAll('summary')];
    expect(summaries).toHaveLength(4);
    for (const s of summaries) {
      expect(s).toHaveClass('log-timeline__summary');
      expect([...s.children].map((c) => c.className.split(' ')[0])).toEqual([
        'log-timeline__mark',
        'log-timeline__when',
        'log-timeline__seat',
        'log-timeline__title',
      ]);
    }
    expect(summaries.map((s) => s.querySelector('.log-timeline__mark')?.textContent)).toEqual([
      '▲',
      '▼',
      '✓',
      '•',
    ]);
    // The seat cell still carries the avatar emoji and the name.
    expect(summaries[0]?.querySelector('.log-timeline__seat .log-timeline__emoji')).not.toBeNull();
    // Expanding a row still renders its body, and only then.
    const item = timeline.querySelector('details.log-timeline__item') as Element;
    expect(item.querySelector('.log-timeline__text')).toBeNull();
    openBlock(item);
    expect(item.querySelector('.log-timeline__text')).not.toBeNull();
  });
});
