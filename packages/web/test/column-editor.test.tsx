/**
 * RCB-34/P7.3, plan §11 O6: the column set is a per-user choice, edited in the app instead of by
 * hand in `board.yml`. `saveColumns` (store.ts) does not set `config` from the response — success
 * relies on the WS `config` broadcast the write triggers — so these tests only ever check the
 * PATCH request the panel sends and how it surfaces a failure, never a config change on save.
 */
import { defaultBoardConfig } from '@repoboard/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (url: string, _init?: RequestInit) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        url,
      }) as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function openEditor() {
  fireEvent.click(screen.getByText('Columns…'));
  return screen.getByTestId('column-editor');
}

function dataRows(panel: HTMLElement) {
  return within(panel).getAllByRole('row').slice(1); // drop the header row
}

describe('ColumnEditor', () => {
  it('renders one row per configured column with the card count', () => {
    const store = testStore();
    const config = defaultBoardConfig();
    snapshot(store, [card('RB-1', 'todo'), card('RB-2', 'todo'), card('RB-3', 'doing')], config);
    renderApp(store);

    const panel = openEditor();
    const rows = dataRows(panel);
    expect(rows).toHaveLength(config.columns.length);

    const todoRow = rows.find((r) => within(r).queryByText('todo'));
    expect(todoRow).toBeDefined();
    expect(within(todoRow as HTMLElement).getByText('2')).toBeInTheDocument();

    const doingRow = rows.find((r) => within(r).queryByText('doing'));
    expect(within(doingRow as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('remove + save sends PATCH /api/board with the remaining ids in order', async () => {
    const fetchMock = stubFetch(200, {});
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);

    const panel = openEditor();
    const decideRow = dataRows(panel).find((r) => within(r).queryByText('decide')) as HTMLElement;
    fireEvent.click(within(decideRow).getByText('Remove'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/board');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body.actor).toBe('web');
    expect(body.columns.map((c: { id: string }) => c.id)).toEqual([
      'backlog',
      'todo',
      'doing',
      'done',
    ]);
  });

  it('up-arrow on the second row swaps order in the saved payload', async () => {
    const fetchMock = stubFetch(200, {});
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);

    const panel = openEditor();
    const decideRow = dataRows(panel).find((r) => within(r).queryByText('decide')) as HTMLElement;
    fireEvent.click(within(decideRow).getByLabelText('move decide up'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.columns.map((c: { id: string }) => c.id)).toEqual([
      'decide',
      'backlog',
      'todo',
      'doing',
      'done',
    ]);
  });

  it('the "Add column" row appends {id,title} to the saved list', async () => {
    const fetchMock = stubFetch(200, {});
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);

    openEditor();
    fireEvent.change(screen.getByLabelText('new column id'), { target: { value: 'review' } });
    fireEvent.change(screen.getByLabelText('new column title'), {
      target: { value: 'Review' },
    });
    fireEvent.click(screen.getByText('Add column'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.columns.at(-1)).toEqual({ id: 'review', title: 'Review' });
  });

  it('a 400 from the server surfaces its error text and leaves the panel open with the edits', async () => {
    stubFetch(400, { error: 'duplicate column id "x"' });
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);

    const panel = openEditor();
    const decideRow = dataRows(panel).find((r) => within(r).queryByText('decide')) as HTMLElement;
    fireEvent.click(within(decideRow).getByText('Remove'));
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/duplicate column id "x"/)).toBeInTheDocument();
    // The panel is still open, and the removal the user made is still in the draft.
    const stillOpen = screen.getByTestId('column-editor');
    expect(dataRows(stillOpen)).toHaveLength(4);
  });

  it('is hidden when hasBoard is false (map-only)', () => {
    const store = testStore();
    snapshot(store, [], defaultBoardConfig(), false);
    renderApp(store);
    expect(screen.queryByText('Columns…')).toBeNull();
  });
});
