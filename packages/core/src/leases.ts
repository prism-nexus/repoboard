/**
 * P8.2 (plan §5 P8.2, §11 O9): `.repoboard/leases.yml` — who holds a named resource (a lock, a
 * dev server, a lane), and the time windows during which one is claimed. One file, like
 * `board.yml`; every mutation goes through the pure functions here, exactly like `moveCard`
 * (§0.4). Core stays I/O-free (§0.5): parsing/serializing text and computing state are the only
 * things this module does.
 *
 * Locked decision 2's boundary: `until` strictly before `now` is STALE; `until === now` is LIVE.
 * `until` absent means "held until released" — it can never go stale on its own.
 */
import * as YAML from 'yaml';
import { z } from 'zod';
import { toIso } from './time.js';
import type { Event, Lease, LeasesDoc, Window } from './types.js';

const isoDatetime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'must be an ISO-8601 datetime',
});

export const LeaseSchema = z.looseObject({
  resource: z.string().min(1),
  holder: z.string().min(1),
  since: isoDatetime,
  until: isoDatetime.optional(),
  note: z.string().optional(),
});

export const WindowSchema = z.looseObject({
  resource: z.string().min(1),
  start: isoDatetime,
  end: isoDatetime,
  name: z.string().min(1),
});

export const LeasesSchema = z.looseObject({
  leases: z.array(LeaseSchema).default(() => []),
  windows: z.array(WindowSchema).default(() => []),
});

export type LeasesParseResult = { ok: true; doc: LeasesDoc } | { ok: false; error: string };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse `.repoboard/leases.yml`. An empty file yields `{leases: [], windows: []}`. Never throws. */
export function parseLeases(text: string): LeasesParseResult {
  let data: unknown;
  try {
    data = YAML.parse(text, { schema: 'core' });
  } catch (e) {
    return { ok: false, error: `leases.yml is not valid YAML: ${(e as Error).message}` };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'leases.yml must be a YAML mapping' };
  }
  const result = LeasesSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map(formatIssue).join('; ') };
  }
  return { ok: true, doc: result.data };
}

const DOC_ORDER = ['leases', 'windows'] as const;
const LEASE_ORDER = ['resource', 'holder', 'since', 'until', 'note'] as const;
const WINDOW_ORDER = ['resource', 'start', 'end', 'name'] as const;

function orderKeys(obj: Record<string, unknown>, first: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const k of first) if (obj[k] !== undefined) out[k] = obj[k];
  for (const [k, v] of Object.entries(obj)) {
    if (!first.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** Serialize a doc to `leases.yml` text. Unknown keys on a lease/window/doc are kept (locked decision 1). */
export function serializeLeases(doc: LeasesDoc): string {
  const ordered = orderKeys(
    {
      ...doc,
      leases: doc.leases.map((l) => orderKeys(l, LEASE_ORDER)),
      windows: doc.windows.map((w) => orderKeys(w, WINDOW_ORDER)),
    },
    DOC_ORDER,
  );
  return YAML.stringify(ordered, { schema: 'core', lineWidth: 0 });
}

/** `until` strictly before `at` is stale; absent `until`, or `until === at`, is live. */
export function isStale(lease: Lease, at: Date): boolean {
  if (lease.until === undefined) return false;
  return Date.parse(lease.until) < at.getTime();
}

/** Every currently-stale lease in the doc. */
export function staleLeases(doc: LeasesDoc, now: Date): Lease[] {
  return doc.leases.filter((l) => isStale(l, now));
}

/** RCB-131: every currently-LIVE lease in the doc — the mirror of `staleLeases`. */
export function liveLeases(doc: LeasesDoc, now: Date): Lease[] {
  return doc.leases.filter((l) => !isStale(l, now));
}

function liveLeaseOn(doc: LeasesDoc, resource: string, at: Date): Lease | undefined {
  return doc.leases.find((l) => l.resource === resource && !isStale(l, at));
}

/**
 * P8.3 (`check`'s `active-without-lease` finding): does `holder` currently hold a live lease on
 * ANY resource? Unlike `liveLeaseOn`, this is not scoped to one resource — a card's assignee may
 * hold a lease on a lane, a lock, anything — `check` only cares whether they hold SOMETHING.
 */
export function holdsLiveLease(doc: LeasesDoc, holder: string, at: Date): boolean {
  return doc.leases.some((l) => l.holder === holder && !isStale(l, at));
}

export interface TakeLeaseInput {
  resource: string;
  until?: string;
  note?: string;
  force?: boolean;
}

export interface LeaseMutationOptions {
  actor: string;
  now: Date;
}

export type LeaseMutationResult =
  | { ok: true; doc: LeasesDoc; event: Event; warnings: string[] }
  | { ok: false; error: string };

/**
 * Locked decision 2: a live lease held by ANOTHER holder refuses (names the holder and `until`)
 * unless `force`; the same holder renews — `since` is kept from the existing lease, `until` and
 * `note` are replaced by whatever this call gives (absent means cleared). A stale lease, or no
 * lease at all, is simply taken fresh.
 */
export function takeLease(
  doc: LeasesDoc,
  input: TakeLeaseInput,
  opts: LeaseMutationOptions,
): LeaseMutationResult {
  if (input.resource.trim().length === 0) return { ok: false, error: 'resource must not be empty' };
  const ts = toIso(opts.now);
  const existing = liveLeaseOn(doc, input.resource, opts.now);
  const warnings: string[] = [];
  let previousHolder: string | null = null;
  let since = ts;

  if (existing) {
    previousHolder = existing.holder;
    if (existing.holder === opts.actor) {
      since = existing.since; // renew: keep since
    } else if (!input.force) {
      return {
        ok: false,
        error:
          `"${input.resource}" is held by ${existing.holder} until ${existing.until ?? '—'} ` +
          '(pass --force to take it anyway)',
      };
    } else {
      warnings.push(
        `forced: took "${input.resource}" from ${existing.holder} ` +
          `(was held until ${existing.until ?? '—'})`,
      );
    }
  }

  const lease: Lease = { resource: input.resource, holder: opts.actor, since };
  if (input.until !== undefined) lease.until = input.until;
  if (input.note !== undefined) lease.note = input.note;

  // Drop every existing entry for this resource (live or stale) — there is exactly one per
  // resource. `existing` alone is not enough: a stale entry has no `existing` (it is not live)
  // but is still sitting in the array and must not be left behind as a second row.
  const nextLeases = doc.leases.filter((l) => l.resource !== input.resource);
  nextLeases.push(lease);
  const event: Event = {
    ts,
    actor: opts.actor,
    type: 'lease',
    cardId: null,
    resource: input.resource,
    from: previousHolder,
    to: opts.actor,
  };
  return { ok: true, doc: { ...doc, leases: nextLeases }, event, warnings };
}

export interface ReleaseLeaseInput {
  resource: string;
  force?: boolean;
}

/**
 * Locked decision 2: releasing a resource this actor does not hold refuses, naming the holder,
 * unless `force`. Releasing a resource with no lease entry at all is also refused — there is
 * nothing to release.
 */
export function releaseLease(
  doc: LeasesDoc,
  input: ReleaseLeaseInput,
  opts: LeaseMutationOptions,
): LeaseMutationResult {
  const existing = doc.leases.find((l) => l.resource === input.resource);
  if (!existing) {
    return { ok: false, error: `no lease is held on "${input.resource}"` };
  }
  const warnings: string[] = [];
  if (existing.holder !== opts.actor) {
    if (!input.force) {
      return {
        ok: false,
        error: `"${input.resource}" is held by ${existing.holder}, not ${opts.actor} (pass --force to release it anyway)`,
      };
    }
    warnings.push(`forced: released "${input.resource}" held by ${existing.holder}`);
  }
  const ts = toIso(opts.now);
  const event: Event = {
    ts,
    actor: opts.actor,
    type: 'lease',
    cardId: null,
    resource: input.resource,
    from: existing.holder,
    to: 'released',
  };
  return {
    ok: true,
    doc: { ...doc, leases: doc.leases.filter((l) => l !== existing) },
    event,
    warnings,
  };
}

export interface AddWindowInput {
  resource: string;
  start: string;
  end: string;
  name: string;
}

export type AddWindowResult =
  | { ok: true; doc: LeasesDoc; event: Event; warnings: string[] }
  | { ok: false; error: string };

/** Appends a window. `end` must be strictly after `start`. No overlap check (none is asked for). */
export function addWindow(
  doc: LeasesDoc,
  input: AddWindowInput,
  opts: LeaseMutationOptions,
): AddWindowResult {
  if (input.name.trim().length === 0) return { ok: false, error: 'name must not be empty' };
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (Number.isNaN(start)) return { ok: false, error: `start: must be an ISO-8601 datetime` };
  if (Number.isNaN(end)) return { ok: false, error: `end: must be an ISO-8601 datetime` };
  if (end <= start) return { ok: false, error: 'end must be after start' };
  const window: Window = {
    resource: input.resource,
    start: input.start,
    end: input.end,
    name: input.name,
  };
  const ts = toIso(opts.now);
  const event: Event = {
    ts,
    actor: opts.actor,
    type: 'window',
    cardId: null,
    resource: input.resource,
    from: null,
    to: input.name,
  };
  return { ok: true, doc: { ...doc, windows: [...doc.windows, window] }, event, warnings: [] };
}

/**
 * Locked decision 2: a window whose `end` is past is pruned only on the next WRITE — never on
 * read, so a read is always pure and never mutates what a concurrent reader sees. The store calls
 * this immediately before serializing, on every mutation.
 */
export function pruneWindows(doc: LeasesDoc, now: Date): LeasesDoc {
  const kept = doc.windows.filter((w) => Date.parse(w.end) >= now.getTime());
  if (kept.length === doc.windows.length) return doc;
  return { ...doc, windows: kept };
}

/** `start` inclusive, `end` exclusive (locked decision 4). */
function inWindow(w: Window, at: Date): boolean {
  const t = at.getTime();
  return t >= Date.parse(w.start) && t < Date.parse(w.end);
}

export type CheckResourceResult = { clear: true } | { clear: false; reasons: string[] };

/**
 * Locked decision 3: clear unless `at` (default: the caller's `now`) falls inside a window on
 * `resource`, or a live lease is held on it — either makes it not clear. Reasons are formatted
 * exactly as `window check` prints them, so the CLI does no extra formatting of its own.
 */
export function checkResource(doc: LeasesDoc, resource: string, at: Date): CheckResourceResult {
  const reasons: string[] = [];
  for (const w of doc.windows) {
    if (w.resource === resource && inWindow(w, at)) {
      reasons.push(`inside ${w.name} ${w.start}–${w.end} ${resource}`);
    }
  }
  for (const l of doc.leases) {
    if (l.resource === resource && !isStale(l, at)) {
      reasons.push(`held by ${l.holder} until ${l.until ?? '—'}`);
    }
  }
  return reasons.length === 0 ? { clear: true } : { clear: false, reasons };
}

const RELATIVE = /^\+(\d+)(m|h)$/;

export type TimeSpecResult = { ok: true; iso: string } | { ok: false; error: string };

/**
 * `--until`/window times accept ISO-8601 or `+90m` / `+2h` relative to `now` (locked decision 6).
 * Pure (no `Date.now()`), so it is testable and reused by CLI, MCP and HTTP alike.
 */
export function resolveTimeSpec(spec: string, now: Date): TimeSpecResult {
  const m = RELATIVE.exec(spec);
  if (m) {
    const amount = Number.parseInt(m[1] ?? '0', 10);
    const unitMs = m[2] === 'h' ? 3_600_000 : 60_000;
    return { ok: true, iso: toIso(new Date(now.getTime() + amount * unitMs)) };
  }
  const parsed = Date.parse(spec);
  if (Number.isNaN(parsed)) {
    return { ok: false, error: `"${spec}" is not an ISO-8601 datetime or a +90m/+2h offset` };
  }
  return { ok: true, iso: toIso(new Date(parsed)) };
}

// ---- display (RCB-131: leases surfaced in `seat`, `state`, `check`) -----------------------

/**
 * RCB-131: `since`/`until` printed as `HH:MMZ` when `iso` falls on the same UTC calendar day as
 * `now`, else the bare date `YYYY-MM-DD` — "since 2 minutes ago" is useful, "since 3 days ago at
 * 14:32Z" is not; the date is what a reader actually needs once a lease is a day old or more.
 * Shared by `formatLeaseLine` below and `checkFindings`'s `live-lease` finding (state.ts) — the
 * ONE place either surface turns a lease's timestamp into text, so the two can never disagree on
 * what "since 14:32Z" means.
 */
export function formatLeaseMoment(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? `${d.toISOString().slice(11, 16)}Z` : d.toISOString().slice(0, 10);
}

/**
 * RCB-131: the ONE lease line — `<resource> · <holder> · since <moment> · until <moment|—>`, a
 * `"<note>"` clause appended only when `lease.note` is present (an explicit empty string still
 * counts as present, same present-vs-missing distinction `parseSeatFields` makes for `in-flight:`/
 * `owes:`), and a trailing ` (yours)` when `opts.as` (case-insensitive, trimmed) matches
 * `lease.holder`. Used by `seat <name>`'s `## Leases` block (`opts.as` = the seat's own name) and
 * `state`'s generated LEASES section (no `opts.as` — that section has no "whose seat is this"
 * concept). `checkFindings`'s `live-lease` finding renders its own sentence shape, not this line,
 * but calls `formatLeaseMoment` for the same since/until text, so every surface agrees on the DATE
 * even where the LAYOUT differs.
 */
export function formatLeaseLine(lease: Lease, now: Date, opts?: { as?: string }): string {
  const since = formatLeaseMoment(lease.since, now);
  const until = lease.until !== undefined ? formatLeaseMoment(lease.until, now) : '—';
  const note = lease.note !== undefined ? ` · "${lease.note}"` : '';
  const wanted = opts?.as?.trim().toLowerCase();
  const yours =
    wanted !== undefined && lease.holder.trim().toLowerCase() === wanted ? ' (yours)' : '';
  return `${lease.resource} · ${lease.holder} · since ${since} · until ${until}${note}${yours}`;
}

/**
 * RCB-131: `formatLeaseLine`, one per lease, newline-joined — `(no live leases)` when `leases` is
 * empty, never an empty section. `leases` is expected already filtered to live-only (`liveLeases`)
 * — this function does no staleness filtering of its own, so a caller cannot ask it to show a
 * stale lease by mistake.
 */
export function renderLeaseLines(
  leases: readonly Lease[],
  now: Date,
  opts?: { as?: string },
): string {
  if (leases.length === 0) return '(no live leases)';
  return leases.map((l) => formatLeaseLine(l, now, opts)).join('\n');
}
