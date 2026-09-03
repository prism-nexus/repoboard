const LOG_HEADING = /^## Log[ \t]*$/m;
/** Any heading of level 1 or 2 ends the Log section. */
const SECTION_END = /^#{1,2}[ \t]/m;

/**
 * Append one bullet under the `## Log` heading of a card body.
 * - If the heading exists, the line goes at the end of that section
 *   (before the next `#`/`##` heading, or at end of body).
 * - If absent, a `## Log` heading is created at the end, preceded by a blank line.
 * Everything else in the body is untouched.
 */
export function appendLogLine(body: string, line: string): string {
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  const heading = LOG_HEADING.exec(body);
  if (!heading) {
    const trimmedEnd = body.replace(/\n+$/, '');
    const prefix = trimmedEnd.length === 0 ? '' : `${trimmedEnd}\n`;
    return `${prefix}\n## Log\n${bullet}\n`;
  }
  const sectionStart = heading.index + heading[0].length;
  const rest = body.slice(sectionStart);
  const nextHeading = SECTION_END.exec(rest);
  const sectionEnd = nextHeading ? sectionStart + nextHeading.index : body.length;
  const section = body.slice(sectionStart, sectionEnd);
  const after = body.slice(sectionEnd);

  // Keep exactly the trailing blank lines the section already had (so a following
  // heading keeps its spacing), and insert the bullet before them.
  const trailing = /\n*$/.exec(section)?.[0] ?? '';
  const content = section.slice(0, section.length - trailing.length);
  const sep = nextHeading ? (trailing.length >= 2 ? trailing : '\n\n') : '\n';
  return `${body.slice(0, sectionStart)}${content}\n${bullet}${sep}${after}`;
}

/** Format a log bullet the way every surface writes it: `- <ISO> <actor> — <message>`. */
export function formatLogLine(ts: string, actor: string, message: string): string {
  return `- ${ts} ${actor} — ${message}`;
}
