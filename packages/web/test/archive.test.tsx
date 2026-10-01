/**
 * P8.5: the Board's `done` column header gets an "archive older than 14d" action that calls
 * `POST /api/archive` and reports the count — nothing else (locked decision 4).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const payload = await handler(url, init);
    return { ok: true, status: 200, json: async () => payload, url } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('done column: archive action', () => {
  it('shows the action only on the done column, not on others', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'done'), card('RB-2', 'todo')]);
    renderApp(store);
    const doneColumn = document.querySelector('[data-column="done"]');
    const todoColumn = document.querySelector('[data-column="todo"]');
    expect(doneColumn).not.toBeNull();
    expect(todoColumn).not.toBeNull();
    expect(
      within(doneColumn as HTMLElement).getByText('archive older than 14d'),
    ).toBeInTheDocument();
    expect(within(todoColumn as HTMLElement).queryByText('archive older than 14d')).toBeNull();
  });

  it('clicking it POSTs /api/archive with olderThan 14d and reports the count', async () => {
    const fetchMock = stubFetch(async () => ({ dryRun: false, archived: ['RB-1', 'RB-2'] }));
    const store = testStore();
    snapshot(store, [card('RB-1', 'done')]);
    renderApp(store);
    screen.getByText('archive older than 14d').click();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/archive');
    expect(JSON.parse(String(init.body))).toEqual({ olderThan: '14d', actor: 'web' });

    expect(await screen.findByText('Archived 2 cards')).toBeInTheDocument();
  });

  it('reports "Nothing to archive" when the count is zero', async () => {
    stubFetch(async () => ({ dryRun: false, archived: [] }));
    const store = testStore();
    snapshot(store, [card('RB-1', 'done')]);
    renderApp(store);
    screen.getByText('archive older than 14d').click();
    expect(await screen.findByText('Nothing to archive')).toBeInTheDocument();
  });
});
