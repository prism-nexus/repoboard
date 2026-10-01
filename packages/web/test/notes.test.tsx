/**
 * RCB-70: the Drawer's Notes section — the `## Notes` timeline and the box that posts
 * `/api/cards/:id/notes`.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
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

function failingFetch(message: string) {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: message }),
      }) as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NOTES_BODY = [
  'The description.',
  '',
  '## Notes',
  '- 2026-09-19T23:20:00Z owner — ship the notes box before RCB-68',
].join('\n');

describe('Drawer: Notes section', () => {
  it('renders existing notes with actor and relative time', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { body: NOTES_BODY })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    expect(within(section).getByText('Notes')).toBeInTheDocument();
    expect(section).toHaveTextContent('ship the notes box before RCB-68');
    expect(section).toHaveTextContent('owner');
  });

  it('renders even with zero notes (the box is the point)', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    expect(screen.getByTestId('notes-section')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Add a note…')).toBeInTheDocument();
  });

  it('the box POSTs {text, actor} with the by value and clears the textarea on 200', async () => {
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return card('RB-1', 'todo', {
        body: `${NOTES_BODY}\n- 2026-09-19T23:25:00Z ${body.actor} — ${body.text}`,
      });
    });
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    const textarea = within(section).getByPlaceholderText('Add a note…');
    fireEvent.change(textarea, { target: { value: 'ship it after the restart' } });
    fireEvent.change(within(section).getByLabelText('Noted by'), {
      target: { value: 'owner' },
    });
    const submit = within(section).getByText('Add note');
    expect(submit).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cards/RB-1/notes');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ text: 'ship it after the restart', actor: 'owner' });

    expect(await within(section).findByPlaceholderText('Add a note…')).toHaveValue('');
  });

  it('a blank by posts actor "owner"; inner whitespace becomes "-" (the line shape needs \\S+)', async () => {
    const fetchMock = stubFetch(async () => card('RB-1', 'todo'));
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    const by = within(section).getByLabelText('Noted by');
    const textarea = within(section).getByPlaceholderText('Add a note…');
    for (const [typed, expected] of [
      ['   ', 'owner'],
      ['Matt  Jahn', 'Matt-Jahn'],
    ] as const) {
      fireEvent.change(textarea, { target: { value: 'x' } });
      fireEvent.change(by, { target: { value: typed } });
      await act(async () => {
        fireEvent.click(within(section).getByText('Add note'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(JSON.parse(String(init.body)).actor).toBe(expected);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed POST toasts and keeps the drafted text', async () => {
    failingFetch('text is required');
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    const textarea = within(section).getByPlaceholderText('Add a note…');
    fireEvent.change(textarea, { target: { value: 'a draft note' } });
    const submit = within(section).getByText('Add note');

    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText(/Note on RB-1 failed: text is required/)).toBeInTheDocument();
    expect(within(section).getByPlaceholderText('Add a note…')).toHaveValue('a draft note');
  });

  it('RCB-72: a note with an Enter (continuation line) renders a <br>, not a collapsed space', () => {
    const body = [
      'The description.',
      '',
      '## Notes',
      '- 2026-09-19T23:20:00Z owner — line one',
      '  line two',
    ].join('\n');
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo', { body })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    const msg = section.querySelector('.timeline__msg');
    expect(msg).not.toBeNull();
    expect(msg?.innerHTML).toMatch(/<br\s*\/?>/);
  });

  it('Add note is disabled while the trimmed text is empty', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('notes-section');
    const submit = within(section).getByText('Add note');
    expect(submit).toBeDisabled();
    fireEvent.change(within(section).getByPlaceholderText('Add a note…'), {
      target: { value: '   ' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(within(section).getByPlaceholderText('Add a note…'), {
      target: { value: 'x' },
    });
    expect(submit).not.toBeDisabled();
  });
});
