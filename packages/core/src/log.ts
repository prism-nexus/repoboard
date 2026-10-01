const LOG_HEADING = /^## Log[ \t]*$/m;
const NOTES_HEADING = /^## Notes[ \t]*$/m;
const DECISION_HEADING = /^## Decision[ \t]*$/m;
/** Any heading of level 1 or 2 ends a section (Log or Notes alike). */
const SECTION_END = /^#{1,2}[ \t]/m;

/**
 * RCB-70/RCB-107: the shared shape `appendLogLine`/`appendNoteLine`/`appendDecisionLine` all
 * funnel through, so the sections cannot drift (CLAUDE.md: one function per guarantee).
 * - `heading` present in `body` → the bullet goes at the end of that section (before the next
 *   `#`/`##` heading, or at end of body), trailing blank lines preserved.
 * - `heading` absent and `createBefore` given → each regex is tried against `body` in order, and
 *   the FIRST one that matches wins: a new section is created immediately before that heading,
 *   with a blank line above (when there is body text before it) and below.
 * - `heading` absent and nothing in `createBefore` matches (or none given) → a new section is
 *   created at the end, preceded by a blank line.
 * Everything else in the body is untouched.
 */
function appendSectionLine(
  body: string,
  heading: RegExp,
  headingText: string,
  line: string,
  createBefore?: RegExp | RegExp[],
): string {
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  const found = heading.exec(body);
  if (!found) {
    const candidates =
      createBefore === undefined ? [] : Array.isArray(createBefore) ? createBefore : [createBefore];
    let before: RegExpExecArray | null = null;
    for (const candidate of candidates) {
      before = candidate.exec(body);
      if (before) break;
    }
    if (before) {
      const at = before.index;
      const head = body.slice(0, at).replace(/\n+$/, '');
      const prefix = head.length === 0 ? '' : `${head}\n\n`;
      return `${prefix}${headingText}\n${bullet}\n\n${body.slice(at)}`;
    }
    const trimmedEnd = body.replace(/\n+$/, '');
    const prefix = trimmedEnd.length === 0 ? '' : `${trimmedEnd}\n`;
    return `${prefix}\n${headingText}\n${bullet}\n`;
  }
  const sectionStart = found.index + found[0].length;
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

/**
 * Append one bullet under the `## Log` heading of a card body.
 * - If the heading exists, the line goes at the end of that section
 *   (before the next `#`/`##` heading, or at end of body).
 * - If absent, a `## Log` heading is created at the end, preceded by a blank line.
 * Everything else in the body is untouched.
 */
export function appendLogLine(body: string, line: string): string {
  return appendSectionLine(body, LOG_HEADING, '## Log', line);
}

/**
 * RCB-70: append one bullet under the `## Notes` heading of a card body — a durable, attributed
 * remark meant to stay on the card, as opposed to `## Log`'s "what happened".
 * - If `## Notes` exists, the line goes at the end of that section, exactly `appendLogLine`'s
 *   in-section behaviour.
 * - If `## Notes` is absent and `## Log` is present, a `## Notes` heading is created immediately
 *   BEFORE `## Log` (blank line above and below), so the file reads description → notes → log.
 * - If neither is present, `## Notes` is created at the end, the way `## Log` is.
 */
export function appendNoteLine(body: string, line: string): string {
  return appendSectionLine(body, NOTES_HEADING, '## Notes', line, [LOG_HEADING]);
}

/**
 * RCB-107: append one bullet under the `## Decision` heading of a card body — the question and
 * options `card ask` opened and the answer `decide` gave, kept in the body (not only the
 * frontmatter `decision:` block, which a re-ask REPLACES) so an earlier question's text survives
 * every later ask.
 * - If `## Decision` exists, the line goes at the end of that section, exactly `appendLogLine`'s
 *   in-section behaviour.
 * - If absent, `## Decision` is created immediately BEFORE `## Notes` if present, else before
 *   `## Log` if present, else at the end — so the file reads description → decision → notes → log.
 */
export function appendDecisionLine(body: string, line: string): string {
  return appendSectionLine(body, DECISION_HEADING, '## Decision', line, [
    NOTES_HEADING,
    LOG_HEADING,
  ]);
}

/** Format a log bullet the way every surface writes it: `- <ISO> <actor> — <message>`. */
export function formatLogLine(ts: string, actor: string, message: string): string {
  return `- ${ts} ${actor} — ${message}`;
}

/**
 * RCB-70: format a note bullet the same shape as `formatLogLine`, except a note may be
 * multi-line: CR is stripped, the whole text is trimmed, and each internal `\n` becomes `\n  `
 * (a two-space continuation — valid markdown list-item continuation) so the note stays one list
 * item instead of breaking the bullet. `formatLogLine` itself is untouched: `append_log` still
 * collapses to one line.
 */
export function formatNoteLine(ts: string, actor: string, text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const continued = normalized.split('\n').join('\n  ');
  return `- ${ts} ${actor} — ${continued}`;
}

/**
 * RCB-107: format a decision bullet — same multi-line-safe shape as `formatNoteLine` (a question's
 * options become nested continuation lines under one bullet), reused rather than copied since a
 * decision entry is a note about what was asked or answered, not a new shape.
 */
export const formatDecisionLine = formatNoteLine;
