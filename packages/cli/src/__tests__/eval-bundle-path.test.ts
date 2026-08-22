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
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { configureInstalledEvalBundle } from '../eval-bundle-path.js';

describe('installed Eval bundle', () => {
  test('points Eval containers at the installed package root', async (t) => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'maka-cli-eval-bundle-'));
    t.after(() => rm(packageRoot, { recursive: true, force: true }));
    await mkdir(join(packageRoot, 'packages/eval'), { recursive: true });
    const environment: NodeJS.ProcessEnv = {};

    configureInstalledEvalBundle(environment, packageRoot);

    assert.equal(environment.MAKA_EVAL_MAKA_BUNDLE_PATH, packageRoot);
  });

  test('preserves an explicit bundle path', () => {
    const environment = { MAKA_EVAL_MAKA_BUNDLE_PATH: '/explicit/bundle' };

    configureInstalledEvalBundle(environment, '/installed/package');

    assert.equal(environment.MAKA_EVAL_MAKA_BUNDLE_PATH, '/explicit/bundle');
  });

  test('does not change source-checkout behavior without a packaged Eval mirror', () => {
    const environment: NodeJS.ProcessEnv = {};

    configureInstalledEvalBundle(environment, '/missing/package');

    assert.equal(Object.hasOwn(environment, 'MAKA_EVAL_MAKA_BUNDLE_PATH'), false);
  });
});
