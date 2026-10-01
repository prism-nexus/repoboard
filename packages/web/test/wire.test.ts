/**
 * RCB-150: `isServerMessage` — the one runtime guard on the wire contract, in isolation.
 * `connectWs` (ws.ts) trusts this to keep a malformed frame from ever reaching a handler.
 */
import { describe, expect, it } from 'vitest';
import { isServerMessage } from '../src/wire.js';

describe('isServerMessage', () => {
  it('true for an object with a string `type`', () => {
    expect(isServerMessage({ type: 'snapshot' })).toBe(true);
  });

  it('false for null', () => {
    expect(isServerMessage(null)).toBe(false);
  });

  it('false for a string', () => {
    expect(isServerMessage('snapshot')).toBe(false);
  });

  it('false for {} — no `type` at all', () => {
    expect(isServerMessage({})).toBe(false);
  });

  it('false when `type` is not a string', () => {
    expect(isServerMessage({ type: 1 })).toBe(false);
  });
});
