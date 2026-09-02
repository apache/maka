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
import test from 'node:test';

import {
  collectDesktopE2eSpecClosures,
  listDesktopE2eSpecs,
  selectDesktopE2eSpecs,
} from './desktop-e2e-test-selection.mjs';

const specs = ['apps/desktop/e2e/alpha.spec.ts', 'apps/desktop/e2e/beta.spec.ts'];
const closures = new Map([
  [specs[0], new Set([specs[0], 'apps/desktop/e2e/fixtures.ts', 'apps/desktop/src/main/a.ts'])],
  [specs[1], new Set([specs[1], 'apps/desktop/e2e/fixtures.ts', 'apps/desktop/src/main/b.ts'])],
]);

test('selection follows the exact source closure of each spec', async () => {
  assert.deepEqual(
    await selectDesktopE2eSpecs(['apps/desktop/src/main/a.ts'], { specs, closures }),
    [specs[0]],
  );
  assert.deepEqual(
    await selectDesktopE2eSpecs(['apps/desktop/e2e/fixtures.ts'], { specs, closures }),
    specs,
  );
  assert.deepEqual(
    await selectDesktopE2eSpecs(['apps/desktop/src/main/unreached.ts'], { specs, closures }),
    [],
  );
});

test('full plans and selection authorities run every spec', async () => {
  for (const path of [
    'package-lock.json',
    'apps/desktop/e2e/playwright.config.ts',
    'scripts/desktop-e2e-test-selection.mjs',
    'scripts/workspace-source-closure.mjs',
  ]) {
    assert.deepEqual(await selectDesktopE2eSpecs([path], { specs, closures }), specs, path);
  }
});

test('non-Electron changes select no Desktop spec', async () => {
  assert.deepEqual(
    await selectDesktopE2eSpecs(['packages/runtime/src/runtime.ts'], { specs, closures }),
    [],
  );
});

test('current spec closures select every repository script they import', async () => {
  const currentSpecs = listDesktopE2eSpecs();
  const currentClosures = await collectDesktopE2eSpecClosures(currentSpecs);

  assert.ok(currentSpecs.length > 0);
  for (const spec of currentSpecs) {
    assert.ok(currentClosures.get(spec)?.has(spec), spec);
    assert.ok(currentClosures.get(spec)?.has('apps/desktop/e2e/fixtures.ts'), spec);
  }

  const scriptInputs = [
    ...new Set(
      [...currentClosures.values()].flatMap((closure) =>
        [...closure].filter((path) => path.startsWith('scripts/')),
      ),
    ),
  ].sort();
  assert.ok(scriptInputs.length > 0);
  for (const path of scriptInputs) {
    const reachableSpecs = currentSpecs.filter((spec) => currentClosures.get(spec)?.has(path));
    assert.deepEqual(
      await selectDesktopE2eSpecs([path], {
        specs: currentSpecs,
        closures: currentClosures,
      }),
      reachableSpecs,
      path,
    );
  }
  assert.deepEqual(
    await selectDesktopE2eSpecs(['scripts/ax-tree-audit.mjs'], {
      specs: currentSpecs,
      closures: currentClosures,
    }),
    ['apps/desktop/e2e/accessibility-coverage.spec.ts'],
  );
});
