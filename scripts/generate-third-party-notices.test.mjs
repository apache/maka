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
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('keeps a version-pinned Apache override scoped to the Apache license', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/generate-third-party-notices.mjs', '--check'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const notices = readFileSync(
    join(root, 'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  // Match the package without its version: the override is version-pinned in
  // the generator, but pinning the version here too would fail on every
  // routine dependency bump rather than on the leak this test guards.
  const providerUtils = notices
    .split('\n================================================================================\n')
    .find((section) => section.includes('Package: @ai-sdk/provider-utils@'));
  assert.ok(providerUtils, 'provider-utils notice section must exist');
  assert.doesNotMatch(providerUtils, /THIRD-PARTY COMPONENTS/);
});
