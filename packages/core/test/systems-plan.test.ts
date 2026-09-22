import { describe, expect, it } from 'vitest';
import { planSystemsMap, type SystemsPlanCounts } from '../src/index.js';

function plan(counts: SystemsPlanCounts, repoName = 'freshpickedjobs') {
  return planSystemsMap({ repoName, counts });
}

describe('planSystemsMap (RCB-111)', () => {
  it('parent: title names the repo, labels/size, body carries the dry-run numbers', () => {
    const { parent } = plan({ systems: 14, connections: 13, unclassified: 7 });
    expect(parent.title).toBe('Systems map for freshpickedjobs');
    expect(parent.labels).toEqual(['systems']);
    expect(parent.size).toBe('M');
    expect(parent.body).toContain('14 systems / 13 connections / 7 unclassified');
    expect(parent.parent).toBeUndefined();
  });

  it('PH.1: title, phase, labels/size, no gate, no parent, body carries the same numbers and the detect command', () => {
    const { steps } = plan({ systems: 14, connections: 13, unclassified: 7 });
    const ph1 = steps[0];
    expect(ph1.title).toBe('Run repoboard systems detect and review the candidates');
    expect(ph1.labels).toEqual(['systems']);
    expect(ph1.size).toBe('S');
    expect(ph1.phase).toBe('PH.1');
    expect(ph1.gate).toBeUndefined();
    expect(ph1.parent).toBeUndefined();
    expect(ph1.body).toContain('14 systems / 13 connections / 7 unclassified');
    expect(ph1.body).toContain('`repoboard systems detect`');
  });

  it('PH.2: title, phase, gate, labels/size, no parent', () => {
    const { steps } = plan({ systems: 14, connections: 13, unclassified: 7 });
    const ph2 = steps[1];
    expect(ph2.title).toBe('Hand-correct the candidates and --apply');
    expect(ph2.labels).toEqual(['systems']);
    expect(ph2.size).toBe('S');
    expect(ph2.phase).toBe('PH.2');
    expect(ph2.gate).toBe('PH.1 reviewed');
    expect(ph2.parent).toBeUndefined();
    expect(ph2.body).toContain('source:');
  });

  it('PH.3: title, phase, gate, labels/size, no parent', () => {
    const { steps } = plan({ systems: 14, connections: 13, unclassified: 7 });
    const ph3 = steps[2];
    expect(ph3.title).toBe('Connections and the Flow view check');
    expect(ph3.labels).toEqual(['systems']);
    expect(ph3.size).toBe('S');
    expect(ph3.phase).toBe('PH.3');
    expect(ph3.gate).toBe('PH.2 applied');
    expect(ph3.parent).toBeUndefined();
    expect(ph3.body).toContain('connections:');
    expect(ph3.body).toContain('via');
  });

  it('zero counts print as literal zeros, not omitted or hidden (a hard-coded control fails this)', () => {
    const { parent, steps } = plan({ systems: 0, connections: 0, unclassified: 0 });
    expect(parent.body).toContain('0 systems / 0 connections / 0 unclassified');
    expect(steps[0].body).toContain('0 systems / 0 connections / 0 unclassified');
  });

  it('the numbers are not hard-coded: a different repo/counts input changes titles and bodies to match', () => {
    const { parent, steps } = plan({ systems: 3, connections: 1, unclassified: 9 }, 'otherrepo');
    expect(parent.title).toBe('Systems map for otherrepo');
    expect(parent.body).toContain('3 systems / 1 connections / 9 unclassified');
    expect(steps[0].body).toContain('3 systems / 1 connections / 9 unclassified');
    expect(parent.body).not.toContain('14 systems');
  });
});
