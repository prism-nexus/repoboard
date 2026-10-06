/**
 * RCB-210: `index.html` carries an inline-SVG favicon, so the browser does not request
 * `/favicon.ico` (the server answered it 404).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest shims `__dirname` for ESM test modules (see board-scroll.test.ts).
const INDEX_PATH = join(__dirname, '..', 'index.html');
const PREFIX = 'data:image/svg+xml,';

describe('index.html: favicon', () => {
  it('RCB-210: exactly one rel="icon" link, an encoded data:image/svg+xml SVG with an xmlns', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)];
    // CONTROL: delete the <link rel="icon"> from index.html -> length is 0, this fails.
    expect(links).toHaveLength(1);

    const href = /\bhref="([^"]*)"/.exec(links[0]?.[0] ?? '')?.[1] ?? '';
    expect(href.startsWith(PREFIX)).toBe(true);

    const payload = href.slice(PREFIX.length);
    // CONTROL: write a raw `#` (instead of `%23`) in the SVG colours -> a browser reads it as
    // the URL fragment and cuts the SVG; this fails. The same goes for a raw `<` or `>`.
    expect(payload).not.toMatch(/[#<>]/);

    const svg = decodeURIComponent(payload);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.localName).toBe('svg');
    expect(doc.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    // Colours survive the round trip: the decoded SVG has real `#` hex colours.
    expect(svg).toMatch(/fill='#[0-9a-f]{3,6}'/i);
  });
});
