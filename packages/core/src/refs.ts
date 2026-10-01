/**
 * K7 (plan §11 O5): a card carries `refs:` — pointers into repo files — and every surface
 * renders the referenced lines live from the file, never from a copy. This is the I/O-free half:
 * `parseRef` turns a spec into a `Ref`, `resolveRef` picks the span out of the file's text.
 * The server owns the one guarded path from a spec to a file; the web only draws the result.
 *
 * Forms (.repoboard/local/briefs/K7-REFS-BRIEF.md):
 *   path#Heading text   first heading whose normalized text starts with the spec, to the line
 *                       before the next heading of the same or higher level (or EOF)
 *   path@Token          first line that, after list markers and emphasis, starts with Token, to
 *                       the line before the next blank line, heading, or list item at the same
 *                       or lesser indent. RCB-177: a line whose first token IS Token wrapped in
 *                       `"` or `'` (optionally followed by `:`) matches too, so `@triggers`
 *                       finds `  "triggers": {` in a JSON/JSONC file
 *   path@a.b            RCB-187, key path: only when no line starts with the literal `a.b`, `a` is
 *                       resolved as above and `b` is the first match INSIDE `a`'s span (`@a.b.c`
 *                       nests further); the answer is `b`'s span, clamped to `a`'s end
 *   path:L10-L20        1-based inclusive line range; `:L10` is one line
 *   path                the whole file
 */

export type Ref =
  | { spec: string; path: string; kind: 'heading'; heading: string }
  | { spec: string; path: string; kind: 'token'; token: string }
  | { spec: string; path: string; kind: 'lines'; start: number; end: number }
  | { spec: string; path: string; kind: 'file' };

export type ParseRefResult = { ok: true; ref: Ref } | { ok: false; error: string };

/** A resolved span. `start`/`end` are 1-based inclusive line numbers of what `text` holds. */
export interface RefSpan {
  text: string;
  start: number;
  end: number;
  /** True when the span hit REF_MAX_LINES or REF_MAX_BYTES; `end` is the last line included. */
  truncated: boolean;
}

/** A missing answer is `text: null` with a reason — never a guess (CLAUDE.md). */
export type ResolveRefResult = RefSpan | { text: null; error: string };

/** Wire shape of one entry of `GET /api/cards/:id/refs` (plan §3), CLI `--resolve`, MCP. */
export interface ResolvedRef {
  spec: string;
  path: string | null;
  start: number | null;
  end: number | null;
  text: string | null;
  truncated: boolean;
  error: string | null;
}

export const REF_MAX_LINES = 200;
export const REF_MAX_BYTES = 16 * 1024;

const LINES_SUFFIX = /^(.*?):L(\d+)(?:-L?(\d+))?$/;
const LINES_ATTEMPT = /:L?\d+(-L?\d+)?$/;
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;

/** Strip `#` markers and closing hashes, trim, case-fold, collapse whitespace. */
export function normalizeHeading(text: string): string {
  return text
    .replace(/^[ \t]*#+/, '')
    .replace(/[ \t]+#+[ \t]*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function parseRef(specIn: string): ParseRefResult {
  const spec = specIn.trim();
  if (spec.length === 0) return { ok: false, error: 'empty ref' };
  const hash = spec.indexOf('#');
  const at = spec.indexOf('@');
  const cut = hash === -1 ? at : at === -1 ? hash : Math.min(hash, at);
  if (cut !== -1) {
    const sigil = spec[cut];
    const path = spec.slice(0, cut).trim();
    const rest = spec.slice(cut + 1).trim();
    if (path.length === 0) return { ok: false, error: `"${spec}": missing path before "${sigil}"` };
    if (sigil === '#') {
      if (normalizeHeading(rest).length === 0) {
        return { ok: false, error: `"${spec}": missing heading text after "#"` };
      }
      return { ok: true, ref: { spec, path, kind: 'heading', heading: rest } };
    }
    if (rest.length === 0) return { ok: false, error: `"${spec}": missing token after "@"` };
    return { ok: true, ref: { spec, path, kind: 'token', token: rest } };
  }
  const lines = LINES_SUFFIX.exec(spec);
  if (lines?.[1] !== undefined && lines[2] !== undefined) {
    const path = lines[1].trim();
    if (path.length === 0) return { ok: false, error: `"${spec}": missing path before ":L"` };
    const start = Number.parseInt(lines[2], 10);
    const end = lines[3] === undefined ? start : Number.parseInt(lines[3], 10);
    if (start < 1) return { ok: false, error: `"${spec}": lines are numbered from 1` };
    if (end < start) return { ok: false, error: `"${spec}": end line ${end} is before ${start}` };
    return { ok: true, ref: { spec, path, kind: 'lines', start, end } };
  }
  if (LINES_ATTEMPT.test(spec)) {
    return { ok: false, error: `"${spec}": a line range is written :L<start> or :L<start>-L<end>` };
  }
  return { ok: true, ref: { spec, path: spec, kind: 'file' } };
}

/**
 * RCB-208: the one rule for "which file does a pointer name" — `parseRef`'s path, or `null` when
 * the spec does not parse. A ranged, token, or heading pointer (`path:L10-L20`, `path@Token`,
 * `path#Heading`) is answered for its WHOLE file: the static test match and the json-summary
 * coverage are per file, never per span.
 */
export function refPath(spec: string): string | null {
  const parsed = parseRef(spec);
  return parsed.ok ? parsed.ref.path : null;
}

/** Lines of a file: `\n` or `\r\n` endings; a trailing newline does not add an empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Heading level per line (1–6) or null. Fence-aware: a `# line` inside a ``` or ~~~ block is
 * code, not a heading — plan §2 has `## Log` inside a fenced example, which must not end §2.
 */
function headingLevels(lines: readonly string[]): (number | null)[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const f = FENCE.exec(line);
    if (f?.[1] !== undefined) {
      const marker = f[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return null;
    }
    if (fence !== null) return null;
    const h = HEADING.exec(line);
    return h?.[1] !== undefined ? h[1].length : null;
  });
}

/**
 * P8.5 (`sync-issues`, plan §11 O9): the 0-based [start,end] inclusive line indices of the
 * section under the first heading whose normalized text starts with `heading` — the SAME rule
 * `resolveRef`'s `'heading'` case uses (extracted here so the two never disagree: `sync-issues`
 * calls this directly rather than re-deriving "what is a heading's section"). Unlike
 * `resolveRef`, this returns indices only — no `span()`, so no `REF_MAX_LINES`/`REF_MAX_BYTES`
 * truncation: a K-entry list can run to thousands of lines and must be read in full, where a
 * card's rendered `refs:` preview is deliberately capped.
 */
export function findHeadingSection(
  lines: readonly string[],
  heading: string,
): { start: number; end: number } | null {
  const want = normalizeHeading(heading);
  const levels = headingLevels(lines);
  const n = lines.length;
  let start = -1;
  let level = 0;
  for (let i = 0; i < n; i++) {
    const lvl = levels[i];
    if (lvl !== null && lvl !== undefined && normalizeHeading(lines[i] ?? '').startsWith(want)) {
      start = i;
      level = lvl;
      break;
    }
  }
  if (start === -1) return null;
  let end = n - 1;
  for (let j = start + 1; j < n; j++) {
    const lvl = levels[j];
    if (lvl !== null && lvl !== undefined && lvl <= level) {
      end = j - 1;
      break;
    }
  }
  return { start, end };
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Lines `s..e` (0-based inclusive) under the caps. Always at least one line, itself cut to fit. */
function span(lines: readonly string[], s: number, e: number): RefSpan {
  let bytes = 0;
  let last = s - 1;
  let truncated = false;
  for (let i = s; i <= e; i++) {
    if (i - s >= REF_MAX_LINES) {
      truncated = true;
      break;
    }
    const cost = utf8Bytes(lines[i] ?? '') + (i > s ? 1 : 0);
    if (bytes + cost > REF_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += cost;
    last = i;
  }
  if (last < s) {
    return { text: (lines[s] ?? '').slice(0, REF_MAX_BYTES), start: s + 1, end: s + 1, truncated };
  }
  return { text: lines.slice(s, last + 1).join('\n'), start: s + 1, end: last + 1, truncated };
}

/** The text a `@Token` is matched against: list marker gone, `**`/`~~`/`__` emphasis gone. */
function tokenText(line: string): string {
  return line
    .replace(LIST_MARKER, '')
    .replace(/\*\*|~~|__/g, '')
    .replace(/^[*_~`]+/, '')
    .trim();
}

/**
 * RCB-177: does `text` (a `tokenText`) open with the token wrapped in one kind of quote —
 * `"token"` or `'token'` — and then nothing, or an optional-whitespace `:` (a JSON/YAML key)?
 * Exact inside the quotes: `@trigger` does NOT match `"triggers":`, which the bare rule (a prefix
 * match) would have. This is an ADDITIONAL way to match, tried only when no line matches the bare
 * rule (`resolveRef`, 'token'), so nothing the bare rule matched changes.
 */
function isQuotedToken(text: string, token: string): boolean {
  const quote = text.charAt(0);
  if (quote !== '"' && quote !== "'") return false;
  if (!text.startsWith(token, 1) || text.charAt(1 + token.length) !== quote) return false;
  const rest = text.slice(token.length + 2).trimStart();
  return rest === '' || rest.startsWith(':');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The line (0-based, within `from..to` inclusive) a `@token` names, or -1. Two passes, bare first:
 * a ref that matched a line before RCB-177 still matches THAT line even when an earlier line would
 * now match by the quoted rule. The quoted rule only ever answers a ref the bare rule could not.
 */
function findTokenLine(lines: readonly string[], token: string, from: number, to: number): number {
  for (let i = from; i <= to; i++) {
    if (tokenText(lines[i] ?? '').startsWith(token)) return i;
  }
  for (let i = from; i <= to; i++) {
    if (isQuotedToken(tokenText(lines[i] ?? ''), token)) return i;
  }
  return -1;
}

/** Last line (0-based) of the `@token` block that opens at `start`: the line before the next blank
 *  line, heading, or list item at the same or lesser indent; EOF when none. */
function tokenEnd(
  lines: readonly string[],
  levels: readonly (number | null)[],
  start: number,
): number {
  const indent = indentOf(lines[start] ?? '');
  const n = lines.length;
  for (let j = start + 1; j < n; j++) {
    const line = lines[j] ?? '';
    const isList = LIST_MARKER.test(line);
    if (line.trim() === '' || levels[j] !== null || (isList && indentOf(line) <= indent)) {
      return j - 1;
    }
  }
  return n - 1;
}

/**
 * RCB-187: `@a.b` read as a key path. Segment 1 is found with the `@token` rule over the whole
 * file; each next segment with the same rule, but only in the lines AFTER the previous segment's
 * line and within its span. The answer is the LAST segment's span, its end clamped to the parent's
 * end (a child's own block rule may run past the parent's; the parent bounds it). An empty segment
 * (`a..b`, `.a`, `a.`) is an error; a missing one is named with its parent.
 */
function resolveKeyPath(
  path: string,
  token: string,
  lines: readonly string[],
  levels: readonly (number | null)[],
): ResolveRefResult {
  const segments = token.split('.');
  if (segments.some((segment) => segment.length === 0)) {
    return { text: null, error: `"${token}" is not a key path: it has an empty segment` };
  }
  let from = 0;
  let to = lines.length - 1;
  let parent: string | null = null;
  let start = 0;
  let end = to;
  for (const segment of segments) {
    const at = findTokenLine(lines, segment, from, to);
    if (at === -1) {
      return {
        text: null,
        error:
          parent === null
            ? `no line starting with "${segment}" in ${path}`
            : `no "${segment}" under "${parent}" in ${path}`,
      };
    }
    start = at;
    end = Math.min(tokenEnd(lines, levels, at), to);
    from = at + 1;
    to = end;
    parent = segment;
  }
  return span(lines, start, end);
}

export function resolveRef(ref: Ref, fileText: string): ResolveRefResult {
  const lines = splitLines(fileText);
  const n = lines.length;
  switch (ref.kind) {
    case 'file':
      return span(lines, 0, n - 1);
    case 'lines': {
      if (ref.start > n) {
        return {
          text: null,
          error: `line ${ref.start} is past the end of ${ref.path} (${n} lines)`,
        };
      }
      if (ref.end > n) {
        return { text: null, error: `line ${ref.end} is past the end of ${ref.path} (${n} lines)` };
      }
      return span(lines, ref.start - 1, ref.end - 1);
    }
    case 'heading': {
      const found = findHeadingSection(lines, ref.heading);
      if (found === null) {
        return { text: null, error: `heading "${ref.heading}" not found in ${ref.path}` };
      }
      return span(lines, found.start, found.end);
    }
    case 'token': {
      const levels = headingLevels(lines);
      // Whole token first, exactly as before RCB-187: a token that contains a dot and matches a
      // line literally (`P6.1`, `v1.2 notes`) still wins. The key-path reading only ever answers a
      // dotted token the literal reading could not.
      const start = findTokenLine(lines, ref.token, 0, n - 1);
      if (start !== -1) return span(lines, start, tokenEnd(lines, levels, start));
      if (ref.token.includes('.')) return resolveKeyPath(ref.path, ref.token, lines, levels);
      return { text: null, error: `no line starting with "${ref.token}" in ${ref.path}` };
    }
  }
}

/** Parse + resolve in one step, in the wire shape. `path` is filled from the spec when it parses. */
export function resolveRefText(spec: string, fileText: string): ResolvedRef {
  const parsed = parseRef(spec);
  if (!parsed.ok) return refError(spec, null, parsed.error);
  const res = resolveRef(parsed.ref, fileText);
  if (res.text === null) return refError(spec, parsed.ref.path, res.error);
  return {
    spec,
    path: parsed.ref.path,
    start: res.start,
    end: res.end,
    text: res.text,
    truncated: res.truncated,
    error: null,
  };
}

export function refError(spec: string, path: string | null, error: string): ResolvedRef {
  return { spec, path, start: null, end: null, text: null, truncated: false, error };
}
