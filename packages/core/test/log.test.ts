import { describe, expect, it } from 'vitest';
import { appendLogLine, formatLogLine } from '../src/log.js';

describe('appendLogLine', () => {
  it('creates the heading preceded by a blank line when absent', () => {
    expect(appendLogLine('Some description.\n', '- a')).toBe('Some description.\n\n## Log\n- a\n');
    expect(appendLogLine('No trailing newline', '- a')).toBe(
      'No trailing newline\n\n## Log\n- a\n',
    );
    expect(appendLogLine('', '- a')).toBe('\n## Log\n- a\n');
    expect(appendLogLine('\n\n', '- a')).toBe('\n## Log\n- a\n');
  });

  it('appends at the end of an existing Log section at end of body', () => {
    expect(appendLogLine('intro\n\n## Log\n- one\n', '- two')).toBe(
      'intro\n\n## Log\n- one\n- two\n',
    );
    expect(appendLogLine('intro\n\n## Log\n- one', '- two')).toBe(
      'intro\n\n## Log\n- one\n- two\n',
    );
    expect(appendLogLine('## Log\n', '- one')).toBe('## Log\n- one\n');
  });

  it('appends inside the Log section when another heading follows, keeping its spacing', () => {
    expect(appendLogLine('## Log\n- one\n\n## Notes\nn\n', '- two')).toBe(
      '## Log\n- one\n- two\n\n## Notes\nn\n',
    );
    expect(appendLogLine('## Log\n- one\n# Top\n', '- two')).toBe(
      '## Log\n- one\n- two\n\n# Top\n',
    );
  });

  it('does not confuse `### Log` or `## Logging` with the heading', () => {
    expect(appendLogLine('### Log\n- x\n', '- a')).toBe('### Log\n- x\n\n## Log\n- a\n');
    expect(appendLogLine('## Logging\n- x\n', '- a')).toBe('## Logging\n- x\n\n## Log\n- a\n');
  });

  it('does not add a second dash', () => {
    expect(appendLogLine('', 'plain')).toBe('\n## Log\n- plain\n');
  });
});

describe('formatLogLine', () => {
  it('matches the documented shape', () => {
    expect(formatLogLine('2026-09-02T22:41:10Z', 'claude/x', 'moved todo → doing')).toBe(
      '- 2026-09-02T22:41:10Z claude/x — moved todo → doing',
    );
  });
});
