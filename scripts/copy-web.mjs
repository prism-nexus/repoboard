// P6.2: copy packages/web/dist into packages/server/dist/web so the published `repoboard`
// package is self-contained (http.ts serves dist/web first, BUILD-PLAN §6). Root `pnpm build`
// runs this after `pnpm -r build`. Plain node, no shell-isms, so it works on Windows.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'packages', 'web', 'dist');
const dest = join(root, 'packages', 'server', 'dist', 'web');

if (!existsSync(join(src, 'index.html'))) {
  console.error(`copy-web: ${join(src, 'index.html')} is missing; run the web build first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

function tally(dir) {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const sub = tally(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

const { files, bytes } = tally(dest);
console.log(`copy-web: ${files} files, ${bytes} bytes -> packages/server/dist/web`);
