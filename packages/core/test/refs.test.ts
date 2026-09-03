import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { parseCard, serializeCard } from '../src/card.js';
import {
  normalizeHeading,
  parseRef,
  REF_MAX_BYTES,
  REF_MAX_LINES,
  type Ref,
  resolveRef,
  resolveRefText,
  splitLines,
} from '../src/refs.js';
import { createCard, updateCard } from '../src/transitions.js';
import { NOW, sampleCard } from './helpers.js';

function ref(spec: string): Ref {
  const r = parseRef(spec);
  if (!r.ok) throw new Error(r.error);
  return r.ref;
}

function must(spec: string, text: string) {
  const r = resolveRef(ref(spec), text);
  if (r.text === null) throw new Error(r.error);
  return r;
}

function fail(spec: string, text: string): string {
  const r = resolveRef(ref(spec), text);
  if (r.text !== null) throw new Error(`expected an error, got lines ${r.start}-${r.end}`);
  return r.error;
}

const DOC = [
  '# Title', // 1
  'intro', // 2
  '', // 3
  '## §1 Decisions', // 4
  'one', // 5
  '### §1.1 Sub', // 6
  'sub', // 7
  '', // 8
  '## §2 File formats', // 9
  '```markdown', // 10
  '## Log', // 11
  '```', // 12
  'two', // 13
  '', // 14
  '## §5 Phases', // 15
  '- **P6.1** README with a GIF.', // 16
  '  continued', // 17
  '- **P6.2** `npx repoboard` works.', // 18
  '', // 19
  '- ~~**K6** struck through~~ Closed: yes', // 20
  '  more', // 21
  '- **K7** next', // 22
  '  - nested item', // 23
  'A paragraph', // 24
  'still paragraph', // 25
  '# Appendix', // 26
  'end', // 27
].join('\n');

describe('parseRef', () => {
  it('parses the four forms', () => {
    expect(ref('docs/a.md#§11 Owner decisions')).toEqual({
      spec: 'docs/a.md#§11 Owner decisions',
      path: 'docs/a.md',
      kind: 'heading',
      heading: '§11 Owner decisions',
    });
    expect(ref('docs/a.md@P6.1')).toEqual({
      spec: 'docs/a.md@P6.1',
      path: 'docs/a.md',
      kind: 'token',
      token: 'P6.1',
    });
    expect(ref('src/x.ts:L10-L20')).toEqual({
      spec: 'src/x.ts:L10-L20',
      path: 'src/x.ts',
      kind: 'lines',
      start: 10,
      end: 20,
    });
    expect(ref('src/x.ts:L10-20')).toMatchObject({ kind: 'lines', start: 10, end: 20 });
    expect(ref('src/x.ts:L7')).toMatchObject({ kind: 'lines', start: 7, end: 7 });
    expect(ref('README.md')).toEqual({ spec: 'README.md', path: 'README.md', kind: 'file' });
  });

  it('trims and keeps the spec verbatim after trimming', () => {
    expect(ref('  docs/a.md#Foo  ').spec).toBe('docs/a.md#Foo');
  });

  it('rejects empty, missing parts, bad ranges, and a range without L', () => {
    const errors = [
      '',
      '#Heading',
      '@Token',
      'a.md#',
      'a.md@',
      'a.md:L0',
      'a.md:L9-L3',
      'a.md:10-20',
    ].map((s) => {
      const r = parseRef(s);
      return r.ok ? `ok:${s}` : r.error;
    });
    expect(errors).toEqual([
      'empty ref',
      '"#Heading": missing path before "#"',
      '"@Token": missing path before "@"',
      '"a.md#": missing heading text after "#"',
      '"a.md@": missing token after "@"',
      '"a.md:L0": lines are numbered from 1',
      '"a.md:L9-L3": end line 3 is before 9',
      '"a.md:10-20": a line range is written :L<start> or :L<start>-L<end>',
    ]);
  });
});

describe('normalizeHeading / splitLines', () => {
  it('strips hashes, case-folds, collapses spaces', () => {
    expect(normalizeHeading('##   §11   Owner  Decisions ##')).toBe('§11 owner decisions');
    expect(normalizeHeading('  §11 Owner decisions')).toBe('§11 owner decisions');
  });
  it('splits LF and CRLF, no phantom last line, empty file is one empty line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual(['']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('resolveRef: heading', () => {
  it('spans from the heading to the line before the next heading of the same or higher level', () => {
    const r = must('doc.md#§1 Decisions', DOC);
    expect([r.start, r.end]).toEqual([4, 8]);
    expect(r.text).toBe('## §1 Decisions\none\n### §1.1 Sub\nsub\n');
    expect(r.truncated).toBe(false);
  });

  it('ends at exactly the line before the next heading (off-by-one guard)', () => {
    const r = must('doc.md#§5 Phases', DOC);
    expect(r.start).toBe(15);
    expect(r.end).toBe(25);
    expect(r.text.endsWith('still paragraph')).toBe(true);
    expect(r.text).not.toContain('# Appendix');
    // A deeper heading does not end the span; a higher one does.
    const sub = must('doc.md#§1.1', DOC);
    expect([sub.start, sub.end]).toEqual([6, 8]);
  });

  it('matches on normalized prefix: case, spaces, leading hashes', () => {
    expect(must('doc.md#§1', DOC).start).toBe(4); // prefix: first heading starting with "§1"
    expect(must('doc.md#§1 DECISIONS', DOC).start).toBe(4);
    expect(must('doc.md### §2   file', DOC).start).toBe(9);
  });

  it('ignores headings inside fenced code and runs to EOF for the last heading', () => {
    const r = must('doc.md#§2 File formats', DOC);
    expect([r.start, r.end]).toEqual([9, 14]);
    expect(r.text).toContain('## Log');
    const last = must('doc.md#Appendix', DOC);
    expect([last.start, last.end]).toEqual([26, 27]);
  });

  it('not found is null text with the heading and path named', () => {
    expect(fail('doc.md#Nope', DOC)).toBe('heading "Nope" not found in doc.md');
  });
});

describe('resolveRef: token', () => {
  it('matches after the list marker and ** and stops at the next list item at the same indent', () => {
    const r = must('doc.md@P6.1', DOC);
    expect([r.start, r.end]).toEqual([16, 17]);
    expect(r.text).toBe('- **P6.1** README with a GIF.\n  continued');
  });

  it('stops at a blank line', () => {
    const r = must('doc.md@P6.2', DOC);
    expect([r.start, r.end]).toEqual([18, 18]);
  });

  it('sees through ~~strikethrough~~ and keeps a nested item', () => {
    expect(must('doc.md@K6', DOC)).toMatchObject({ start: 20, end: 21 });
    // The nested item is kept; the paragraph after it is neither blank, heading, nor list, so it runs on.
    expect(must('doc.md@K7', DOC)).toMatchObject({ start: 22, end: 25 });
  });

  it('a paragraph runs to the next blank line or heading', () => {
    const r = must('doc.md@A paragraph', DOC);
    expect([r.start, r.end]).toEqual([24, 25]);
  });

  it('a multi-word token with a dash matches the heading-less O1 shape', () => {
    const text = '- **O1 — name: `repoboard`.** npm package\n  more\n- **O2 — GitHub.** later\n';
    expect(must('p.md@O1 —', text)).toMatchObject({ start: 1, end: 2 });
  });

  it('not found is null text', () => {
    expect(fail('doc.md@ZZZ', DOC)).toBe('no line starting with "ZZZ" in doc.md');
  });
});

describe('resolveRef: lines and file', () => {
  it('returns exactly the 1-based inclusive range', () => {
    const r = must('doc.md:L4-L5', DOC);
    expect(r).toEqual({ text: '## §1 Decisions\none', start: 4, end: 5, truncated: false });
    expect(must('doc.md:L27', DOC)).toMatchObject({ text: 'end', start: 27, end: 27 });
  });

  it('a range past EOF is an error, not a shorter answer', () => {
    expect(fail('doc.md:L27-L28', DOC)).toBe('line 28 is past the end of doc.md (27 lines)');
    expect(fail('doc.md:L99', DOC)).toBe('line 99 is past the end of doc.md (27 lines)');
    expect(must('doc.md:L1', 'end\n')).toMatchObject({ start: 1, end: 1, text: 'end' });
  });

  it('whole file', () => {
    const r = must('doc.md', DOC);
    expect([r.start, r.end]).toEqual([1, 27]);
    expect(r.text).toBe(DOC);
  });

  it('CRLF input resolves by line and returns LF text', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    expect(must('doc.md#§1 Decisions', crlf)).toEqual(must('doc.md#§1 Decisions', DOC));
    expect(must('doc.md:L4-L5', crlf).text).toBe('## §1 Decisions\none');
    expect(must('doc.md@P6.1', crlf).text).not.toContain('\r');
  });
});

describe('resolveRef: caps', () => {
  it(`stops at ${REF_MAX_LINES} lines and says so`, () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
    const r = must('big.md', text);
    expect(r).toMatchObject({ start: 1, end: REF_MAX_LINES, truncated: true });
    expect(r.text.split('\n')).toHaveLength(REF_MAX_LINES);
    expect(must('big.md:L1-L200', text).truncated).toBe(false);
    expect(must('big.md:L1-L201', text)).toMatchObject({ end: 200, truncated: true });
  });

  it(`stops before ${REF_MAX_BYTES} bytes, counting UTF-8 and newlines`, () => {
    const line = '§'.repeat(1000); // 2 bytes each: 2000 B + newline
    const text = Array.from({ length: 20 }, () => line).join('\n');
    const r = must('big.md', text);
    // 8 lines = 8*2000 + 7 = 16007 ≤ 16384; 9 lines = 18008 > 16384
    expect(r).toMatchObject({ start: 1, end: 8, truncated: true });
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(REF_MAX_BYTES);
  });

  it('a single oversized line is cut rather than dropped', () => {
    const r = must('big.md', 'x'.repeat(REF_MAX_BYTES + 5));
    expect(r).toMatchObject({ start: 1, end: 1, truncated: true });
    expect(r.text).toHaveLength(REF_MAX_BYTES);
  });
});

describe('resolveRefText (wire shape)', () => {
  it('fills the wire shape on success and on both kinds of failure', () => {
    expect(resolveRefText('doc.md:L2', DOC)).toEqual({
      spec: 'doc.md:L2',
      path: 'doc.md',
      start: 2,
      end: 2,
      text: 'intro',
      truncated: false,
      error: null,
    });
    expect(resolveRefText('doc.md#Nope', DOC)).toEqual({
      spec: 'doc.md#Nope',
      path: 'doc.md',
      start: null,
      end: null,
      text: null,
      truncated: false,
      error: 'heading "Nope" not found in doc.md',
    });
    expect(resolveRefText('#Nope', DOC)).toMatchObject({ path: null, text: null });
  });
});

describe('refs: on a card', () => {
  const text = `---
id: RB-3
title: With refs
status: todo
files:
  - a.ts
refs:
  - docs/BUILD-PLAN.md@P4.1
  - docs/BUILD-PLAN.md#§11 Owner decisions
created: 2026-09-02T22:00:00Z
updated: 2026-09-02T22:41:10Z
---
body
`;

  it('parses refs and serializes them after files, before created', () => {
    const r = parseCard(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.refs).toEqual([
      'docs/BUILD-PLAN.md@P4.1',
      'docs/BUILD-PLAN.md#§11 Owner decisions',
    ]);
    const out = serializeCard(r.card);
    expect(out.indexOf('refs:')).toBeGreaterThan(out.indexOf('files:'));
    expect(out.indexOf('refs:')).toBeLessThan(out.indexOf('created:'));
    const again = parseCard(out);
    expect(again.ok && again.card.refs).toEqual(r.card.refs);
  });

  it('refs must be a list of strings; a null value is absent', () => {
    const bad = parseCard(
      text.replace(
        'refs:\n  - docs/BUILD-PLAN.md@P4.1\n  - docs/BUILD-PLAN.md#§11 Owner decisions',
        'refs: 7',
      ),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^refs:/);
    const empty = parseCard(
      text.replace(
        'refs:\n  - docs/BUILD-PLAN.md@P4.1\n  - docs/BUILD-PLAN.md#§11 Owner decisions',
        'refs:',
      ),
    );
    expect(empty.ok && 'refs' in empty.card).toBe(false);
  });

  it('createCard and updateCard carry refs like files', () => {
    const config = defaultBoardConfig();
    const created = createCard(
      { title: 't', refs: ['a.md#X'] },
      { existingIds: [], now: NOW, config },
    );
    expect(created.ok && created.card.refs).toEqual(['a.md#X']);
    const updated = updateCard(sampleCard(), { refs: ['b.md:L1'] }, { actor: 'a', now: NOW });
    expect(updated.ok && updated.card.refs).toEqual(['b.md:L1']);
    expect(updated.ok && updated.card.body).toContain('updated refs');
    const cleared = updateCard(
      sampleCard({ refs: ['x'] }),
      { refs: null },
      { actor: 'a', now: NOW },
    );
    expect(cleared.ok && 'refs' in cleared.card).toBe(false);
  });
});
