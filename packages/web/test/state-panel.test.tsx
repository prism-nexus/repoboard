/**
 * P8.3, locked decision 7: STATE.md as a collapsible panel at the top of the Board view. OWNER
 * QUEUE is recomputed from the live `cards` (not trusted from a possibly-stale wire payload), and
 * a queue line scrolls to the `decide` column rather than toggling a filter (O11 dropped the
 * TopBar filter; orchestrator note 2).
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, emptyState, mockState, renderApp, snapshot, testStore } from './helpers.jsx';

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-02T22:41:10Z') }));
afterEach(() => vi.useRealTimers());

describe('StatePanel', () => {
  it('before any STATE.md exists: says so, no crash', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, emptyState());
    renderApp(store);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('no STATE.md yet');
  });

  it('with no state payload at all (pre-P8.3 server), also reads as "no STATE.md yet"', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]); // no state arg
    renderApp(store);
    expect(screen.getByTestId('state-panel')).toHaveTextContent('no STATE.md yet');
  });

  it('renders LIVE, LAST LANDINGS and SEATS from the payload', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
    renderApp(store);
    const panel = screen.getByTestId('state-panel');
    expect(panel).toHaveTextContent('Tree is dev.');
    expect(panel).toHaveTextContent('K117 landed.');
    expect(panel).toHaveTextContent('ops watching.');
    expect(panel).toHaveTextContent('written');
    expect(panel).toHaveTextContent('claude/p8-3');
  });

  it('the OWNER QUEUE is generated from cards that need a decision, one line per card', () => {
    const store = testStore();
    const asked = card('RCB-40', 'decide', {
      decision: {
        question: 'sync-issues column?',
        options: [
          { letter: 'A', text: 'todo' },
          { letter: 'B', text: 'backlog' },
        ],
        askedBy: 'claude/coordinator',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: 'doing',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    snapshot(store, [asked], undefined, undefined, undefined, mockState());
    renderApp(store);
    const badge = screen.getByTestId('state-panel-queue-count');
    expect(badge).toHaveTextContent('1 needs decision');
    const queue = screen.getByTestId('state-panel-queue');
    expect(queue).toHaveTextContent('RCB-40 · sync-issues column? · [A B]');
  });

  it('a decided card never appears in the queue', () => {
    const store = testStore();
    const decided = card('RCB-41', 'todo', {
      decision: {
        question: 'q',
        options: [],
        askedBy: 'a',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: null,
        chosen: null,
        words: 'done',
        decidedBy: 'web',
        decidedAt: '2026-09-02T22:05:00Z',
      },
    });
    snapshot(store, [decided], undefined, undefined, undefined, mockState());
    renderApp(store);
    expect(screen.queryByTestId('state-panel-queue-count')).toBeNull();
    expect(screen.getByTestId('state-panel')).toHaveTextContent('No open decisions.');
  });

  it('clicking a queue line scrolls the decide column into view', () => {
    const store = testStore();
    const asked = card('RCB-40', 'decide', {
      decision: {
        question: 'q',
        options: [{ letter: 'A', text: 'x' }],
        askedBy: 'a',
        askedAt: '2026-09-02T22:00:00Z',
        returnTo: 'doing',
        chosen: null,
        words: null,
        decidedBy: null,
        decidedAt: null,
      },
    });
    snapshot(store, [asked], undefined, undefined, undefined, mockState());
    renderApp(store);
    const decideColumn = document.querySelector('[data-column="decide"]');
    expect(decideColumn).not.toBeNull();
    const scrollSpy = vi.fn();
    if (decideColumn) (decideColumn as HTMLElement).scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByText('RCB-40 · q · [A]'));
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('the collapse toggle hides the body and remembers the choice across a re-render', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    });
    try {
      const store = testStore();
      snapshot(store, [card('RB-1', 'todo')], undefined, undefined, undefined, mockState());
      const { unmount } = renderApp(store);
      expect(screen.getByTestId('state-panel')).toHaveTextContent('Tree is dev.');
      fireEvent.click(screen.getByRole('button', { name: /^STATE/ }));
      expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
      unmount();

      // A fresh mount reads the remembered collapsed state back.
      renderApp(store);
      expect(screen.getByTestId('state-panel')).not.toHaveTextContent('Tree is dev.');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
