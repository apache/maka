import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

  test('backfills legacy schedule ownership as the first graph instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-instance-migration-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 77 });
      await store.commitAgentGraphScheduleUpdate(request());
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
          finish: { resultIds: ['result-1'], reason: 'legacy graph complete' },
        }),
      );
      store.close();

      const legacy = new DatabaseSync(path);
      legacy.exec(`
        DROP TABLE agent_graph_instances;
        UPDATE session_metadata_schema
        SET version = 23
        WHERE scope = 'session_metadata';
      `);
      legacy.close();

      const migrated = createSqliteSessionMetadataStore(path);
      try {
        assert.deepEqual(await migrated.listAgentGraphInstances('session-main'), [
          {
            schemaVersion: 1,
            graphId: 'graph-1',
            rootSessionId: 'session-main',
            sequence: 1,
            status: 'finished',
            createdAt: 77,
            finishedAt: 77,
          },
        ]);
      } finally {
        migrated.close();
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

  test('creates sequential graph instances after finish without reopening history', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(200) });
    try {
      const first = await store.getOrCreateActiveAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'session-main',
      });
      assert.equal(first.created, true);
      assert.equal(first.instance.sequence, 1);

      await store.commitAgentGraphScheduleUpdate(request());
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
          finish: { resultIds: ['result-1'], reason: 'first graph complete' },
        }),
      );

      assert.equal(await store.readActiveAgentGraphInstance('session-main'), undefined);
      assert.equal((await store.readLatestAgentGraphInstance('session-main'))?.status, 'finished');

      const second = await store.getOrCreateActiveAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-2',
        rootSessionId: 'session-main',
      });
      assert.equal(second.created, true);
      assert.equal(second.instance.sequence, 2);
      assert.notEqual(second.instance.graphId, first.instance.graphId);

      const concurrentRetry = await store.getOrCreateActiveAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-3',
        rootSessionId: 'session-main',
      });
      assert.equal(concurrentRetry.created, false);
      assert.equal(concurrentRetry.instance.graphId, 'graph-2');

      const secondUpdate = await store.commitAgentGraphScheduleUpdate(
        request({
          graphId: 'graph-2',
          updateId: `graph_update_${'f'.repeat(32)}`,
          updateFingerprint: `sha256:${'1'.repeat(64)}`,
          source: {
            sessionId: 'session-main',
            runId: 'run-second',
            turnId: 'turn-second',
            toolCallId: 'tool-second',
          },
        }),
      );
      assert.equal(secondUpdate.update.revision, 1);
      assert.deepEqual(
        (await store.listAgentGraphInstances('session-main')).map((instance) => ({
          graphId: instance.graphId,
          sequence: instance.sequence,
          status: instance.status,
        })),
        [
          { graphId: 'graph-1', sequence: 1, status: 'finished' },
          { graphId: 'graph-2', sequence: 2, status: 'open' },
        ],
      );

      await assert.rejects(
        store.commitAgentGraphScheduleUpdate(
          request({
            updateId: `graph_update_${'2'.repeat(32)}`,
            updateFingerprint: `sha256:${'3'.repeat(64)}`,
            source: {
              sessionId: 'session-main',
              runId: 'run-old',
              turnId: 'turn-old',
              toolCallId: 'tool-old',
            },
          }),
        ),
        /already finished/,
      );
      assert.equal(await store.purgeAgentGraphControlStateForRootSession('session-main'), 5);
      assert.deepEqual(await store.listAgentGraphInstances('session-main'), []);
      assert.deepEqual(await store.listAgentGraphScheduleUpdates('graph-1'), []);
      assert.deepEqual(await store.listAgentGraphScheduleUpdates('graph-2'), []);
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
