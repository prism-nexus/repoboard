/**
 * RCB-218: the LANDED panel — `landings` rows (commits grouped by card id, from git) joined to the
 * LIVE cards for a title and a column. Each test names its CONTROL: the perturbation of the source
 * that makes it fail; none was run (the brief forbids any runner), the gating seat watches each fail.
 */
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { card, mockState, renderApp, testStore } from './helpers.jsx';
import { landingRow, landingsPayload, NOW_ISO, sendSnapshot } from './status-fixtures.js';

beforeEach(() => vi.useFakeTimers({ now: new Date(NOW_ISO) }));
afterEach(() => vi.useRealTimers());

describe('LANDED panel', () => {
  // CONTROL: in LandedPanel.tsx make `stillIn` always `null` — RB-2's flag is gone and the first
  // assertion fails; make it `columnLabel(...)` unconditionally — RB-1 (in Done) is flagged too and
  // the `toBeNull` fails.
  it('joins each row to its live card: the title, and a flag when the card is not in a done column', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [
        card('RB-1', 'done', { title: 'Publish from CI on a tag' }),
        card('RB-2', 'todo', { title: 'Guard every outgoing commit' }),
      ],
      landings: landingsPayload([landingRow('RB-2'), landingRow('RB-1', ['5d0b7f3'])]),
      state: mockState(),
    });
    renderApp(store);
    const open = screen.getByTestId('landing-RB-2');
    expect(open).toHaveTextContent('Guard every outgoing commit');
    expect(screen.getByTestId('landing-flag-RB-2')).toHaveTextContent(
      '⚠ landed, card still in To do',
    );
    const done = screen.getByTestId('landing-RB-1');
    expect(done).toHaveTextContent('Publish from CI on a tag');
    expect(screen.queryByTestId('landing-flag-RB-1')).toBeNull();
  });

  // CONTROL: in LandedPanel.tsx `stillIn`, drop the `card &&` guard (`!card || …`) — a landing whose
  // card is not on the board is then flagged against a column nobody knows, and this fails.
  it('a landing whose card is not on the board shows the commit subject, muted, and claims nothing', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [],
      landings: landingsPayload([landingRow('RB-9', ['9f40ab6'])]),
      state: mockState(),
    });
    renderApp(store);
    const row = screen.getByTestId('landing-RB-9');
    expect(row).toHaveTextContent('the work behind 9f40ab6');
    expect(row.textContent).not.toContain('RB-9: ');
    expect(screen.queryByTestId('landing-flag-RB-9')).toBeNull();
  });

  // CONTROL: in LandedPanel.tsx render every sha as the plain `<span>` — no link exists and the
  // `getByRole('link')` fails.
  it('short shas are links to the commit when the server knows the repo web base', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [card('RB-1', 'done')],
      landings: landingsPayload([landingRow('RB-1', ['a1c94e2', '5d0b7f3'])], {
        web: 'https://github.com/acme/demo/',
      }),
      state: mockState(),
    });
    renderApp(store);
    const panel = within(screen.getByTestId('landed-panel'));
    expect(panel.getByRole('link', { name: 'a1c94e2' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo/commit/a1c94e2',
    );
    expect(panel.getByRole('link', { name: '5d0b7f3' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo/commit/5d0b7f3',
    );
  });

  // CONTROL: in LandedPanel.tsx build `base` from `web` without `isWebBase` — the `javascript:` base
  // becomes an href and the second assertion fails; ignore `web === null` — a link with no host.
  it('no web base, or a base that is not http(s): the shas are text, never a link', () => {
    for (const web of [null, 'javascript:alert(1)']) {
      const store = testStore();
      sendSnapshot(store, {
        cards: [card('RB-1', 'done')],
        landings: landingsPayload([landingRow('RB-1', ['a1c94e2'])], { web }),
        state: mockState(),
      });
      const { unmount } = renderApp(store);
      const panel = within(screen.getByTestId('landed-panel'));
      expect(panel.queryByRole('link')).toBeNull();
      expect(panel.getByText('a1c94e2')).toBeInTheDocument();
      unmount();
    }
  });

  // CONTROL: in LandedPanel.tsx replace the `landings === null` branch's text with the empty-rows
  // text — the "newer server" line is gone and this fails.
  it('a server that sends no landings payload: ONE muted line saying landings need a newer server', () => {
    const store = testStore();
    sendSnapshot(store, { cards: [card('RB-1', 'done')], state: mockState() });
    renderApp(store);
    expect(screen.getAllByText(/newer server/)).toHaveLength(1);
    expect(screen.getByTestId('landed-unsupported')).toHaveClass('empty-note');
    expect(screen.getByTestId('landed-panel')).not.toHaveTextContent('No commit starts');
  });

  // CONTROL: in LandedPanel.tsx test `landings === null || landings.rows.length === 0` for the
  // "newer server" line — an empty (answered) payload is then called unsupported and this fails.
  it('a payload with no rows is an answer, not an unsupported server', () => {
    const store = testStore();
    sendSnapshot(store, { landings: landingsPayload([]), state: mockState() });
    renderApp(store);
    expect(screen.queryByTestId('landed-unsupported')).toBeNull();
    expect(screen.getByTestId('landed-panel')).toHaveTextContent('No commit starts with a card id');
  });

  // CONTROL: in store.ts delete `case 'landings'` — the row never appears and this fails.
  it('a `landings` message fills the panel without a snapshot', () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [card('RB-1', 'done', { title: 'Late landing' })],
      state: mockState(),
    });
    renderApp(store);
    expect(screen.queryByTestId('landing-RB-1')).toBeNull();
    act(() =>
      store.dispatch({ type: 'landings', landings: landingsPayload([landingRow('RB-1')]) }),
    );
    expect(screen.getByTestId('landing-RB-1')).toHaveTextContent('Late landing');
  });

  // CONTROL: in LandedPanel.tsx drop `newest ? … : null` — the author and age are gone.
  it("shows the newest commit's author and age, and the payload's own provenance line", () => {
    const store = testStore();
    sendSnapshot(store, {
      cards: [card('RB-1', 'done')],
      landings: landingsPayload([landingRow('RB-1')]),
      state: mockState(),
    });
    renderApp(store);
    expect(screen.getByTestId('landing-RB-1')).toHaveTextContent('builder · 30m ago');
    expect(screen.getByTestId('landed-panel')).toHaveTextContent('git log HEAD, last 14 days');
  });

  // CONTROL: in LandedPanel.tsx set `SHAS_SHOWN` to `Infinity` — eight links render and this fails.
  it('a card with many commits shows six shas and "+2 more"', () => {
    const store = testStore();
    const shas = [
      'a000001',
      'a000002',
      'a000003',
      'a000004',
      'a000005',
      'a000006',
      'a000007',
      'a000008',
    ];
    sendSnapshot(store, {
      cards: [card('RB-1', 'done')],
      landings: landingsPayload([landingRow('RB-1', shas)]),
      state: mockState(),
    });
    renderApp(store);
    const row = within(screen.getByTestId('landing-RB-1'));
    expect(row.getAllByRole('link')).toHaveLength(6);
    expect(row.getByText('+2 more')).toBeInTheDocument();
  });
});
