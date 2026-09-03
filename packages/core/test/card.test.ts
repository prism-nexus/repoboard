import { describe, expect, it } from 'vitest';
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
