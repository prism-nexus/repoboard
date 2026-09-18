/**
 * P8.1: the CardItem badge/chip and the Drawer's Decision section — lettered options the owner
 * picks, a words field, and a Decide button that POSTs `/api/cards/:id/decide`.
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

const OPEN_DECISION = {
  question: 'Ship it?',
  options: [
    { letter: 'A', text: 'yes, ship now' },
    { letter: 'B', text: 'no, wait' },
  ],
  askedBy: 'claude/agent',
  askedAt: '2026-09-02T22:00:00Z',
  returnTo: 'todo',
  chosen: null,
  words: null,
  decidedBy: null,
  decidedAt: null,
};

describe('CardItem: decision badge and chip', () => {
  it('an OPEN decision shows the ? mark and the option letters inline', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'decide', { decision: OPEN_DECISION })]);
    renderApp(store);
    const badge = screen.getByTestId('decision-badge-RB-1');
    expect(within(badge).getByText('?')).toBeInTheDocument();
    expect(badge).toHaveTextContent('A B');
    expect(badge).toHaveAttribute('title', expect.stringContaining('Ship it?'));
  });

  it('a DECIDED card shows the chosen letter as a small chip, no badge', () => {
    const store = testStore();
    const decided = {
      ...OPEN_DECISION,
      chosen: 'A',
      decidedBy: 'web',
      decidedAt: '2026-09-02T23:00:00Z',
    };
    snapshot(store, [card('RB-1', 'todo', { decision: decided })]);
    renderApp(store);
    expect(screen.queryByTestId('decision-badge-RB-1')).toBeNull();
    const chip = screen.getByTestId('decision-chip-RB-1');
    expect(chip).toHaveTextContent('A');
  });

  it('a card with no decision shows neither', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    expect(screen.queryByTestId('decision-badge-RB-1')).toBeNull();
    expect(screen.queryByTestId('decision-chip-RB-1')).toBeNull();
  });
});

const OPEN_TASK = {
  question: 'buy the domain',
  kind: 'task' as const,
  options: [],
  askedBy: 'claude/agent',
  askedAt: '2026-09-02T22:00:00Z',
  returnTo: 'todo',
  chosen: null,
  words: null,
  decidedBy: null,
  decidedAt: null,
};

describe('CardItem: owner task mark (RCB-52)', () => {
  it('an OPEN task shows the ! mark, not ?', () => {
    const store = testStore();
    snapshot(store, [card('RB-2', 'decide', { decision: OPEN_TASK })]);
    renderApp(store);
    const badge = screen.getByTestId('decision-badge-RB-2');
    expect(within(badge).getByText('!')).toBeInTheDocument();
    expect(within(badge).getByText('!')).toHaveClass('card__decision-mark--task');
    expect(badge).toHaveAttribute('title', expect.stringContaining('owner task: buy the domain'));
  });
});

describe('Drawer: Owner task section (RCB-52)', () => {
  it('heading reads Owner task, no option buttons, Done enabled with empty words', async () => {
    const fetchMock = stubFetch(async () =>
      card('RB-2', 'todo', {
        decision: {
          ...OPEN_TASK,
          decidedBy: 'web',
          decidedAt: '2026-09-02T23:00:00Z',
        },
      }),
    );
    const store = testStore();
    snapshot(store, [card('RB-2', 'decide', { decision: OPEN_TASK })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-2'));
    const section = screen.getByTestId('decision-section');
    expect(within(section).getByText('Owner task')).toBeInTheDocument();
    expect(within(section).queryByTestId(/decision-option-/)).toBeNull();
    const submit = within(section).getByText('Done');
    expect(submit).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ actor: 'web' });

    const answer = await screen.findByTestId('decision-answer');
    expect(answer).toHaveTextContent('Done');
  });
});

describe('Drawer: Decision section', () => {
  it('renders one button per option and a words field above the description', () => {
    const store = testStore();
    snapshot(store, [
      card('RB-1', 'decide', { decision: OPEN_DECISION, body: 'The description.\n' }),
    ]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('decision-section');
    expect(within(section).getByText('Ship it?')).toBeInTheDocument();
    expect(within(section).getByTestId('decision-option-A')).toHaveTextContent('A');
    expect(within(section).getByTestId('decision-option-A')).toHaveTextContent('yes, ship now');
    expect(within(section).getByTestId('decision-option-B')).toHaveTextContent('no, wait');
    expect(within(section).getByLabelText('Your words')).toBeInTheDocument();
    // Decision section is above the description (prose).
    const drawer = screen.getByTestId('drawer');
    const order = Array.from(drawer.querySelectorAll('section')).map((s) =>
      s.className.includes('drawer__decision')
        ? 'decision'
        : s.textContent?.includes('The description')
          ? 'description'
          : 'other',
    );
    expect(order.indexOf('decision')).toBeLessThan(order.indexOf('description'));
  });

  it('Decide is disabled with neither picked, enabled by a letter, and POSTs the letter', async () => {
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ...card('RB-1', 'todo', {
          decision: {
            ...OPEN_DECISION,
            chosen: (body.letter as string | undefined) ?? null,
            decidedBy: 'web',
            decidedAt: '2026-09-02T23:00:00Z',
          },
        }),
      };
    });
    const store = testStore();
    snapshot(store, [card('RB-1', 'decide', { decision: OPEN_DECISION })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('decision-section');
    const submit = within(section).getByText('Decide');
    expect(submit).toBeDisabled();

    fireEvent.click(within(section).getByTestId('decision-option-A'));
    expect(submit).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cards/RB-1/decide');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ letter: 'A', actor: 'web' });

    const answer = await screen.findByTestId('decision-answer');
    expect(answer).toHaveTextContent('Decided A');
    expect(screen.queryByTestId('decision-option-A')).toBeNull();
  });

  it('words alone enables Decide and is sent without a letter', async () => {
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return card('RB-1', 'todo', {
        decision: {
          ...OPEN_DECISION,
          options: [],
          chosen: null,
          words: (body.words as string | undefined) ?? null,
          decidedBy: 'web',
          decidedAt: '2026-09-02T23:00:00Z',
        },
      });
    });
    const store = testStore();
    snapshot(store, [card('RB-1', 'decide', { decision: { ...OPEN_DECISION, options: [] } })]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    const section = screen.getByTestId('decision-section');
    const submit = within(section).getByText('Decide');
    expect(submit).toBeDisabled();
    fireEvent.change(within(section).getByLabelText('Your words'), {
      target: { value: 'go for it' },
    });
    expect(submit).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
      await Promise.resolve();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ words: 'go for it', actor: 'web' });
    expect(await screen.findByTestId('decision-answer')).toHaveTextContent('"go for it"');
  });
});
