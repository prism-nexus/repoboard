import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { distStaleness, stampDist } from '../src/dist-stale.js';
import { makeTempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function freshRoot(): Promise<string> {
  const root = await makeTempDir('repoboard-dist-stale-');
  dirs.push(root);
  return root;
}

const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2030-01-01T00:00:00Z');
const NEWER = new Date('2031-01-01T00:00:00Z');
const NEWEST = new Date('2032-01-01T00:00:00Z');

/** Write `path` (creating parent dirs) then set its mtime explicitly — `writeFile` alone leaves
 *  mtime at "now", which is too close in time for these tests to order reliably. */
async function writeAt(path: string, mtime: Date, text = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  await utimes(path, mtime, mtime);
}

describe('distStaleness (RCB-60)', () => {
  it('1: fresh dist (dist mtime > src mtime) → null', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD);
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    expect(await distStaleness(root)).toBeNull();
  });

  it('2: one stale package among two → the line names only that package', async () => {
    const root = await freshRoot();
    // a: fresh.
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD);
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    // b: stale (src newer than dist).
    await writeAt(join(root, 'packages', 'b', 'dist', 'index.js'), OLD);
    await writeAt(join(root, 'packages', 'b', 'src', 'index.ts'), NEW);
    const line = await distStaleness(root);
    // toBe pins the whole line, including the parenthesized package list — proof enough that
    // fresh package "a" is not named alongside stale package "b".
    expect(line).toBe('dist is older than src — run pnpm build (b)');
  });

  it('3a: no packages/ at all → null', async () => {
    const root = await freshRoot();
    expect(await distStaleness(root)).toBeNull();
  });

  it('3b: a package with src but no dist is ignored → null', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), NEW);
    expect(await distStaleness(root)).toBeNull();
  });

  it('4: a nested src file newer than every dist file is stale (recursion proven)', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD);
    await writeAt(join(root, 'packages', 'a', 'src', 'nested', 'deep', 'file.ts'), NEWER);
    const line = await distStaleness(root);
    expect(line).toBe('dist is older than src — run pnpm build (a)');
  });
});

describe('distStaleness trusts a content digest over a bare mtime (RCB-145)', () => {
  it('5: stamp, then a src file gets a newer mtime but the SAME bytes → null (not stale)', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD, 'same bytes');
    await stampDist(root);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), NEWER, 'same bytes');
    expect(await distStaleness(root)).toBeNull();
  });

  it('6: stamp, then a src file changes bytes (newer mtime) → the stale line', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD, 'v1');
    await stampDist(root);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), NEWER, 'v2');
    expect(await distStaleness(root)).toBe('dist is older than src — run pnpm build (a)');
  });

  it('7: stamp, then dist itself changes (newer mtime) and src is newer still → stale (stamp no longer trusted)', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD, 'same bytes');
    await stampDist(root);
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEWER, 'same bytes');
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), NEWEST, 'same bytes');
    expect(await distStaleness(root)).toBe('dist is older than src — run pnpm build (a)');
  });

  it('8: a corrupt .src-digest → stale, never throws', async () => {
    const root = await freshRoot();
    await writeAt(join(root, 'packages', 'a', 'dist', 'index.js'), NEW);
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), OLD, 'same bytes');
    await stampDist(root);
    await writeFile(join(root, 'packages', 'a', 'dist', '.src-digest'), 'not json');
    await writeAt(join(root, 'packages', 'a', 'src', 'index.ts'), NEWER, 'same bytes');
    await expect(distStaleness(root)).resolves.toBe('dist is older than src — run pnpm build (a)');
  });
});
