/**
 * K12 T1 (unit, no filesystem, no git spawn): the ignore rule driven by fixture `git ls-files`
 * text, exactly as `gitIgnoredPaths` would hand it to `parseGitIgnoredOutput`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRepoWatchIgnore,
  isGitIgnoredPath,
  parseGitIgnoredOutput,
} from '../src/watch-ignore.js';

// `git ls-files -z … --directory` output: NUL-joined, trailing NUL after the last entry.
// `backups/` is a wholly-ignored directory (git's `--directory` collapse); `notes/private.md`
// is an individually-ignored file whose containing directory is not wholly ignored.
const FIXTURE_OUTPUT = ['backups/', 'notes/private.md', ''].join('\0');

describe('parseGitIgnoredOutput', () => {
  it('separates a wholly-ignored directory from an individually-ignored file', () => {
    const ignored = parseGitIgnoredOutput(FIXTURE_OUTPUT);
    expect([...ignored.dirs]).toEqual(['backups']);
    expect([...ignored.files]).toEqual(['notes/private.md']);
  });

  it('a trailing empty split (the final NUL) contributes nothing', () => {
    const ignored = parseGitIgnoredOutput('');
    expect(ignored.dirs.size).toBe(0);
    expect(ignored.files.size).toBe(0);
  });
});

describe('isGitIgnoredPath', () => {
  const ignored = parseGitIgnoredOutput(FIXTURE_OUTPUT);

  it('backups/ ignored -> backups/a/b.dump ignored (any depth under a wholly-ignored dir)', () => {
    expect(isGitIgnoredPath('backups', ignored)).toBe(true);
    expect(isGitIgnoredPath('backups/a/b.dump', ignored)).toBe(true);
  });

  it('a listed ignored file is ignored', () => {
    expect(isGitIgnoredPath('notes/private.md', ignored)).toBe(true);
  });

  it('a sibling untracked file is NOT ignored', () => {
    expect(isGitIgnoredPath('notes/public.md', ignored)).toBe(false);
    expect(isGitIgnoredPath('sibling.txt', ignored)).toBe(false);
  });
});

describe('buildRepoWatchIgnore (the predicate the watcher actually installs)', () => {
  const ignored = parseGitIgnoredOutput(FIXTURE_OUTPUT);
  const isIgnored = buildRepoWatchIgnore('/repo', ignored);

  it('a wholly-ignored directory is ignored at any depth', () => {
    expect(isIgnored('/repo/backups')).toBe(true);
    expect(isIgnored('/repo/backups/a/b.dump')).toBe(true);
  });

  it('a listed ignored file is ignored', () => {
    expect(isIgnored('/repo/notes/private.md')).toBe(true);
  });

  it('a sibling untracked file is NOT ignored (a new source file must still be watched)', () => {
    expect(isIgnored('/repo/notes/public.md')).toBe(false);
    expect(isIgnored('/repo/fresh.txt')).toBe(false);
  });

  it('node_modules segment is still ignored at any depth (pre-existing rule, unchanged)', () => {
    expect(isIgnored('/repo/node_modules/x/i.js')).toBe(true);
    expect(isIgnored('/repo/packages/foo/node_modules/x/i.js')).toBe(true);
  });

  it('.repoboard is ignored (the store watches that itself)', () => {
    expect(isIgnored('/repo/.repoboard/cards/RB-1.md')).toBe(true);
  });

  it('.git/HEAD and .git/logs/HEAD are allowed; the rest of .git is not', () => {
    expect(isIgnored('/repo/.git/HEAD')).toBe(false);
    expect(isIgnored('/repo/.git/logs/HEAD')).toBe(false);
    expect(isIgnored('/repo/.git/index')).toBe(true);
    expect(isIgnored('/repo/.git/objects/ab/cd')).toBe(true);
  });

  it('the root itself and a path escaping the root are never ignored by this predicate', () => {
    expect(isIgnored('/repo')).toBe(false);
    expect(isIgnored('/elsewhere/file.txt')).toBe(false);
  });
});
