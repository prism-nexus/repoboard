/**
 * P8.5: the I/O half of `repoboard archive` (locked decision 1) — moving a card file from
 * `.repoboard/cards/<id>.md` to `.repoboard/archive/<id>.md`. `git mv` when `.repoboard/` is
 * inside a git work tree AND the file is tracked (so the rename is itself a tracked change, not
 * a delete + untracked add); a plain `fs.rename` otherwise. Neither path rewrites a single byte
 * of the file — that is `store.ts`'s job to preserve (never routes the card through
 * `serializeCard`), this module only decides which OS-level move to use.
 */
import { execFile } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function isInsideWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function isTracked(root: string, relPath: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relPath]);
    return true;
  } catch {
    return false;
  }
}

export type ArchiveMoveMethod = 'git' | 'rename';

/**
 * Move one file. `absSrc`/`absDst` are absolute paths; `relSrc`/`relDst` are relative to `root`
 * (what `git -C root` wants). Returns which method it used, for the tests that must exercise
 * both (`git mv` path vs `rename` path, two fixtures).
 */
export async function archiveMoveFile(
  root: string,
  relSrc: string,
  relDst: string,
): Promise<ArchiveMoveMethod> {
  await mkdir(join(root, dirname(relDst)), { recursive: true });
  if ((await isInsideWorkTree(root)) && (await isTracked(root, relSrc))) {
    await execFileP('git', ['-C', root, 'mv', relSrc, relDst]);
    return 'git';
  }
  await rename(join(root, relSrc), join(root, relDst));
  return 'rename';
}
