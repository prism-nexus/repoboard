import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.use({ gfm: true, async: false });

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export interface LogEntry {
  ts: string | null;
  actor: string | null;
  message: string;
}

const LOG_HEADING = /^## Log[ \t]*$/m;
const SECTION_END = /^#{1,2}[ \t]/m;
/** `- 2026-09-02T22:41Z claude/web-agent — moved to doing` (core's formatLogLine shape). */
const LOG_LINE = /^-\s+(\S+)\s+(\S+)\s+—\s+(.*)$/;

/**
 * Split a card body into the markdown to render and the `## Log` bullets to show as a timeline.
 * Anything after the log section (another heading) is rendered with the description.
 */
export function splitBody(body: string): { description: string; log: LogEntry[] } {
  const heading = LOG_HEADING.exec(body);
  if (!heading) return { description: body, log: [] };
  const start = heading.index + heading[0].length;
  const rest = body.slice(start);
  const next = SECTION_END.exec(rest);
  const end = next ? start + next.index : body.length;
  const section = body.slice(start, end);
  const description = body.slice(0, heading.index) + body.slice(end);
  const log: LogEntry[] = [];
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = LOG_LINE.exec(line);
    if (m && !Number.isNaN(Date.parse(m[1] ?? ''))) {
      log.push({ ts: m[1] ?? null, actor: m[2] ?? null, message: m[3] ?? '' });
    } else {
      log.push({ ts: null, actor: null, message: line.replace(/^-\s+/, '') });
    }
  }
  return { description, log };
}
