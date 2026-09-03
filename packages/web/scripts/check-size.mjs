// Bundle control (P3.5): fail if the gzipped JS in dist/assets exceeds the limit.
// Limit in KB from RCB_SIZE_LIMIT_KB (default 600). Run after `vite build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = Number(process.env.RCB_SIZE_LIMIT_KB ?? 600);
const dir = join(process.cwd(), 'dist', 'assets');

function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(dir);
} catch {
  console.error(`check-size: ${dir} not found — run \`vite build\` first`);
  process.exit(2);
}

let jsTotal = 0;
let cssTotal = 0;
for (const f of files.sort()) {
  const gz = gzipSync(readFileSync(f)).length;
  const kb = (gz / 1024).toFixed(1);
  if (f.endsWith('.js')) {
    jsTotal += gz;
    console.log(`  js  ${kb.padStart(7)} KB  ${f.slice(dir.length + 1)}`);
  } else if (f.endsWith('.css')) {
    cssTotal += gz;
    console.log(`  css ${kb.padStart(7)} KB  ${f.slice(dir.length + 1)}`);
  }
}
const jsKb = jsTotal / 1024;
console.log(
  `check-size: gzipped JS ${jsKb.toFixed(1)} KB (limit ${LIMIT_KB} KB), CSS ${(cssTotal / 1024).toFixed(1)} KB`,
);
if (jsKb > LIMIT_KB) {
  console.error(`check-size: FAIL — ${jsKb.toFixed(1)} KB > ${LIMIT_KB} KB`);
  process.exit(1);
}
console.log('check-size: OK');
