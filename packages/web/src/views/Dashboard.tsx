/**
 * RCB-112 B (plan the repo dashboard is decided in the card, not a numbered plan section): the
 * fourth top-level view, "Repo" — one page per served repo, `GET /api/dashboard` (RCB-112 A,
 * `packages/core/src/repo-health.ts`), fetched exactly like `Flow.tsx` fetches `/tests`: live on
 * mount and on repo change, never re-derived here. Three bands, top to bottom: Health (the last
 * recorded gate result per check, never re-run — CLAUDE.md non-negotiable 2), Commits (git log,
 * read live by the server), Systems + coverage (RCB-110's per-system line). Every null in the
 * payload is a real, inert answer ("no gate recorded" / "no git history" / "no systems.yml"),
 * never an error — the error state is reserved for the fetch itself failing.
 */
import type {
  CommitRow,
  GateCheckName,
  RepoCommits,
  RepoDashboard,
  RepoHealth,
} from '@repoboard/core';
import { useEffect, useState } from 'react';
import { useBoardState } from '../hooks.js';
import { apiPath } from '../repo-key.js';
import { relTime } from '../time.js';

type DashboardState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: RepoDashboard }
  | { kind: 'error'; message: string };

/** Mirrors `Flow.tsx`'s `useSystemTests`: fetched live, never cached, re-fetched when `repoKey`
 * or `reloadToken` (the refresh button) changes. */
function useDashboard(repoKey: string | null, reloadToken: number): DashboardState {
  const [state, setState] = useState<DashboardState>({ kind: 'loading' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken's CHANGE (not its value) is the refresh button's retrigger
  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    const url = apiPath('/api/dashboard', repoKey);
    const load = async (): Promise<DashboardState> => {
      if (typeof fetch !== 'function') return { kind: 'error', message: 'fetch unavailable' };
      const res = await fetch(url);
      if (!res.ok) return { kind: 'error', message: `${url} → HTTP ${res.status}` };
      const data = (await res.json()) as RepoDashboard;
      return { kind: 'ok', data };
    };
    load()
      .catch(
        (e: unknown): DashboardState => ({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [repoKey, reloadToken]);
  return state;
}

/** `relTime` against the PAYLOAD's `now`, never the browser's live clock — the age of a
 * recorded fact is fixed at the moment the server answered, not still ticking on screen. */
function ageFrom(at: string, nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  return relTime(at, Number.isNaN(nowMs) ? undefined : nowMs);
}

const CHECK_NAMES: readonly GateCheckName[] = ['tests', 'typecheck', 'lint', 'build'];

function HealthBand({ health, now }: { health: RepoHealth; now: string }) {
  return (
    <section className="dash__band" data-testid="dash-health">
      <h2>Health</h2>
      <div className="dash__health-rows">
        {CHECK_NAMES.map((name) => {
          const check = health.checks[name];
          return (
            <div
              key={name}
              className="dash__health-row"
              data-testid={`dash-health-${name}`}
              data-ok={check === null ? undefined : check.ok}
            >
              <span className="dash__health-name mono">{name}</span>
              {check === null ? (
                <span className="muted">no gate recorded</span>
              ) : (
                <>
                  <span
                    className={`dash__mark ${check.ok ? 'dash__mark--ok' : 'dash__mark--fail'}`}
                    title={check.ok ? 'ok' : 'fail'}
                  >
                    {check.ok ? '✓' : '✗'}
                  </span>
                  <span className="mono">{check.value}</span>
                  <span className="mono muted">{check.sha ?? '—'}</span>
                  <span className="muted">{check.as}</span>
                  <span className="muted">{ageFrom(check.at, now)}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {health.errors.length > 0 ? (
        <ul className="dash__health-errors" data-testid="dash-health-errors">
          {health.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <p className="mono" data-testid="dash-ledger">
        {health.ledger ?? 'no ledger'}
      </p>
      <p className="mono muted">{health.source}</p>
    </section>
  );
}

/** Shared row shape for both `head` and `originMain` — a commit's sha, subject (visually
 * truncated by CSS ellipsis, full text kept in `title`), `agent ?? author`, and age. */
function CommitList({ rows, now }: { rows: readonly CommitRow[]; now: string }) {
  return (
    <ul className="dash__commit-list mono">
      {rows.map((r) => (
        <li key={r.sha} className="dash__commit-row">
          <span className="dash__commit-sha">{r.sha}</span>
          <span className="dash__commit-subject" title={r.subject}>
            {r.subject}
          </span>
          <span className="dash__commit-who muted" title={r.agent ?? r.author}>
            {r.agent ?? r.author}
          </span>
          <span className="dash__commit-age muted">{ageFrom(r.at, now)}</span>
        </li>
      ))}
    </ul>
  );
}

/** `originMain: null` (no `origin/main` ref found — a real, inert fact, same as any other null
 * field here) reads as "no git history", same as a missing `head`. Otherwise: same first sha as
 * `head` means `origin/main` IS `HEAD`, so the list is not rendered a second time — only the one
 * line. A different first sha renders `originMain`'s own rows. */
function OriginMainSection({
  head,
  originMain,
  now,
}: {
  head: readonly CommitRow[] | null;
  originMain: readonly CommitRow[] | null;
  now: string;
}) {
  if (originMain === null) {
    return (
      <p className="muted" data-testid="dash-origin-main">
        no git history
      </p>
    );
  }
  const headFirst = head?.[0]?.sha;
  const sameAsHead = headFirst !== undefined && originMain[0]?.sha === headFirst;
  if (sameAsHead) {
    return (
      <p className="mono muted" data-testid="dash-origin-main">
        origin/main = HEAD
      </p>
    );
  }
  return (
    <div data-testid="dash-origin-main">
      <p className="mono muted dash__origin-label">origin/main</p>
      <CommitList rows={originMain} now={now} />
    </div>
  );
}

/** 14 plain CSS bars, no chart library. Bar height is each day's count over the max in the
 * window (or 1, so an all-zero window still draws flat bars rather than dividing by zero). Dates
 * are UTC (`perDay`'s own contract) — the label above names that, since a bare date string reads
 * as local time otherwise. */
function CommitBars({ perDay }: { perDay: readonly { date: string; count: number }[] }) {
  const max = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <>
      <p className="mono muted dash__bars-label">commits / day, last 14 days (UTC)</p>
      <div className="dash__bars" data-testid="dash-bars">
        {perDay.map((d) => (
          <div
            key={d.date}
            className="dash__bar"
            role="img"
            style={{ height: `${Math.round((d.count / max) * 100)}%` }}
            title={`${d.date}: ${d.count}`}
            aria-label={`${d.date}: ${d.count}`}
          />
        ))}
      </div>
    </>
  );
}

function CommitsBand({ commits, now }: { commits: RepoCommits; now: string }) {
  return (
    <section className="dash__band" data-testid="dash-commits">
      <h2>Commits</h2>
      {commits.branch === null ? (
        <p className="muted" data-testid="dash-branch">
          no git history
        </p>
      ) : (
        <p className="mono" data-testid="dash-branch">
          {commits.branch}
        </p>
      )}
      {commits.head === null ? (
        <p className="muted" data-testid="dash-head">
          no git history
        </p>
      ) : (
        <div data-testid="dash-head">
          <CommitList rows={commits.head} now={now} />
        </div>
      )}
      <OriginMainSection head={commits.head} originMain={commits.originMain} now={now} />
      {commits.perDay === null ? (
        <p className="muted" data-testid="dash-bars">
          no git history
        </p>
      ) : (
        <CommitBars perDay={commits.perDay} />
      )}
      {commits.byWho === null ? (
        <p className="muted" data-testid="dash-bywho">
          no git history
        </p>
      ) : (
        <ul className="dash__bywho mono" data-testid="dash-bywho">
          {commits.byWho.map((w) => (
            <li key={w.who}>
              {w.who} · {w.count}
            </li>
          ))}
        </ul>
      )}
      <p className="mono muted">{commits.source}</p>
    </section>
  );
}

function CoverageBand({
  coverage,
  source,
}: {
  coverage: { id: string; line: string }[] | null;
  source: string;
}) {
  return (
    <section className="dash__band" data-testid="dash-coverage">
      <h2>Systems + coverage</h2>
      {coverage === null ? (
        <p className="muted">no systems.yml — the Flow view can plan one</p>
      ) : (
        <ul className="dash__coverage-list mono">
          {coverage.map((c) => (
            <li key={c.id}>
              <strong>{c.id}</strong> <span className="muted">{c.line}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mono muted">{source}</p>
    </section>
  );
}

export function DashboardView() {
  const { repoKey } = useBoardState();
  const [reloadToken, setReloadToken] = useState(0);
  const state = useDashboard(repoKey, reloadToken);

  return (
    <div className="dash" data-testid="dashboard">
      <div className="dash__toolbar">
        <button type="button" className="toggle" onClick={() => setReloadToken((t) => t + 1)}>
          refresh
        </button>
      </div>
      {state.kind === 'loading' ? (
        <p className="mono muted dash__loading">Loading…</p>
      ) : state.kind === 'error' ? (
        <div className="dash__error" role="alert" data-testid="dash-error">
          <div className="dash__error-head mono">could not load dashboard</div>
          <div className="dash__error-message">{state.message}</div>
        </div>
      ) : (
        <div className="dash__bands">
          <HealthBand health={state.data.health} now={state.data.now} />
          <CommitsBand commits={state.data.commits} now={state.data.now} />
          <CoverageBand coverage={state.data.coverage} source={state.data.coverageSource} />
        </div>
      )}
    </div>
  );
}
