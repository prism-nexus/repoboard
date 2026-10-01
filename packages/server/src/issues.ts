/**
 * P8.5: the I/O half of `sync-issues <path>#<heading>` — reading the source file (guarded exactly
 * like a card's `refs:`, K7's own path) and handing the section text to core's pure
 * `parseIssueItems`/`planSync`. **Never writes `path`** (plan O9's standing constraint): this
 * module only ever calls `readRepoText`, never any write function, on the source file.
 */
import {
  findHeadingSection,
  type PlanCard,
  type PlanSyncResult,
  parseIssueItems,
  planSync,
  splitLines,
} from '@repoboard/core';
import { readRepoText, resolveRepoPath } from './refs.js';
import type { CardStore } from './store.js';

export interface SyncIssuesInput {
  path: string;
  heading: string;
  status: string;
  label: string;
}

export type SyncPlanOutcome =
  | {
      ok: true;
      plan: PlanSyncResult;
      malformed: string[];
      doneColumn: string;
    }
  | { ok: false; error: string };

/**
 * Read `input.path` (guarded: repo-relative, no `..`, no escaping the root — `resolveRepoPath`),
 * find the section under `input.heading` with the SAME function `refs.ts`'s `'heading'` ref case
 * uses (`findHeadingSection`), parse it, and compute the plan against the store's CURRENT cards.
 * A pure read: no write, no matter what the plan says — `applySyncPlan` is the writer.
 */
export async function computeSyncPlan(
  store: CardStore,
  input: SyncIssuesInput,
): Promise<SyncPlanOutcome> {
  const guarded = await resolveRepoPath(store.root, input.path);
  if (!guarded.ok) return { ok: false, error: guarded.error };
  const read = await readRepoText(guarded.path, input.path);
  if (!read.ok) return { ok: false, error: read.error };
  const lines = splitLines(read.text);
  const section = findHeadingSection(lines, input.heading);
  if (!section) {
    return { ok: false, error: `heading "${input.heading}" not found in ${input.path}` };
  }
  const sectionText = lines.slice(section.start, section.end + 1).join('\n');
  const parsed = parseIssueItems(sectionText);
  const doneColumn = store.config.columns.find((c) => c.done === true);
  if (!doneColumn) return { ok: false, error: 'board has no done: true column' };
  const cards: PlanCard[] = store.list().map((c) => ({ id: c.id, status: c.status, refs: c.refs }));
  const plan = planSync(parsed.items, cards, {
    path: input.path,
    status: input.status,
    doneColumn: doneColumn.id,
  });
  return { ok: true, plan, malformed: parsed.malformed, doneColumn: doneColumn.id };
}

export interface ApplySyncResult {
  created: string[];
  closed: string[];
  errors: string[];
}

/**
 * Write the plan: `store.create` for every `create` entry, `store.closeSynced` for every `close`
 * entry. Collects per-item errors rather than throwing on the first one, so a partial failure
 * (e.g. a WIP warning is not one — those are `warnings`, not errors) does not hide the rest.
 */
export async function applySyncPlan(
  store: CardStore,
  input: SyncIssuesInput,
  plan: PlanSyncResult,
  actor: string,
): Promise<ApplySyncResult> {
  const created: string[] = [];
  const closed: string[] = [];
  const errors: string[] = [];
  for (const c of plan.create) {
    const res = await store.create(
      {
        title: c.title,
        status: input.status,
        labels: [input.label],
        refs: [`${input.path}@K${c.n}`],
        body: `Filed from ${input.path} §${input.heading}. The entry is the text; this card is the pointer.`,
      },
      actor,
    );
    if (!res.ok) errors.push(`K${c.n}: ${res.error}`);
    else created.push(res.card.id);
  }
  for (const cl of plan.close) {
    const res = await store.closeSynced(cl.cardId, input.path, actor);
    if (!res.ok) errors.push(`${cl.cardId} (K${cl.n}): ${res.error}`);
    else closed.push(cl.cardId);
  }
  return { created, closed, errors };
}
