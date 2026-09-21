/**
 * K7: the drawer's References section renders what `GET /api/cards/:id/refs` returns — two
 * resolved refs (one markdown, one plain) and an error entry — and refetches on a `card` echo.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const RESOLVED = [
  {
    spec: 'docs/plan.md#§5 Phases',
    path: 'docs/plan.md',
    start: 3,
    end: 5,
    text: '## §5 Phases\n- **P6.1** README with a GIF.\n',
    truncated: false,
    error: null,
  },
  {
    spec: 'src/x.ts:L1-L2',
    path: 'src/x.ts',
    start: 1,
    end: 2,
    text: 'const a = 1;\nconst b = 2;',
    truncated: true,
    error: null,
  },
  {
    spec: '../../etc/hosts',
    path: '../../etc/hosts',
    start: null,
    end: null,
    text: null,
    truncated: false,
    error: '".." not allowed in path: ../../etc/hosts',
  },
];

afterEach(() => vi.unstubAllGlobals());

function stubFetch(payload: unknown = RESOLVED, status = 200) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: status === 200,
    status,
    json: async () => payload,
    url,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('drawer References (K7)', () => {
  it('shows a ref count on the tile and renders two refs plus an error from the fetched array', async () => {
    const fetchMock = stubFetch();
    const store = testStore();
    const c = card('RB-1', 'todo', {
      refs: ['docs/plan.md#§5 Phases', 'src/x.ts:L1-L2', '../../etc/hosts'],
      body: 'Points, does not paste.\n',
    });
    snapshot(store, [c, card('RB-2', 'todo')]);
    renderApp(store);

    expect(within(screen.getByTestId('card-RB-1')).getByTestId('ref-count')).toHaveTextContent(
      '3 refs',
    );
    expect(within(screen.getByTestId('card-RB-2')).queryByTestId('ref-count')).toBeNull();

    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = await screen.findByTestId('drawer-refs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cards/RB-1/refs');

    const refs = await within(section).findAllByTestId('ref');
    expect(refs).toHaveLength(2);
    // Markdown ref: rendered (an h2 and a <strong>), headed path:start–end.
    expect(within(refs[0] as HTMLElement).getByText('docs/plan.md:3–5')).toBeInTheDocument();
    expect((refs[0] as HTMLElement).querySelector('h2')?.textContent).toBe('§5 Phases');
    expect((refs[0] as HTMLElement).querySelector('strong')?.textContent).toBe('P6.1');
    // Non-markdown ref: a <pre>, with the truncation flag.
    expect((refs[1] as HTMLElement).querySelector('pre')?.textContent).toBe(
      'const a = 1;\nconst b = 2;',
    );
    expect(refs[1]).toHaveTextContent('src/x.ts:1–2 (truncated)');
    // Error entry: the spec and the error string, not nothing.
    const err = within(section).getByTestId('ref-error');
    expect(err).toHaveTextContent('../../etc/hosts');
    expect(err).toHaveTextContent('".." not allowed in path: ../../etc/hosts');
  });

  it('refetches on a card echo for that id and shows the new text', async () => {
    const fetchMock = stubFetch();
    const store = testStore();
    const c = card('RB-1', 'todo', { refs: ['docs/plan.md#§5 Phases'] });
    snapshot(store, [c]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    await screen.findAllByTestId('ref');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => [{ ...RESOLVED[0], text: '## §5 Phases\n- appended line\n', end: 6 }],
      url,
    }));
    act(() => store.dispatch({ type: 'card', card: { ...c, updated: '2026-09-02T23:00:00Z' } }));
    await screen.findByText('appended line');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch shows an error state, and a card without refs has no section', async () => {
    stubFetch({ error: 'boom' }, 500);
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { refs: ['docs/plan.md'] }), card('RB-2', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = await screen.findByTestId('drawer-refs');
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      '/api/cards/RB-1/refs → HTTP 500',
    );
    fireEvent.click(screen.getByTitle('Open RB-2'));
    expect(screen.queryByTestId('drawer-refs')).toBeNull();
  });
});
