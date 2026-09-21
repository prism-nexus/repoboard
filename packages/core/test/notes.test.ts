/**
 * RCB-70 (owner 2026-09-19 20:4xZ): a note — dated, attributed, appended, never rewritten.
 * `appendNoteLine`/`formatNoteLine` (log.ts) share `appendSectionLine` with `appendLogLine` so the
 * two sections cannot drift; `addNote` (notes.ts) is the pure funnel every surface calls.
 */
import { describe, expect, it } from 'vitest';
import { appendLogLine, appendNoteLine, formatLogLine, formatNoteLine } from '../src/log.js';
import { addNote } from '../src/notes.js';
import { NOW, sampleCard } from './helpers.js';

const actor = 'claude/test';

describe('appendNoteLine', () => {
  it('appends at the end of an existing ## Notes section, keeping what follows byte-identical', () => {
    const body = '## Notes\n- one\n\n## Log\n- x\n';
    expect(appendNoteLine(body, '- two')).toBe('## Notes\n- one\n- two\n\n## Log\n- x\n');
  });

  it('creates ## Notes immediately before ## Log when Notes is absent, blank lines above and below', () => {
    const body = 'desc\n\n## Log\n- one\n';
    expect(appendNoteLine(body, '- new note')).toBe(
      'desc\n\n## Notes\n- new note\n\n## Log\n- one\n',
    );
  });

  it('creates ## Notes at the end (like appendLogLine) when neither heading is present', () => {
    expect(appendNoteLine('desc\n', '- a')).toBe('desc\n\n## Notes\n- a\n');
    expect(appendNoteLine('', '- a')).toBe('\n## Notes\n- a\n');
  });

  it('Notes present + Log absent: a later appendLogLine call lands Log after Notes', () => {
    const withNote = appendNoteLine('desc\n', '- note1');
    expect(withNote).toBe('desc\n\n## Notes\n- note1\n');
    const withLog = appendLogLine(withNote, '- did x');
    expect(withLog).toBe('desc\n\n## Notes\n- note1\n\n## Log\n- did x\n');
    expect(withLog.indexOf('## Notes')).toBeLessThan(withLog.indexOf('## Log'));
  });

  it('multi-line text (via formatNoteLine) becomes a continuation line under the same bullet', () => {
    const line = formatNoteLine('2026-09-19T23:20:00Z', actor, 'line one\nline two');
    expect(appendNoteLine('', line)).toBe(
      '\n## Notes\n- 2026-09-19T23:20:00Z claude/test — line one\n  line two\n',
    );
  });

  it('everything outside the Notes section is byte-identical before and after', () => {
    const body = 'Desc.\n\n## Files\n- a.ts\n\n## Notes\n- existing\n\n## Log\n- did x\n';
    const before = body.indexOf('## Notes');
    const afterLog = body.slice(body.indexOf('## Log'));
    const result = appendNoteLine(body, '- new');
    // Description + Files heading, untouched.
    expect(result.slice(0, before)).toBe(body.slice(0, before));
    // The Log section (and everything from its heading on), untouched.
    expect(result.slice(result.indexOf('## Log'))).toBe(afterLog);
  });
});

describe('formatNoteLine', () => {
  it('matches the documented shape and strips CR / trims whitespace', () => {
    expect(formatNoteLine('2026-09-19T23:20:00Z', 'owner', '  ship the notes box  ')).toBe(
      '- 2026-09-19T23:20:00Z owner — ship the notes box',
    );
    expect(formatNoteLine('2026-09-19T23:20:00Z', 'owner', 'a\r\nb')).toBe(
      '- 2026-09-19T23:20:00Z owner — a\n  b',
    );
  });

  it('does not touch formatLogLine (append_log still collapses to one line)', () => {
    expect(formatLogLine('2026-09-02T22:41:10Z', 'claude/x', 'moved todo → doing')).toBe(
      '- 2026-09-02T22:41:10Z claude/x — moved todo → doing',
    );
  });
});

describe('addNote', () => {
  it('empty/blank text is refused', () => {
    const card = sampleCard({ status: 'doing' });
    expect(addNote(card, { text: '   ', actor, now: NOW })).toEqual({
      ok: false,
      error: 'note text must not be empty',
    });
  });

  it('bumps updated, appends under ## Notes, writes NO ## Log line, and the event is exact', () => {
    const card = sampleCard({
      status: 'doing',
      body: 'Desc.\n\n## Log\n- 2026-09-02T22:41Z claude/web-agent — moved to doing\n',
    });
    const r = addNote(card, { text: 'ship the notes box before RCB-68', actor, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.updated).toBe('2026-09-02T22:41:10Z');
    expect(r.card.body).toContain(
      '## Notes\n- 2026-09-02T22:41:10Z claude/test — ship the notes box before RCB-68',
    );
    // The Log section is exactly what it was — no new line, no rewrite.
    expect(r.card.body.slice(r.card.body.indexOf('## Log'))).toBe(
      card.body.slice(card.body.indexOf('## Log')),
    );
    expect(r.event).toEqual({
      ts: '2026-09-02T22:41:10Z',
      actor,
      type: 'note',
      cardId: card.id,
      from: 'doing',
      to: 'doing',
    });
  });
});
