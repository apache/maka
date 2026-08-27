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
import { assertPackagedUpdateConfiguration } from './desktop-update-contract.mjs';

test('packaged clients have one exact production update authority', async () => {
  const expected =
    'owner: apache\nrepo: maka\nprovider: github\nupdaterCacheDirName: "@makadesktop-updater"\n';
  await assertPackagedUpdateConfiguration('resources', { read: async () => expected });
  await assert.rejects(
    assertPackagedUpdateConfiguration('resources', {
      read: async () => expected.replace('owner: apache', 'owner: personal-fork'),
    }),
    /expected.*apache/u,
  );
  await assert.rejects(
    assertPackagedUpdateConfiguration('resources', {
      read: async () => `${expected}extra: rejected\n`,
    }),
    /expected/u,
  );
});
