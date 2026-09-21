import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as YAML from 'yaml';
import { parseCard, serializeCard } from '../src/card.js';
import type { Card } from '../src/types.js';
import { rng, sampleCard } from './helpers.js';

const SPEC_EXAMPLE = `---
id: RB-12
title: Treemap view of the repo
status: doing
assignee: claude/web-agent
priority: high          # high | medium | low, optional
labels: [web, viz]
files:
  - packages/web/src/views/Treemap.tsx
created: 2026-09-02T22:00:00Z
updated: 2026-09-02T22:41:10Z
---

Description in markdown. Agents append notes below a \`## Log\` heading; humans write wherever.

## Log
- 2026-09-02T22:41Z claude/web-agent — moved to doing, starting on the d3 layout
`;

function mustParse(text: string): Card {
  const r = parseCard(text);
  if (!r.ok) throw new Error(r.error);
  return r.card;
}

describe('parseCard', () => {
  it('parses the §2 example, timestamps stay strings', () => {
    const card = mustParse(SPEC_EXAMPLE);
    expect(card.id).toBe('RB-12');
    expect(card.title).toBe('Treemap view of the repo');
    expect(card.status).toBe('doing');
    expect(card.assignee).toBe('claude/web-agent');
    expect(card.priority).toBe('high');
    expect(card.labels).toEqual(['web', 'viz']);
    expect(card.files).toEqual(['packages/web/src/views/Treemap.tsx']);
    expect(card.created).toBe('2026-09-02T22:00:00Z');
    expect(typeof card.updated).toBe('string');
    expect(card.body).toBe(
      '\nDescription in markdown. Agents append notes below a `## Log` heading; humans write wherever.\n\n## Log\n- 2026-09-02T22:41Z claude/web-agent — moved to doing, starting on the d3 layout\n',
    );
  });

  it('returns ok:false naming each missing required key', () => {
    const r = parseCard('---\nid: RB-1\nstatus: todo\n---\nbody\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing required keys: title, created, updated/);
  });

  it('names a single missing key', () => {
    const r = parseCard(
      '---\nid: RB-1\nstatus: todo\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect(r).toEqual({ ok: false, error: 'missing required key: title' });
  });

  it('rejects a bad priority and a non-ISO timestamp, naming the key', () => {
    const bad = parseCard(
      '---\nid: RB-1\ntitle: t\nstatus: todo\npriority: urgent\ncreated: yesterday\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatch(/priority/);
    expect(bad.error).toMatch(/created: must be an ISO-8601 datetime/);
  });

  it('rejects a bad size (lower-case is not normalised) like a bad priority', () => {
    const bad = parseCard(
      '---\nid: RB-1\ntitle: t\nstatus: todo\nsize: xl\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatch(/size/);
  });

  it('rejects text without frontmatter, unterminated frontmatter, invalid YAML, empty mapping', () => {
    expect(parseCard('just markdown').ok).toBe(false);
    expect(parseCard('---\nid: RB-1\n').ok).toBe(false);
    expect(parseCard('---\nid: [\n---\n').ok).toBe(false);
    expect(parseCard('---\n---\n').ok).toBe(false);
    expect(parseCard('---\n- a\n- b\n---\n').ok).toBe(false);
    expect(parseCard('')).toEqual({
      ok: false,
      error: 'missing frontmatter: file must start with a `---` line',
    });
  });

  it('rejects a frontmatter key named body', () => {
    const r = parseCard(
      '---\nid: RB-1\ntitle: t\nstatus: todo\nbody: x\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect(r.ok).toBe(false);
  });

  it('treats an empty optional value (`assignee:`) as absent', () => {
    const card = mustParse(
      '---\nid: RB-1\ntitle: t\nstatus: todo\nassignee:\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect('assignee' in card).toBe(false);
  });

  it('keeps unknown frontmatter keys', () => {
    const card = mustParse(
      '---\nid: RB-1\ntitle: t\nstatus: todo\nfoo: bar\nnested:\n  a: 1\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    );
    expect(card.foo).toBe('bar');
    expect(card.nested).toEqual({ a: 1 });
  });

  it('body is byte-for-byte: no trailing newline, CRLF, leading blanks', () => {
    const base =
      '---\nid: RB-1\ntitle: t\nstatus: todo\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---';
    expect(mustParse(base).body).toBe('');
    expect(mustParse(`${base}\n`).body).toBe('');
    expect(mustParse(`${base}\n\n\n  x  \n\n`).body).toBe('\n\n  x  \n\n');
    expect(mustParse(`${base}\r\nline\r\n`).body).toBe('line\r\n');
    expect(mustParse(`${base}\nno newline at end`).body).toBe('no newline at end');
  });
});

describe('serializeCard / round-trip', () => {
  it('parse → serialize → parse is identity', () => {
    const first = mustParse(SPEC_EXAMPLE);
    const text = serializeCard(first);
    const second = mustParse(text);
    expect(second).toEqual(first);
  });

  it('writes known keys in canonical order and omits undefined', () => {
    const text = serializeCard(sampleCard({ labels: undefined }));
    expect(text.split('\n').slice(0, 9)).toEqual([
      '---',
      'id: RB-12',
      'title: Treemap view of the repo',
      'status: doing',
      'assignee: claude/web-agent',
      'priority: high',
      'files:',
      '  - packages/web/src/views/Treemap.tsx',
      'created: 2026-09-02T22:00:00Z',
    ]);
    expect(text).not.toMatch(/labels/);
  });

  it('RCB-67: size written in the wrong place (after refs) round-trips into canonical position, after priority and before labels/refs', () => {
    const wrongPlace = mustParse(
      '---\nid: RB-1\ntitle: t\nstatus: todo\npriority: high\nrefs: [x]\nsize: M\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\nbody\n',
    );
    expect(wrongPlace.size).toBe('M');
    const text = serializeCard(wrongPlace);
    expect(text).toBe(
      '---\nid: RB-1\ntitle: t\nstatus: todo\npriority: high\nsize: M\nrefs:\n  - x\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\nbody\n',
    );
  });

  it('unknown key `foo: bar` survives the round-trip and is written after known keys', () => {
    const card = mustParse(
      '---\nfoo: bar\nid: RB-1\ntitle: t\nstatus: todo\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nhello\n',
    );
    const text = serializeCard(card);
    expect(text).toBe(
      '---\nid: RB-1\ntitle: t\nstatus: todo\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nfoo: bar\n---\nhello\n',
    );
    expect(mustParse(text).foo).toBe('bar');
  });

  it('a body containing `---` lines survives', () => {
    const body = '\nintro\n\n---\n\nafter the rule\n---\nand again\n';
    const card = sampleCard({ body });
    const text = serializeCard(card);
    expect(mustParse(text).body).toBe(body);
    expect(mustParse(text)).toEqual(card);
  });

  it('a body that is a `---` line without trailing newline survives', () => {
    const card = sampleCard({ body: '---' });
    expect(mustParse(serializeCard(card))).toEqual(card);
  });

  it('title needing quotes (colons, leading #, numbers) survives', () => {
    for (const title of ['a: b', '#1 fix', '123', 'true', ' padded ', 'multi\nline', '']) {
      const card = sampleCard({ title });
      expect(mustParse(serializeCard(card)).title).toBe(title);
    }
  });

  it('property: 200 random cards round-trip exactly', () => {
    const rand = rng(42);
    const pick = <T>(xs: readonly T[]): T => {
      const v = xs[Math.floor(rand() * xs.length)];
      if (v === undefined) throw new Error('empty');
      return v;
    };
    const words = ['alpha', 'a: b', '#tag', '- dash', '"quoted"', "it's", 'ünï', '---', 'x'];
    const randStr = (): string =>
      Array.from({ length: Math.floor(rand() * 4) }, () => pick(words)).join(' ');
    for (let i = 0; i < 200; i++) {
      const card: Card = {
        id: `P${i}-${Math.floor(rand() * 1000)}`,
        title: randStr(),
        status: pick(['backlog', 'todo', 'doing']),
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-02T00:00:00Z',
        body: Array.from({ length: Math.floor(rand() * 5) }, () => randStr()).join('\n'),
      };
      if (rand() < 0.5) card.assignee = randStr();
      if (rand() < 0.5) card.priority = pick(['high', 'medium', 'low']);
      if (rand() < 0.5) card.labels = [randStr(), randStr()];
      if (rand() < 0.5) card.files = [randStr()];
      if (rand() < 0.5) card.extra = { n: Math.floor(rand() * 10), s: randStr() };
      expect(mustParse(serializeCard(card))).toEqual(card);
    }
  });
});

/**
 * K1(b) (RCB-29): `title: P3.1 Board view: columns` is invalid YAML and 7 of the first 24
 * hand-written cards were written that way. `parseCard` retries once with only that value
 * quoted. The two dangers are opposite: a strict parser rejecting a fixable file, and a lenient
 * one silently changing what a file that already parsed means. Both are asserted below.
 */
describe('parseCard: unquoted title recovery (K1(b))', () => {
  const card = (titleLine: string, tail = '') =>
    `---\nid: RCB-1\n${titleLine}\nstatus: todo\n${tail}created: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\nbody\n`;

  it('recovers a title containing a colon', () => {
    const c = mustParse(card('title: P3.1 Board view: columns'));
    expect(c.title).toBe('P3.1 Board view: columns');
  });

  it('the recovered card equals the same card written with the title quoted', () => {
    const recovered = mustParse(card('title: P3.1 Board view: columns'));
    const quoted = mustParse(card('title: "P3.1 Board view: columns"'));
    expect(recovered).toEqual(quoted);
  });

  it('round-trips through serializeCard, with the title quoted', () => {
    const first = mustParse(card('title: P3.1 Board view: columns'));
    const text = serializeCard(first);
    expect(text).toContain('title: "P3.1 Board view: columns"');
    expect(mustParse(text)).toEqual(first);
    expect(serializeCard(mustParse(text))).toBe(text);
  });

  it('escapes rather than concatenating quotes: backslashes and double quotes survive', () => {
    for (const title of [
      'C:\\tmp: a path',
      'He said: "no"',
      'both: a "b" and a \\ and: another',
      'trailing spaces: kept?   ',
    ]) {
      const c = mustParse(card(`title: ${title}`));
      expect(c.title).toBe(title.replace(/[ \t]+$/, ''));
      expect(mustParse(serializeCard(c))).toEqual(c);
    }
  });

  it('recovers a colon title on a card that also has other keys', () => {
    const c = mustParse(
      card('title: RCB-9: refs: resolve', 'assignee: claude/core-agent\npriority: high\n'),
    );
    expect(c.title).toBe('RCB-9: refs: resolve');
    expect(c.assignee).toBe('claude/core-agent');
    expect(c.priority).toBe('high');
  });

  it('a colon in some OTHER value still fails, with the ORIGINAL error, not the retry\u2019s', () => {
    // Frontmatter line 2 is the title, line 3 the status. The first parse throws on line 2; the
    // retry (title quoted) throws on line 3. The user never wrote the retry, so must not see it.
    const r = parseCard(
      card('title: Board view: columns', 'ignored: no\n').replace(
        'status: todo',
        'status: doing: now',
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/frontmatter is not valid YAML/);
    expect(r.error).toContain('line 2');
    expect(r.error).not.toContain('line 3');
  });

  it('bad indentation is not a title problem and still fails', () => {
    const r = parseCard('---\nid: RCB-1\n  title: t\nstatus: todo\n---\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/frontmatter is not valid YAML/);
  });

  it('does not quote a value whose first character would change meaning', () => {
    // `&` starts an anchor; quoting it is a rewrite, not a recovery. Broken stays broken.
    for (const titleLine of ['title: &a x: y', 'title: !!str x: y', 'title: {a: b: c}']) {
      const r = parseCard(card(titleLine));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/frontmatter is not valid YAML/);
    }
  });

  // Three separate cases, because the fear is one bug — a fallback that runs on a document that
  // already parsed — and each of these is a different way that bug corrupts a valid file.
  it('a trailing comment on the title line stays a comment', () => {
    expect(mustParse(card('title: hello   # a note')).title).toBe('hello');
    expect(mustParse(card('title: "a: b"')).title).toBe('a: b');
    expect(mustParse(card("title: 'a: b'")).title).toBe('a: b');
  });

  it('a multi-line plain scalar and a block scalar title keep folding', () => {
    expect(mustParse(card('title: first\n  second')).title).toBe('first second');
    expect(mustParse(card('title: |-\n  Board view: columns')).title).toBe('Board view: columns');
  });

  it('`title: null` stays a missing title; leniency would invent the string "null"', () => {
    expect(parseCard(card('title: null'))).toEqual({
      ok: false,
      error: 'missing required key: title',
    });
  });
});

/**
 * RCB-52: `kind: 'task'` on a `decision:` block. Control C1 — `DecisionSchema`'s FIELD ORDER (not
 * the input file's order) is what a re-serialize follows: a hand-written file with `kind: task`
 * written LAST still comes back out with `kind: task` on the line right after `question:`, because
 * zod's parsed output follows the schema's declared key order (card.ts's own comment). A plain
 * QUESTION card's bytes stay byte-for-byte UNCHANGED — no `kind:` line at all, never written as
 * `kind: question` (the field is spread conditionally in `askDecision`, and simply absent from a
 * hand-written question card). Perturbing `DecisionSchema` to declare `kind` after `options`
 * instead of right after `question` makes the first test below fail.
 */
describe('RCB-52: decision.kind "task" follows schema order; a question card is byte-unchanged (C1)', () => {
  const DECISION_TASK_LAST = [
    '---',
    'id: RB-1',
    'title: t',
    'status: decide',
    'decision:',
    '  question: buy the domain',
    '  options: []',
    '  askedBy: claude/test',
    '  askedAt: 2026-09-02T22:41:10Z',
    '  returnTo: null',
    '  chosen: null',
    '  words: null',
    '  decidedBy: null',
    '  decidedAt: null',
    '  kind: task', // written LAST on purpose — proves SCHEMA order wins, not input order
    'created: 2026-01-01T00:00:00Z',
    'updated: 2026-01-02T00:00:00Z',
    '---',
    'body\n',
  ].join('\n');

  it('a task round-trips with `kind: task` on the line right after `question:`, regardless of input order', () => {
    const card = mustParse(DECISION_TASK_LAST);
    expect(card.decision?.kind).toBe('task');
    const text = serializeCard(card);
    const lines = text.split('\n');
    const questionIdx = lines.findIndex((l) => l.trim().startsWith('question:'));
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(lines[questionIdx + 1]?.trim()).toBe('kind: task');
    expect(mustParse(text)).toEqual(card);
    expect(serializeCard(mustParse(text))).toBe(text);
  });

  it('a plain QUESTION card (no kind) is byte-for-byte unchanged: no `kind:` line at all', () => {
    const card = mustParse(DECISION_TASK_LAST.replace('  kind: task\n', ''));
    expect('kind' in (card.decision as object)).toBe(false);
    const text = serializeCard(card);
    expect(text).not.toMatch(/^\s*kind:/m);
    expect(mustParse(text)).toEqual(card);
  });
});

/**
 * RCB-68: `parent`/`phase`/`gate` frontmatter fields. They sit after `refs`, before `decision`
 * (card.ts's `KNOWN_ORDER`) — a serialize always writes them there regardless of the order a
 * human (or another agent) wrote them in.
 */
describe('RCB-68: parent/phase/gate fields', () => {
  it('round-trip in canonical order, regardless of the order they were written in', () => {
    const card = mustParse(
      [
        '---',
        'id: RCB-1',
        'title: t',
        'status: todo',
        'gate: RCB-2',
        'phase: PH.3',
        'parent: RCB-9',
        'created: 2026-01-01T00:00:00Z',
        'updated: 2026-01-02T00:00:00Z',
        '---',
        'body\n',
      ].join('\n'),
    );
    expect(card.parent).toBe('RCB-9');
    expect(card.phase).toBe('PH.3');
    expect(card.gate).toBe('RCB-2');
    const text = serializeCard(card);
    expect(text).toBe(
      [
        '---',
        'id: RCB-1',
        'title: t',
        'status: todo',
        'parent: RCB-9',
        'phase: PH.3',
        'gate: RCB-2',
        'created: 2026-01-01T00:00:00Z',
        'updated: 2026-01-02T00:00:00Z',
        '---',
        'body\n',
      ].join('\n'),
    );
    expect(mustParse(text)).toEqual(card);
  });

  it('an empty gate (and parent, and phase) is refused by the schema', () => {
    const base = (line: string) =>
      `---\nid: RCB-1\ntitle: t\nstatus: todo\n${line}\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\n`;
    for (const line of ['gate: ""', 'parent: ""', 'phase: ""']) {
      const r = parseCard(base(line));
      expect(r.ok, line).toBe(false);
    }
  });
});

/**
 * The recovery must be invisible to every card this repo already has: if none of them makes
 * `YAML.parse` throw, none of them can reach the fallback, so none can change meaning. Read-only,
 * and skipped when the directory is absent (a packed copy, a clean checkout of the package alone).
 */
const CARDS_DIR = fileURLToPath(new URL('../../../.repoboard/cards', import.meta.url));
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(\r?\n|$)/m;

describe.skipIf(!existsSync(CARDS_DIR))('this repo’s own cards are unaffected', () => {
  const files = existsSync(CARDS_DIR)
    ? readdirSync(CARDS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];

  it('every card file parses', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    const failures = files.filter((f) => !parseCard(readFileSync(`${CARDS_DIR}/${f}`, 'utf8')).ok);
    expect(failures).toEqual([]);
  });

  it('none of them reaches the fallback: their frontmatter is valid YAML as written', () => {
    const needFallback: string[] = [];
    for (const f of files) {
      const m = FRONTMATTER.exec(readFileSync(`${CARDS_DIR}/${f}`, 'utf8'));
      expect(m?.[1]).toBeDefined();
      try {
        YAML.parse(m?.[1] ?? '', { schema: 'core' });
      } catch {
        needFallback.push(f);
      }
    }
    expect(needFallback).toEqual([]);
  });
});
