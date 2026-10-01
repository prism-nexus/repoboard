/**
 * RCB-112 A: the repo dashboard's pure half — a gate ledger a seat appends to (never re-run from
 * the page, CLAUDE.md non-negotiable 2) and a git commit log the server already spawned. Nothing
 * here does I/O or reads a clock of its own; the server (`packages/server/src/repo-health.ts`)
 * reads the ledger file and runs `git log`, then hands the raw text here.
 */

/** One check's numbers inside a gate ledger line — `tests` only; typecheck/lint/build are a bare
 * exit code. `null` in any field is "not recorded on this line", never a plausible zero. */
export interface GateTestsRecord {
  files: number | null;
  passed: number | null;
  skipped: number | null;
  failed: number | null;
}

/** One JSONL line in the gate ledger — a seat's `repoboard gate record` call. A line need not
 * carry every check: `--tests` alone leaves `typecheck`/`lint`/`build` (and vice versa) `null`. */
export interface GateRecord {
  at: string;
  sha: string | null;
  as: string;
  tests: GateTestsRecord | null;
  typecheck: number | null;
  lint: number | null;
  build: number | null;
  note: string | null;
}

export type GateCheckName = 'tests' | 'typecheck' | 'lint' | 'build';

/** The newest recorded result for one check, already reduced to a display line. */
export interface GateCheckResult {
  ok: boolean;
  value: string;
  at: string;
  sha: string | null;
  as: string;
}

/** `ledger`/`errors` describe the ledger FILE (present, parse errors); `checks` is the reduction
 * over whatever records parsed. `source` always names the file, whether or not it exists. */
export interface RepoHealth {
  checks: Record<GateCheckName, GateCheckResult | null>;
  ledger: string | null;
  errors: string[];
  source: string;
}

export interface CommitRow {
  sha: string;
  at: string;
  author: string;
  agent: string | null;
  subject: string;
}

export interface RepoCommits {
  branch: string | null;
  head: CommitRow[] | null;
  originMain: CommitRow[] | null;
  perDay: { date: string; count: number }[] | null;
  byWho: { who: string; count: number }[] | null;
  source: string;
}

export interface RepoDashboard {
  now: string;
  health: RepoHealth;
  commits: RepoCommits;
  coverage: { id: string; line: string }[] | null;
  coverageSource: string;
}

// ---- gate ledger ----------------------------------------------------------------------------

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || v === undefined || typeof v === 'number';
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || v === undefined || typeof v === 'string';
}

type GateRecordResult = { ok: true; record: GateRecord } | { ok: false; error: string };

/** One JSONL line, already `JSON.parse`d: every field checked, nothing coerced. */
function toGateRecord(v: unknown): GateRecordResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'not a JSON object' };
  }
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'string' || o.at.length === 0) {
    return { ok: false, error: '"at" must be a non-empty string' };
  }
  if (!isStringOrNull(o.sha)) return { ok: false, error: '"sha" must be a string or null' };
  if (typeof o.as !== 'string' || o.as.length === 0) {
    return { ok: false, error: '"as" must be a non-empty string' };
  }

  let tests: GateTestsRecord | null = null;
  if (o.tests !== null && o.tests !== undefined) {
    if (typeof o.tests !== 'object' || Array.isArray(o.tests)) {
      return { ok: false, error: '"tests" must be an object or null' };
    }
    const t = o.tests as Record<string, unknown>;
    if (
      !isNumberOrNull(t.files) ||
      !isNumberOrNull(t.passed) ||
      !isNumberOrNull(t.skipped) ||
      !isNumberOrNull(t.failed)
    ) {
      return { ok: false, error: '"tests" fields must be numbers or null' };
    }
    tests = {
      files: t.files ?? null,
      passed: t.passed ?? null,
      skipped: t.skipped ?? null,
      failed: t.failed ?? null,
    } as GateTestsRecord;
  }

  if (!isNumberOrNull(o.typecheck))
    return { ok: false, error: '"typecheck" must be a number or null' };
  if (!isNumberOrNull(o.lint)) return { ok: false, error: '"lint" must be a number or null' };
  if (!isNumberOrNull(o.build)) return { ok: false, error: '"build" must be a number or null' };
  if (!isStringOrNull(o.note)) return { ok: false, error: '"note" must be a string or null' };

  return {
    ok: true,
    record: {
      at: o.at,
      sha: (o.sha as string | null | undefined) ?? null,
      as: o.as,
      tests,
      typecheck: (o.typecheck as number | null | undefined) ?? null,
      lint: (o.lint as number | null | undefined) ?? null,
      build: (o.build as number | null | undefined) ?? null,
      note: (o.note as string | null | undefined) ?? null,
    },
  };
}

export interface ParseGateLedgerResult {
  records: GateRecord[];
  errors: string[];
}

/**
 * JSONL: one gate record per line, blank lines skipped. A line that is not valid JSON, or valid
 * JSON that does not fit `GateRecord`, is an ERROR (`"line N: why"`, 1-indexed) — never a throw,
 * and never dropped silently; every other line still parses.
 */
export function parseGateLedger(text: string): ParseGateLedgerResult {
  const records: GateRecord[] = [];
  const errors: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    const result = toGateRecord(parsed);
    if (!result.ok) {
      errors.push(`line ${i + 1}: ${result.error}`);
      continue;
    }
    records.push(result.record);
  }
  return { records, errors };
}

function formatTestsValue(t: GateTestsRecord): string {
  const parts: string[] = [];
  if (t.passed !== null) parts.push(`${t.passed} passed`);
  if (t.skipped !== null) parts.push(`${t.skipped} skipped`);
  if (t.failed !== null) parts.push(`${t.failed} failed`);
  if (t.files !== null) parts.push(`${t.files} files`);
  return parts.length > 0 ? parts.join(' · ') : 'no data';
}

function latestFor<T>(
  records: readonly GateRecord[],
  field: (r: GateRecord) => T | null,
  toValue: (v: T) => string,
  toOk: (v: T) => boolean,
): GateCheckResult | null {
  let best: { record: GateRecord; value: T } | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    const v = field(r);
    if (v === null) continue;
    const parsed = Date.parse(r.at);
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (best === null || time >= bestTime) {
      best = { record: r, value: v };
      bestTime = time;
    }
  }
  if (!best) return null;
  return {
    ok: toOk(best.value),
    value: toValue(best.value),
    at: best.record.at,
    sha: best.record.sha,
    as: best.record.as,
  };
}

/**
 * Per check, the record with the newest `at` that carries a non-null value for THAT check —
 * order by `at`, never by file/array position, so an older passing line after a newer failing one
 * still reports the failure; a tie on `at` (same-second precision, two `gate record` calls in one
 * second) is broken by ledger (append) order — the LATER element wins, since the ledger is
 * append-only and a later line is the later record. `ok` is `failed === 0` for tests, `exit code
 * === 0` for the rest; a `null` failed/exit code (recorded but unknown) reads as not-ok, never a
 * guessed pass.
 */
export function latestChecks(
  records: readonly GateRecord[],
): Record<GateCheckName, GateCheckResult | null> {
  return {
    tests: latestFor(
      records,
      (r) => r.tests,
      formatTestsValue,
      (t) => t.failed === 0,
    ),
    typecheck: latestFor(
      records,
      (r) => r.typecheck,
      (v) => `exit ${v}`,
      (v) => v === 0,
    ),
    lint: latestFor(
      records,
      (r) => r.lint,
      (v) => `exit ${v}`,
      (v) => v === 0,
    ),
    build: latestFor(
      records,
      (r) => r.build,
      (v) => `exit ${v}`,
      (v) => v === 0,
    ),
  };
}

// ---- commit log -------------------------------------------------------------------------------

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';
const TRAILER_SEP = '\x1d';

/** `"Name <email>"` → `"Name"`; a bare name (no `<...>`) passes through; `""`/absent → `null`. */
function agentFromTrailers(field: string | undefined): string | null {
  if (!field) return null;
  const first = field.split(TRAILER_SEP)[0]?.trim();
  if (!first) return null;
  const m = /^(.*?)\s*<[^>]*>\s*$/.exec(first);
  const name = (m?.[1] ?? first).trim();
  return name.length > 0 ? name : null;
}

/**
 * `git log --format=%h%x1f%cI%x1f%an%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1d)%x1e`
 * output → rows, newest-first (git's own order, preserved). `agent` is the first Co-Authored-By
 * trailer's name (email stripped) — `null` when a commit carries none. A trailing blank record
 * (the newline git prints after the last `%x1e`) is dropped; a short/malformed record is skipped,
 * never thrown.
 */
export function parseCommitLog(out: string): CommitRow[] {
  const rows: CommitRow[] = [];
  for (const raw of out.split(RECORD_SEP)) {
    const rec = raw.replace(/^\n+/, '');
    if (rec.trim().length === 0) continue;
    const fields = rec.split(FIELD_SEP);
    const [sha, at, author, subject, trailers] = fields;
    if (!sha || !at || !author || subject === undefined) continue;
    rows.push({ sha, at, author, agent: agentFromTrailers(trailers), subject });
  }
  return rows;
}

/** UTC dates, oldest first, `days` entries ending today (server's `now`) — zeros included for a
 * day with no commit, so a 14-day cadence chart never has a gap. */
export function perDay(
  ats: readonly string[],
  now: Date,
  days = 14,
): { date: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const at of ats) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

/** Commits per `agent ?? author`, count descending, ties broken alphabetically for a stable order. */
export function byWho(rows: readonly CommitRow[]): { who: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const who = r.agent ?? r.author;
    counts.set(who, (counts.get(who) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([who, count]) => ({ who, count }))
    .sort((a, b) => b.count - a.count || a.who.localeCompare(b.who));
}
