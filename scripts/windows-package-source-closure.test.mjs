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

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  collectWindowsPackageSourceClosure,
  collectWorkspaceSourceClosure,
  readPullRequestPathPatterns,
  readWindowsReleasePathPatterns,
  windowsReleasePatternCoversSource,
} from './windows-package-source-closure.mjs';

/**
 * The `packages/` half of this lane's filter that the import closure does not
 * account for. Each entry schedules a 25-minute Windows runner on its own, so
 * it has to earn that here rather than sit indistinguishable among the twenty
 * derived entries — which is the only way a rotted one is ever noticed.
 */
const UNDERIVED_PACKAGE_PATTERNS = new Map([
  // Regenerated and diffed by `check:release`, and consumed by the packaging
  // step rather than imported by the worker.
  ['packages/cli/RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv', 'peer dependency manifest'],
  ['packages/cli/RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt', 'peer dependency manifest'],
  // Candidate election runs in the packaged app, not in the worker closure, and
  // has broken this path before.
  ['packages/runtime-host/src/client/connect-or-spawn.ts', 'Runtime Host candidate election'],
  ['packages/runtime-host/src/client/launcher.ts', 'Runtime Host candidate election'],
  // Builds the worker the closure starts from, so it precedes rather than joins
  // it.
  ['packages/runtime/scripts/build-filesystem-worker.mjs', 'builds the worker itself'],
]);

test('the Windows package trigger is exactly its closure plus declared exceptions', async () => {
  const closure = await collectWindowsPackageSourceClosure();
  const patterns = readWindowsReleasePathPatterns();
  const missing = closure.filter(
    (sourcePath) =>
      !patterns.some((pattern) => windowsReleasePatternCoversSource(sourcePath, pattern)),
  );

  for (const expected of [
    'packages/core/src/absolute-path.ts',
    'packages/core/src/sandbox-boundary.ts',
    'packages/core/src/serialized-byte-length.ts',
    'packages/core/src/windows-path.ts',
    'packages/runtime/src/child-fd-input.ts',
    'packages/runtime/src/child-process-lifecycle.ts',
    'packages/runtime/src/process-tree-terminator.ts',
  ]) {
    assert.ok(closure.includes(expected), `closure omitted ${expected}`);
  }
  assert.deepEqual(missing, []);

  // The other direction, which containment alone cannot see: a pattern backed
  // by nothing is dead weight that still books a Windows runner every time it
  // matches, and nothing reports it. Exceptions are declared above, so this
  // fails both when the closure stops reaching an entry and when a stale
  // exception outlives its reason.
  const underived = patterns
    .filter((pattern) => pattern.startsWith('packages/'))
    .filter((pattern) => !closure.some((path) => windowsReleasePatternCoversSource(path, pattern)))
    .sort();
  assert.deepEqual(underived, [...UNDERIVED_PACKAGE_PATTERNS.keys()].sort());
});

test('the Windows package workflow path list has no duplicate entries', () => {
  const patterns = readWindowsReleasePathPatterns();
  assert.equal(new Set(patterns).size, patterns.length);
});

/**
 * This belongs beside the other closure contract rather than with the planner
 * tests, because computing a closure needs esbuild and the planner tests run
 * before `npm ci` installs it. `.github/workflows/windows-recovery.yml` is in
 * `RELEASE_CONTRACT_FILES` so that editing the filter selects the gate that
 * checks it.
 */
test('the recovery filter is exactly the Windows-branching closure of its tests', async () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/windows-recovery.yml', import.meta.url),
    'utf8',
  );
  const filtered = readPullRequestPathPatterns('windows-recovery.yml')
    .filter((path) => path.startsWith('packages/'))
    .sort();

  // Derived from the dist tests the steps actually execute, mapped back to
  // source. A suite added to a step joins this set without anyone remembering
  // to widen the filter.
  const entrypoints = [
    ...new Set(
      [...workflow.matchAll(/packages\/([\w-]+)\/dist\/__tests__\/([\w.-]+)\.test\.js/gu)].map(
        ([, workspace, name]) => `packages/${workspace}/src/__tests__/${name}.test.ts`,
      ),
    ),
  ].sort();
  assert.ok(entrypoints.length > 0, 'no executed suite was recognised');
  for (const entrypoint of entrypoints) {
    assert.ok(existsSync(new URL(`../${entrypoint}`, import.meta.url)), entrypoint);
  }

  // Set equality, not containment, and in both directions on purpose. A subset
  // check cannot see an omission, which is how `stable-storage.ts` — reached
  // through the two listed lock authorities — sat outside a filter that was
  // supposed to cover exactly it. A superset check cannot see a file that
  // stopped branching and now schedules a Windows runner for nothing.
  const closure = await collectWorkspaceSourceClosure(entrypoints);
  const windowsBranching = closure
    .filter((path) =>
      readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').includes('win32'),
    )
    .sort();

  assert.deepEqual(filtered, windowsBranching);
});
