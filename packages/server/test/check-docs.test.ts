import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FINDING_KINDS } from '@repoboard/core';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { NOW } from './helpers.js';

// RCB-209 3A: `FINDING_KINDS` (packages/core/src/state.ts) is the one list of `check` finding
// kinds, and three places document them by hand — `repoboard check --help`, the README's check
// section, `docs/REFERENCE.md`'s findings table. Nothing else held those three to the list, so a
// kind added to the code was quietly missing from them. Each test below collects EVERY kind its
// surface lacks and asserts the array is `[]`, so a failure names the kinds.

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function repoboard(cwd: string, ...argv: string[]) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    cwd,
    stdout,
    stderr,
    env: { REPOBOARD_ACTOR: 'test-actor' },
    now: () => NOW,
  });
  return { code, out: stdout.text, err: stderr.text };
}

async function readRepoFile(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
}

/** `text` between the first `from` and the first `to` after it — fails loudly when either marker
 * has moved, so a renamed heading cannot turn the section into an empty string that "passes". */
function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('check finding kinds are documented', () => {
  it('has a kind list long enough that an empty or truncated one cannot pass vacuously', () => {
    expect(FINDING_KINDS.length).toBeGreaterThanOrEqual(28);
    expect(new Set(FINDING_KINDS).size).toBe(FINDING_KINDS.length);
  });

  it('`repoboard check --help` names every kind', async () => {
    // `<cmd> --help` opens no store and writes nothing, so any directory will do for the cwd.
    const help = await repoboard(tmpdir(), 'check', '--help');
    expect(help.code).toBe(0);
    // A whole-word match: a kind that is only a prefix of another kind's name is not named.
    const missing = FINDING_KINDS.filter(
      (k) => !new RegExp(`(?<![\\w-])${k}(?![\\w-])`).test(help.out),
    );
    expect(missing).toEqual([]);
  });

  it("the README's check section names every kind in backticks", async () => {
    const readme = await readRepoFile('README.md');
    const checkSection = section(readme, '`repoboard check` prints', '`repoboard cost');
    const missing = FINDING_KINDS.filter((k) => !checkSection.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });

  it("docs/REFERENCE.md's findings table has a row for every kind", async () => {
    const reference = await readRepoFile('docs/REFERENCE.md');
    const table = section(reference, "### `repoboard check`'s findings", '\n### ');
    const missing = FINDING_KINDS.filter((k) => !table.includes(`\n| \`${k}\` |`));
    expect(missing).toEqual([]);
  });
});
