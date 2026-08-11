import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteDeepResearchStore } from '../deep-research-store.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { openInteractiveScheduledTaskStoreForWrite } from '../scheduled-task-store.js';
import { createSqlitePlanStore } from '../plan-store.js';
import { createSqliteTaskLedgerStore } from '../task-ledger-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';

const SESSION_ID = 'session-workflow';

describe('SQLite workflow stores', () => {
  test('persists Task Ledger events and projections', async () => {
    await withRoot(async (root) => {
      const store = createSqliteTaskLedgerStore(root);
      const { created } = await store.create(SESSION_ID, [{ subject: 'Implement SQLite' }]);
      assert.equal(created[0]?.status, 'pending');
      store.close();

      const reopened = createSqliteTaskLedgerStore(root);
      try {
        assert.equal((await reopened.list(SESSION_ID))[0]?.subject, 'Implement SQLite');
      } finally {
        reopened.close();
      }
    });
  });

  test('persists Plan events and their projection', async () => {
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
    });
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

  test('projects a pre-bound legacy Plan ledger into the bounded Host contract', async () => {
    await withRoot(async (root) => {
      seedLegacyPlanLedger(root);
      const store = createSqlitePlanStore(root);
      try {
        const state = await store.readState(SESSION_ID);
        const proposal = state.proposals[0];
        const execution = state.executions[0];
        assert.ok(proposal);
        assert.ok(execution);
        assert.match(proposal.steps[0]!.id, /^[A-Za-z0-9_-]+$/);
        assert.equal(proposal.steps[0]!.files?.length, 50);
        assert.equal(proposal.risks?.length, 20);
        assert.ok(Buffer.byteLength(proposal.steps[0]!.description, 'utf8') < 4_000);
        assert.equal(proposal.legacyProjection?.truncated, true);
        assert.equal(execution.legacyProjection?.truncated, true);
        assert.ok(Buffer.byteLength(proposal.title, 'utf8') < 16 * 1024);
        assert.ok(proposal.steps[0]!.title.length <= 30);

        await assert.rejects(
          store.updateExecution({
            operationId: 'update-legacy',
            sessionId: SESSION_ID,
            executionId: execution.executionId,
            steps: execution.steps.map((step) => ({ id: step.id, status: step.status })),
          }),
          /projected legacy execution/,
        );
        const interrupted = await store.interruptActiveExecution(
          SESSION_ID,
          'Upgrade requires a fresh Plan',
          'interrupt-legacy',
        );
        assert.equal(interrupted?.state.executions[0]?.status, 'interrupted');
        await assert.rejects(
          store.resumeExecution(SESSION_ID, execution.executionId, 'resume-legacy'),
          /projected legacy execution/,
        );

        const cancelled = await store.cancelExecution({
          operationId: 'cancel-legacy',
          sessionId: SESSION_ID,
          executionId: execution.executionId,
          reason: 'Legacy execution closed after upgrade',
        });
        assert.equal(cancelled.state.storeVersion, 5);
        assert.equal(cancelled.state.executions[0]?.status, 'cancelled');
      } finally {
        store.close();
      }
    });
  });

  test('requires a projected legacy proposal to be revised or abandoned', async () => {
    await withRoot(async (root) => {
      seedLegacyPlanLedger(root, 1);
      const store = createSqlitePlanStore(root);
      try {
        const state = await store.readState(SESSION_ID);
        const proposal = state.proposals[0];
        assert.ok(proposal);
        assert.equal(proposal.legacyProjection?.truncated, true);
        await assert.rejects(
          store.approveProposal({
            operationId: 'approve-legacy',
            sessionId: SESSION_ID,
            proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
            expectedStoreVersion: state.storeVersion,
          }),
          /projected legacy plan/,
        );

        const revised = await store.requestRevision({
          operationId: 'revise-legacy',
          sessionId: SESSION_ID,
          proposalId: proposal.proposalId,
        });
        assert.equal(revised.state.proposals[0]?.status, 'stale');
      } finally {
        store.close();
      }
    });
  });

  test('purges Plan events and projections for retired Sessions', async () => {
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
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask test root');
  return {
    owner,
    open: () => openInteractiveScheduledTaskStoreForWrite(owner.lease),
  };
}

function seedLegacyPlanLedger(root: string, eventCount = 3): void {
  const lease = acquireOperationalStateDatabase(root);
  try {
    // Each dimension exceeds its projection bound by just enough to force
    // truncation: 51 files > PLAN_MAX_FILES_PER_STEP, 21 risks >
    // PLAN_MAX_RISKS, 31 title chars > PLAN_STEP_TITLE_MAX_CHARS, and four
    // 4_000-byte descriptions oversubscribe PLAN_PROJECTION_ITEM_MAX_BYTES so
    // the shared text budget must settle below 4_000 bytes.
    const steps = Array.from({ length: 4 }, (_, index) => ({
      id: `legacy step ${index}`,
      title: '"'.repeat(31),
      description: '"'.repeat(4_000),
      files: Array.from({ length: 51 }, () => '"'.repeat(100)),
    }));
    const proposal = {
      planId: 'legacy-plan',
      proposalId: 'legacy-proposal',
      sessionId: SESSION_ID,
      turnId: 'legacy-turn',
      revision: 1,
      title: '"'.repeat(16 * 1024),
      steps,
      risks: Array.from({ length: 21 }, (_, index) => `Legacy risk ${index}`),
      status: 'pending_approval',
      submittedAt: 1,
    };
    const execution = {
      executionId: 'legacy-execution',
      planId: proposal.planId,
      proposalId: proposal.proposalId,
      sessionId: SESSION_ID,
      status: 'active',
      steps: steps.map((step) => ({ ...step, status: 'pending', updatedAt: 2 })),
      startedAt: 2,
      updatedAt: 2,
    };
    const events = [
      {
        type: 'plan_submitted',
        id: 'legacy-submit',
        sessionId: SESSION_ID,
        ts: 1,
        storeVersion: 1,
        proposal,
      },
      {
        type: 'plan_approved',
        id: 'legacy-approve',
        sessionId: SESSION_ID,
        ts: 2,
        storeVersion: 2,
        proposalId: proposal.proposalId,
        execution,
      },
      {
        type: 'plan_progress_updated',
        id: 'legacy-progress',
        sessionId: SESSION_ID,
        ts: 3,
        storeVersion: 3,
        executionId: execution.executionId,
        steps: execution.steps.map((step, index) => ({
          ...step,
          status: index === 0 ? 'in_progress' : 'pending',
          note: '"'.repeat(4_000),
          updatedAt: 3,
        })),
        explanation: '"'.repeat(16 * 1024),
      },
    ];
    const insert = lease.database.prepare(`
      INSERT INTO workflow_plan_events(
        session_id, sequence, event_id, store_version, record_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    events.slice(0, eventCount).forEach((event, sequence) => {
      insert.run(SESSION_ID, sequence, event.id, event.storeVersion, JSON.stringify(event));
    });
  } finally {
    lease.close();
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
