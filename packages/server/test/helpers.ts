/** Test helpers. Everything lives under os.tmpdir(); the repo's own .repoboard is never touched. */
import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultBoardConfig, serializeBoard } from '@repoboard/core';

export const NOW = new Date('2026-09-02T22:41:10Z');

export function cardText(
  id: string,
  status: string,
  extra: { title?: string; assignee?: string; body?: string } = {},
): string {
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(extra.title ?? `Card ${id}`)}`,
    `status: ${status}`,
  ];
  if (extra.assignee) lines.push(`assignee: ${extra.assignee}`);
  lines.push('created: 2026-09-02T22:00:00Z', 'updated: 2026-09-02T22:00:00Z', '---');
  return `${lines.join('\n')}\n${extra.body ?? '\nBody.\n'}`;
}

export interface TempRepo {
  root: string;
  cardsDir: string;
  cleanup(): Promise<void>;
}

/** A temp root with `.repoboard/board.yml` (defaults) and the given cards. */
export async function makeTempRepoboard(cards: Record<string, string> = {}): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'repoboard-test-'));
  const cardsDir = join(root, '.repoboard', 'cards');
  await mkdir(cardsDir, { recursive: true });
  await writeFile(join(root, '.repoboard', 'board.yml'), serializeBoard(defaultBoardConfig()));
  for (const [name, text] of Object.entries(cards)) {
    await writeFile(join(cardsDir, name), text);
  }
  return { root, cardsDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function makeTempDir(prefix = 'repoboard-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * P7.2 map-only fixture: a temp root holding `files` (paths relative to the root) and **no**
 * `.repoboard/` at all. Like every fixture here it lives under `os.tmpdir()`; nothing outside the
 * directory this function created is ever touched.
 */
export async function makeTempRepoNoBoard(
  files: Record<string, string> = {},
): Promise<TempRepo & { hasRepoboard(): Promise<boolean> }> {
  const root = await mkdtemp(join(tmpdir(), 'repoboard-noboard-'));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const repoboardDir = join(root, '.repoboard');
  return {
    root,
    cardsDir: join(repoboardDir, 'cards'),
    hasRepoboard: () =>
      stat(repoboardDir).then(
        () => true,
        () => false,
      ),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Resolve with the first emission of `event` whose payload passes `pred`, or reject on timeout. */
export function waitForEvent<T = unknown>(
  emitter: EventEmitter,
  event: string,
  pred: (payload: T) => boolean = () => true,
  timeoutMs = 4000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`));
    }, timeoutMs);
    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter listener payloads are untyped here
    const handler = (payload: any): void => {
      if (!pred(payload as T)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload as T);
    };
    emitter.on(event, handler);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `pred` every `intervalMs`, resolving the first time it is true; rejects on timeout. */
export function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}
