import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderNote, splitBody } from '../src/markdown.js';
import { reconnectDelay } from '../src/ws.js';

describe('markdown', () => {
  it('splits the ## Log section into a timeline and keeps the rest as description', () => {
    const body = [
      'Desc with `code`.',
      '',
      '## Log',
      '- 2026-09-02T22:41Z claude/web-agent — moved to doing',
      '- a free-form note',
      '',
      '## After',
      'tail',
    ].join('\n');
    const { description, log } = splitBody(body);
    expect(log).toEqual([
      { ts: '2026-09-02T22:41Z', actor: 'claude/web-agent', message: 'moved to doing' },
      { ts: null, actor: null, message: 'a free-form note' },
    ]);
    expect(description).toContain('Desc with');
    expect(description).toContain('## After');
    expect(description).not.toContain('## Log');
  });

  it('RCB-70: splits ## Notes out of the description too, before ## Log', () => {
    const body = [
      'Desc.',
      '',
      '## Notes',
      '- 2026-09-19T23:20:00Z owner — ship it before RCB-68',
      '',
      '## Log',
      '- 2026-09-02T22:41Z claude/web-agent — moved to doing',
    ].join('\n');
    const { description, notes, log } = splitBody(body);
    expect(notes).toEqual([
      { ts: '2026-09-19T23:20:00Z', actor: 'owner', message: 'ship it before RCB-68' },
    ]);
    expect(log).toEqual([
      { ts: '2026-09-02T22:41Z', actor: 'claude/web-agent', message: 'moved to doing' },
    ]);
    expect(description).toContain('Desc.');
    expect(description).not.toContain('## Notes');
    expect(description).not.toContain('ship it before RCB-68');
  });

  it('RCB-70: a two-space continuation line joins the previous note, not a new entry', () => {
    const body = [
      '## Notes',
      '- 2026-09-19T23:20:00Z owner — line one',
      '  line two',
      '',
      '## Log',
      '- 2026-09-02T22:41Z claude/web-agent — moved to doing',
    ].join('\n');
    const { notes } = splitBody(body);
    expect(notes).toEqual([
      { ts: '2026-09-19T23:20:00Z', actor: 'owner', message: 'line one\nline two' },
    ]);
  });

  it('sanitizes rendered html', () => {
    const html = renderMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('<p>hi');
  });

  it('RCB-72: renderNote turns a single newline into <br>', () => {
    const html = renderNote('a\nb');
    expect(html).toMatch(/<br\s*\/?>/);
    expect(html).toContain('a');
    expect(html).toContain('b');
  });

  it('RCB-72: renderMarkdown keeps a soft break as a space (unchanged)', () => {
    const html = renderMarkdown('a\nb');
    expect(html).not.toMatch(/<br\s*\/?>/);
  });
});

describe('reconnect backoff', () => {
  it('doubles from 500 ms and caps at 10 s', () => {
    const noJitter = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => reconnectDelay(n, noJitter))).toEqual([
      500, 1000, 2000, 4000, 8000, 10000, 10000,
    ]);
    expect(reconnectDelay(20, () => 1)).toBeLessThanOrEqual(10000);
  });
});
