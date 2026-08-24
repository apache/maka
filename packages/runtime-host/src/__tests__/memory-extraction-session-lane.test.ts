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
import { test } from 'node:test';

import { MemoryExtractionSessionLane } from '../server/memory-extraction-session-lane.js';

test('user-requested extraction passes queued background work without preempting the running job', async () => {
  const lane = new MemoryExtractionSessionLane();
  const order: string[] = [];
  let releaseRunning!: () => void;
  const runningGate = new Promise<void>((resolve) => {
    releaseRunning = resolve;
  });

  const running = lane.run(
    'session-1',
    async () => {
      order.push('background-running');
      await runningGate;
    },
    'background',
  );
  const queued = lane.run(
    'session-1',
    async () => {
      order.push('background-queued');
    },
    'background',
  );
  const foreground = lane.run(
    'session-1',
    async () => {
      order.push('foreground');
    },
    'foreground',
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['background-running']);
  releaseRunning();
  await Promise.all([running, queued, foreground]);
  assert.deepEqual(order, ['background-running', 'foreground', 'background-queued']);
});
