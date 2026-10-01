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
import { describe, test } from 'node:test';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  type StorageRetentionQueryResult,
  type StorageRetentionSetResult,
} from '../protocol/index.js';

const querySpec = HOST_OPERATION_SPECS['storage.retention.query'];
const setSpec = HOST_OPERATION_SPECS['storage.retention.set'];

const queried: StorageRetentionQueryResult = {
  revision: 3,
  enabled: true,
  days: 60,
  enabledAt: 1_700_000_000_000,
  preview: { count: 4, eligibleAt: 1_705_184_000_000 },
  lastSweep: { at: 1_706_000_000_000, deleted: 2, skippedBusy: 1, needsReview: 1, failed: 0 },
  lastDeletion: { at: 1_706_000_000_000, count: 2, bytes: 4096 },
};

function rejects(decode: () => unknown): void {
  assert.throws(decode, RuntimeHostProtocolError);
}

describe('storage retention protocol', () => {
  test('round-trips the query and set shapes', () => {
    assert.deepEqual(querySpec.decodeInput({}), {});
    assert.deepEqual(querySpec.decodeInput({ previewDays: 90 }), { previewDays: 90 });
    assert.deepEqual(querySpec.decodeOutput(JSON.parse(JSON.stringify(queried))), queried);
    const minimal = { revision: 0, enabled: false, days: 30 };
    assert.deepEqual(querySpec.decodeOutput(minimal), minimal);
    const paused = {
      ...minimal,
      lastSweep: { at: 1, deleted: 0, skippedBusy: 0, needsReview: 0, failed: 0, paused: true },
      preview: { count: 0 },
    };
    assert.deepEqual(querySpec.decodeOutput(paused), paused);

    const input = { expectedRevision: 3, enabled: true, days: 30 };
    assert.deepEqual(setSpec.decodeInput(input), input);
    const committed: StorageRetentionSetResult = {
      kind: 'committed',
      setting: { revision: 4, enabled: true, days: 30, enabledAt: 5 },
    };
    assert.deepEqual(setSpec.decodeOutput(committed), committed);
    const conflict: StorageRetentionSetResult = {
      kind: 'revision_conflict',
      expectedRevision: 3,
      actualRevision: 4,
    };
    assert.deepEqual(setSpec.decodeOutput(conflict), conflict);
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-set',
        operation: 'storage.retention.set',
        ok: true,
        result: committed,
      }),
      { requestId: 'request-set', operation: 'storage.retention.set', ok: true, result: committed },
    );
  });

  test('rejects malformed inputs and results', () => {
    rejects(() => querySpec.decodeInput({ previewDays: 45 }));
    rejects(() => querySpec.decodeInput({ days: 30 }));
    rejects(() => setSpec.decodeInput({ expectedRevision: 0, enabled: true }));
    rejects(() => setSpec.decodeInput({ expectedRevision: -1, enabled: true, days: 30 }));
    rejects(() => setSpec.decodeInput({ expectedRevision: 0, enabled: 'yes', days: 30 }));
    // The client never stamps the time: the Host does.
    rejects(() =>
      setSpec.decodeInput({ expectedRevision: 0, enabled: true, days: 30, enabledAt: 1 }),
    );

    // enabledAt is present exactly while enabled.
    rejects(() => querySpec.decodeOutput({ revision: 1, enabled: true, days: 30 }));
    rejects(() => querySpec.decodeOutput({ revision: 1, enabled: false, days: 30, enabledAt: 1 }));
    rejects(() => querySpec.decodeOutput({ ...queried, days: 7 }));
    rejects(() => querySpec.decodeOutput({ ...queried, unknown: true }));
    // A preview with tasks says when; one without says nothing.
    rejects(() => querySpec.decodeOutput({ ...queried, preview: { count: 2 } }));
    rejects(() => querySpec.decodeOutput({ ...queried, preview: { count: 0, eligibleAt: 1 } }));
    rejects(() =>
      querySpec.decodeOutput({ ...queried, lastSweep: { ...queried.lastSweep, paused: false } }),
    );
    rejects(() =>
      querySpec.decodeOutput({ ...queried, lastDeletion: { at: 1, count: 1, bytes: -1 } }),
    );
    rejects(() => setSpec.decodeOutput({ kind: 'committed' }));
    rejects(() => setSpec.decodeOutput({ kind: 'stale' }));
    rejects(() =>
      setSpec.decodeOutput({
        kind: 'revision_conflict',
        expectedRevision: 1,
        actualRevision: 2,
        setting: {},
      }),
    );
  });

  test('a set result must answer the request it was given', () => {
    const input = { expectedRevision: 3, enabled: true, days: 60 } as const;
    assert.throws(
      () =>
        setSpec.assertOutputForInput!(input, {
          kind: 'committed',
          setting: { revision: 4, enabled: true, days: 30, enabledAt: 1 },
        }),
      RuntimeHostProtocolError,
    );
    assert.throws(
      () =>
        setSpec.assertOutputForInput!(input, {
          kind: 'revision_conflict',
          expectedRevision: 2,
          actualRevision: 4,
        }),
      RuntimeHostProtocolError,
    );
    setSpec.assertOutputForInput!(input, {
      kind: 'committed',
      setting: { revision: 4, enabled: true, days: 60, enabledAt: 1 },
    });
  });

  test('is a Ready query and command a remote owner may use', () => {
    assert.equal(querySpec.mode, 'query');
    assert.equal(setSpec.mode, 'command');
    assert.equal(querySpec.availability, 'ready');
    assert.equal(setSpec.availability, 'ready');
    assert.ok(REMOTE_OWNER_OPERATION_GRANTS.includes('storage.retention.query'));
    assert.ok(REMOTE_OWNER_OPERATION_GRANTS.includes('storage.retention.set'));
  });
});
