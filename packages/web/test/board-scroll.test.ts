/**
 * RCB-84: the board scrolls as one area, not per column. Before, `.board` was
 * `overflow-y: hidden` and every `.column__cards` was `overflow-y: auto`, so each column carried
 * its own viewport-tall scroll box. This is the control: with the old CSS the first `it` fails
 * (`.board` was `hidden`, not `auto`) and the second fails (`.column__cards` still had
 * `overflow-y: auto`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Not `fileURLToPath(new URL(…, import.meta.url))`: under the jsdom environment that throws
// "The URL must be of scheme file". vitest shims `__dirname` for ESM test modules.
const STYLES_PATH = join(__dirname, '..', 'src', 'styles.css');

describe('board scroll (RCB-84)', () => {
  it('the .board rule scrolls vertically as one area', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/^\.board \{[^}]*\}/m);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain('overflow-y: auto');
  });

  it('the .column__cards rule no longer scrolls on its own', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const rule = css.match(/^\.column__cards \{[^}]*\}/m);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).not.toContain('overflow-y');
  });
});
