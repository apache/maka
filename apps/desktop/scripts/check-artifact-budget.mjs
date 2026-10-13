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

// electron-builder ships the production dependency closure of `package.json`
// whether or not anything loads it. That is how #3146 happened: `@maka/ui`
// was a production dependency, so `mermaid`, `lucide-react` and
// `@astryxdesign/*` shipped whole -- about 183 MB of renderer sources that
// vite had already bundled into `dist-renderer`. Each author saw only their
// own slice and nothing reported the step change.
//
// This check makes the closure a reviewed list. `artifact-budget.json` records
// exactly which package instances ship; adding a production dependency changes
// that file, so the cost lands in the diff of the pull request that causes it.
//
// It tracks the set of package instances rather than bytes on purpose. The
// bytes that reach `app.asar` are what survives the `files` globs -- on this
// checkout the closure is 241 MiB on disk and 142 MiB in the archive -- and
// reproducing those globs here would be the same hand-written exclude list
// that `electron-builder.config.mjs` already records as unable to hold.
//
// The closure is read from `scripts/third-party-closure.mjs`, the definition
// the security audit and the packaged-app verifier already use, so this
// pull-request gate and those release checks cannot measure different sets.
//
// The ledger is the Linux x64 install, because that is where CI runs it.
// npm installs OS-gated optional dependencies only on their own platform, so a
// ledger refreshed on macOS or Windows would differ from what CI sees, and a
// package that ships only on those platforms never reaches this ledger at all.
// Refresh it on Linux.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectProductionInstances } from '../../../scripts/third-party-closure.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const LEDGER_PATH = join(DESKTOP_ROOT, 'artifact-budget.json');
const WORKSPACE = '@maka/desktop';

export function readLedger(path = LEDGER_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function compare(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    added: actual.filter((name) => !expectedSet.has(name)),
    removed: expected.filter((name) => !actualSet.has(name)),
  };
}

export function formatFailure({ added, removed }) {
  const lines = ['The packaged production dependency closure changed.', ''];
  if (added.length) {
    lines.push(`  ships now, did not before (${added.length}):`);
    for (const name of added) lines.push(`    + ${name}`);
  }
  if (removed.length) {
    lines.push(`  shipped before, does not now (${removed.length}):`);
    for (const name of removed) lines.push(`    - ${name}`);
  }
  lines.push(
    '',
    'Every package here is copied into app.asar whether or not anything loads it.',
    'If the change is intended, refresh the ledger so the cost is reviewable',
    '(on Linux, which is the install CI checks):',
    '',
    '  npm --workspace @maka/desktop run check:artifact-budget -- --write',
    '',
    'If it is not, a renderer-only package probably reached `dependencies`;',
    'those belong in `devDependencies`, where vite bundles them instead.',
  );
  return lines.join('\n');
}

export function main({
  argv = process.argv,
  ledgerPath = LEDGER_PATH,
  collect = () => collectProductionInstances(WORKSPACE),
} = {}) {
  const actual = collect();

  if (argv.includes('--write')) {
    writeFileSync(ledgerPath, `${JSON.stringify({ packages: actual }, null, 2)}\n`);
    console.log(`Wrote ${actual.length} package instances to artifact-budget.json`);
    return;
  }

  const difference = compare(readLedger(ledgerPath).packages, actual);
  if (difference.added.length || difference.removed.length) {
    console.error(formatFailure(difference));
    process.exitCode = 1;
    return;
  }
  console.log(`Artifact budget OK — ${actual.length} package instances ship in app.asar.`);
}

if (process.argv[1] === SCRIPT_PATH) main();
