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

import { installWithRetry } from './install-electron-with-retry.mjs';

test('waits through a sustained transient Electron download outage', async () => {
  const attempts = [];
  const delays = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 5
        ? { status: 1, context: '{"kind":"http","status":500}' }
        : { status: 0, context: '' };
    },
    {
      wait: async (delay) => delays.push(delay),
      warn: () => {},
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000]);
});
