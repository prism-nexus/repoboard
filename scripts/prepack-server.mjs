// RCB-121: npm only takes README/LICENSE from the package directory, but they live at the repo
// root (one README, one LICENSE for the whole monorepo). `prepack` (npm pack / npm publish) runs
// this to copy them into packages/server before packing; the copies are gitignored (never
// committed) and are safe to leave in place between packs. Plain node, no shell-isms.
//
// The README copy also gets its relative markdown link/image targets rewritten to absolute
// GitHub URLs: `repository.directory: packages/server` in package.json means npm may resolve a
// relative target (e.g. `docs/board.png`) under packages/server/ on the npm page, where it does
// not exist — a broken image. The ROOT README.md is never touched; only the copy is rewritten.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'packages', 'server');

const REPO_BLOB_BASE = 'https://github.com/prism-nexus/repoboard/blob/main/';
const REPO_RAW_BASE = 'https://raw.githubusercontent.com/prism-nexus/repoboard/main/';

/** True when `target` is a relative markdown link/image target (not absolute, not in-page). */
function isRelative(target) {
  return !/^https?:\/\//i.test(target) && !target.startsWith('#') && !/^mailto:/i.test(target);
}

/**
 * Rewrite every relative markdown link/image target in `text` to an absolute GitHub URL.
 * Images (`![alt](target)`) point at raw.githubusercontent.com so they render; other links
 * (`[text](target)`) point at the blob viewer. Returns the rewritten text and the count changed.
 */
function rewriteRelativeLinks(text) {
  let count = 0;
  const rewritten = text.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (whole, bang, label, rawTarget) => {
      const titleMatch = rawTarget.match(/^(\S+)(\s+(?:"[^"]*"|'[^']*'))?$/);
      if (!titleMatch) return whole;
      const [, target, title = ''] = titleMatch;
      if (!isRelative(target)) return whole;
      const cleanPath = target.replace(/^\.\//, '');
      const base = bang === '!' ? REPO_RAW_BASE : REPO_BLOB_BASE;
      count += 1;
      return `${bang}[${label}](${base}${cleanPath}${title})`;
    },
  );
  return { rewritten, count };
}

for (const name of ['README.md', 'LICENSE']) {
  const src = join(root, name);
  const dest = join(serverDir, name);
  if (name === 'README.md') {
    const original = readFileSync(src, 'utf8');
    const { rewritten, count } = rewriteRelativeLinks(original);
    writeFileSync(dest, rewritten);
    console.log(
      `prepack-server: ${name} -> packages/server/${name} (${count} relative link(s) rewritten)`,
    );
  } else {
    copyFileSync(src, dest);
    console.log(`prepack-server: ${name} -> packages/server/${name}`);
  }
}
