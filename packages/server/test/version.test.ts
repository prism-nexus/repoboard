import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('equals packages/server/package.json version (the two are kept in sync by hand)', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
