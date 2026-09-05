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
import { warmupDevRenderer } from './dev-renderer-warmup.mjs';

test('warms the client environment and waits for its imports to settle', async () => {
  const calls = [];
  const server = {
    environments: {
      client: {
        async warmupRequest(url) { calls.push(`warmup:${url}`); },
        async waitForRequestsIdle() { calls.push('idle'); },
      },
    },
    async warmupRequest() { throw new Error('legacy server API should not be used'); },
  };

  await warmupDevRenderer(server);

  assert.deepEqual(calls, ['warmup:/main.tsx', 'idle']);
});

test('falls back to the server warmup API for older Vite versions', async () => {
  const calls = [];
  const server = {
    async warmupRequest(url) { calls.push(url); },
  };

  await warmupDevRenderer(server, '/legacy.tsx');

  assert.deepEqual(calls, ['/legacy.tsx']);
});
