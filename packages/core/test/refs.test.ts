import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { parseCard, serializeCard } from '../src/card.js';
import {
  normalizeHeading,
  parseRef,
  REF_MAX_BYTES,
  REF_MAX_LINES,
  type Ref,
  refPath,
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

describe('refPath (RCB-208)', () => {
  it('is the file every ref form names, the same path parseRef reports', () => {
    expect(refPath('src/x.ts')).toBe('src/x.ts');
    expect(refPath('src/x.ts:L10-L20')).toBe('src/x.ts');
    expect(refPath('src/x.ts:L7')).toBe('src/x.ts');
    expect(refPath('docs/a.md@P6.1')).toBe('docs/a.md');
    expect(refPath('docs/a.md#§11 Owner decisions')).toBe('docs/a.md');
    expect(refPath('  docs/a.md#Foo  ')).toBe('docs/a.md');
  });

  it('is null for a spec parseRef rejects', () => {
    for (const s of ['', '#Heading', 'a.md@', 'a.md:L0', 'a.md:L9-L3', 'a.md:10-20']) {
      expect(refPath(s), s).toBeNull();
    }
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

// RCB-177: `@token` also finds a JSON/JSONC/YAML key — a line whose first token is the token in
// quotes (optionally followed by `:`). A member's `wrangler.jsonc@…` pointers all failed on the leading `"`.
describe('resolveRef: token — quoted keys (RCB-177)', () => {
  const JSONC = [
    '{', // 1
    '  "name": "w",', // 2
    '  "triggers": {', // 3
    '    "crons": ["0 * * * *"]', // 4
    '  },', // 5
    '', // 6
    "  'vars': {", // 7
    '    "A": "1"', // 8
    '  },', // 9
    '', // 10
    '  "triggersX": 1,', // 11
    '  "trigger" , ', // 12
    '}', // 13
  ].join('\n');

  it('@triggers matches `  "triggers": {` and runs to the line before the next blank line', () => {
    // CONTROL: with the `isQuotedToken` branch removed from `resolveRef`, this is "no line
    // starting with "triggers"" and `must` throws — the real-world failure, reproduced.
    expect(must('wrangler.jsonc@triggers', JSONC)).toMatchObject({
      start: 3,
      end: 5,
      text: '  "triggers": {\n    "crons": ["0 * * * *"]\n  },',
    });
  });

  it("a single-quoted key matches too (`'vars': {`), and so does a lone quoted token with no colon", () => {
    expect(must('wrangler.jsonc@vars', JSONC)).toMatchObject({ start: 7, end: 9 });
    expect(must('a.txt@hello', '"hello"\n')).toMatchObject({ start: 1, end: 1 });
    expect(must('a.txt@hello', "'hello'  \n")).toMatchObject({ start: 1, end: 1 });
    // ...but a quoted token followed by anything other than `:` is prose, not a key.
    expect(fail('a.txt@hello', '"hello" world\n')).toBe('no line starting with "hello" in a.txt');
  });

  it('is exact INSIDE the quotes: @trigger does not match "triggers": or "triggersX":, and @trig matches nothing', () => {
    // CONTROL: a prefix match inside the quotes (dropping the closing-quote check in
    // `isQuotedToken`) lands `@trigger` on line 3 and `@trig` on line 3 — both throw here.
    expect(fail('wrangler.jsonc@trig', JSONC)).toBe(
      'no line starting with "trig" in wrangler.jsonc',
    );
    // `"trigger" , ` (line 12) is quoted-exact but followed by `,`, not `:` — not a key.
    expect(fail('wrangler.jsonc@trigger', JSONC)).toBe(
      'no line starting with "trigger" in wrangler.jsonc',
    );
  });

  it('a quote only counts at the FIRST token: a key mentioned mid-line does not match', () => {
    expect(fail('a.json@crons', '{ "crons": 1 }\n')).toBe(
      'no line starting with "crons" in a.json',
    );
  });

  it('a bare-token ref that matched before still matches THE SAME line — an earlier quoted line never steals it', () => {
    // Line 1 would match `@K7` by the quoted rule; the bare rule matches line 3. The bare rule
    // is tried over the whole file first, so the answer is line 3 exactly as before RCB-177.
    // CONTROL: one pass (`findIndex` on `bare || quoted`) answers line 1 and this fails.
    const text = ['"K7": {', 'x', '- **K7** next', '  more'].join('\n');
    expect(must('doc.md@K7', text)).toMatchObject({ start: 3, end: 4 });
    // ...and the existing DOC cases above are byte-for-byte what they were (P6.1, K6, K7).
    expect(must('doc.md@P6.1', DOC)).toMatchObject({ start: 16, end: 17 });
  });
});

// RCB-187: `@a.b` is a key path when no line starts with the literal `a.b` — `a` by the token rule,
// then `b` by the same rule INSIDE `a`'s span. A member's systems.yml uses `wrangler.jsonc@durable_objects.bindings`
// (x2) and `wrangler.jsonc@triggers.crons`, which resolved to nothing while `@durable_objects` alone worked.
describe('resolveRef: token — key path (RCB-187)', () => {
  const JSONC = [
    '{', // 1
    '  "name": "acme",', // 2
    '  "durable_objects": {', // 3
    '    "bindings": [', // 4
    '      { "name": "ROOM", "class_name": "Room" },', // 5
    '      { "name": "ARCHIVE", "class_name": "Archive" }', // 6
    '    ]', // 7
    '  },', // 8
    '', // 9
    '  "triggers": {', // 10
    '    "crons": ["0 * * * *", "30 6 * * *"]', // 11
    '  },', // 12
    '', // 13
    '  "kv_namespaces": {', // 14
    '    "bindings": [],', // 15
    '    "crons": []', // 16
    '  }', // 17
    '}', // 18
  ].join('\n');

  it('@durable_objects.bindings and @triggers.crons resolve to the nested key line and its span', () => {
    // CONTROL: with the key-path fallback removed from `resolveRef`, both are "no line starting
    // with "durable_objects.bindings"" / "…"triggers.crons"" and `must` throws — the same real-world failure.
    expect(must('wrangler.jsonc@durable_objects.bindings', JSONC)).toMatchObject({
      start: 4,
      end: 8,
      text: [
        '    "bindings": [',
        '      { "name": "ROOM", "class_name": "Room" },',
        '      { "name": "ARCHIVE", "class_name": "Archive" }',
        '    ]',
        '  },',
      ].join('\n'),
    });
    expect(must('wrangler.jsonc@triggers.crons', JSONC)).toMatchObject({
      start: 11,
      end: 12,
      text: '    "crons": ["0 * * * *", "30 6 * * *"]\n  },',
    });
    // The parent alone is what it was (RCB-177).
    expect(must('wrangler.jsonc@durable_objects', JSONC)).toMatchObject({ start: 3, end: 8 });
  });

  it('the child is searched only INSIDE the parent: a same-named key outside its span is not an answer', () => {
    // `"bindings"` is also on line 15 (after triggers' span) and line 4 (before it); `"crons"` is
    // also on line 16. Neither is under the parent asked for, so each is a miss naming the parent.
    expect(fail('wrangler.jsonc@triggers.bindings', JSONC)).toBe(
      'no "bindings" under "triggers" in wrangler.jsonc',
    );
    expect(fail('wrangler.jsonc@durable_objects.crons', JSONC)).toBe(
      'no "crons" under "durable_objects" in wrangler.jsonc',
    );
    // ...and the same-named key INSIDE the asked-for parent is found: kv_namespaces.bindings is line 15.
    expect(must('wrangler.jsonc@kv_namespaces.bindings', JSONC)).toMatchObject({
      start: 15,
      end: 18,
    });
  });

  it('a missing FIRST segment is named the way a plain token miss is', () => {
    expect(fail('wrangler.jsonc@nope.bindings', JSONC)).toBe(
      'no line starting with "nope" in wrangler.jsonc',
    );
  });

  it('three segments nest: each is searched after the previous one, inside its span', () => {
    const YAML = [
      'services:', // 1
      '  web:', // 2
      '    ports:', // 3
      '      - 80', // 4
      '  db:', // 5
      '    ports:', // 6
      '      - 5432', // 7
    ].join('\n');
    // `ports` is on line 3 AND line 6; the one under `db` is line 6, not the first in the file.
    expect(must('c.yml@services.db.ports', YAML)).toMatchObject({ start: 6, end: 7 });
    expect(must('c.yml@services.web.ports', YAML)).toMatchObject({ start: 3, end: 7 });
    expect(fail('c.yml@services.db.nope', YAML)).toBe('no "nope" under "db" in c.yml');
  });

  it("the answer's end is clamped to the parent's end", () => {
    // Parent `a` (indent 4) ends at line 2: line 3 is a list item at indent 2 <= 4. Child `b`
    // (indent 0) would run on to EOF by its own rule (a list item at indent 2 is deeper than 0).
    // CONTROL: without the `Math.min(..., to)` clamp in `resolveKeyPath` this is 2-4.
    const text = ['    - **a** parent', 'b child', '  - sibling of a', '  tail'].join('\n');
    expect(must('doc.md@a.b', text)).toMatchObject({ start: 2, end: 2, text: 'b child' });
    expect(must('doc.md@b', text)).toMatchObject({ start: 2, end: 4 });
  });

  it('a dotted token that exists LITERALLY still resolves literally, before any key path', () => {
    // Line 1 (`v1`) then its nested `2 details` (line 2) would answer `@v1.2` as a key path (2-2);
    // line 3 `v1.2 notes` matches the whole token, so it wins.
    // CONTROL: trying the key path FIRST answers lines 2-2 and this fails.
    const text = ['- v1 release', '  - 2 details', '- v1.2 notes', '  more'].join('\n');
    expect(must('doc.md@v1.2', text)).toMatchObject({ start: 3, end: 4 });
    // The existing DOC cases with a dot are what they were.
    expect(must('doc.md@P6.1', DOC)).toMatchObject({ start: 16, end: 17 });
  });

  it('an empty segment is an error, not a guess: @a..b, @.a, @a.', () => {
    const text = ['a', '  b', '  c', ''].join('\n');
    for (const token of ['a..b', '.a', 'a.']) {
      expect(resolveRefText(`x.md@${token}`, text)).toMatchObject({
        path: 'x.md',
        text: null,
        error: `"${token}" is not a key path: it has an empty segment`,
      });
    }
    // Only a token no line starts with literally reaches this: a line that IS `a..b` still matches.
    expect(must('x.md@a..b', '- a..b range\n')).toMatchObject({ start: 1, end: 1 });
  });

  it('a dotted miss whose first segment exists names the missing second one, not the whole token', () => {
    expect(fail('doc.md@P6.9', DOC)).toBe('no "9" under "P6" in doc.md');
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
