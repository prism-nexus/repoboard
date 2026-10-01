import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.use({ gfm: true, async: false });

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return sanitize(html);
}

/** RCB-72: a note's message — like `renderMarkdown` but a single newline is a `<br>` (GFM `breaks`). */
export function renderNote(md: string): string {
  const html = marked.parse(md, { async: false, breaks: true, gfm: true }) as string;
  return sanitize(html);
}

export interface LogEntry {
  ts: string | null;
  actor: string | null;
  message: string;
}

const LOG_HEADING = /^## Log[ \t]*$/m;
const NOTES_HEADING = /^## Notes[ \t]*$/m;
const SECTION_END = /^#{1,2}[ \t]/m;
/** `- 2026-09-02T22:41Z claude/web-agent — moved to doing` (core's formatLogLine shape). */
const LOG_LINE = /^-\s+(\S+)\s+(\S+)\s+—\s+(.*)$/;

/** Pull `heading`'s section out of `body`: its text, and `body` with that section removed. */
function extractSection(body: string, heading: RegExp): { section: string; rest: string } {
  const m = heading.exec(body);
  if (!m) return { section: '', rest: body };
  const start = m.index + m[0].length;
  const afterHeading = body.slice(start);
  const next = SECTION_END.exec(afterHeading);
  const end = next ? start + next.index : body.length;
  const section = body.slice(start, end);
  const rest = body.slice(0, m.index) + body.slice(end);
  return { section, rest };
}

/**
 * Parse a section's raw text into entries. Log lines (matching `LOG_LINE`, with a parseable
 * timestamp) each start a new entry. When `continuation` is set (RCB-70's `## Notes`), any other
 * non-blank line — a two-space-indented continuation line, or anything else that does not match —
 * is appended to the PREVIOUS entry's `message` with `\n` instead of starting a new one; with no
 * previous entry it becomes a `{ts:null, actor:null}` entry, same as `## Log`'s own fallback.
 */
function parseEntries(section: string, continuation: boolean): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of section.split('\n')) {
    if (raw.trim() === '') continue;
    const line = raw.trim();
    // A raw line starting with two spaces is a continuation line by construction
    // (`formatNoteLine`'s `\n  ` shape) even if its trimmed text happens to look like a bullet.
    const m = raw.startsWith('  ') ? null : LOG_LINE.exec(line);
    const isBullet = m !== null && !Number.isNaN(Date.parse(m[1] ?? ''));
    if (continuation && !isBullet) {
      const prev = out.at(-1);
      if (prev) {
        prev.message += `\n${line}`;
        continue;
      }
    }
    if (isBullet && m) {
      out.push({ ts: m[1] ?? null, actor: m[2] ?? null, message: m[3] ?? '' });
    } else {
      out.push({ ts: null, actor: null, message: line.replace(/^-\s+/, '') });
    }
  }
  return out;
}

/**
 * Split a card body into the markdown to render and the `## Notes` / `## Log` bullets to show as
 * timelines. Anything after both sections (another heading) is rendered with the description.
 * RCB-70: `## Notes` is removed the same way `## Log` is — otherwise every note renders twice.
 */
export function splitBody(body: string): {
  description: string;
  notes: LogEntry[];
  log: LogEntry[];
} {
  const { section: notesSection, rest: afterNotes } = extractSection(body, NOTES_HEADING);
  const { section: logSection, rest: description } = extractSection(afterNotes, LOG_HEADING);
  return {
    description,
    notes: parseEntries(notesSection, true),
    log: parseEntries(logSection, false),
  };
}
