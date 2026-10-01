/**
 * P8.4 (plan §5 P8.4, §11 O9): `extractLinkedPaths` (the backtick rule), `summarizeCost` (the
 * arithmetic and the OVER rule), `formatCostTable`. RCB-46 / RCB-209: the sample fixture is a
 * routing-anchor CLAUDE.md written from scratch for a made-up project (`acme`), so this test never
 * touches a real repo and the fixture describes no real one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  approxTokens,
  type CostEntry,
  DEFAULT_CLAUDE_MD_BUDGET_BYTES,
  extractLinkedPaths,
  extractLinkedPathsFlagged,
  formatCostTable,
  MCP_SCHEMA_NOTE,
  summarizeCost,
} from '../src/cost.js';

const SAMPLE_CLAUDE_MD = fileURLToPath(new URL('./fixtures/sample-claude.md', import.meta.url));

/**
 * Written BY HAND from the fixture's own text (RCB-209), BEFORE running `extractLinkedPaths`
 * against it — not derived from the function under test (CLAUDE.md's own habit: "trust a
 * protective test only after watching it fail" applies equally to trusting an expectation only
 * after writing it independently). In order of FIRST appearance; every other backticked span in
 * the file is excluded for a reason recorded below. The fixture repeats `docs/STATUS.md`,
 * `docs/DECISIONS.md`, `README.md`, `docs/ROUTER.md` and `docs/STYLE-NOTES-2025-10-12.md` after
 * other paths have first appeared, so a last-occurrence order or a missing dedupe changes this list.
 */
const SAMPLE_EXPECTED_LINKED_PATHS = [
  'docs/STATUS.md',
  'docs/DECISIONS.md',
  'README.md',
  'docs/DESIGN.md',
  'docs/ROADMAP-2025.md',
  'docs/ROUTER.md',
  'docs/STYLE-NOTES-2025-10-12.md',
  'docs/REVIEW-GUIDE-2025-11-04.md',
  'docs/RELEASE-RUNBOOK.md',
  'scripts/README.md',
  'docs/SCHEMA.md',
  'docs/archive/CLAUDE-2025-11-03.md',
] as const;

describe('extractLinkedPaths — the sample CLAUDE.md fixture', () => {
  it('extracts exactly the hand-written list, in order, deduplicated', () => {
    const text = readFileSync(SAMPLE_CLAUDE_MD, 'utf8');
    expect(extractLinkedPaths(text)).toEqual([...SAMPLE_EXPECTED_LINKED_PATHS]);
  });

  it('excludes every other backticked span in the fixture, and says why', () => {
    // Each of these appears verbatim in the fixture (grep -o '`[^`]*`' confirms it) and is
    // excluded for the reason named — a change to `looksLikePath` that admits one of these
    // must fail here, not just fail to add it to the expected list above.
    const excludedWithReason: Record<string, string> = {
      '--apply': 'no slash, no extension',
      '.../acme-staging': 'a path segment ("...") made only of dots',
      '/tmp/acme-test.lock': 'absolute',
      '/healthz': 'absolute',
      '~/.acme/cache': 'contains "~", not in the allowed character set',
      main: 'no slash, no extension',
      any: 'no slash, no extension',
      'acme-docs': 'no slash, no extension',
      flag_page: 'no slash, no extension',
      close_thread: 'no slash, no extension',
      'docs/journal/<today>.md': 'contains "<"/">" , not in the allowed character set',
      'docs/journal/<yesterday>.md': 'contains "<"/">" , not in the allowed character set',
      'Closes B<n>': 'contains a space and "<"/">"',
      'B<n>': 'contains "<"/">"',
      '§': 'not in the allowed character set',
      'pnpm dev': 'contains a space',
      'pnpm test': 'contains a space',
      'pnpm typecheck': 'contains a space',
      'wc -c CLAUDE.md': 'contains a space (the ".md" extension alone must not admit it)',
    };
    const text = readFileSync(SAMPLE_CLAUDE_MD, 'utf8');
    const extracted = new Set(extractLinkedPaths(text));
    for (const [span, reason] of Object.entries(excludedWithReason)) {
      // RCB-50: assert the "appears verbatim" claim, so a fixture edit that drops a span cannot
      // leave this loop checking nothing.
      expect(text, `${JSON.stringify(span)} should be in the fixture`).toContain(`\`${span}\``);
      expect(extracted.has(span), `${JSON.stringify(span)} should be excluded: ${reason}`).toBe(
        false,
      );
    }
  });
});

describe("extractLinkedPaths — ignores .., absolute, but NOT non-existent (that is the server's job)", () => {
  it('ignores a ".." segment', () => {
    expect(extractLinkedPaths('See `../outside/secret.md` for details.')).toEqual([]);
  });

  it('ignores an absolute path', () => {
    expect(extractLinkedPaths('See `/etc/passwd` for details.')).toEqual([]);
  });

  it('keeps a syntactically valid relative path even when nothing on disk has that name — core does not check the filesystem', () => {
    expect(extractLinkedPaths('See `docs/DOES-NOT-EXIST.md` for details.')).toEqual([
      'docs/DOES-NOT-EXIST.md',
    ]);
  });

  it('dedupes repeats, keeping the first-appearance order', () => {
    expect(extractLinkedPaths('`docs/A.md` ... `docs/B.md` ... `docs/A.md`')).toEqual([
      'docs/A.md',
      'docs/B.md',
    ]);
  });

  it('admits a bare filename with a known extension (no slash required)', () => {
    expect(extractLinkedPaths('See `README.md`.')).toEqual(['README.md']);
  });

  it('rejects a glob (the "*" character is outside the allowed set)', () => {
    expect(extractLinkedPaths('See `docs/*-BRIEF.md`.')).toEqual([]);
  });

  it('does not span a fenced fake-multiline "backtick"', () => {
    // A backtick pair separated by a newline is not one inline-code span.
    expect(extractLinkedPaths('`docs/A.md\ndocs/B.md`')).toEqual([]);
  });
});

describe('summarizeCost — the budget boundary (C1: `<=` reads OK, must be `>`)', () => {
  it('is OK exactly AT the budget', () => {
    const report = summarizeCost([{ file: 'CLAUDE.md', bytes: 8192, why: 'root' }], {
      budget: 8192,
      claudeMdBytes: 8192,
      mcpServers: [],
    });
    expect(report.over).toBe(false);
  });

  it('is OVER at budget + 1', () => {
    const report = summarizeCost([{ file: 'CLAUDE.md', bytes: 8193, why: 'root' }], {
      budget: 8192,
      claudeMdBytes: 8193,
      mcpServers: [],
    });
    expect(report.over).toBe(true);
  });

  it('an absent CLAUDE.md can never be OVER', () => {
    const report = summarizeCost([], { budget: 8192, claudeMdBytes: null, mcpServers: [] });
    expect(report.over).toBe(false);
    expect(report.claudeMdBytes).toBeNull();
  });

  it('sums bytes and estimates tokens at 4 B/token', () => {
    const report = summarizeCost(
      [
        { file: 'CLAUDE.md', bytes: 4000, why: 'root' },
        { file: 'docs/AGENTS.md', bytes: 4000, why: 'agents' },
      ],
      { budget: DEFAULT_CLAUDE_MD_BUDGET_BYTES, claudeMdBytes: 4000, mcpServers: ['repoboard'] },
    );
    expect(report.totalBytes).toBe(8000);
    expect(report.totalTokensApprox).toBe(approxTokens(8000));
    expect(report.mcpServers).toEqual(['repoboard']);
    expect(report.mcpNote).toBe(MCP_SCHEMA_NOTE);
  });

  it('does not alias the input arrays (a caller mutating its own array after the call cannot change the report)', () => {
    const entries: CostEntry[] = [{ file: 'CLAUDE.md', bytes: 10, why: 'root' }];
    const mcpServers = ['repoboard'];
    const report = summarizeCost(entries, { budget: 100, claudeMdBytes: 10, mcpServers });
    entries.push({ file: 'AGENTS.md', bytes: 999, why: 'agents' });
    mcpServers.push('other');
    expect(report.entries).toHaveLength(1);
    expect(report.mcpServers).toEqual(['repoboard']);
  });
});

describe('formatCostTable', () => {
  it('renders the table, the total line, and an OK verdict', () => {
    const report = summarizeCost(
      [
        { file: 'CLAUDE.md', bytes: 4996, why: 'root' },
        { file: 'docs/BUILD-PLAN.md', bytes: 100, why: 'linked from CLAUDE.md' },
      ],
      { budget: 8192, claudeMdBytes: 4996, mcpServers: [] },
    );
    const text = formatCostTable(report);
    expect(text).toContain('FILE');
    expect(text).toContain('BYTES');
    expect(text).toContain('≈TOK');
    expect(text).toContain('WHY');
    expect(text).toContain('total  5096  ≈1274');
    expect(text).toContain('CLAUDE.md 4996 of budget 8192  OK');
    expect(text).toContain('estimate');
  });

  it('renders OVER and the absent line', () => {
    const over = formatCostTable(
      summarizeCost([{ file: 'CLAUDE.md', bytes: 9000, why: 'root' }], {
        budget: 8192,
        claudeMdBytes: 9000,
        mcpServers: [],
      }),
    );
    expect(over).toContain('CLAUDE.md 9000 of budget 8192  OVER');

    const absent = formatCostTable(
      summarizeCost([], { budget: 8192, claudeMdBytes: null, mcpServers: [] }),
    );
    expect(absent).toContain('CLAUDE.md — absent');
  });

  it('names MCP servers with the fixed note when at least one is configured', () => {
    const text = formatCostTable(
      summarizeCost([], { budget: 8192, claudeMdBytes: null, mcpServers: ['repoboard', 'acme'] }),
    );
    expect(text).toContain('mcp servers: repoboard, acme');
    expect(text).toContain(MCP_SCHEMA_NOTE);
  });

  it('omits the mcp servers line entirely when none are configured', () => {
    const text = formatCostTable(
      summarizeCost([], { budget: 8192, claudeMdBytes: null, mcpServers: [] }),
    );
    expect(text).not.toContain('mcp servers');
  });
});

// ---- RCB-91: a FROZEN-linked path is billed separately and left out of the total ----------

describe('extractLinkedPathsFlagged — the frozen flag, SENTENCE-scoped (RCB-91 pass 2)', () => {
  const TEXT = [
    '`docs/HOT.md` is read fresh, every time.',
    '`docs/COLD.md` is FROZEN history — read a section it is pointed at, never append to it.',
  ].join('\n');

  it('flags only the path whose own sentence says FROZEN', () => {
    expect(extractLinkedPathsFlagged(TEXT)).toEqual([
      { path: 'docs/HOT.md', frozen: false },
      { path: 'docs/COLD.md', frozen: true },
    ]);
  });

  it('extractLinkedPaths (unchanged) returns the same bare path list, in the same order', () => {
    expect(extractLinkedPaths(TEXT)).toEqual(['docs/HOT.md', 'docs/COLD.md']);
  });

  it('a path named twice is frozen per its FIRST occurrence’s sentence only', () => {
    const text = [
      '`docs/A.md` is FROZEN as of today.',
      'See `docs/A.md` again here, plainly.',
    ].join('\n');
    expect(extractLinkedPathsFlagged(text)).toEqual([{ path: 'docs/A.md', frozen: true }]);

    const reversed = [
      'See `docs/A.md` here, plainly.',
      '`docs/A.md` is FROZEN as of today, on its second mention.',
    ].join('\n');
    expect(extractLinkedPathsFlagged(reversed)).toEqual([{ path: 'docs/A.md', frozen: false }]);
  });

  it('the `\\b` word boundary: "unfrozen" prose does NOT flag (one word, no boundary before "frozen")', () => {
    expect(extractLinkedPathsFlagged('`docs/A.md` stays unfrozen and editable.')).toEqual([
      { path: 'docs/A.md', frozen: false },
    ]);
  });

  it('a path whose own name contains "frozen" does NOT self-flag on an otherwise plain sentence', () => {
    expect(extractLinkedPathsFlagged('See `docs/frozen-yogurt.md` for the recipe.')).toEqual([
      { path: 'docs/frozen-yogurt.md', frozen: false },
    ]);
  });

  it('a capitalised "Frozen" on its own IS the word', () => {
    expect(extractLinkedPathsFlagged('`docs/A.md` — Frozen as of today.')).toEqual([
      { path: 'docs/A.md', frozen: true },
    ]);
  });

  it('RCB-91 pass 2: the span and "FROZEN" sit on DIFFERENT lines of ONE sentence — still flags (this is a member project’s own docs/HANDOFF.md shape: the backtick span ends one source line, "is FROZEN history..." opens the next, same sentence, no terminator between)', () => {
    const text = ['`docs/A.md`', 'is FROZEN as of today, continuing this very sentence.'].join(
      '\n',
    );
    expect(extractLinkedPathsFlagged(text)).toEqual([{ path: 'docs/A.md', frozen: true }]);
  });

  it('RCB-91 pass 2: "FROZEN" in the NEXT sentence, even on the SAME source line, must NOT flag', () => {
    const text = '`docs/A.md` is fine here. FROZEN shows up in the very next sentence, same line.';
    expect(extractLinkedPathsFlagged(text)).toEqual([{ path: 'docs/A.md', frozen: false }]);
  });

  it('a blank line (paragraph break) ends a sentence even with no terminator before it', () => {
    const text = ['`docs/A.md` has no period here', '', 'FROZEN starts a new paragraph.'].join(
      '\n',
    );
    expect(extractLinkedPathsFlagged(text)).toEqual([{ path: 'docs/A.md', frozen: false }]);
  });
});

describe('summarizeCost / formatCostTable — a frozen entry is billed out of the total (RCB-91)', () => {
  const entries: CostEntry[] = [
    { file: 'docs/HOT.md', bytes: 300, why: 'linked from CLAUDE.md' },
    { file: 'docs/COLD.md', bytes: 700, why: 'frozen' },
  ];

  it('totalBytes excludes the frozen entry; frozenBytes sums it separately', () => {
    const report = summarizeCost(entries, { budget: 8192, claudeMdBytes: 100, mcpServers: [] });
    expect(report.totalBytes).toBe(300);
    expect(report.totalTokensApprox).toBe(approxTokens(300));
    expect(report.frozenBytes).toBe(700);
    expect(report.frozenTokensApprox).toBe(approxTokens(700));
  });

  it('formatCostTable: the frozen row reads "frozen — not in total"; a frozen line follows total', () => {
    const report = summarizeCost(entries, { budget: 8192, claudeMdBytes: 100, mcpServers: [] });
    const text = formatCostTable(report);
    expect(text).toContain('frozen — not in total');
    expect(text).toContain(`total  300  ≈${approxTokens(300)}`);
    expect(text).toContain(`frozen  700  ≈${approxTokens(700)}  (linked as FROZEN, not in total)`);
  });

  it('omits the frozen line entirely when frozenBytes is 0', () => {
    const report = summarizeCost(
      [{ file: 'docs/HOT.md', bytes: 300, why: 'linked from CLAUDE.md' }],
      { budget: 8192, claudeMdBytes: 100, mcpServers: [] },
    );
    expect(report.frozenBytes).toBe(0);
    expect(formatCostTable(report)).not.toContain('frozen');
  });
});

describe("summarizeCost / formatCostTable — a 'systems' entry (RCB-97: .repoboard/systems.yml)", () => {
  it('bills into totalBytes like root/agents, not frozenBytes', () => {
    const report = summarizeCost([{ file: '.repoboard/systems.yml', bytes: 512, why: 'systems' }], {
      budget: 8192,
      claudeMdBytes: 100,
      mcpServers: [],
    });
    expect(report.totalBytes).toBe(512);
    expect(report.frozenBytes).toBe(0);
  });

  it('formatCostTable shows the file with why "systems"', () => {
    const report = summarizeCost([{ file: '.repoboard/systems.yml', bytes: 512, why: 'systems' }], {
      budget: 8192,
      claudeMdBytes: 100,
      mcpServers: [],
    });
    const text = formatCostTable(report);
    expect(text).toContain('.repoboard/systems.yml');
    expect(text).toContain('systems');
    expect(text).toContain(`total  512  ≈${approxTokens(512)}`);
  });
});
