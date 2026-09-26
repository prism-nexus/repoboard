/**
 * RCB-68: phases + gates on the board — `phaseInfoFor`/`lanesFor` (web/src/store.ts),
 * `CardItem`'s chips, `Board`'s swimlanes, and the Drawer's read-only Phase block.
 */
import { defaultBoardConfig, type GateMemberFacts } from '@repoboard/core';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { lanesFor, phaseInfoFor } from '../src/store.js';
import { card, renderApp, snapshot, testStore } from './helpers.jsx';

const config = defaultBoardConfig(); // backlog, decide, todo, doing, done{done:true}

describe('phaseInfoFor', () => {
  it('is null for a plain card (no phase, no gate, no children)', () => {
    const plain = card('RB-1', 'todo');
    expect(phaseInfoFor(plain, [plain], config, [])).toBeNull();
  });

  it('is null when config is absent, even for a card that otherwise has phase info', () => {
    const step = card('RB-2', 'todo', { phase: 'PH.1' });
    expect(phaseInfoFor(step, [step], null, [])).toBeNull();
  });

  it('carries phase/blocked for a step, and total/done/blockedOn for a phase card', () => {
    const parent = card('RB-1', 'todo');
    const gateCard = card('RB-9', 'todo');
    const step = card('RB-2', 'todo', { parent: 'RB-1', phase: 'PH.1', gate: 'RB-9' });
    const all = [parent, gateCard, step];
    expect(phaseInfoFor(step, all, config, [])).toEqual({
      phase: 'PH.1',
      blocked: 'blocked on RB-9 (todo)',
      rollup: null,
    });
    expect(phaseInfoFor(parent, all, config, [])).toEqual({
      phase: null,
      blocked: null,
      rollup: { total: 1, done: 0, blockedOn: 'blocked on RB-9 (todo)' },
    });
  });
});

describe('phaseInfoFor: workspace gate members (RCB-154)', () => {
  const wsConfig = { ...config, prefix: 'WS' };
  const mbConfig = { ...config, prefix: 'MB' };

  function members(memberCard: ReturnType<typeof card>): GateMemberFacts[] {
    return [{ key: 'mb', prefix: 'MB', cards: [memberCard], config: mbConfig }];
  }

  it('a done member card clears the gate', () => {
    // A phase keeps the PhaseInfo non-null, so `blocked: null` is asserted, not `?.` over null.
    const wsCard = card('WS-1', 'todo', { gate: 'MB-1', phase: 'PH.1' });
    const memberCard = card('MB-1', 'done');
    expect(phaseInfoFor(wsCard, [wsCard], wsConfig, members(memberCard))).toEqual({
      phase: 'PH.1',
      blocked: null,
      rollup: null,
    });
  });

  it('a todo member card blocks, naming it', () => {
    const wsCard = card('WS-1', 'todo', { gate: 'MB-1' });
    const memberCard = card('MB-1', 'todo');
    expect(phaseInfoFor(wsCard, [wsCard], wsConfig, members(memberCard))?.blocked).toBe(
      'blocked on MB-1 (todo)',
    );
  });

  it('no members at all — "no such card", never a silent clear', () => {
    const wsCard = card('WS-1', 'todo', { gate: 'MB-1' });
    expect(phaseInfoFor(wsCard, [wsCard], wsConfig, [])?.blocked).toBe(
      'blocked on MB-1 (no such card)',
    );
  });
});

describe('lanesFor', () => {
  it('one lane, parent: null, for a column with no parented card', () => {
    const cards = [card('RB-1', 'todo'), card('RB-2', 'todo')];
    const lanes = lanesFor(cards, cards);
    expect(lanes).toEqual([{ parent: null, cards }]);
  });

  it('lanes in parent-id order, each lane’s steps in phase order, restricted to the column', () => {
    const parent1 = card('RB-1', 'todo');
    const parent10 = card('RB-10', 'todo');
    const step1b = card('RB-3', 'todo', { parent: 'RB-1', phase: 'PH.10' });
    const step1a = card('RB-4', 'todo', { parent: 'RB-1', phase: 'PH.2' });
    const step10 = card('RB-5', 'todo', { parent: 'RB-10', phase: 'PH.1' });
    const plain = card('RB-6', 'todo');
    const columnCards = [parent1, parent10, step1b, step1a, step10, plain];
    const all = columnCards;
    const lanes = lanesFor(columnCards, all);
    // First lane: the un-parented cards, in the order given (columnsWithCards' own order).
    expect(lanes[0]).toEqual({ parent: null, cards: [parent1, parent10, plain] });
    // Then RB-1's lane before RB-10's (natural id order), each in NATURAL phase order (PH.2 < PH.10).
    expect(lanes[1]?.parent?.id).toBe('RB-1');
    expect(lanes[1]?.cards.map((c) => c.id)).toEqual(['RB-4', 'RB-3']);
    expect(lanes[2]?.parent?.id).toBe('RB-10');
    expect(lanes[2]?.cards.map((c) => c.id)).toEqual(['RB-5']);
  });

  it('an orphan lane (parent deleted) still returns its steps, with parent: null', () => {
    const step = card('RB-2', 'todo', { parent: 'RB-404', phase: 'PH.1' });
    const lanes = lanesFor([step], [step]);
    expect(lanes).toEqual([
      { parent: null, cards: [] },
      { parent: null, cards: [step] },
    ]);
  });
});

describe('CardItem chips (RCB-68)', () => {
  it('a step shows the phase chip and a blocked chip carrying the reason as its title', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo');
    const gateCard = card('RB-9', 'todo');
    const step = card('RB-2', 'todo', { parent: 'RB-1', phase: 'PH.3', gate: 'RB-9' });
    snapshot(store, [parent, gateCard, step]);
    renderApp(store);
    const cardEl = screen.getByTestId('card-RB-2');
    expect(within(cardEl).getByText('PH.3')).toHaveClass('chip--phase');
    const blocked = screen.getByTestId('blocked-RB-2');
    expect(blocked).toHaveTextContent('blocked');
    expect(blocked).toHaveAttribute('title', 'blocked on RB-9 (todo)');
  });

  it('a phase card shows "n/m done" and a "blocked on …" chip from its first blocked step', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo');
    const gateCard = card('RB-9', 'todo');
    const steps = [
      card('RB-2', 'done', { parent: 'RB-1', phase: 'PH.1' }),
      card('RB-3', 'todo', { parent: 'RB-1', phase: 'PH.2', gate: 'RB-9' }),
    ];
    snapshot(store, [parent, gateCard, ...steps]);
    renderApp(store);
    const cardEl = screen.getByTestId('card-RB-1');
    expect(within(cardEl).getByText('1/2 done')).toHaveClass('chip--rollup');
    expect(within(cardEl).getByText('blocked on RB-9 (todo)')).toHaveClass('chip--blocked');
  });

  it('a plain card (no phase, gate, or children) renders no phase chips at all', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    const cardEl = screen.getByTestId('card-RB-1');
    expect(cardEl.querySelector('.chip--phase')).toBeNull();
    expect(cardEl.querySelector('.chip--blocked')).toBeNull();
    expect(cardEl.querySelector('.chip--rollup')).toBeNull();
    expect(cardEl.querySelector('.card__meta')).toBeNull();
  });
});

describe('Board swimlanes', () => {
  it('a column with no parented card has zero .lane__head elements (byte-identical to today)', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo'), card('RB-2', 'doing')]);
    renderApp(store);
    expect(document.querySelectorAll('.lane__head')).toHaveLength(0);
  });

  it('renders a lane head naming the parent and its rollup, and opens the parent on click', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo', { title: 'Phase H' });
    const step = card('RB-2', 'todo', { parent: 'RB-1', phase: 'PH.1' });
    snapshot(store, [parent, step]);
    renderApp(store);
    const head = screen.getByTestId('lane-RB-1');
    expect(head).toHaveTextContent('RB-1');
    expect(head).toHaveTextContent('Phase H');
    expect(head).toHaveTextContent('0/1 done');
    fireEvent.click(within(head).getByText('RB-1'));
    // The parent's own drawer opened.
    const drawer = screen.getByTestId('drawer');
    expect(within(drawer).getByText('RB-1')).toBeInTheDocument();
  });
});

describe('Board swimlanes: phase chain on the lane head (RCB-108)', () => {
  it('renders the chain in phase order, with done/here classes for the other columns', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo', { title: 'Phase H' });
    const steps = [
      card('RB-2', 'done', { parent: 'RB-1', phase: 'PH.0' }),
      card('RB-3', 'doing', { parent: 'RB-1', phase: 'PH.1' }),
      card('RB-4', 'backlog', { parent: 'RB-1', phase: 'PH.2' }),
    ];
    snapshot(store, [parent, ...steps]);
    renderApp(store);
    // The lane for RB-1 in "Doing" (RB-3's own column): PH.0 is done, PH.1 is HERE, PH.2 is plain.
    const doing = screen.getByRole('region', { name: 'Doing' });
    const chain = within(doing).getByTestId('lane-chain-RB-1');
    const chips = chain.querySelectorAll('.lane__step');
    expect(Array.from(chips).map((c) => c.textContent)).toEqual(['PH.0', 'PH.1', 'PH.2']);
    expect(chips[0]).toHaveClass('lane__step--done');
    expect(chips[0]).toHaveAttribute('title', 'RB-2 · done');
    expect(chips[1]).toHaveClass('lane__step--here');
    expect(chips[1]).not.toHaveClass('lane__step--done');
    expect(chips[2]).not.toHaveClass('lane__step--done');
    expect(chips[2]).not.toHaveClass('lane__step--here');
    expect(chain.querySelectorAll('.lane__chain-arrow')).toHaveLength(2);
  });

  it('within a lane, DOM card order is phase order even when `updated` order is the reverse', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo');
    // step10 is the most recently updated (default sort is updated desc) but PH.2 < PH.10.
    const step10 = card('RB-2', 'doing', {
      parent: 'RB-1',
      phase: 'PH.10',
      updated: '2026-09-02T23:00:00Z',
    });
    const step2 = card('RB-3', 'doing', {
      parent: 'RB-1',
      phase: 'PH.2',
      updated: '2026-09-02T20:00:00Z',
    });
    snapshot(store, [parent, step10, step2]);
    renderApp(store);
    const doing = screen.getByRole('region', { name: 'Doing' });
    const cardEls = within(doing).getAllByTestId(/^card-/);
    expect(cardEls.map((el) => el.getAttribute('data-testid'))).toEqual(['card-RB-3', 'card-RB-2']);
  });
});

describe('Column WIP count: parents excluded (RCB-108)', () => {
  it('column__count reads the WIP-adjusted count, with a note naming how many parents were excluded', () => {
    const store = testStore();
    const parent = card('RB-1', 'doing'); // a plan parent: RB-2 below names it
    const step = card('RB-2', 'todo', { parent: 'RB-1', phase: 'PH.1' });
    const plains = [card('RB-3', 'doing'), card('RB-4', 'doing'), card('RB-5', 'doing')];
    snapshot(store, [parent, step, ...plains]);
    renderApp(store);
    const doing = screen.getByRole('region', { name: 'Doing' });
    // 4 raw cards in "doing" (RB-1, RB-3, RB-4, RB-5), but RB-1 is a plan parent: 3 / 3, no breach.
    const count = within(doing).getByText('3 / 3');
    expect(count).not.toHaveClass('column__count--breach');
    const note = within(doing).getByText('parents not counted');
    expect(note).toHaveAttribute('title', '1 parent not counted');
  });
});

describe('Drawer: Phase block (RCB-68)', () => {
  it('on a step: parent (opens it), phase chip, and the gate state line', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo', { title: 'Phase H' });
    const gateCard = card('RB-9', 'done');
    const step = card('RB-2', 'todo', { parent: 'RB-1', phase: 'PH.1', gate: 'RB-9' });
    snapshot(store, [parent, gateCard, step]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-2'));
    const section = screen.getByTestId('phase-section');
    expect(within(section).getByText('PH.1')).toHaveClass('chip--phase');
    expect(screen.getByTestId('phase-gate-state')).toHaveTextContent('clear — RB-9 (done)');
    fireEvent.click(screen.getByTestId('phase-parent-open'));
    expect(within(screen.getByTestId('drawer')).getByText(/RB-1/)).toBeInTheDocument();
  });

  it('on a phase card: the steps list, one row per step with id/phase/status/blocked', () => {
    const store = testStore();
    const parent = card('RB-1', 'todo');
    const gateCard = card('RB-9', 'todo');
    const steps = [
      card('RB-2', 'done', { parent: 'RB-1', phase: 'PH.1' }),
      card('RB-3', 'todo', { parent: 'RB-1', phase: 'PH.2', gate: 'RB-9' }),
    ];
    snapshot(store, [parent, gateCard, ...steps]);
    renderApp(store);
    // RB-1 is ALSO a lane head in this same column (its own step RB-3 sits in "todo" too), so
    // scope the click to the card item's own open button, not the lane head's.
    fireEvent.click(within(screen.getByTestId('card-RB-1')).getByTitle('Open RB-1'));
    const section = screen.getByTestId('phase-section');
    const row2 = within(section).getByTestId('phase-step-RB-2');
    expect(row2).toHaveTextContent('RB-2');
    expect(row2).toHaveTextContent('PH.1');
    expect(row2).toHaveTextContent('done');
    expect(within(row2).queryByTestId('phase-step-blocked-RB-2')).toBeNull();
    const row3 = within(section).getByTestId('phase-step-RB-3');
    expect(within(row3).getByTestId('phase-step-blocked-RB-3')).toBeInTheDocument();
  });

  it('absent on a plain card — no Phase section at all', () => {
    const store = testStore();
    snapshot(store, [card('RB-1', 'todo')]);
    renderApp(store);
    fireEvent.click(screen.getByTitle('Open RB-1'));
    expect(screen.queryByTestId('phase-section')).toBeNull();
  });
});

describe('Board: workspace gate members reach the board (RCB-154)', () => {
  it('a snapshot carrying gateMembers clears the chip; a later gateMembers message re-blocks it', () => {
    const store = testStore();
    const wsConfig = { ...defaultBoardConfig(), prefix: 'WS' };
    const mbConfig = { ...defaultBoardConfig(), prefix: 'MB' };
    const wsCard = card('WS-1', 'todo', { gate: 'MB-1' });

    store.dispatch({
      type: 'snapshot',
      board: { config: wsConfig, cards: [wsCard] },
      repo: null,
      gateMembers: [{ key: 'mb', prefix: 'MB', cards: [card('MB-1', 'done')], config: mbConfig }],
    });
    renderApp(store);
    expect(screen.queryByTestId('blocked-WS-1')).toBeNull();

    act(() =>
      store.dispatch({
        type: 'gateMembers',
        members: [{ key: 'mb', prefix: 'MB', cards: [card('MB-1', 'todo')], config: mbConfig }],
      }),
    );
    const blocked = screen.getByTestId('blocked-WS-1');
    expect(blocked).toHaveAttribute('title', 'blocked on MB-1 (todo)');
  });
});
