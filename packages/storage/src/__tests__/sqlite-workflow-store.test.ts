import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteDeepResearchStore } from '../deep-research-store.js';
import { createSqlitePlanReminderStore } from '../plan-reminder-store.js';
import { createSqlitePlanStore } from '../plan-store.js';
import { createSqliteTaskLedgerStore } from '../task-ledger-store.js';

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

  test('persists Plan Reminders', async () => {
    await withRoot(async (root) => {
      const store = createSqlitePlanReminderStore(root);
      const reminder = await store.create({ title: 'Review SQLite', runAt: Date.now() + 60_000 });
      store.close();

      const reopened = createSqlitePlanReminderStore(root);
      try {
        assert.equal((await reopened.list())[0]?.id, reminder.id);
      } finally {
        reopened.close();
      }
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-workflow-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
