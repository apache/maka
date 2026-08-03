#!/usr/bin/env node
// Applies patches/ during the root postinstall.
//
// patch-package is a root devDependency, so `npm ci --workspace <name>` and
// `npm ci --omit=dev` install a tree without it while still running the root
// postinstall. Failing there would break install modes that work on main, so a
// missing patch-package is reported and skipped; a patch that exists but no
// longer applies still fails the install via --error-on-fail.
//
// Skipping is safe because those trees are not what ships: every release and CI
// lane runs a plain root `npm ci`, and an unpatched tree turns
// packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts red.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchesDirectory = join(repoRoot, 'patches');

if (
  !existsSync(patchesDirectory) ||
  !readdirSync(patchesDirectory).some((entry) => entry.endsWith('.patch'))
) {
  process.exit(0);
}

let patchPackageEntry;
try {
  patchPackageEntry = createRequire(import.meta.url).resolve('patch-package/index.js');
} catch {
  console.warn(
    'patch-package is not installed; skipping patches/. Run a plain `npm ci` from the repo root before building or packaging.',
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, [patchPackageEntry, '--error-on-fail'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
