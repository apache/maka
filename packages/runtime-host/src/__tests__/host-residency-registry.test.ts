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
import { HostResidencyRegistry } from '../server/host-residency-registry.js';

test('Host residency registry explains liveness and drains on exact release', async () => {
  const registry = new HostResidencyRegistry();
  const execution = registry.acquire('hosted-execution');
  const firstResource = registry.acquire('runtime-resource');
  const secondResource = registry.acquire('runtime-resource');
  assert.equal(registry.activeCount, 3);
  assert.deepEqual(registry.snapshot(), [
    { label: 'hosted-execution', count: 1 },
    { label: 'runtime-resource', count: 2 },
  ]);

  let drained = false;
  const drain = registry.waitForEmpty().then(() => {
    drained = true;
  });
  firstResource.release();
  firstResource.release();
  execution.release();
  await Promise.resolve();
  assert.equal(drained, false);
  secondResource.release();
  await drain;
  assert.equal(registry.activeCount, 0);
  assert.deepEqual(registry.snapshot(), []);
});
