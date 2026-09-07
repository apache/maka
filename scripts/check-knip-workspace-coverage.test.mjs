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
import { evaluateWorkspaceCoverage } from './check-knip-workspace-coverage.mjs';

test('a package.json workspace missing from knip.json is reported', () => {
  const { ok, missing, stale } = evaluateWorkspaceCoverage({
    knipKeys: ['.', 'packages/runtime'],
    packageWorkspaces: ['packages/runtime', 'packages/storage'],
  });
  assert.equal(ok, false);
  assert.deepEqual(missing, ['packages/storage']);
  assert.deepEqual(stale, []);
});

test('a stale knip.json key is reported even when other workspaces are covered', () => {
  const { ok, missing, stale } = evaluateWorkspaceCoverage({
    knipKeys: ['.', 'packages/runtime', 'packages/retired'],
    packageWorkspaces: ['packages/runtime'],
  });
  assert.equal(ok, false);
  assert.deepEqual(missing, []);
  assert.deepEqual(stale, ['packages/retired']);
});

test('the root knip key is exempt from the stale check', () => {
  const { ok, stale } = evaluateWorkspaceCoverage({
    knipKeys: ['.', 'packages/runtime'],
    packageWorkspaces: ['packages/runtime'],
  });
  assert.equal(ok, true);
  assert.deepEqual(stale, []);
});
