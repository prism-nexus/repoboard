import {
  type BoardConfig,
  boardDisplayName,
  type RepoSnapshot,
  type Sibling,
} from '@repoboard/core';
import { locationForRepo } from '../repo-key.js';
import type { Theme, View } from '../store.js';
import type { ReposPayload } from '../wire.js';

interface Props {
  config: BoardConfig | null;
  /** RCB-42: the server's already-merged list (board.yml + `--sibling` flags). Zero renders
   * nothing — no empty container, no separator. */
  siblings: Sibling[];
  repo: RepoSnapshot | null;
  connected: boolean;
  fun: boolean;
  theme: Theme;
  view: View;
  /** RCB-43 slice 3: `GET /api/repos`, fetched once by the store; `null` until it lands. The
   * selector renders only once it has landed AND lists 2+ repos — a one-repo `serve` shows
   * nothing new. */
  repos: ReposPayload | null;
  /** RCB-43 slice 3: this page's own key (`?repo=<key>` at load), or `null` for the primary. */
  repoKey: string | null;
  onView: (v: View) => void;
  onFun: (fun: boolean) => void;
  onTheme: (t: Theme) => void;
}

export function TopBar({
  config,
  siblings,
  repo,
  connected,
  fun,
  theme,
  view,
  repos,
  repoKey,
  onView,
  onFun,
  onTheme,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar__repo">
        <span className="topbar__mark">repoboard</span>
        {repo ? (
          <>
            <span className="topbar__name">{boardDisplayName(config, repo.root)}</span>
            {repo.head ? (
              <span className="mono topbar__head" title={repo.head.sha}>
                {repo.head.branch} <span className="muted">{repo.head.sha.slice(0, 7)}</span>
              </span>
            ) : (
              <span className="muted">no git</span>
            )}
          </>
        ) : (
          <span className="muted">waiting for board…</span>
        )}
        {repos && repos.repos.length >= 2 ? (
          <select
            className="topbar__repos"
            aria-label="Repo"
            value={repoKey ?? repos.primary}
            onChange={(e) => window.location.assign(locationForRepo(e.target.value, repos.primary))}
          >
            {repos.repos.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
                {r.hasBoard ? '' : ' · map-only'}
              </option>
            ))}
          </select>
        ) : null}
        {siblings.length > 0 ? (
          <span className="topbar__siblings">
            {siblings.map((s) => (
              <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer">
                {s.name}
              </a>
            ))}
          </span>
        ) : null}
      </div>
      <nav className="tabs" aria-label="View">
        <button
          type="button"
          className={`tab ${view === 'board' ? 'tab--on' : ''}`}
          onClick={() => onView('board')}
          aria-pressed={view === 'board'}
        >
          Board
        </button>
        <button
          type="button"
          className={`tab ${view === 'map' ? 'tab--on' : ''}`}
          onClick={() => onView('map')}
          aria-pressed={view === 'map'}
        >
          Map
        </button>
      </nav>
      <div className="topbar__tools">
        <span
          className={`dot ${connected ? 'dot--on' : 'dot--off'}`}
          title={connected ? 'Connected' : 'Disconnected'}
          role="status"
        >
          <span className="sr-only">{connected ? 'Connected' : 'Disconnected'}</span>
        </span>
        <button
          type="button"
          className={`toggle ${fun ? 'toggle--on' : ''}`}
          onClick={() => onFun(!fun)}
          aria-pressed={fun}
          title="Fun: animations, confetti, scrolling ticker"
        >
          fun
        </button>
        <button
          type="button"
          className="toggle"
          onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          title="Switch theme"
        >
          {theme === 'dark' ? 'light' : 'dark'}
        </button>
      </div>
    </header>
  );
}
