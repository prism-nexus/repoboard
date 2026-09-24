// RCB-145: stamp each built package's dist/.src-digest with a content digest of its src/, so
// dist-stale.ts can tell "same bytes, newer mtime" (e.g. a git checkout) from a real rebuild need.
// Root `pnpm build` runs this last, after `pnpm -r build` has produced
// packages/server/dist/dist-stale.js. Plain node, no shell-isms, so it works on Windows.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampDist } from '../packages/server/dist/dist-stale.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stamped = await stampDist(root);
console.log(`stamp-dist: ${stamped.join(', ')}`);
