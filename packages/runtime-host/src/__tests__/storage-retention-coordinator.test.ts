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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import {
  HostStorageRetentionPolicy,
  RETENTION_DAY_MS,
} from '../server/storage-retention-policy.js';
import { HostStorageRetentionCoordinator } from '../server/storage-retention-coordinator.js';

const context = {
  hostEpoch: 'test',
  connectionId: 'test',
  principal: 'local_os_user' as const,
  acquireResidency: () => ({ release() {} }),
};
test('retention does no candidate SQL before opt-in deadline, pauses rollback across restart, and bounds each tick', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  let queries = 0;
  let deleted = 0;
  const policy = await HostStorageRetentionPolicy.open(root, () => now);
  const options = {
    stateRoot: root,
    policy,
    now: () => now,
    stores: {
      listRetentionCandidates: async (input: { limit: number; cutoff: number; after?: string }) => {
        queries++;
        assert.equal(input.limit, 8);
        return {
          sessionIds: Array.from({ length: 8 }, (_, i) => String(i)),
          hasMore: input.cutoff > 1_000,
        };
      },
      readCatalogRecord: async () =>
        ({ revision: 1, summary: {} }) as Awaited<
          ReturnType<ExecutionSessionWriter['readCatalogRecord']>
        >,
    },
    retirement: {
      estimateRetentionBytes: async () => undefined,
      removeForRetention: async () => {
        deleted++;
        return 'removed' as const;
      },
    },
  };
  let coordinator = await HostStorageRetentionCoordinator.open(options);
  assert.equal(await coordinator.run({ maxFamilies: 8 }), false);
  assert.equal(queries, 0);
  await policy.set({ enabled: true, days: 30, expectedRevision: 0 });
  now += 30 * RETENTION_DAY_MS;
  assert.equal(await coordinator.run({ maxFamilies: 8 }), false);
  assert.equal(queries, 0);
  now++;
  assert.equal(await coordinator.run({ maxFamilies: 8 }), true);
  assert.equal(deleted, 8);
  now--;
  coordinator = await HostStorageRetentionCoordinator.open(options);
  assert.equal(await coordinator.run({ maxFamilies: 8 }), false);
  assert.equal(queries, 1);
  const result = await coordinator.handlers['storage.retention.query']({}, context);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.lastSweep?.deleted, 8);
    assert.equal(result.result.lastDeletion?.count, 8);
  }
  coordinator.beginDrain();
  assert.equal(await coordinator.run({ maxFamilies: 8 }), false);
});

test('changing a policy while candidates are read rejects the old sweep', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const policy = await HostStorageRetentionPolicy.open(root, () => now);
  await policy.set({ enabled: true, days: 30, expectedRevision: 0 });
  now += 30 * RETENTION_DAY_MS + 1;
  const coordinator = await HostStorageRetentionCoordinator.open({
    stateRoot: root,
    policy,
    now: () => now,
    stores: {
      listRetentionCandidates: async () => {
        await policy.set({ enabled: false, days: 30, expectedRevision: 1 });
        return { sessionIds: ['candidate'], hasMore: false };
      },
      readCatalogRecord: async () =>
        ({ revision: 1, summary: {} }) as Awaited<
          ReturnType<ExecutionSessionWriter['readCatalogRecord']>
        >,
    },
    retirement: {
      estimateRetentionBytes: async () => undefined,
      removeForRetention: async () => assert.fail('stale policy must not delete'),
    },
  });
  assert.equal(await coordinator.run({ maxFamilies: 8 }), false);
});
