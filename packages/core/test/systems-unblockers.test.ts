/**
 * RCB-161 slice 2: `unblockerInfo` moved here from `packages/server/src/cli.ts` (unchanged) so
 * both the CLI (`repoboard systems show`) and the Flow view resolve one `unblocked_by` id the
 * SAME way. The four cases the brief names: an open decision, a next step, an unknown id (no
 * card), and neither (a plain card with no decision and no steps).
 */
import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '../src/board.js';
import { unblockerInfo } from '../src/systems-unblockers.js';
import type { BoardConfig, Card } from '../src/types.js';
import { sampleCard } from './helpers.js';

const config: BoardConfig = defaultBoardConfig();

describe('unblockerInfo (RCB-161 slice 2)', () => {
  it('an open decision: card + decision, nextStep null', () => {
    const cards: Card[] = [
      sampleCard({
        id: 'RB-1',
        title: 'Pick a path',
        status: 'decide',
        decision: {
          question: 'Which way?',
          options: [
            { letter: 'A', text: 'go left' },
            { letter: 'B', text: 'go right' },
          ],
          askedBy: 'owner',
          askedAt: '2026-09-22T00:00:00Z',
          returnTo: 'todo',
          chosen: null,
          words: null,
          decidedBy: null,
          decidedAt: null,
        },
      }),
    ];
    const info = unblockerInfo('RB-1', cards, config);
    expect(info).toEqual({
      id: 'RB-1',
      card: { title: 'Pick a path', status: 'decide' },
      decision: {
        question: 'Which way?',
        options: [
          { letter: 'A', text: 'go left' },
          { letter: 'B', text: 'go right' },
        ],
      },
      nextStep: null,
    });
  });

  it('a next step: no open decision, but a not-yet-done, not-blocked step — nextStep names it', () => {
    const cards: Card[] = [
      sampleCard({ id: 'RB-2', title: 'Ship the widget', status: 'backlog' }),
      sampleCard({
        id: 'RB-3',
        title: 'Do the first step',
        status: 'todo',
        parent: 'RB-2',
        phase: 'PH.1',
      }),
    ];
    const info = unblockerInfo('RB-2', cards, config);
    expect(info).toEqual({
      id: 'RB-2',
      card: { title: 'Ship the widget', status: 'backlog' },
      decision: null,
      nextStep: { id: 'RB-3', title: 'Do the first step' },
    });
  });

  it('unknown id: no card here, card is null, decision and nextStep are null', () => {
    const info = unblockerInfo('RB-99', [], config);
    expect(info).toEqual({ id: 'RB-99', card: null, decision: null, nextStep: null });
  });

  it('neither: a plain card with no decision and no steps — decision and nextStep both null', () => {
    const cards: Card[] = [sampleCard({ id: 'RB-4', title: 'Just a card', status: 'todo' })];
    const info = unblockerInfo('RB-4', cards, config);
    expect(info).toEqual({
      id: 'RB-4',
      card: { title: 'Just a card', status: 'todo' },
      decision: null,
      nextStep: null,
    });
  });
});
