/**
 * RCB-96 B (plan docs/SYSTEMS-FLOW-PLAN.md §3.2): the I/O shell around core's pure detectors
 * (`packages/core/src/systems-detect.ts`, brief A). `detectSystems` reads a FIXED list of files
 * under `root` — it never walks the tree — and hands their text to the matching pure detector;
 * `runDetect` reads `.repoboard/systems.yml`, merges in the candidates (`applyDetected`), and
 * writes only when `apply` is true (non-negotiable 5: dry-run by default). Every read goes
 * through `resolveRepoPath` (K7's guard), so a workspace glob or a `wrangler.jsonc` path can never
 * make this module read outside `root`.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyDetected,
  type Candidates,
  detectCompose,
  detectDockerfile,
  detectDrizzleConfig,
  detectEnvExample,
  detectPackageJson,
  detectPrismaSchema,
  detectViteConfig,
  detectWorkflow,
  detectWrangler,
  emptySystemsDoc,
  mergeCandidates,
  parseSystems,
  type SystemsDoc,
  serializeSystems,
  workspaceGlobs,
} from '@repoboard/core';
import { resolveRepoPath } from './refs.js';

type Detector = (rel: string, text: string) => Candidates;

/** Brief order: for root, THEN every workspace dir, in this fixed order, only files present. */
const PER_DIR_FILES: readonly { name: string; detect: Detector }[] = [
  { name: 'wrangler.toml', detect: detectWrangler },
  { name: 'wrangler.jsonc', detect: detectWrangler },
  { name: 'wrangler.json', detect: detectWrangler },
  { name: 'Dockerfile', detect: detectDockerfile },
  { name: '.env.example', detect: detectEnvExample },
  { name: '.dev.vars', detect: detectEnvExample },
  { name: 'vite.config.ts', detect: detectViteConfig },
  { name: 'vite.config.js', detect: detectViteConfig },
  { name: 'vite.config.mts', detect: detectViteConfig },
  { name: 'vite.config.mjs', detect: detectViteConfig },
  { name: 'drizzle.config.ts', detect: detectDrizzleConfig },
  { name: 'drizzle.config.js', detect: detectDrizzleConfig },
  { name: 'drizzle.config.mts', detect: detectDrizzleConfig },
  { name: 'drizzle.config.mjs', detect: detectDrizzleConfig },
  { name: 'prisma/schema.prisma', detect: detectPrismaSchema },
];

/** Root only, in this order, only files present. */
const ROOT_ONLY_FILES: readonly { name: string; detect: Detector }[] = [
  { name: 'docker-compose.yml', detect: detectCompose },
  { name: 'docker-compose.yaml', detect: detectCompose },
  { name: 'compose.yml', detect: detectCompose },
  { name: 'compose.yaml', detect: detectCompose },
];

/** `resolveRepoPath` + a best-effort `readFile`; a missing file or a read failure is skipped,
 * never a throw (brief: "a missing file is simply skipped; a read that fails is skipped"). */
async function readIfPresent(root: string, rel: string): Promise<string | null> {
  const resolved = await resolveRepoPath(root, rel);
  if (!resolved.ok) return null;
  try {
    return await readFile(resolved.path, 'utf8');
  } catch {
    return null;
  }
}

/** Direct subdirectories of repo-relative `dir` (`''` = root), skipping `node_modules` and
 * dotdirs, sorted for a deterministic `files` order. Guarded by `resolveRepoPath`, so a glob like
 * `../outside/*` can never read a sibling directory (test 8). */
async function subdirsOf(root: string, dir: string): Promise<string[]> {
  const resolved = await resolveRepoPath(root, dir === '' ? '.' : dir);
  if (!resolved.ok) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(resolved.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    out.push(dir === '' ? e.name : `${dir}/${e.name}`);
  }
  return out.sort();
}

/** A glob `dir/*` or `dir/**` expands to `dir`'s direct subdirectories; any other glob (a plain
 * `dir`, no wildcard) is that one dir, as given. */
async function expandWorkspaceGlob(root: string, glob: string): Promise<string[]> {
  if (glob.endsWith('/**')) return subdirsOf(root, glob.slice(0, -3));
  if (glob.endsWith('/*')) return subdirsOf(root, glob.slice(0, -2));
  return [glob];
}

async function workflowFiles(root: string): Promise<string[]> {
  const resolved = await resolveRepoPath(root, '.github/workflows');
  if (!resolved.ok) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(resolved.path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')))
    .map((e) => `.github/workflows/${e.name}`)
    .sort();
}

/**
 * Reads the fixed candidate-file list (brief §"packages/server/src/systems-detect.ts") and hands
 * each to its detector. NEVER walks the tree: every path read here is named by this function or
 * by `workspaceGlobs`'s expansion of it, nothing more.
 */
export async function detectSystems(
  root: string,
): Promise<{ files: string[]; candidates: Candidates }> {
  const files: string[] = [];
  const parts: Candidates[] = [];

  async function collect(rel: string, detect: Detector): Promise<void> {
    const text = await readIfPresent(root, rel);
    if (text === null) return;
    files.push(rel);
    parts.push(detect(rel, text));
  }

  const rootPkgText = await readIfPresent(root, 'package.json');
  const workspaceDirs: string[] = [];
  if (rootPkgText !== null) {
    files.push('package.json');
    parts.push(detectPackageJson('package.json', rootPkgText));
    const pnpmYamlText = await readIfPresent(root, 'pnpm-workspace.yaml');
    const seen = new Set<string>();
    for (const glob of workspaceGlobs(rootPkgText, pnpmYamlText)) {
      for (const dir of await expandWorkspaceGlob(root, glob)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        workspaceDirs.push(dir);
      }
    }
  }

  for (const dir of workspaceDirs) {
    await collect(`${dir}/package.json`, detectPackageJson);
  }

  for (const dir of ['', ...workspaceDirs]) {
    for (const { name, detect } of PER_DIR_FILES) {
      await collect(dir === '' ? name : `${dir}/${name}`, detect);
    }
  }

  for (const { name, detect } of ROOT_ONLY_FILES) {
    await collect(name, detect);
  }

  for (const rel of await workflowFiles(root)) {
    await collect(rel, detectWorkflow);
  }

  return { files, candidates: mergeCandidates(parts) };
}

export interface DetectRun {
  files: string[];
  candidates: Candidates;
  plan: { added: string[]; updated: string[]; skipped: string[] };
  applied: boolean;
  path: string;
  errors: string[];
}

/**
 * Dry-run by default (non-negotiable 5): only `opts.apply === true` ever calls `writeFile`. An
 * existing `.repoboard/systems.yml` that fails to parse is refused whole — errors, empty plan,
 * `applied: false`, nothing written — whether or not `--apply` was given, because merging into a
 * document core could not validate would be a guess, not a merge.
 */
export async function runDetect(
  root: string,
  opts: { apply: boolean; now: Date },
): Promise<DetectRun> {
  const { files, candidates } = await detectSystems(root);
  const path = '.repoboard/systems.yml';
  const fullPath = join(root, '.repoboard', 'systems.yml');

  let existingText: string | null;
  try {
    existingText = await readFile(fullPath, 'utf8');
  } catch {
    existingText = null;
  }

  let doc: SystemsDoc;
  if (existingText === null) {
    doc = emptySystemsDoc();
  } else {
    const parsed = parseSystems(existingText);
    if (!parsed.ok) {
      return {
        files,
        candidates,
        plan: { added: [], updated: [], skipped: [] },
        applied: false,
        path,
        errors: parsed.errors,
      };
    }
    doc = parsed.doc;
  }

  const applied = applyDetected(doc, candidates, opts.now.toISOString());
  const plan = { added: applied.added, updated: applied.updated, skipped: applied.skipped };

  if (!opts.apply) {
    return { files, candidates, plan, applied: false, path, errors: [] };
  }

  const hasRepoboardDir = await stat(join(root, '.repoboard')).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!hasRepoboardDir) {
    return {
      files,
      candidates,
      plan,
      applied: false,
      path,
      errors: [`not a repoboard repo: ${root} has no .repoboard/`],
    };
  }

  await writeFile(fullPath, serializeSystems(applied.doc));
  return { files, candidates, plan, applied: true, path, errors: [] };
}
