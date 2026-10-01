// RCB-121: npm only takes README/LICENSE from the package directory, but they live at the repo
// root (one README, one LICENSE for the whole monorepo). `prepack` (npm pack / npm publish) runs
// this to copy them into packages/server before packing; the copies are gitignored (never
// committed) and are safe to leave in place between packs. Plain node, no shell-isms.
//
// The README copy also gets its relative markdown link/image targets rewritten to absolute
// GitHub URLs: `repository.directory: packages/server` in package.json means npm may resolve a
// relative target (e.g. `docs/board.png`) under packages/server/ on the npm page, where it does
// not exist — a broken image. The ROOT README.md is never touched; only the copy is rewritten.
//
// RCB-135: the root README also carries wording that is only true in-repo ("not on npm yet") and
// prose pointers to docs the npm package does not ship (it ships only dist/, README, LICENSE).
// `<!-- npm:omit -->...<!-- /npm:omit -->` regions mark text that must not reach the npm page;
// they are stripped from the copy before the link rewrite. The root file keeps the full text —
// the markers are the only thing prepack ever removes from it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/**
 * Strip every `<!-- npm:omit -->...<!-- /npm:omit -->` region (markers inclusive) from `text`.
 * Markers may sit inline mid-paragraph, and a region may span multiple lines. Throws (with a
 * one-line message naming the problem) if the markers are unbalanced or nested — the caller must
 * not write anything in that case.
 *
 * Removing a region can leave two spaces adjacent at the splice seam (one that was before the
 * opening marker, one that was after the closing marker) with nothing now between them; that run
 * is collapsed to a single space. Nothing else in the document is touched — in particular this
 * never reaches into list-continuation indentation or code-block alignment, since those spaces
 * never sit at a splice seam.
 */
function stripOmitRegions(text) {
  const markerRe = /<!--\s*(\/?)npm:omit\s*-->/g;
  const ranges = [];
  let openAt = -1;
  for (const match of text.matchAll(markerRe)) {
    const isClose = match[1] === '/';
    if (!isClose) {
      if (openAt !== -1) {
        throw new Error(`nested <!-- npm:omit --> marker at offset ${match.index}`);
      }
      openAt = match.index;
    } else {
      if (openAt === -1) {
        throw new Error(`unmatched <!-- /npm:omit --> marker at offset ${match.index}`);
      }
      ranges.push([openAt, match.index + match[0].length]);
      openAt = -1;
    }
  }
  if (openAt !== -1) {
    throw new Error(`unclosed <!-- npm:omit --> marker at offset ${openAt}`);
  }

  const segments = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    segments.push(text.slice(cursor, start));
    cursor = end;
  }
  segments.push(text.slice(cursor));

  let out = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    const next = segments[i];
    const prevSpaces = out.match(/ +$/)?.[0] ?? '';
    const nextSpaces = next.match(/^ +/)?.[0] ?? '';
    if (prevSpaces.length + nextSpaces.length >= 2) {
      out = `${out.slice(0, out.length - prevSpaces.length)} ${next.slice(nextSpaces.length)}`;
    } else {
      out += next;
    }
  }

  return { text: out, count: ranges.length };
}

/** `--out <dir>` writes the copies somewhere other than packages/server; `--src <file>` reads the
 * README from somewhere other than the repo root README.md (used by tests, to exercise a broken
 * fixture without ever touching the real README). Both optional; default behaviour unchanged. */
function parseArgs(argv) {
  const args = { out: null, src: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--src') {
      args.src = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/** A path for the log line: relative to the repo root when inside it, absolute otherwise. */
function displayPath(p) {
  const rel = relative(root, p);
  return rel.startsWith('..') ? p : rel;
}

const args = parseArgs(process.argv.slice(2));
const destDir = args.out ? resolve(args.out) : serverDir;
const readmeSrc = args.src ? resolve(args.src) : join(root, 'README.md');
const licenseSrc = join(root, 'LICENSE');

const originalReadme = readFileSync(readmeSrc, 'utf8');

let stripped;
try {
  stripped = stripOmitRegions(originalReadme);
} catch (err) {
  console.error(`prepack-server: ${err.message}`);
  process.exit(1);
}

const { rewritten, count: linkCount } = rewriteRelativeLinks(stripped.text);

mkdirSync(destDir, { recursive: true });
writeFileSync(join(destDir, 'README.md'), rewritten);
console.log(
  `prepack-server: README.md -> ${displayPath(join(destDir, 'README.md'))} ` +
    `(${stripped.count} npm:omit region(s) stripped, ${linkCount} relative link(s) rewritten)`,
);

copyFileSync(licenseSrc, join(destDir, 'LICENSE'));
console.log(`prepack-server: LICENSE -> ${displayPath(join(destDir, 'LICENSE'))}`);
