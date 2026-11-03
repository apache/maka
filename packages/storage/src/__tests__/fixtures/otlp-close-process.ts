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
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../../root-authority.js';
import { openInteractiveUsageStoresForWrite } from '../../usage-stores.js';

const capability = await resolveStorageRoot({ path: process.argv[2]!, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert(owner);
const stores = await openInteractiveUsageStoresForWrite(owner.lease);
try {
  for (let i = 0; i < 64; i++) {
    await stores.telemetry.recordToolInvocation({
      id: `tool-${i}`,
      toolName: 'Bash',
      durationMs: 1,
      status: 'success',
      bytesIn: 0,
      bytesOut: 0,
      date: '2026-01-01',
      ts: 1,
      startedAt: 0,
    });
  }
  const summary = await stores.telemetry.toolSummary({ range: 'all' });
  assert.equal(summary.requests, 64);
  const closed = stores.close();
  process.send?.('closing');
  await closed;
} finally {
  await stores.close();
  await owner.close();
  process.disconnect?.();
}
// No forced exit: the parent verifies that cancellation releases network handles.
