import { describe, expect, it } from 'vitest';
import { renderMarkdown, splitBody } from '../src/markdown.js';
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

  it('sanitizes rendered html', () => {
    const html = renderMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('<p>hi');
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
