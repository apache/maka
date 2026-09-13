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
import type { InteractionRecord, StoredInteractionRequest } from '@maka/storage/interaction-store';
import { HostCanonicalPermissionOutcomeReader } from '../server/canonical-permission-outcome-reader.js';

describe('HostCanonicalPermissionOutcomeReader', () => {
  test('bounds cached records by least-recently-used identity', async () => {
    const records = new Map([
      ['permission-a', permissionRecord('permission-a')],
      ['permission-b', permissionRecord('permission-b')],
      ['permission-c', permissionRecord('permission-c')],
    ]);
    const reader = new HostCanonicalPermissionOutcomeReader({
      store: { readInteraction: async (requestId) => records.get(requestId) },
      capacity: 2,
    });

    const firstA = await reader.readPermissionOutcome('permission-a');
    const firstB = await reader.readPermissionOutcome('permission-b');
    assert.ok(firstA);
    assert.ok(firstB);
    assert.strictEqual(await reader.readPermissionOutcome('permission-a'), firstA);
    await reader.readPermissionOutcome('permission-c');

    records.clear();
    assert.strictEqual(await reader.readPermissionOutcome('permission-a'), firstA);
    assert.equal(await reader.readPermissionOutcome('permission-b'), undefined);
  });

  test('single-flights point reads and retries absent and failed outcomes', async () => {
    let record: InteractionRecord | undefined;
    let usePendingRead = false;
    let settlePendingRead!: (value: InteractionRecord | undefined) => void;
    const pendingRead = new Promise<InteractionRecord | undefined>((resolve) => {
      settlePendingRead = resolve;
    });
    const reader = new HostCanonicalPermissionOutcomeReader({
      store: {
        readInteraction: () => (usePendingRead ? pendingRead : Promise.resolve(record)),
      },
    });

    assert.equal(await reader.readPermissionOutcome('permission-a'), undefined);
    record = permissionRecord('permission-a');

    usePendingRead = true;
    const first = reader.readPermissionOutcome('permission-a');
    const second = reader.readPermissionOutcome('permission-a');
    settlePendingRead(record);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    assert.ok(firstOutcome);
    assert.strictEqual(secondOutcome, firstOutcome);

    const readFailure = new Error('read failed');
    let failedReadCount = 0;
    let failRead = true;
    const failedReader = new HostCanonicalPermissionOutcomeReader({
      store: {
        readInteraction: async () => {
          failedReadCount += 1;
          if (failRead) throw readFailure;
          return permissionRecord('permission-b');
        },
      },
    });
    const failures = await Promise.allSettled([
      failedReader.readPermissionOutcome('permission-b'),
      failedReader.readPermissionOutcome('permission-b'),
    ]);
    assert.equal(failedReadCount, 1);
    assert.equal(failures[0]?.status, 'rejected');
    assert.equal(failures[1]?.status, 'rejected');
    if (failures[0]?.status === 'rejected' && failures[1]?.status === 'rejected') {
      assert.strictEqual(failures[1].reason, failures[0].reason);
    }

    failRead = false;
    assert.equal(
      (await failedReader.readPermissionOutcome('permission-b'))?.requestId,
      'permission-b',
    );
    assert.equal(failedReadCount, 2);
  });
});

function permissionRecord(requestId: string): InteractionRecord {
  const request: StoredInteractionRequest = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId,
    createdAt: 1,
    request: {
      kind: 'permission',
      toolUseId: `tool-${requestId}`,
      prompt: {
        kind: 'tool_permission',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        review: { kind: 'command', command: 'echo okay', cwd: '/repo' },
        rememberForTurnAllowed: true,
      },
    },
  };
  return {
    request,
    outcome: {
      sessionId: request.sessionId,
      turnId: request.turnId,
      runId: request.runId,
      requestId,
      outcome: {
        kind: 'permission_answer',
        decision: 'allow',
        rememberForTurn: false,
        reviewer: 'user',
        committedAt: 2,
      },
    },
  };
}
