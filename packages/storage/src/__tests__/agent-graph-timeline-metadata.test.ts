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
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import { AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION } from '@maka/core/agent-graph-schedule';
import { AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION } from '@maka/core/agent-graph-supervisor-wake';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite agent graph timeline metadata', () => {
  test('reads one graph control-plane snapshot with current admission and wake attempts', async () => {
    let now = 100;
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => now++ });
    try {
      await store.commitAgentGraphScheduleUpdate({
        schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
        updateId: `graph_update_${'a'.repeat(32)}`,
        updateFingerprint: `sha256:${'b'.repeat(64)}`,
        graphId: 'graph-1',
        source: {
          sessionId: 'root-session',
          runId: 'root-run',
          turnId: 'root-turn',
          toolCallId: 'schedule-call',
        },
        addWork: [
          {
            workId: `graph_work_${'c'.repeat(32)}`,
            target: { kind: 'operator', operatorId: 'operator-1' },
            instruction: 'Sensitive schedule instruction.',
            inputIds: [],
          },
        ],
        stop: [],
      });
      await store.claimAgentGraphIntentAtScheduleRevision(
        {
          schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
          claimId: `graph_claim_${'d'.repeat(32)}`,
          graphId: 'graph-1',
          intentId: `graph_intent_${'e'.repeat(32)}`,
          intentFingerprint: `sha256:${'f'.repeat(64)}`,
          readinessContextFingerprint: `sha256:${'1'.repeat(64)}`,
          targetOperatorId: 'operator-1',
          targetSessionId: 'child-session',
          targetTurnId: 'child-turn',
          targetRunId: 'child-run',
        },
        1,
      );
      await store.beginAgentGraphIntentExecutionAtScheduleRevision(
        'graph-1',
        `graph_intent_${'e'.repeat(32)}`,
        1,
      );
      await store.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: 'graph-1',
        wakeId: 'wake-1',
        snapshotVersion: 'snapshot-1',
        rootSessionId: 'root-session',
      });
      await store.beginAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
        turnId: 'wake-turn',
      });
      await store.completeAgentGraphSupervisorWakeAttempt({
        graphId: 'graph-1',
        wakeId: 'wake-1',
        attemptId: 'attempt-1',
        status: 'delivered',
      });

      const snapshot = await store.readAgentGraphTimelineMetadata('graph-1');
      assert.equal(snapshot.graphId, 'graph-1');
      assert.equal(snapshot.scheduleUpdates.length, 1);
      assert.equal(snapshot.operatorProvisions.length, 0);
      assert.equal(snapshot.intentClaims.length, 1);
      assert.deepEqual(snapshot.intentAdmissions, [
        {
          graphId: 'graph-1',
          intentId: `graph_intent_${'e'.repeat(32)}`,
          state: 'executing',
          updatedAt: 102,
        },
      ]);
      assert.equal(snapshot.supervisorWakes.length, 1);
      assert.equal(snapshot.supervisorWakes[0]?.wake.status, 'delivered');
      assert.deepEqual(
        snapshot.supervisorWakes[0]?.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          status: attempt.status,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
        })),
        [
          {
            attemptId: 'attempt-1',
            status: 'delivered',
            startedAt: 104,
            completedAt: 105,
          },
        ],
      );
      assert.deepEqual(await store.readAgentGraphTimelineMetadata('another-graph'), {
        graphId: 'another-graph',
        scheduleUpdates: [],
        operatorProvisions: [],
        intentClaims: [],
        intentAdmissions: [],
        supervisorWakes: [],
      });
    } finally {
      store.close();
    }
  });
});
