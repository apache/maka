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
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostStorageUsageCoordinator } from '../server/storage-usage-coordinator.js';

const context = {} as ConnectionContext;

function footprint(bytes: number): StorageFootprint {
  return {
    totals: [{ kind: 'database', bytes, exact: true }],
    reclaimableBytes: 1024,
    worktreeCount: 1,
  };
}

/** A reader whose every `measure()` waits until the test settles it. */
function deferredReader() {
  const pending: Array<(value: StorageFootprint) => void> = [];
  const sessionQueries: Array<readonly string[]> = [];
  const reader: InteractiveStorageFootprintReader = {
    measure: () => new Promise<StorageFootprint>((resolve) => pending.push(resolve)),
    measureSessions: async (sessionIds) => {
      sessionQueries.push(sessionIds);
      return sessionIds.map((sessionId) => ({
        sessionId,
        bytes: { transcript: 1, runtime: 2, artifacts: 3 },
        worktreeCount: 0,
      }));
    },
  };
  return { reader, pending, sessionQueries };
}

test('concurrent totals requests share one measurement and a later request re-measures', async () => {
  let now = 1_000;
  const { reader, pending } = deferredReader();
  const coordinator = new HostStorageUsageCoordinator({ footprint: reader, now: () => now });
  const query = coordinator.handlers['storage.usage.query'];

  const first = query({}, context);
  const second = query({}, context);
  assert.equal(pending.length, 1, 'concurrent requests share one scan');
  pending[0]!(footprint(4096));
  assert.deepEqual(await first, {
    ok: true,
    result: { measuredAt: 1_000, ...footprint(4096) },
  });
  assert.deepEqual(await second, await first);

  now = 1_001;
  const refreshed = query({}, context);
  assert.equal(pending.length, 2, 'a request after the scan settles measures again');
  pending[1]!(footprint(8192));
  assert.deepEqual(await refreshed, {
    ok: true,
    result: { measuredAt: 1_001, ...footprint(8192) },
  });
});

test('Session usage never computes totals', async () => {
  const { reader, pending, sessionQueries } = deferredReader();
  const coordinator = new HostStorageUsageCoordinator({ footprint: reader });
  const outcome = await coordinator.handlers['storage.usage.sessions.query'](
    { sessionIds: ['session-1'] },
    context,
  );
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      sessions: [
        {
          sessionId: 'session-1',
          bytes: { transcript: 1, runtime: 2, artifacts: 3 },
          worktreeCount: 0,
        },
      ],
    },
  });
  assert.deepEqual(sessionQueries, [['session-1']]);
  assert.equal(pending.length, 0);
});

test('storage usage reports measurement failures and refuses work while draining', async () => {
  let fail = true;
  const coordinator = new HostStorageUsageCoordinator({
    footprint: {
      measure: async () => {
        if (fail) throw new Error('disk I/O error');
        return footprint(1);
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
  fail = false;
  assert.equal((await query({}, context)).ok, true);

  coordinator.beginDrain();
  const drained = await query({}, context);
  assert.equal(drained.ok, false);
  assert.equal(!drained.ok && drained.error.code, 'host_draining');
});
