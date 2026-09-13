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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteDeepResearchStore } from '../deep-research-store.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';
import { openInteractiveScheduledTaskStoreForWrite } from '../scheduled-task-store.js';
import { createSqlitePlanStore } from '../plan-store.js';
import { createSqliteSessionTodoStore } from '../session-todo-store.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from '../sqlite-workflow-schema.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

const SESSION_ID = 'session-workflow';

describe('SQLite workflow stores', () => {
  test('persists Plan exclusively through events', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root, {
        newId: (() => {
          let id = 0;
          return () => `plan-${++id}`;
        })(),
        now: () => 100,
      });
      const submitted = await store.submitProposal({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        title: 'SQLite plan',
        steps: [{ id: 'one', title: 'Persist state', description: 'Write one transaction' }],
      });
      store.close();

      const reopened = createSqlitePlanStore(root);
      try {
        assert.equal(
          (await reopened.readState(SESSION_ID)).latestProposalId,
          submitted.state.latestProposalId,
        );
      } finally {
        reopened.close();
      }

      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(rowCount(database, 'workflow_plan_events'), 1);
        assert.equal(tableExists(database, 'workflow_plan_projections'), false);
      } finally {
        database.close();
      }
    });
  });

  test('migrates released workflow schema 9 projections to the current workflow schema', async () => {
    await withRoot(async (root) => {
      const planStore = createSqlitePlanStore(root, { newId: () => 'proposal-1', now: () => 100 });
      const submitted = await planStore.submitProposal({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        title: 'Preserve Plan events',
        steps: [{ id: 'one', title: 'Replay', description: 'Ignore stale projection bytes' }],
      });
      planStore.close();

      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released);
        released
          .prepare(
            'INSERT INTO workflow_task_ledger_projections(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, '{not-json');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 999, '{not-json');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      const migratedPlan = createSqlitePlanStore(root);
      try {
        assert.equal(
          (await migratedPlan.readState(SESSION_ID)).latestProposalId,
          submitted.state.latestProposalId,
        );
      } finally {
        migratedPlan.close();
      }

      const verified = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(workflowSchemaVersion(verified), SQLITE_WORKFLOW_SCHEMA_VERSION);
        assert.equal(tableExists(verified, 'workflow_task_ledger_projections'), false);
        assert.equal(tableExists(verified, 'workflow_plan_projections'), false);
        assert.equal(rowCount(verified, 'workflow_plan_events'), 1);
      } finally {
        verified.close();
      }
    });
  });

  test('restores SessionTodo storage and drops Task Ledger events from workflow schema 10', async () => {
    await withRoot(async (root) => {
      createSqliteSessionTodoStore(root).close();

      // Recreate the schema-10 shape: SessionTodo storage did not exist yet and
      // Task Ledger events did, so the migration has to add one and drop the other.
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        released.exec(`
          CREATE TABLE workflow_task_ledger_events (
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK (sequence >= 0),
            event_id TEXT NOT NULL,
            record_json TEXT NOT NULL,
            PRIMARY KEY (session_id, sequence),
            UNIQUE (session_id, event_id)
          );
        `);
        released
          .prepare(`
            INSERT INTO workflow_task_ledger_events(session_id, sequence, event_id, record_json)
            VALUES (?, 0, 'retired-event', '{}')
          `)
          .run(SESSION_ID);
        released.exec('DROP TABLE workflow_session_todo_documents');
        setWorkflowSchemaVersion(released, 10);
      } finally {
        released.close();
      }

      const migrated = createSqliteSessionTodoStore(root);
      try {
        assert.deepEqual(await migrated.readOrBootstrap(SESSION_ID), { items: [] });
      } finally {
        migrated.close();
      }

      const verified = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(workflowSchemaVersion(verified), SQLITE_WORKFLOW_SCHEMA_VERSION);
        assert.equal(tableExists(verified, 'workflow_task_ledger_events'), false);
        assert.equal(rowCount(verified, 'workflow_session_todo_documents'), 1);
      } finally {
        verified.close();
      }
    });
  });

  test('preserves every released projection when one table has unfamiliar DDL', async () => {
    await withRoot(async (root) => {
      createSqlitePlanStore(root).close();
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released, { planVersionFloor: -1 });
        released
          .prepare(
            'INSERT INTO workflow_task_ledger_projections(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, 'task-sentinel');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 0, 'plan-sentinel');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
          /unfamiliar released shape/u.test(error.message),
      );

      assertReleasedProjectionStatePreserved(root);
    });
  });

  test('preserves every released projection when one table carries an extra trigger', async () => {
    await withRoot(async (root) => {
      createSqlitePlanStore(root).close();
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released);
        released.exec(`
          CREATE TRIGGER workflow_task_ledger_projection_guard
          AFTER INSERT ON workflow_task_ledger_projections
          BEGIN
            SELECT 1;
          END;
        `);
        released
          .prepare(
            'INSERT INTO workflow_task_ledger_projections(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, 'task-sentinel');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 0, 'plan-sentinel');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
          /unexpected object/u.test(error.message),
      );

      assertReleasedProjectionStatePreserved(root);
    });
  });

  test('preserves an unfamiliar projection whose table name differs only by case', async () => {
    await withRoot(async (root) => {
      createSqlitePlanStore(root).close();
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released, {
          taskTableName: 'WORKFLOW_TASK_LEDGER_PROJECTIONS',
        });
        released
          .prepare(
            'INSERT INTO WORKFLOW_TASK_LEDGER_PROJECTIONS(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, 'task-sentinel');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 0, 'plan-sentinel');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
          /unfamiliar released shape/u.test(error.message),
      );

      assertReleasedProjectionStatePreserved(root);
    });
  });

  test('preserves released projections with a sqliteX-prefixed trigger', async () => {
    await withRoot(async (root) => {
      createSqlitePlanStore(root).close();
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released);
        released.exec(`
          CREATE TRIGGER sqliteX_projection_guard
          AFTER INSERT ON workflow_task_ledger_projections
          BEGIN
            SELECT 1;
          END;
        `);
        released
          .prepare(
            'INSERT INTO workflow_task_ledger_projections(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, 'task-sentinel');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 0, 'plan-sentinel');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
          /unexpected object/u.test(error.message),
      );

      assertReleasedProjectionStatePreserved(root);
    });
  });

  test('preserves released projections with a sqliteX-prefixed dependent view', async () => {
    await withRoot(async (root) => {
      createSqlitePlanStore(root).close();
      const released = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        installReleasedProjectionTables(released);
        released.exec(`
          CREATE VIEW sqliteX_projection_guard AS
          SELECT session_id, record_json
          FROM workflow_task_ledger_projections;
        `);
        released
          .prepare(
            'INSERT INTO workflow_task_ledger_projections(session_id, record_json) VALUES (?, ?)',
          )
          .run(SESSION_ID, 'task-sentinel');
        released
          .prepare(
            'INSERT INTO workflow_plan_projections(session_id, store_version, record_json) VALUES (?, ?, ?)',
          )
          .run(SESSION_ID, 0, 'plan-sentinel');
        setWorkflowSchemaVersion(released, 9);
      } finally {
        released.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
          /unexpected schema object view:sqliteX_projection_guard/u.test(error.message),
      );

      assertReleasedProjectionStatePreserved(root);
      const preserved = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(tableExists(preserved, 'sqliteX_projection_guard', 'view'), true);
      } finally {
        preserved.close();
      }
    });
  });

  test('an older workflow reader rejects the newer schema without changing it', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root, { newId: () => 'proposal-1', now: () => 100 });
      await store.submitProposal({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        title: 'Preserve newer workflow state',
        steps: [{ id: 'one', title: 'Persist', description: 'Write one event' }],
      });
      store.close();

      const newer = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        setWorkflowSchemaVersion(newer, SQLITE_WORKFLOW_SCHEMA_VERSION + 1);
        newer.exec(`
          CREATE TABLE workflow_future_sentinel (value TEXT NOT NULL);
          INSERT INTO workflow_future_sentinel(value) VALUES ('preserved');
        `);
      } finally {
        newer.close();
      }

      assert.throws(
        () => createSqlitePlanStore(root),
        /Operational schema workflow is newer than supported/u,
      );

      const preserved = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(workflowSchemaVersion(preserved), SQLITE_WORKFLOW_SCHEMA_VERSION + 1);
        assert.equal(rowCount(preserved, 'workflow_plan_events'), 1);
        assert.equal(
          (
            preserved.prepare('SELECT value FROM workflow_future_sentinel').get() as {
              value?: unknown;
            }
          ).value,
          'preserved',
        );
      } finally {
        preserved.close();
      }
    });
  });

  test('backs up and restores Plan and initialized SessionTodo state', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-workflow-backup-'));
    const stateRoot = join(base, 'state');
    const backupRoot = join(base, 'backup');
    const restoreRoot = join(base, 'restore');
    await mkdir(stateRoot);
    try {
      const planStore = createSqlitePlanStore(stateRoot, {
        newId: () => 'backup-proposal',
        now: () => 100,
      });
      const submitted = await planStore.submitProposal({
        sessionId: SESSION_ID,
        turnId: 'turn-backup',
        title: 'Restore Plan event',
        steps: [{ id: 'restore', title: 'Restore', description: 'Replay the event ledger' }],
      });
      planStore.close();

      const todoStore = createSqliteSessionTodoStore(stateRoot);
      await todoStore.replaceAll('todo-non-empty', [
        { content: 'Restore current Todo', status: 'in_progress' },
      ]);
      await todoStore.replaceAll('todo-empty', []);
      todoStore.close();

      await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
      await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

      const restoredPlan = createSqlitePlanStore(restoreRoot);
      try {
        assert.equal(
          (await restoredPlan.readState(SESSION_ID)).latestProposalId,
          submitted.state.latestProposalId,
        );
      } finally {
        restoredPlan.close();
      }
      const restoredTodos = createSqliteSessionTodoStore(restoreRoot);
      try {
        assert.deepEqual(await restoredTodos.readOrBootstrap('todo-non-empty'), {
          items: [{ content: 'Restore current Todo', status: 'in_progress' }],
        });
        assert.deepEqual(await restoredTodos.readOrBootstrap('todo-empty'), { items: [] });
      } finally {
        restoredTodos.close();
      }

      const restored = new DatabaseSync(join(restoreRoot, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(tableExists(restored, 'workflow_task_ledger_projections'), false);
        assert.equal(tableExists(restored, 'workflow_plan_projections'), false);
        assert.equal(rowCount(restored, 'workflow_plan_events'), 1);
        assert.equal(rowCount(restored, 'workflow_session_todo_documents'), 2);
      } finally {
        restored.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('reconciles exact Plan retries through durable operation identity', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root, {
        newId: (() => {
          let id = 0;
          return () => `generated-${++id}`;
        })(),
        now: () => 100,
      });
      try {
        const input = {
          operationId: 'submit-operation',
          sessionId: SESSION_ID,
          turnId: 'turn-1',
          title: 'Stable plan',
          steps: [{ id: 'one', title: 'Persist once', description: 'Commit one event' }],
        };
        const submitted = await store.submitProposal(input);
        await store.requestRevision({
          operationId: 'revision-operation',
          sessionId: SESSION_ID,
          proposalId:
            submitted.event.type === 'plan_submitted' ? submitted.event.proposal.proposalId : '',
        });

        const retried = await store.submitProposal(input);
        assert.equal(retried.event.id, 'submit-operation');
        assert.equal(retried.state.storeVersion, 1);
        assert.equal(
          (await store.readOperationReceipt(SESSION_ID, input.operationId, input))?.storeVersion,
          1,
        );
        await assert.rejects(
          store.submitProposal({ ...input, title: 'Reused identity' }),
          /identity was reused/,
        );
        await assert.rejects(
          store.readOperationReceipt(SESSION_ID, input.operationId, {
            ...input,
            title: 'Reused identity',
          }),
          /identity was reused/,
        );
        assert.equal((await store.readState(SESSION_ID)).storeVersion, 2);
      } finally {
        store.close();
      }
    });
  });

  test('rejects Plan data that the Runtime Host projection cannot represent', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root);
      try {
        await assert.rejects(
          store.submitProposal({
            sessionId: SESSION_ID,
            turnId: 'turn-1',
            title: 'Invalid identifiers',
            steps: [{ id: 'step one', title: 'Reject input', description: 'Invalid id' }],
          }),
          /canonical entity id/,
        );
        await assert.rejects(
          store.submitProposal({
            sessionId: SESSION_ID,
            turnId: 'turn-2',
            title: 'Oversized text',
            steps: [
              {
                id: 'step-1',
                title: 'Reject input',
                description: 'x'.repeat(16 * 1024 + 1),
              },
            ],
          }),
          /text limit/,
        );
        await assert.rejects(
          store.submitProposal({
            sessionId: SESSION_ID,
            turnId: 'turn-3',
            title: 'Oversized projection',
            steps: Array.from({ length: 16 }, (_, index) => ({
              id: `step-${index}`,
              title: `Step ${index}`,
              description: 'x'.repeat(4_000),
            })),
          }),
          /projection item limit/,
        );
        assert.equal((await store.readState(SESSION_ID)).storeVersion, 0);
      } finally {
        store.close();
      }
    });
  });

  test('reserves enough projection space for the complete Plan lifecycle', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root);
      try {
        const submitted = await store.submitProposal({
          operationId: 'submit-lifecycle',
          sessionId: SESSION_ID,
          turnId: 'turn-lifecycle',
          title: 'Lifecycle-safe plan',
          steps: Array.from({ length: 50 }, (_, index) => ({
            id: `step-${index}`,
            title: `Step ${index}`,
            description: 'x'.repeat(900),
          })),
        });
        assert.equal(submitted.event.type, 'plan_submitted');
        if (submitted.event.type !== 'plan_submitted') return;
        const approval = {
          sessionId: SESSION_ID,
          proposalId: submitted.event.proposal.proposalId,
          expectedRevision: submitted.event.proposal.revision,
          expectedStoreVersion: submitted.state.storeVersion,
        };
        const approved = await store.approveProposal({
          ...approval,
          operationId: 'approve-lifecycle',
        });
        await assert.rejects(
          store.approveProposal({ ...approval, operationId: 'approve-again' }),
          /already approved by another operation/,
        );
        assert.equal(approved.event.type, 'plan_approved');
        if (approved.event.type !== 'plan_approved') return;

        await store.interruptActiveExecution(SESSION_ID, 'i'.repeat(1024), 'interrupt-lifecycle');
        const cancelled = await store.cancelExecution({
          operationId: 'cancel-lifecycle',
          sessionId: SESSION_ID,
          executionId: approved.event.execution.executionId,
          reason: 'c'.repeat(1024),
        });

        assert.equal(cancelled.state.storeVersion, 4);
        assert.equal(cancelled.state.executions[0]?.status, 'cancelled');
      } finally {
        store.close();
      }
    });
  });

  test('rejects proposals whose later lifecycle projection would overflow', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root);
      try {
        await assert.rejects(
          store.submitProposal({
            sessionId: SESSION_ID,
            turnId: 'turn-lifecycle-overflow',
            title: 'Lifecycle overflow',
            steps: Array.from({ length: 50 }, (_, index) => ({
              id: `step-${index}`,
              title: `Step ${index}`,
              description: 'x'.repeat(1_100),
            })),
          }),
          /projection item limit/,
        );
      } finally {
        store.close();
      }
    });
  });

  test('purges Plan events for retired Sessions', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanStore(root);
      try {
        await store.submitProposal({
          sessionId: SESSION_ID,
          turnId: 'turn-1',
          title: 'Disposable plan',
          steps: [{ id: 'one', title: 'Remove state', description: 'Purge the ledger' }],
        });
        await store.purgeSessionState(SESSION_ID);
        assert.deepEqual(await store.readState(SESSION_ID), {
          schemaVersion: 1,
          sessionId: SESSION_ID,
          storeVersion: 0,
          proposals: [],
          executions: [],
        });
      } finally {
        store.close();
      }
    });
  });

  test('persists Deep Research events', async () => {
    await withRoot(async (root) => {
      const store = createSqliteDeepResearchStore(root, {
        newId: () => 'research-1',
        now: () => 200,
      });
      await store.start(SESSION_ID, 'Map the SQLite authority', 'deep');
      store.close();

      const reopened = createSqliteDeepResearchStore(root);
      try {
        assert.equal((await reopened.read(SESSION_ID))?.objective, 'Map the SQLite authority');
      } finally {
        reopened.close();
      }
    });
  });

  test('purges Deep Research events for retired Sessions', async () => {
    await withRoot(async (root) => {
      const store = createSqliteDeepResearchStore(root);
      try {
        await store.start(SESSION_ID, 'Remove the retired research workspace', 'standard');
        await store.purgeSessionState(SESSION_ID);
        assert.equal(await store.read(SESSION_ID), undefined);
        assert.deepEqual(await store.readEvents(SESSION_ID), []);
      } finally {
        store.close();
      }
    });
  });

  test('persists Scheduled Tasks and admits each fire once', async () => {
    await withRoot(async (root) => {
      const now = Date.now();
      const { owner, open } = await scheduledTaskStoreRoot(root);
      const store = await open();
      const task = await store.create(
        {
          title: 'Review SQLite',
          intentBody: '',
          schedule: { kind: 'once', runAt: now + 1_000 },
          effect: { kind: 'notify', channel: 'local' },
          createdBy: { kind: 'user' },
        },
        now,
      );
      const claims = await Promise.all([
        store.claimNextDue(now + 1_000),
        store.claimNextDue(now + 1_000),
      ]);
      const claim = claims.map((entry) => entry.claim).find((entry) => entry !== null);
      assert.ok(claim);
      assert.equal(claims.filter((entry) => entry.claim !== null).length, 1);
      assert.equal((await store.claimNextDue(now + 1_000)).claim, null);
      await store.settleFire(claim.id, {
        at: now + 1_000,
        outcome: 'ok',
        message: 'done',
      });
      store.close();

      const reopened = await open();
      try {
        const persisted = (await reopened.list())[0];
        assert.equal(persisted?.id, task.id);
        assert.equal(persisted?.status, 'completed');
        assert.equal(persisted?.fireCount, 1);
      } finally {
        reopened.close();
        await owner.close();
      }
    });
  });

  test('persists the exact ScheduledTask Agent execution identity before admission', async () => {
    await withRoot(async (root) => {
      const now = Date.now();
      const { owner, open } = await scheduledTaskStoreRoot(root);
      const store = await open();
      const task = await store.create(
        {
          title: 'Durable Agent fire',
          intentBody: 'Continue the release',
          schedule: { kind: 'once', runAt: now + 1_000 },
          effect: {
            kind: 'agent_run',
            execution: {
              cwd: '/workspace',
              backend: 'ai-sdk',
              llmConnectionId: 'connection-default',
              llmConnectionSlug: 'default',
              model: 'test-model',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
            },
          },
          createdBy: { kind: 'user' },
        },
        now,
      );
      assert.equal(
        task.effect.kind === 'agent_run' ? task.effect.execution.llmConnectionId : undefined,
        'connection-default',
      );
      const claim = await store.claimNow(task.id, now);
      await store.bindFireExecution(claim.id, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        userMessageId: 'message-1',
      });
      store.close();

      const reopened = await open();
      try {
        assert.deepEqual((await reopened.listPendingFires())[0]?.execution, {
          sessionId: 'session-1',
          turnId: 'turn-1',
          runId: 'run-1',
          userMessageId: 'message-1',
        });
      } finally {
        reopened.close();
        await owner.close();
      }
    });
  });

  test('folds retired permission modes in tasks and pending fire claims', async () => {
    await withRoot(async (root) => {
      const now = Date.now();
      const { owner, open } = await scheduledTaskStoreRoot(root);
      const store = await open();
      await assert.rejects(
        () =>
          store.create(
            {
              title: 'Reject retired input',
              intentBody: 'run',
              schedule: { kind: 'once', runAt: now + 1_000 },
              effect: {
                kind: 'agent_run',
                execution: {
                  cwd: '/workspace',
                  llmConnectionId: 'connection-default',
                  llmConnectionSlug: 'default',
                  model: 'test-model',
                  permissionMode: 'execute',
                  collaborationMode: 'agent',
                  orchestrationMode: 'default',
                },
              },
              createdBy: { kind: 'user' },
            },
            now,
          ),
        /execution.permissionMode is required/,
      );
      const task = await store.create(
        {
          title: 'Decode retired rows',
          intentBody: 'run',
          schedule: { kind: 'once', runAt: now + 1_000 },
          effect: {
            kind: 'agent_run',
            execution: {
              cwd: '/workspace',
              llmConnectionId: 'connection-default',
              llmConnectionSlug: 'default',
              model: 'test-model',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
            },
          },
          createdBy: { kind: 'user' },
        },
        now,
      );
      await store.claimNow(task.id, now);
      store.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database.exec(`
          UPDATE workflow_scheduled_tasks
          SET record_json = json_set(record_json, '$.effect.execution.permissionMode', 'execute');
          UPDATE workflow_scheduled_task_fires
          SET record_json = json_set(record_json, '$.task.effect.execution.permissionMode', 'execute');
        `);
      } finally {
        database.close();
      }

      const reopened = await open();
      try {
        const decodedTask = (await reopened.list())[0];
        const decodedClaim = (await reopened.listPendingFires())[0];
        assert.equal(
          decodedTask?.effect.kind === 'agent_run'
            ? decodedTask.effect.execution.permissionMode
            : undefined,
          'ask',
        );
        assert.equal(
          decodedClaim?.task.effect.kind === 'agent_run'
            ? decodedClaim.task.effect.execution.permissionMode
            : undefined,
          'ask',
        );
      } finally {
        reopened.close();
        await owner.close();
      }
    });
  });

  test('does not lower maxFires below the task fire count', async () => {
    await withRoot(async (root) => {
      const now = Date.now();
      const { owner, open } = await scheduledTaskStoreRoot(root);
      const store = await open();
      try {
        const task = await store.create(
          {
            title: 'Bounded recurrence',
            intentBody: '',
            schedule: { kind: 'interval', everySeconds: 60, startAt: now + 1_000 },
            effect: { kind: 'notify', channel: 'local' },
            createdBy: { kind: 'user' },
          },
          now,
        );
        const claim = await store.claimNow(task.id, now);
        await store.settleFire(claim.id, { at: now, outcome: 'ok', message: 'done' });
        await assert.rejects(
          () => store.update(task.id, { maxFires: 1 }, now + 1),
          /maxFires must be greater than the current fireCount/,
        );
      } finally {
        store.close();
        await owner.close();
      }
    });
  });
});

async function scheduledTaskStoreRoot(root: string) {
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask test root');
  return {
    owner,
    open: () => openInteractiveScheduledTaskStoreForWrite(owner.lease),
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tableExists(database: DatabaseSync, name: string, type = 'table'): boolean {
  return (
    database
      .prepare('SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?')
      .get(type, name) !== undefined
  );
}

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count?: unknown;
  };
  assert.equal(typeof row.count, 'number');
  return row.count as number;
}

function installReleasedProjectionTables(
  database: DatabaseSync,
  options: { planVersionFloor?: number; taskTableName?: string } = {},
): void {
  const taskTableName = options.taskTableName ?? 'workflow_task_ledger_projections';
  database.exec(`
    CREATE TABLE ${taskTableName} (
      session_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
    CREATE TABLE workflow_plan_projections (
      session_id TEXT PRIMARY KEY,
      store_version INTEGER NOT NULL CHECK (store_version >= ${options.planVersionFloor ?? 0}),
      record_json TEXT NOT NULL
    );
  `);
}

function setWorkflowSchemaVersion(database: DatabaseSync, version: number): void {
  database
    .prepare("UPDATE operational_schema_migrations SET version = ? WHERE scope = 'workflow'")
    .run(version);
}

function workflowSchemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
    .get() as { version?: unknown } | undefined;
  const version = row?.version;
  assert.equal(typeof version, 'number');
  return version as number;
}

function assertReleasedProjectionStatePreserved(root: string): void {
  const preserved = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    assert.equal(workflowSchemaVersion(preserved), 9);
    assert.equal(rowCount(preserved, 'workflow_task_ledger_projections'), 1);
    assert.equal(rowCount(preserved, 'workflow_plan_projections'), 1);
  } finally {
    preserved.close();
  }
}
