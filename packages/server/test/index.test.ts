import { describe, expect, it } from 'vitest';
import { defaultPrefix, SERVER_NAME } from '../src/index.js';

describe('@rcb/server stub', () => {
  it('links to @rcb/core through the workspace', () => {
    expect(SERVER_NAME).toBe('@rcb/server');
    expect(defaultPrefix()).toBe('RCB');
  });
});
