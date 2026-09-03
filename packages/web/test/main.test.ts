import { describe, expect, it } from 'vitest';
import { avatarLabel, WEB_NAME } from '../src/main.js';

describe('@rcb/web stub', () => {
  it('links to @rcb/core through the workspace', () => {
    expect(WEB_NAME).toBe('@rcb/web');
    expect(avatarLabel('claude/web-agent')).toMatch(/^\S+ claude\/web-agent \(#[0-9a-f]{6}\)$/);
  });
});
