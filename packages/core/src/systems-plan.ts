/**
 * RCB-111 (plan §"Flow view, no systems.yml"): pure card shapes for the Flow view's
 * "Plan the systems map" button — a repo with no `.repoboard/systems.yml` gets one parent card
 * plus three PH.1..PH.3 steps that walk detect → hand-correct → connect. No I/O, no dates: the
 * server stamps `created`/`updated`/ids when it calls `store.create` for each of these.
 */
import type { CreateCardInput } from './transitions.js';

export interface SystemsPlanCounts {
  systems: number;
  connections: number;
  unclassified: number;
}

export interface SystemsPlanInput {
  repoName: string;
  counts: SystemsPlanCounts;
}

export interface SystemsPlan {
  parent: CreateCardInput;
  steps: [CreateCardInput, CreateCardInput, CreateCardInput];
}

/** `n systems / m connections / k unclassified` — the numbers as given; `0` prints as `0`,
 * never omitted (CLAUDE.md: claims carry numbers). */
function countsLine(counts: SystemsPlanCounts): string {
  return `${counts.systems} systems / ${counts.connections} connections / ${counts.unclassified} unclassified`;
}

export function planSystemsMap(input: SystemsPlanInput): SystemsPlan {
  const { repoName, counts } = input;
  const line = countsLine(counts);

  const parent: CreateCardInput = {
    title: `Systems map for ${repoName}`,
    labels: ['systems'],
    size: 'M',
    body:
      '`.repoboard/systems.yml` is the per-system map the Flow view draws — the systems, their ' +
      'connections, and what is still unclassified.\n\n' +
      `A dry run against this repo found ${line}.`,
  };

  const step1: CreateCardInput = {
    title: 'Run repoboard systems detect and review the candidates',
    labels: ['systems'],
    size: 'S',
    phase: 'PH.1',
    body:
      `A dry run against this repo found ${line}.\n\n` +
      'Run `repoboard systems detect` on this repo (dry run — nothing written; `--root <path>` from another checkout) and ' +
      'review the candidates it proposes.',
  };

  const step2: CreateCardInput = {
    title: 'Hand-correct the candidates and --apply',
    labels: ['systems'],
    size: 'S',
    phase: 'PH.2',
    gate: 'PH.1 reviewed',
    body:
      'Hand rows win over detected ones; every row keeps its `source:` provenance ' +
      '(`hand:` or `detected:`). Once the candidates read true, run detect again with `--apply`.',
  };

  const step3: CreateCardInput = {
    title: 'Connections and the Flow view check',
    labels: ['systems'],
    size: 'S',
    phase: 'PH.3',
    gate: 'PH.2 applied',
    body:
      'Add `connections:` between systems, each with a `via`, then open the Flow view and check ' +
      'that the diagram reads the way the systems actually talk to each other.',
  };

  return { parent, steps: [step1, step2, step3] };
}
