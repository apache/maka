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
import type {
  InteractiveStorageFootprintReader,
  StorageFootprint,
} from '@maka/storage/storage-writer-composition';
import { HOST_OPERATION_SPECS } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  HostStorageUsageCoordinator,
  STORAGE_USAGE_TOTALS_TTL_MS,
} from '../server/storage-usage-coordinator.js';

const context = {} as ConnectionContext;
const footprint: StorageFootprint = {
  totals: [{ kind: 'database', bytes: 4096, exact: false }],
  reclaimableBytes: 1024,
  worktreeCount: 1,
};

test('storage usage shares one totals scan and reads Sessions fresh', async () => {
  let now = 1_000;
  let measures = 0;
  let release: (() => void) | undefined;
  const sessionQueries: Array<readonly string[]> = [];
  const reader: InteractiveStorageFootprintReader = {
    measure: async () => {
      measures += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return footprint;
    },
    measureSessions: async (sessionIds) => {
      sessionQueries.push(sessionIds);
      return sessionIds.map((sessionId) => ({
        sessionId,
        bytes: { transcript: 1, runtime: 2, artifacts: 3 },
        worktreeCount: 0,
      }));
    },
  };
  const coordinator = new HostStorageUsageCoordinator({ footprint: reader, now: () => now });
  const query = coordinator.handlers['storage.usage.query'];

  const first = query({}, context);
  const second = query({ sessionIds: ['session-1'] }, context);
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  const [totalsOnly, withSessions] = await Promise.all([first, second]);
  assert.equal(measures, 1);
  assert.deepEqual(totalsOnly, {
    ok: true,
    result: { measuredAt: 1_000, ...footprint },
  });
  assert.ok(withSessions.ok);
  assert.deepEqual(withSessions.result.sessions, [
    {
      sessionId: 'session-1',
      bytes: { transcript: 1, runtime: 2, artifacts: 3 },
      worktreeCount: 0,
    },
  ]);
  const spec = HOST_OPERATION_SPECS['storage.usage.query'];
  assert.doesNotThrow(() =>
    spec.assertOutputForInput?.({ sessionIds: ['session-1'] }, withSessions.result),
  );

  now += STORAGE_USAGE_TOTALS_TTL_MS - 1;
  const cached = await query({ sessionIds: ['session-2'] }, context);
  assert.equal(measures, 1);
  assert.ok(cached.ok);
  assert.equal(cached.result.measuredAt, 1_000);
  assert.deepEqual(sessionQueries, [['session-1'], ['session-2']]);

  now += 1;
  const refreshed = query({}, context);
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  const next = await refreshed;
  assert.equal(measures, 2);
  assert.ok(next.ok);
  assert.equal(next.result.measuredAt, now);
});

test('storage usage reports measurement failures and refuses work while draining', async () => {
  let fail = true;
  const coordinator = new HostStorageUsageCoordinator({
    footprint: {
      measure: async () => {
        if (fail) throw new Error('disk I/O error');
        return footprint;
      },
      measureSessions: async () => [],
    },
  });
  const query = coordinator.handlers['storage.usage.query'];
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await query({}, context), {
      ok: false,
      error: { code: 'persistence_failed', message: 'Storage usage could not be measured' },
    });
  } finally {
    console.error = originalError;
  }
  // A failed scan is not cached.
  fail = false;
  assert.equal((await query({}, context)).ok, true);

  coordinator.beginDrain();
  const drained = await query({}, context);
  assert.equal(drained.ok, false);
  assert.equal(!drained.ok && drained.error.code, 'host_draining');
});
