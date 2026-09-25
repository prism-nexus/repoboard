/**
 * RCB-112 A: `GET /api/dashboard`'s one payload — health (a recorded gate ledger, never re-run
 * from the page) + commits (git, read live like the scanner) + coverage (RCB-110's per-system
 * test line, corpus loaded once). Every band degrades to its null state instead of throwing: an
 * empty temp dir with no `.git` and no `.repoboard/` still answers, every field null/empty.
 *
 * RCB-113: each coverage band line gains `· <measured.line>` — source B (the gate's own coverage
 * report) beside source A (the static test-file count), same corpus, same null-state discipline.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  byWho,
  type CommitRow,
  type GateRecord,
  latestChecks,
  parseCommitLog,
  parseGateLedger,
  perDay,
  type RepoCommits,
  type RepoDashboard,
  type RepoHealth,
  SYSTEM_TESTS_SOURCE,
  type SystemsDoc,
  toIso,
} from '@repoboard/core';
import { hasLocal, localDir } from './local.js';
import { git, isGitRepo } from './scanner.js';
import { loadTestCorpus, systemTests } from './systems-tests.js';

/** `.repoboard/local/gate.jsonl` when `.repoboard/local/` is a directory, else
 * `.repoboard/gate.jsonl` — the ONE function the reader (`loadHealth` below) and the writer
 * (`cli.ts`'s `gate record`) both call, so they can never disagree about which file is the ledger. */
export async function gateLedgerPath(root: string): Promise<string> {
  const dir = (await hasLocal(root)) ? localDir(root) : join(root, '.repoboard');
  return join(dir, 'gate.jsonl');
}

/** RCB-146: `gate record`'s own input — the same shape both the CLI's already-parsed flags and
 * MCP `record_gate`'s arguments boil down to. `undefined` means "not given"; the distinction
 * between `--tests` given and `--failed`/`--files` given alone matters for the validation below
 * (only `passed`/`skipped` — `--tests` — requires `failed`), so it is kept explicit rather than
 * folded into one `tests` object. */
export interface GateRecordInput {
  as: string;
  passed?: number;
  skipped?: number;
  failed?: number;
  files?: number;
  typecheck?: number;
  lint?: number;
  build?: number;
  sha?: string;
  note?: string;
}

/**
 * RCB-146: `cmdGateRecord`'s body, moved here after flag parsing — the SAME function MCP's
 * `record_gate` calls, so a CLI-recorded line and an MCP-recorded line can never disagree about
 * what counts as a valid one. CLAUDE.md non-negotiable 2: this NEVER runs the checks it
 * records — it only writes down a number the caller already produced. `sha` defaults to `git
 * rev-parse --short HEAD` (null outside a git repo, or with no commits). Throws a plain `Error`
 * (never a CLI `UserError`) with the CLI's own wording — unchanged from `cmdGateRecord` before
 * this move, since no other wording was asked for: "needs at least one check" when none of
 * tests/typecheck/lint/build is given; "needs --failed <n>" when `passed`/`skipped` (`--tests`) is
 * given without `failed`. Appends one JSONL line to `gateLedgerPath` and returns it.
 */
export async function recordGate(
  root: string,
  input: GateRecordInput,
  now: Date,
): Promise<GateRecord> {
  const testsGiven = input.passed !== undefined || input.skipped !== undefined;
  if (testsGiven && input.failed === undefined) {
    throw new Error('gate record --tests needs --failed <n> (0 means a clean run)');
  }
  const hasTests = testsGiven || input.failed !== undefined || input.files !== undefined;
  if (
    !hasTests &&
    input.typecheck === undefined &&
    input.lint === undefined &&
    input.build === undefined
  ) {
    throw new Error(
      'gate record needs at least one check: --tests, --typecheck, --lint or --build',
    );
  }

  let sha = input.sha ?? null;
  if (sha === null) {
    try {
      const out = await git(root, ['rev-parse', '--short', 'HEAD']);
      const trimmed = out.trim();
      sha = trimmed.length > 0 ? trimmed : null;
    } catch {
      sha = null;
    }
  }

  const record: GateRecord = {
    at: toIso(now),
    sha,
    as: input.as,
    tests: hasTests
      ? {
          passed: input.passed ?? null,
          skipped: input.skipped ?? null,
          failed: input.failed ?? null,
          files: input.files ?? null,
        }
      : null,
    typecheck: input.typecheck ?? null,
    lint: input.lint ?? null,
    build: input.build ?? null,
    note: input.note ?? null,
  };

  const path = await gateLedgerPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function repoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** RCB-112: exported so `cli.ts`'s `gate show` reads the SAME reduction `GET /api/dashboard`
 * does, without paying for the commit log or the coverage corpus it does not need. */
export async function loadGateHealth(root: string): Promise<RepoHealth> {
  const path = await gateLedgerPath(root);
  const rel = repoRelative(root, path);
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (text === null) {
    return {
      checks: { tests: null, typecheck: null, lint: null, build: null },
      ledger: null,
      errors: [],
      source: rel,
    };
  }
  const { records, errors } = parseGateLedger(text);
  return { checks: latestChecks(records), ledger: rel, errors, source: rel };
}

const LOG_FORMAT =
  '%h%x1f%cI%x1f%an%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1d)%x1e';
const COMMITS_SOURCE =
  'git log (HEAD -n 10, origin/main -n 10; HEAD --since=<UTC midnight 13 days ago> for the 14-day cadence and per-seat counts)';

async function commitRows(root: string, ref: string, n: number): Promise<CommitRow[] | null> {
  try {
    const out = await git(root, ['log', '-n', String(n), `--format=${LOG_FORMAT}`, ref]);
    return parseCommitLog(out);
  } catch {
    return null;
  }
}

async function originMainExists(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '-q', 'origin/main']);
    return true;
  } catch {
    return false;
  }
}

function utcMidnightDaysAgo(now: Date, days: number): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - days * 86_400_000).toISOString();
}

async function loadCommits(root: string, now: Date): Promise<RepoCommits> {
  const inGit = await isGitRepo(root);
  if (!inGit) {
    return {
      branch: null,
      head: null,
      originMain: null,
      perDay: null,
      byWho: null,
      source: COMMITS_SOURCE,
    };
  }

  let branch: string | null = null;
  try {
    const out = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const trimmed = out.trim();
    branch = trimmed.length > 0 ? trimmed : null;
  } catch {
    branch = null;
  }

  const head = await commitRows(root, 'HEAD', 10);
  const originMain = (await originMainExists(root))
    ? await commitRows(root, 'origin/main', 10)
    : null;

  let recent: CommitRow[] | null = null;
  try {
    const since = utcMidnightDaysAgo(now, 13);
    const out = await git(root, ['log', `--since=${since}`, `--format=${LOG_FORMAT}`, 'HEAD']);
    recent = parseCommitLog(out);
  } catch {
    recent = null;
  }

  return {
    branch,
    head,
    originMain,
    perDay: recent
      ? perDay(
          recent.map((r) => r.at),
          now,
          14,
        )
      : null,
    byWho: recent ? byWho(recent) : null,
    source: COMMITS_SOURCE,
  };
}

async function loadCoverage(
  root: string,
  systemsDoc: SystemsDoc | null,
): Promise<{ coverage: { id: string; line: string }[] | null; source: string }> {
  if (!systemsDoc) return { coverage: null, source: SYSTEM_TESTS_SOURCE };
  if (systemsDoc.systems.length === 0) {
    return { coverage: [], source: SYSTEM_TESTS_SOURCE };
  }
  // RCB-112: loaded ONCE for every system below — this is the read `systemTests` would otherwise
  // repeat per system (the earlier RCB-110 shape).
  const corpus = await loadTestCorpus(root);
  const coverage = await Promise.all(
    systemsDoc.systems.map(async (s) => {
      const t = await systemTests(root, s.pointers, corpus);
      return { id: s.id, line: `${t.line} · ${t.measured.line}` };
    }),
  );
  return { coverage, source: SYSTEM_TESTS_SOURCE };
}

/**
 * RCB-112 A: the whole `GET /api/dashboard` payload. `systemsDoc` is whatever the caller's own
 * `store.systems().doc` already is (null when there is no valid `systems.yml`) — this function
 * never parses it itself, so it can never disagree with `GET /api/systems`.
 */
export async function repoDashboard(
  root: string,
  systemsDoc: SystemsDoc | null,
  now: Date,
): Promise<RepoDashboard> {
  const [health, commits, coverageResult] = await Promise.all([
    loadGateHealth(root),
    loadCommits(root, now),
    loadCoverage(root, systemsDoc),
  ]);
  return {
    now: toIso(now),
    health,
    commits,
    coverage: coverageResult.coverage,
    coverageSource: coverageResult.source,
  };
}
