#!/usr/bin/env node
/**
 * PR-BUILD-HYGIENE-0: detect a stale `dist/` (source newer than its
 * compiled output) and exit non-zero so CI / pre-test hooks can
 * force a rebuild.
 *
 * Rule per workspace pkg `<W>`:
 *   - If `<W>/dist` is missing, treat as stale.
 *   - If any `*.ts(x)` file under `<W>/src` has mtime newer than the
 *     newest file under `<W>/dist`, treat as stale.
 *
 * `apps/desktop` has two outputs (`dist` for main + preload,
 * `dist-renderer` for the renderer bundle). Source paths split by
 * `src/main` / `src/preload` vs `src/renderer`, so this script
 * walks them independently to avoid false positives where a
 * renderer edit invalidates the main dist or vice versa.
 *
 * Pure file mtime comparison — no TypeScript program is started,
 * keeps the gate cheap enough to run before every `npm test`.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const pairs = [
  { pkg: '@maka/core', src: 'packages/core/src', dist: 'packages/core/dist' },
  { pkg: '@maka/storage', src: 'packages/storage/src', dist: 'packages/storage/dist' },
  { pkg: '@maka/runtime', src: 'packages/runtime/src', dist: 'packages/runtime/dist' },
  {
    pkg: '@maka/runtime-host',
    src: 'packages/runtime-host/src',
    dist: 'packages/runtime-host/dist',
  },
  { pkg: '@maka/ui', src: 'packages/ui/src', dist: 'packages/ui/dist' },
  { pkg: '@maka/desktop:main', src: 'apps/desktop/src/main', dist: 'apps/desktop/dist/main' },
  {
    pkg: '@maka/desktop:preload',
    src: 'apps/desktop/src/preload',
    dist: 'apps/desktop/dist/preload',
  },
  {
    pkg: '@maka/desktop:renderer',
    src: 'apps/desktop/src/renderer',
    dist: 'apps/desktop/dist-renderer',
  },
];

function walkMaxMtime(dir, predicate) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (!predicate(entry.name)) continue;
      const m = statSync(full).mtimeMs;
      if (m > max) max = m;
    }
  }
  return max;
}

const stale = [];
for (const pair of pairs) {
  const srcDir = join(repoRoot, pair.src);
  const distDir = join(repoRoot, pair.dist);

  if (!existsSync(srcDir)) continue; // workspace not present
  if (!existsSync(distDir)) {
    stale.push({ pkg: pair.pkg, reason: 'dist missing' });
    continue;
  }
  const srcMax = walkMaxMtime(srcDir, (n) => n.endsWith('.ts') || n.endsWith('.tsx'));
  const distMax = walkMaxMtime(
    distDir,
    (n) => n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs') || n === 'index.html',
  );
  if (srcMax > distMax) {
    stale.push({
      pkg: pair.pkg,
      reason: `src newer than dist (Δ=${Math.round((srcMax - distMax) / 1000)}s)`,
    });
  }
}

if (stale.length === 0) {
  console.log('dist is fresh.');
  process.exit(0);
}

console.error('STALE DIST DETECTED:');
for (const s of stale) console.error(`  - ${s.pkg}: ${s.reason}`);
console.error('\nRun `npm run rebuild` and retry.');
process.exit(2);
