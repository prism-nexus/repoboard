/**
 * RCB-91: `gatherCost` bills a FROZEN-linked path (`why: 'frozen'`) separately and out of the
 * total — the CLI/JSON table-level assertions already live in `cli.test.ts`'s `describe('repoboard
 * cost', ...)`; this file is the direct unit coverage of `gatherCost` itself (no prior
 * `packages/server/test/cost.test.ts` existed before this card — see the brief's own file list).
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherCost } from '../src/cost.js';
import { makeTempRepoNoBoard } from './helpers.js';

// RCB-46's own pattern: the freshpickedjobs-against-the-real-file check needs a real sibling
// repo, which a public CI box does not have — point $REPOBOARD_SIBLING_ROOT at one to run it (no
// default); unset or missing, it skips.
const siblingRoot = process.env.REPOBOARD_SIBLING_ROOT ?? '';
const hasSiblingRoot = siblingRoot !== '' && existsSync(siblingRoot);

const dirs: string[] = [];
async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

describe('gatherCost — a FROZEN-linked path is billed as why: "frozen" and out of the total (RCB-91)', () => {
  it('a plain linked path stays why: "linked from CLAUDE.md"; a FROZEN one becomes why: "frozen"', async () => {
    const claudeMd = [
      '# root',
      '',
      '`docs/HOT.md` is read fresh, every time.',
      '`docs/COLD.md` is FROZEN history — read a section it is pointed at, never append to it.',
      '',
    ].join('\n');
    const fixture = await makeTempRepoNoBoard({
      'CLAUDE.md': claudeMd,
      'docs/HOT.md': 'x'.repeat(50),
      'docs/COLD.md': 'y'.repeat(700),
    });
    dirs.push(fixture.root);
    try {
      const report = await gatherCost(fixture.root, 8192);
      const hot = report.entries.find((e) => e.file === 'docs/HOT.md');
      const cold = report.entries.find((e) => e.file === 'docs/COLD.md');
      expect(hot?.why).toBe('linked from CLAUDE.md');
      expect(cold?.why).toBe('frozen');
      // CLAUDE.md itself (its UTF-8 BYTE length — it contains an em dash, 3 B, 1 UTF-16
      // code unit, so `.length` alone undercounts) + docs/HOT.md (50 B) is in the total;
      // docs/COLD.md (700 B) is billed into frozenBytes instead.
      expect(report.totalBytes).toBe(Buffer.byteLength(claudeMd, 'utf8') + 50);
      expect(report.frozenBytes).toBe(700);
    } finally {
      await cleanup();
    }
  });

  it('the read-only proof still holds with a frozen entry present (git status unchanged)', async () => {
    // Not a git repo here (makeTempRepoNoBoard doesn't init one) — the property under test is
    // that gatherCost never writes, which the fixture's own untouched mtimes/contents already
    // prove structurally; the git-status version of this proof (against a real repo) lives in
    // cli.test.ts's `describe('repoboard cost', ...)`.
    const fixture = await makeTempRepoNoBoard({
      'CLAUDE.md': '`docs/A.md` is FROZEN.\n',
      'docs/A.md': 'z'.repeat(10),
    });
    dirs.push(fixture.root);
    try {
      const before = await import('node:fs/promises').then((fs) =>
        fs.readFile(join(fixture.root, 'docs/A.md'), 'utf8'),
      );
      await gatherCost(fixture.root, 8192);
      const after = await import('node:fs/promises').then((fs) =>
        fs.readFile(join(fixture.root, 'docs/A.md'), 'utf8'),
      );
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });
});

describe.skipIf(!hasSiblingRoot)(
  'gatherCost against freshpickedjobs’ real CLAUDE.md (RCB-91 pass 2: the SENTENCE rule)',
  () => {
    it('docs/HANDOFF.md is frozen (its sentence, wrapped across two source lines, says FROZEN); docs/BUILD-PLAN.md — the PRECEDING sentence in the same paragraph — is not', async () => {
      // freshpickedjobs' CLAUDE.md (2026-09-22), the paragraph both paths live in:
      //   `docs/BUILD-PLAN.md` is the architecture authority; when it
      //   and anything else disagree, the plan wins and the disagreement is worth reporting.
      //   `docs/HANDOFF.md`
      //   is FROZEN history as of 2026-09-17 — read a `§` it is pointed at, never append to it.
      // Two sentences: "...`docs/BUILD-PLAN.md` is the architecture authority; ... reporting."
      // (no FROZEN) and "`docs/HANDOFF.md` is FROZEN history ... never append to it." (FROZEN,
      // even though the backtick span and the word sit on different SOURCE lines — the pass-2
      // fix: a sentence, not a `\n`-bounded line).
      const report = await gatherCost(siblingRoot, 8192);
      const handoff = report.entries.find((e) => e.file === 'docs/HANDOFF.md');
      const buildPlan = report.entries.find((e) => e.file === 'docs/BUILD-PLAN.md');
      expect(handoff?.why).toBe('frozen');
      expect(buildPlan?.why).toBe('linked from CLAUDE.md');
      expect(report.frozenBytes).toBeGreaterThan(2_000_000);
      expect(report.totalBytes).toBeLessThan(1_000_000);
    });

    it('every other linked path in the SAME paragraph as docs/HANDOFF.md stays unfrozen', async () => {
      // `.repoboard/STATE.md`, `docs/log/<today>.md` (rejected by `looksLikePath` — a `<`/`>`
      // path, never reaches `entries` at all), `docs/OWNER-DECISIONS.md`, and `README.md` are
      // all in the FIRST sentence of the same paragraph (ends "...and edits the list)."), well
      // before "FROZEN" appears; `docs/ROUTER.md` is in a different paragraph entirely (the
      // routing table, further down the file).
      const report = await gatherCost(siblingRoot, 8192);
      const stayUnfrozen = [
        '.repoboard/STATE.md',
        'docs/OWNER-DECISIONS.md',
        'README.md',
        'docs/ROUTER.md',
      ];
      for (const file of stayUnfrozen) {
        const entry = report.entries.find((e) => e.file === file);
        expect(entry?.why, `${file} should not be frozen`).toBe('linked from CLAUDE.md');
      }
    });
  },
);
