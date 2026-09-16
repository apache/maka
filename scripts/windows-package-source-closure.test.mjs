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
import { collectWorkspaceSourceClosure } from './windows-package-source-closure.mjs';
import { readPullRequestPathFilter } from './workflow-pull-request-paths.mjs';

test('the recovery filter is exactly the Windows-branching closure of its tests', async () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/windows-recovery.yml', import.meta.url),
    'utf8',
  );
  const filtered = readPullRequestPathFilter('windows-recovery.yml')
    .filter((path) => path.startsWith('packages/'))
    .sort();

  // Derived from the dist tests the steps actually execute, mapped back to
  // source. A suite added to a step joins this set without anyone remembering
  // to widen the filter.
  // The separator class matches the backslash form too, because these steps run
  // under pwsh where both are legal — a suite spelled with backslashes would
  // otherwise be dropped from the set that decides the filter, which is the
  // fail-open direction.
  const entrypoints = [
    ...new Set(
      [
        ...workflow.matchAll(
          /packages[/\\]([\w-]+)[/\\]dist[/\\]__tests__[/\\]([\w.-]+)\.test\.js/gu,
        ),
      ].map(([, workspace, name]) => `packages/${workspace}/src/__tests__/${name}.test.ts`),
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
  //
  // `win32` is the criterion because it is the one a machine can check, not
  // because it names every Windows-only path: `git-worktree-child-executor.ts`
  // carries a genuine Windows workaround with no such literal. A branch written
  // without it stays outside this filter, and the lane's schedule is what
  // observes it.
  const closure = await collectWorkspaceSourceClosure(entrypoints);
  const windowsBranching = closure
    .filter((path) =>
      readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').includes('win32'),
    )
    .sort();

  assert.deepEqual(filtered, windowsBranching);
});
