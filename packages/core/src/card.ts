import * as YAML from 'yaml';
import { z } from 'zod';
import type { Card } from './types.js';

const isoDatetime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'must be an ISO-8601 datetime',
});

export const PrioritySchema = z.enum(['high', 'medium', 'low']);

/** Frontmatter only. Loose: unknown keys pass through (§2: never dropped). */
export const CardFrontmatterSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  status: z.string().min(1),
  created: isoDatetime,
  updated: isoDatetime,
  assignee: z.string().optional(),
  priority: PrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
});

/** Frontmatter + body = a Card. */
export const CardSchema = CardFrontmatterSchema.extend({ body: z.string() });

export const REQUIRED_CARD_KEYS = ['id', 'title', 'status', 'created', 'updated'] as const;
export const OPTIONAL_CARD_KEYS = ['assignee', 'priority', 'labels', 'files', 'refs'] as const;
/** Canonical frontmatter order on serialize; unknown keys follow in their original order. */
const KNOWN_ORDER = [
  'id',
  'title',
  'status',
  'assignee',
  'priority',
  'labels',
  'files',
  'refs',
  'created',
  'updated',
] as const;
const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN_ORDER);

export type CardParseResult = { ok: true; card: Card } | { ok: false; error: string };

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(\r?\n|$)/m;

function splitFrontmatter(
  text: string,
): { ok: true; yaml: string; body: string } | { ok: false; error: string } {
  const open = OPEN.exec(text);
  if (!open) {
    return { ok: false, error: 'missing frontmatter: file must start with a `---` line' };
  }
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) {
    return { ok: false, error: 'unterminated frontmatter: no closing `---` line' };
  }
  return {
    ok: true,
    yaml: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

/** The one line the K1(b) fallback may rewrite: a top-level, non-empty `title:` value. */
const TITLE_LINE = /^title:[ \t]+(.*)$/m;
/**
 * A value starting with one of these is not a plain scalar, so quoting it would change what the
 * document means (`|`/`>` block, `&`/`*` anchor, `!` tag, `#` comment, `{`/`[` flow collection)
 * — plus the two quote characters, which mean the value is already quoted.
 */
const UNSAFE_TITLE_STARTS: ReadonlySet<string> = new Set([
  '|',
  '>',
  '&',
  '*',
  '!',
  '#',
  '{',
  '[',
  '"',
  "'",
]);

/**
 * K1(b): `title: P3.1 Board view: columns` is invalid YAML, and 7 of the first 24 hand-written
 * cards were written that way (HANDOFF §7.1). Return `yamlText` with only that one line's value
 * quoted, or `null` when there is nothing that can be safely quoted.
 *
 * This is a recovery attempt, not a parse strategy: `parseCard` calls it only after `YAML.parse`
 * has thrown, so a document that parses keeps exactly its own meaning.
 */
function quoteTitleValue(yamlText: string): string | null {
  const m = TITLE_LINE.exec(yamlText);
  const raw = m?.[1];
  if (m === null || raw === undefined) return null;
  // A plain scalar drops trailing spaces and a stray CR; keep the same value YAML would have.
  const value = raw.replace(/[ \t\r]+$/, '');
  const first = value[0];
  if (first === undefined || UNSAFE_TITLE_STARTS.has(first)) return null;
  // Let the YAML writer do the escaping — a hand-rolled `"` + value + `"` gets `\` and `"` wrong.
  const quoted = YAML.stringify(value, {
    defaultStringType: 'QUOTE_DOUBLE',
    lineWidth: 0,
  }).replace(/\n$/, '');
  // A quoted scalar that still spans lines would shift every line below it; refuse instead.
  if (quoted.includes('\n')) return null;
  return `${yamlText.slice(0, m.index)}title: ${quoted}${yamlText.slice(m.index + m[0].length)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parse the text of a `.repoboard/cards/<id>.md` file.
 * Never throws; a bad file yields `{ok:false, error}` with a message naming the problem key.
 */
export function parseCard(text: string): CardParseResult {
  const split = splitFrontmatter(text);
  if (!split.ok) return split;

  let data: unknown;
  try {
    // YAML 1.2 core schema: timestamps stay strings, which is what we want.
    data = YAML.parse(split.yaml, { schema: 'core' });
  } catch (e) {
    const original = `frontmatter is not valid YAML: ${(e as Error).message}`;
    // K1(b): one retry, with only the `title:` value quoted. Anything else stays as written.
    const retried = quoteTitleValue(split.yaml);
    if (retried === null) return { ok: false, error: original };
    try {
      data = YAML.parse(retried, { schema: 'core' });
    } catch {
      // The user never wrote the rewrite, so they must not be shown its error.
      return { ok: false, error: original };
    }
  }
  if (data === null || data === undefined) {
    return { ok: false, error: 'frontmatter is empty' };
  }
  if (!isPlainObject(data)) {
    return { ok: false, error: 'frontmatter must be a YAML mapping' };
  }
  if ('body' in data) {
    return { ok: false, error: 'frontmatter key "body" is reserved for the markdown body' };
  }

  const missing = REQUIRED_CARD_KEYS.filter((k) => data[k] === undefined || data[k] === null);
  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'key' : 'keys';
    return { ok: false, error: `missing required ${noun}: ${missing.join(', ')}` };
  }
  // `assignee:` with no value reads as null; treat null optional keys as absent.
  for (const k of OPTIONAL_CARD_KEYS) {
    if (data[k] === null) delete data[k];
  }

  const result = CardSchema.safeParse({ ...data, body: split.body });
  if (!result.success) {
    return { ok: false, error: result.error.issues.map(formatIssue).join('; ') };
  }
  return { ok: true, card: result.data };
}

/**
 * Serialize a Card back to file text. Known keys in canonical order, unknown keys after in
 * their original order, undefined values omitted, body appended byte-for-byte.
 */
export function serializeCard(card: Card): string {
  const { body, ...frontmatter } = card;
  const ordered: Record<string, unknown> = {};
  for (const k of KNOWN_ORDER) {
    if (frontmatter[k] !== undefined) ordered[k] = frontmatter[k];
  }
  for (const [k, v] of Object.entries(frontmatter)) {
    if (!KNOWN_SET.has(k) && v !== undefined) ordered[k] = v;
  }
  const yamlText = YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
  return `---\n${yamlText}---\n${body}`;
}
