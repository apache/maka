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
import { describe, test } from 'node:test';
import {
  AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
  AgentGraphScheduleClosedError,
  AgentGraphScheduleRevisionConflictError,
  type AgentGraphScheduleUpdateRequest,
} from '@maka/core/agent-graph-schedule';
import {
  AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
  type AgentGraphIntentClaimRequest,
} from '@maka/core/agent-graph-control';
import {
  AgentGraphScheduleUpdateConflictError,
  createSqliteSessionMetadataStore,
} from '../sqlite-session-metadata-store.js';

describe('SQLite agent graph schedule updates', () => {
  test('commits ordered idempotent updates and closes the schedule atomically', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(40) });
    try {
      const first = await store.commitAgentGraphScheduleUpdate(request());
      const retry = await store.commitAgentGraphScheduleUpdate(request());
      const finish = await store.commitAgentGraphScheduleUpdate(
        request({
          updateId: `graph_update_${'d'.repeat(32)}`,
          updateFingerprint: `sha256:${'e'.repeat(64)}`,
          source: {
            sessionId: 'session-main',
            runId: 'run-main',
            turnId: 'turn-main',
            toolCallId: 'tool-finish',
          },
          addWork: [],
          stop: [{ targetId: first.update.addWork[0]!.workId, reason: 'evidence is sufficient' }],
          finish: { resultIds: ['result-1'], reason: 'accept the verified result' },
        }),
      );

      assert.equal(first.created, true);
      assert.equal(retry.created, false);
      assert.deepEqual(retry.update, first.update);
      assert.equal(first.update.revision, 1);
      assert.equal(finish.update.revision, 2);
      assert.deepEqual(await store.listAgentGraphScheduleUpdates('graph-1'), [
        first.update,
        finish.update,
      ]);
      await assert.rejects(
        store.commitAgentGraphScheduleUpdate(
          request({
            updateId: `graph_update_${'f'.repeat(32)}`,
            updateFingerprint: `sha256:${'1'.repeat(64)}`,
            source: {
              sessionId: 'session-main',
              runId: 'run-main',
              turnId: 'turn-later',
              toolCallId: 'tool-later',
            },
          }),
        ),
        /already finished/,
      );
    } finally {
      store.close();
    }
  });

  test('rejects tool-call and update identities reused for different work', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.commitAgentGraphScheduleUpdate(request());
      await assert.rejects(
        store.commitAgentGraphScheduleUpdate(
          request({
            updateFingerprint: `sha256:${'9'.repeat(64)}`,
            addWork: [
              {
                ...request().addWork[0]!,
                instruction: 'Perform different work.',
              },
            ],
          }),
        ),
        AgentGraphScheduleUpdateConflictError,
      );
      await assert.rejects(
        store.commitAgentGraphScheduleUpdate(
          request({
            updateId: `graph_update_${'7'.repeat(32)}`,
            updateFingerprint: `sha256:${'8'.repeat(64)}`,
          }),
        ),
        AgentGraphScheduleUpdateConflictError,
      );
      assert.equal((await store.listAgentGraphScheduleUpdates('graph-1')).length, 1);
    } finally {
      store.close();
    }
  });

  test('rolls back an update when the transaction fails before commit', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint(point) {
        if (point === 'after_agent_graph_schedule_update_write') throw new Error('crash');
      },
    });
    try {
      await assert.rejects(store.commitAgentGraphScheduleUpdate(request()), /crash/);
      assert.deepEqual(await store.listAgentGraphScheduleUpdates('graph-1'), []);
    } finally {
      store.close();
    }
  });

  test('replays the same schedule after reopening the workspace database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-schedule-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 77 });
      const committed = await store.commitAgentGraphScheduleUpdate(request());
      store.close();

      const reopened = createSqliteSessionMetadataStore(path);
      try {
        assert.deepEqual(await reopened.listAgentGraphScheduleUpdates('graph-1'), [
          committed.update,
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('linearizes scheduled admission against revision changes and closure', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(90) });
    try {
      await store.commitAgentGraphScheduleUpdate(request());
      const first = await store.claimAgentGraphIntentAtScheduleRevision(claimRequest(), 1);
      assert.equal(first.created, true);

      await store.commitAgentGraphScheduleUpdate(
        request({
          updateId: `graph_update_${'d'.repeat(32)}`,
          updateFingerprint: `sha256:${'e'.repeat(64)}`,
          source: {
            sessionId: 'session-main',
            runId: 'run-main',
            turnId: 'turn-finish',
            toolCallId: 'tool-finish',
          },
          addWork: [],
          stop: [],
          finish: { resultIds: ['result-1'], reason: 'accept the result' },
        }),
      );

      await assert.rejects(
        store.claimAgentGraphIntentAtScheduleRevision(
          {
            ...claimRequest(),
            claimId: `graph_claim_${'d'.repeat(32)}`,
            intentId: `graph_intent_${'e'.repeat(32)}`,
            targetTurnId: 'turn-2',
            targetRunId: 'run-2',
          },
          1,
        ),
        (error: unknown) =>
          error instanceof AgentGraphScheduleRevisionConflictError && error.currentRevision === 2,
      );
      assert.equal(
        (
          await store.claimAgentGraphIntentAtScheduleRevision(
            { ...claimRequest(), targetTurnId: 'discarded', targetRunId: 'discarded' },
            2,
          )
        ).created,
        false,
      );
      await assert.rejects(
        store.claimAgentGraphIntentAtScheduleRevision(
          {
            ...claimRequest(),
            claimId: `graph_claim_${'d'.repeat(32)}`,
            intentId: `graph_intent_${'e'.repeat(32)}`,
            targetTurnId: 'turn-2',
            targetRunId: 'run-2',
          },
          2,
        ),
        AgentGraphScheduleClosedError,
      );
      assert.equal((await store.listAgentGraphIntentClaims('graph-1')).length, 1);
    } finally {
      store.close();
    }
  });
});

function request(
  overrides: Partial<AgentGraphScheduleUpdateRequest> = {},
): AgentGraphScheduleUpdateRequest {
  return {
    schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
    updateId: `graph_update_${'a'.repeat(32)}`,
    updateFingerprint: `sha256:${'b'.repeat(64)}`,
    graphId: 'graph-1',
    source: {
      sessionId: 'session-main',
      runId: 'run-main',
      turnId: 'turn-main',
      toolCallId: 'tool-main',
    },
    addWork: [
      {
        workId: `graph_work_${'c'.repeat(32)}`,
        target: { kind: 'agent', agentId: 'fact-checker' },
        instruction: 'Verify the selected evidence.',
        inputIds: ['result-1'],
      },
    ],
    stop: [],
    ...overrides,
  };
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}

function claimRequest(): AgentGraphIntentClaimRequest {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'writer',
    targetSessionId: 'session-writer',
    targetTurnId: 'turn-1',
    targetRunId: 'run-1',
  };
}
