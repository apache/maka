#!/usr/bin/env node
/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Applies patches/ from the repository root, for the two callers that need it.
//
// Root `postinstall` (default): patch-package is a root devDependency, so
// `npm ci --workspace <name>` and `npm ci --omit=dev` install a tree without it
// while still running the root postinstall. Failing there would break install
// modes that work on main, so a missing patch-package is reported and skipped;
// a patch that exists but no longer applies still fails the install via
// --error-on-fail. Skipping is safe because those trees are not what ships:
// every release and CI lane runs a plain root `npm ci`, and an unpatched tree
// turns packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts red.
//
// `--strict` (packages/runtime `prebuild`): a build must not compile against
// unpatched dependency source, because the resulting failure looks like a
// product regression rather than a stale install. A missing patch-package or a
// patch that no longer applies stops before tsc and names a fresh root `npm ci`
// as the recovery; it cannot promise that recovery for every cause.
//
// Applying an already-applied patch is a no-op, so both callers are idempotent.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECOVERY =
  'Run `npm ci` from the repository root to restore a clean, fully patched dependency tree, then rerun.';

let strict = false;
for (const argument of process.argv.slice(2)) {
  if (argument === '--strict') {
    strict = true;
    continue;
  }
  // A mistyped flag must not silently fall back to the postinstall behavior
  // that skips patches, which is the state --strict exists to catch.
  console.error(`Unknown argument: ${argument}`);
  process.exit(2);
}

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
  const missing = 'patch-package is not installed, so patches/ cannot be applied.';
  if (strict) {
    console.error(`${missing} ${RECOVERY}`);
    process.exit(1);
  }
  console.warn(`${missing} Skipping patches/. ${RECOVERY}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [patchPackageEntry, '--error-on-fail'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not run patch-package: ${result.error.message} ${RECOVERY}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `patches/ did not apply cleanly; the installed dependencies are stale or only partially patched. ${RECOVERY}`,
  );
  process.exit(result.status ?? 1);
}
