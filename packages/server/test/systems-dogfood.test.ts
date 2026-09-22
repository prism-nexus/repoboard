/**
 * RCB-99 (plan docs/SYSTEMS-FLOW-PLAN.md §4 PH.5): dogfood — repoboard's OWN
 * `.repoboard/systems.yml` (hand rows, RCB-99) read for real, no fixture, no temp dir. Proves the
 * schema (RCB-95), the byte budget, the refs pointers, the layout (RCB-98), and `detect` dry-run
 * (RCB-96) all agree on the one file this repo ships.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SYSTEMS_BUDGET_BYTES,
  layoutSystems,
  parseSystems,
  type SystemsDoc,
} from '@repoboard/core';
import { describe, expect, it } from 'vitest';
import { resolveRefSpec } from '../src/refs.js';
import { runDetect } from '../src/systems-detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SYSTEMS_PATH = join(REPO_ROOT, '.repoboard', 'systems.yml');

async function readSystemsText(): Promise<string> {
  return readFile(SYSTEMS_PATH, 'utf8');
}

describe("systems dogfood (RCB-99): this repo's own .repoboard/systems.yml", () => {
  it('parses: ok, 5 systems, 3 connections, prod is none', async () => {
    const text = await readSystemsText();
    const parsed = parseSystems(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.systems).toHaveLength(5);
    expect(parsed.doc.connections).toHaveLength(3);
    expect('none' in parsed.doc.environments.prod).toBe(true);
  });

  it('stays under the default systems.yml byte budget', async () => {
    const text = await readSystemsText();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_SYSTEMS_BUDGET_BYTES);
  });

  it('every system pointer resolves against the real repo tree', async () => {
    const text = await readSystemsText();
    const parsed = parseSystems(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const allPointers = parsed.doc.systems.flatMap((s) => s.pointers);
    expect(allPointers.length).toBeGreaterThan(0);
    for (const spec of allPointers) {
      const resolved = await resolveRefSpec(REPO_ROOT, spec);
      expect({ spec, error: resolved.error }).toEqual({ spec, error: null });
    }
  });

  it('layoutSystems places all 5 boxes in "both" and "dev"; "prod" reports the none-note', async () => {
    const text = await readSystemsText();
    const parsed = parseSystems(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const doc: SystemsDoc = parsed.doc;

    const both = layoutSystems(doc, 'both');
    const bothBoxCount = both.rows.reduce((n, r) => n + r.boxes.length, 0);
    expect(bothBoxCount).toBe(5);

    const dev = layoutSystems(doc, 'dev');
    const devBoxCount = dev.rows.reduce((n, r) => n + r.boxes.length, 0);
    expect(devBoxCount).toBe(5);

    const prod = layoutSystems(doc, 'prod');
    expect(prod.rows).toEqual([]);
    expect(prod.edges).toEqual([]);
    expect(prod.none.prod).toBe('local-only by design — speed and tokens');
  });

  it('runDetect dry-run on this repo: 0 added, 0 updated, 3 hand rows kept, applied false', async () => {
    const now = new Date('2026-09-22T00:00:00Z');
    const run = await runDetect(REPO_ROOT, { apply: false, now });
    expect(run.errors).toEqual([]);
    expect(run.applied).toBe(false);
    expect(run.plan.added).toEqual([]);
    expect(run.plan.updated).toEqual([]);
    expect(run.plan.skipped).toHaveLength(3);
    expect(new Set(run.plan.skipped)).toEqual(new Set(['repoboard', 'web', 'ci']));
  });
});
