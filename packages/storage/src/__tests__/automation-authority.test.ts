import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { AutomationDefinition, AutomationPendingFire } from '@maka/core/automation';
import {
  authenticateInteractiveAutomationAuthorityWriter,
  openInteractiveAutomationAuthorityForWrite,
  type InteractiveAutomationAuthorityWriter,
} from '../automation-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';

describe('interactive Automation authority', () => {
  test('single-flights one authentic writer and atomically commits definitions with pending fires', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveAutomationAuthorityForWrite(owner.lease),
          openInteractiveAutomationAuthorityForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveAutomationAuthorityWriter(first), first);

        const automation = definitionWithPendingFire();
        const fire = pendingFire();
        const committed = await first.commit({
          expectedRevision: 0,
          automations: [automation],
          pendingFires: [fire],
        });
        assert.equal(committed.kind, 'committed');
        if (committed.kind !== 'committed') return;
        assert.equal(committed.snapshot.revision, 1);

        automation.name = 'mutated after commit';
        const persisted = (await second.read()).automations[0];
        assert.equal(persisted?.name, 'daily summary');
        assert.deepEqual(persisted?.capabilityRequirements, [capabilityRequirement()]);
        assert.equal(persisted?.waiting?.reason, 'client_capability_provider_unavailable');

        assert.deepEqual(
          await second.commit({ expectedRevision: 0, automations: [], pendingFires: [] }),
          { kind: 'revision_conflict', actualRevision: 1 },
        );
        const settled = await second.commit({
          expectedRevision: 1,
          automations: [{ ...definition(), status: 'completed', nextFireAt: null }],
          pendingFires: [],
        });
        assert.equal(settled.kind, 'committed');

        first.close();
        assert.throws(
          () => authenticateInteractiveAutomationAuthorityWriter(first),
          isInvalidLease,
        );
        const reopened = await openInteractiveAutomationAuthorityForWrite(owner.lease);
        assert.notEqual(reopened, first);
        const snapshot = await reopened.read();
        assert.equal(snapshot.revision, 2);
        assert.equal(snapshot.automations[0]?.status, 'completed');
        assert.deepEqual(snapshot.pendingFires, []);
        reopened.close();
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('updates only changed definition rows while advancing a full-snapshot revision', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveAutomationAuthorityForWrite(owner.lease);
      const second = { ...definition(), id: 'automation-2', name: 'second summary' };
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const first = await writer.commit({
          expectedRevision: 0,
          automations: [definition(), second],
          pendingFires: [],
        });
        assert.equal(first.kind, 'committed');
        database.exec(`
          CREATE TABLE automation_write_audit(operation TEXT NOT NULL, automation_id TEXT NOT NULL);
          CREATE TRIGGER automation_definition_insert_audit
          AFTER INSERT ON automation_definitions BEGIN
            INSERT INTO automation_write_audit VALUES ('insert', NEW.automation_id);
          END;
          CREATE TRIGGER automation_definition_update_audit
          AFTER UPDATE ON automation_definitions BEGIN
            INSERT INTO automation_write_audit VALUES ('update', NEW.automation_id);
          END;
          CREATE TRIGGER automation_definition_delete_audit
          AFTER DELETE ON automation_definitions BEGIN
            INSERT INTO automation_write_audit VALUES ('delete', OLD.automation_id);
          END;
        `);

        const changed = { ...definition(), name: 'updated summary', updatedAt: 2 };
        const committed = await writer.commit({
          expectedRevision: 1,
          automations: [changed, second],
          pendingFires: [],
        });
        assert.equal(committed.kind, 'committed');
        assert.deepEqual(
          database
            .prepare('SELECT operation, automation_id FROM automation_write_audit ORDER BY rowid')
            .all()
            .map((row) => ({ ...row })),
          [{ operation: 'update', automation_id: 'automation-1' }],
        );
      } finally {
        database.close();
        writer.close();
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects multiple pending fires for one Automation without changing canonical state', async () => {
    await withWriter(async ({ writer }) => {
      assert.throws(
        () =>
          void writer.commit({
            expectedRevision: 0,
            automations: [definitionWithPendingFire()],
            pendingFires: [pendingFire(), { ...pendingFire(), id: 'fire-2', runId: 'run-2' }],
          }),
        /Duplicate pending Automation id/,
      );
      assert.deepEqual(await writer.read(), { revision: 0, automations: [], pendingFires: [] });
    });
  });

  test('rejects canonical reads and commits after the owner lease closes', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveAutomationAuthorityForWrite(owner.lease);
      await owner.close();
      await assert.rejects(() => writer.read(), isInvalidLease);
      await assert.rejects(
        () => writer.commit({ expectedRevision: 0, automations: [], pendingFires: [] }),
        isInvalidLease,
      );
      writer.close();
    });
  });

  test('rejects orphaned and contradictory pending fires before mutation', async () => {
    await withWriter(async ({ writer }) => {
      assert.throws(
        () =>
          void writer.commit({
            expectedRevision: 0,
            automations: [],
            pendingFires: [pendingFire()],
          }),
        /has no definition/,
      );
      assert.throws(
        () =>
          void writer.commit({
            expectedRevision: 0,
            automations: [definitionWithPendingFire()],
            pendingFires: [{ ...pendingFire(), prompt: 'Different prompt.' }],
          }),
        /contradicts its definition/,
      );
      assert.deepEqual(await writer.read(), { revision: 0, automations: [], pendingFires: [] });
    });
  });
});

function definition(): AutomationDefinition {
  return {
    id: 'automation-1',
    kind: 'cron',
    name: 'daily summary',
    status: 'active',
    prompt: 'Summarize the workspace.',
    sessionId: 'creator-session',
    schedule: { type: 'interval', seconds: 60 },
    createdAt: 1,
    updatedAt: 1,
    nextFireAt: 60_001,
    lastFireAt: null,
    lastRunId: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: 604_800_001,
    lastError: null,
    consecutiveFailures: 0,
    durable: true,
    execution: {
      cwd: '/workspace',
      backend: 'ai-sdk',
      llmConnectionSlug: 'openrouter',
      model: 'openrouter/free',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  };
}

function definitionWithPendingFire(): AutomationDefinition {
  return {
    ...definition(),
    updatedAt: 60_002,
    nextFireAt: 120_002,
    lastFireAt: 60_002,
    fireCount: 1,
    capabilityRequirements: [capabilityRequirement()],
    waiting: {
      reason: 'client_capability_provider_unavailable',
      since: 60_002,
      message: 'Capability provider is offline',
    },
  };
}

function pendingFire(): AutomationPendingFire {
  return {
    id: 'fire-1',
    automationId: 'automation-1',
    automationKind: 'cron',
    automationName: 'daily summary',
    prompt: 'Summarize the workspace.',
    scheduledFor: 60_001,
    targetSessionId: 'automation-session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    userMessageId: 'message-1',
    status: 'admitted',
    admittedAt: 60_002,
    updatedAt: 60_002,
    capabilityRequirements: [capabilityRequirement()],
    execution: {
      cwd: '/workspace',
      backend: 'ai-sdk',
      llmConnectionSlug: 'openrouter',
      model: 'openrouter/free',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  };
}

function capabilityRequirement() {
  return {
    principalId: 'automation-provider',
    clientInstanceId: 'provider-instance',
    contractId: 'provider-contract',
  } as const;
}

async function withWriter(
  run: (input: { writer: InteractiveAutomationAuthorityWriter }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const writer = await openInteractiveAutomationAuthorityForWrite(owner.lease);
    try {
      await run({ writer });
    } finally {
      writer.close();
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-automation-authority-'));
  try {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
