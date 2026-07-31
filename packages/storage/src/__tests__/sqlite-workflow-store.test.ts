import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createDeepResearchStore, createSqliteDeepResearchStore } from '../deep-research-store.js';
import { createPlanReminderStore, createSqlitePlanReminderStore } from '../plan-reminder-store.js';
import { createPlanStore, createSqlitePlanStore } from '../plan-store.js';
import { createSqliteTaskLedgerStore, createTaskLedgerStore } from '../task-ledger-store.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';

const SESSION_ID = 'session-workflow';

describe('SQLite workflow cutover', () => {
  test('imports every workflow ledger once and keeps later writes SQLite-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-'));
    let planId = 0;
    let researchId = 0;
    try {
      const legacyTasks = createTaskLedgerStore(root);
      const {
        created: [legacyTask],
      } = await legacyTasks.create(SESSION_ID, [{ subject: 'Migrate workflow state' }]);
      assert.ok(legacyTask);

      const legacyPlan = createPlanStore(root, {
        newId: () => `plan-id-${++planId}`,
        now: () => 100 + planId,
      });
      const submitted = await legacyPlan.submitProposal({
        sessionId: SESSION_ID,
        turnId: 'turn-plan',
        title: 'Workflow migration',
        steps: [{ id: 'migrate', title: 'Migrate state', description: 'Move state to SQLite' }],
      });

      const legacyResearch = createDeepResearchStore(root, {
        newId: () => `research-id-${++researchId}`,
        now: () => 200 + researchId,
      });
      await legacyResearch.start(SESSION_ID, 'Map the workflow stores', 'deep');

      const legacyReminders = createPlanReminderStore(root);
      const legacyReminder = await legacyReminders.create({
        title: 'Review migration',
        runAt: Date.now() + 60_000,
      });

      const legacyPaths = [
        join(root, 'sessions', SESSION_ID, 'task-events.jsonl'),
        join(root, 'sessions', SESSION_ID, 'tasks.json'),
        join(root, 'sessions', SESSION_ID, 'plan-events.jsonl'),
        join(root, 'sessions', SESSION_ID, 'plans.json'),
        join(root, 'sessions', SESSION_ID, 'deep-research', 'events.jsonl'),
        join(root, 'plan-reminders.json'),
      ];
      const before = await Promise.all(legacyPaths.map((path) => readFile(path, 'utf8')));

      const tasks = createSqliteTaskLedgerStore(root);
      const plan = createSqlitePlanStore(root, {
        newId: () => `sqlite-plan-${++planId}`,
        now: () => 400 + planId,
      });
      const research = createSqliteDeepResearchStore(root, {
        newId: () => `sqlite-research-${++researchId}`,
        now: () => 500 + researchId,
      });
      const reminders = createSqlitePlanReminderStore(root);
      await Promise.all([tasks.ready(), plan.ready(), research.ready(), reminders.ready()]);

      assert.equal((await tasks.get(SESSION_ID, legacyTask.id))?.subject, legacyTask.subject);
      assert.equal(
        (await plan.readState(SESSION_ID)).latestProposalId,
        submitted.state.latestProposalId,
      );
      assert.equal((await research.read(SESSION_ID))?.objective, 'Map the workflow stores');
      assert.equal((await reminders.list())[0]?.id, legacyReminder.id);

      await tasks.update(SESSION_ID, legacyTask.id, { status: 'in_progress' });
      await plan.requestRevision({
        sessionId: SESSION_ID,
        proposalId: submitted.state.latestProposalId!,
      });
      await research.recordArtifact(SESSION_ID, {
        artifactId: 'artifact-1',
        role: 'source',
        name: 'source.md',
        createdAt: 501,
        locator: 'https://example.com/source',
        contentHash: `sha256:${'a'.repeat(64)}`,
        sourceArtifactIds: [],
      });
      await reminders.setEnabled(legacyReminder.id, false);

      assert.deepEqual(
        await Promise.all(legacyPaths.map((path) => readFile(path, 'utf8'))),
        before,
      );

      const lease = acquireOperationalStateDatabase(root);
      try {
        const counts = lease.database
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM workflow_task_ledger_events) AS tasks,
              (SELECT COUNT(*) FROM workflow_plan_events) AS plans,
              (SELECT COUNT(*) FROM workflow_deep_research_events) AS research,
              (SELECT COUNT(*) FROM workflow_plan_reminders) AS reminders
          `)
          .get() as Record<string, number>;
        assert.deepEqual(
          { ...counts },
          {
            tasks: 2,
            plans: 2,
            research: 2,
            reminders: 1,
          },
        );
      } finally {
        lease.close();
      }

      tasks.close();
      plan.close();
      research.close();
      reminders.close();

      const reopenedTasks = createSqliteTaskLedgerStore(root);
      const reopenedPlan = createSqlitePlanStore(root);
      const reopenedResearch = createSqliteDeepResearchStore(root);
      const reopenedReminders = createSqlitePlanReminderStore(root);
      await Promise.all([
        reopenedTasks.ready(),
        reopenedPlan.ready(),
        reopenedResearch.ready(),
        reopenedReminders.ready(),
      ]);
      assert.equal((await reopenedTasks.get(SESSION_ID, legacyTask.id))?.status, 'in_progress');
      assert.equal((await reopenedPlan.readState(SESSION_ID)).proposals[0]?.status, 'stale');
      assert.equal((await reopenedResearch.readEvents(SESSION_ID)).length, 2);
      assert.equal(
        (await reopenedReminders.list()).find((reminder) => reminder.id === legacyReminder.id)
          ?.enabled,
        false,
      );
      reopenedTasks.close();
      reopenedPlan.close();
      reopenedResearch.close();
      reopenedReminders.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rolls back a copied workflow ledger and resumes the same cutover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-crash-'));
    try {
      await createTaskLedgerStore(root).create(SESSION_ID, [{ subject: 'Crash-safe import' }]);
      const interrupted = createSqliteTaskLedgerStore(root, {
        failpoint: (point) => {
          if (point === 'after_cutover_rows_copied') throw new Error('simulated crash');
        },
      });
      await assert.rejects(interrupted.ready(), /simulated crash/);
      interrupted.close();

      const resumed = createSqliteTaskLedgerStore(root);
      await resumed.ready();
      assert.equal((await resumed.list(SESSION_ID)).length, 1);
      const lease = acquireOperationalStateDatabase(root);
      try {
        const row = lease.database
          .prepare(`
            SELECT state
            FROM cutover_journal
            WHERE store_name = 'workflow_task_ledger'
          `)
          .get() as { state?: unknown };
        assert.equal(row.state, 'completed');
      } finally {
        lease.close();
      }
      resumed.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed if a legacy workflow ledger changes after cutover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-fingerprint-'));
    try {
      const legacy = createTaskLedgerStore(root);
      await legacy.create(SESSION_ID, [{ subject: 'Imported task' }]);
      const migrated = createSqliteTaskLedgerStore(root);
      await migrated.ready();
      migrated.close();

      await legacy.create(SESSION_ID, [{ subject: 'Unexpected legacy write' }]);
      const reopened = createSqliteTaskLedgerStore(root);
      await assert.rejects(
        reopened.ready(),
        /Legacy workflow_task_ledger source changed after cutover completed/,
      );
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
