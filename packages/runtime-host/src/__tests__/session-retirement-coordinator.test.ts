import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { createSessionStore } from '@maka/storage';
import {
  HostAutomationSessionBusyError,
  type HostAutomationSessionRetirement,
} from '../server/automation-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostSessionRetirementCoordinator } from '../server/session-retirement-coordinator.js';

const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'retirement-test',
  connectionId: 'retirement-test-connection',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('Host Session retirement coordinator', () => {
  test('archives, restores, and removes one whole edit-and-resend family', async () => {
    await withHarness(async (harness) => {
      const archived = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.revisionId, state: 'archived' },
        CONNECTION_CONTEXT,
      );
      assert.equal(archived.ok, true);
      if (!archived.ok) return;
      if ('kind' in archived.result) assert.fail('Expected a supported Session projection');
      assert.equal(archived.result.id, harness.revisionId);
      assert.equal(archived.result.isArchived, true);
      await assertFamilyLifecycle(harness, true);
      assert.deepEqual(new Set(harness.actions.disposed), new Set(harness.familyIds));
      assert.deepEqual(new Set(harness.actions.refreshed), new Set(harness.familyIds));

      harness.actions.disposed.length = 0;
      harness.actions.refreshed.length = 0;
      const restored = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.rootId, state: 'active' },
        CONNECTION_CONTEXT,
      );
      assert.equal(restored.ok, true);
      if (!restored.ok) return;
      if ('kind' in restored.result) assert.fail('Expected a supported Session projection');
      assert.equal(restored.result.isArchived, false);
      await assertFamilyLifecycle(harness, false);
      assert.deepEqual(harness.actions.disposed, []);
      assert.deepEqual(new Set(harness.actions.refreshed), new Set(harness.familyIds));

      const target = await harness.store.readHeaderRecordSnapshot(harness.revisionId);
      const stale = await harness.coordinator.handlers['session.remove'](
        {
          sessionId: harness.revisionId,
          expectedRevision: target.revision + 1,
        },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(stale, {
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: target.revision + 1,
          actualRevision: target.revision,
        },
      });
      assert.deepEqual(harness.actions.disposed, []);

      const removed = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.revisionId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(removed, {
        ok: true,
        result: { kind: 'removed', sessionId: harness.revisionId },
      });
      for (const sessionId of harness.familyIds) {
        assert.deepEqual(await harness.store.probeSessionRemoval(sessionId), {
          kind: 'removed',
        });
      }
      assert.deepEqual(new Set(harness.actions.removedContinuity), new Set(harness.familyIds));
      assert.deepEqual(new Set(harness.actions.retiredCapabilities), new Set(harness.familyIds));
      assert.deepEqual(new Set(harness.actions.retiredMessages), new Set(harness.familyIds));

      const disposeCount = harness.actions.disposed.length;
      assert.deepEqual(
        await harness.coordinator.handlers['session.remove'](
          { sessionId: harness.revisionId, expectedRevision: target.revision },
          CONNECTION_CONTEXT,
        ),
        removed,
      );
      assert.equal(harness.actions.disposed.length, disposeCount);
    });
  });

  test('rejects a busy signal from each retirement participant before side effects', async () => {
    await withHarness(async (harness) => {
      const blockers = [
        harness.blockers.root,
        harness.blockers.message,
        harness.blockers.interaction,
        harness.blockers.goal,
        harness.blockers.resource,
        harness.blockers.automation,
      ];
      for (const blocker of blockers) {
        blocker.add(harness.rootId);
        const outcome = await harness.coordinator.handlers['session.lifecycle.set'](
          { sessionId: harness.revisionId, state: 'archived' },
          CONNECTION_CONTEXT,
        );
        assert.equal(outcome.ok, false);
        if (outcome.ok) assert.fail('Live owner must block Session retirement');
        assert.equal(outcome.error.code, 'session_busy');
        await assertFamilyLifecycle(harness, false);
        assert.deepEqual(harness.actions.disposed, []);
        assert.deepEqual(harness.actions.retiredCapabilities, []);
        assert.deepEqual(harness.actions.retiredMessages, []);
        blocker.clear();
      }
    });
  });

  test('re-resolves a revision family that changes before admission', async () => {
    await withHarness(async (harness) => {
      harness.hideRevisionFromNextFamilyRead = true;
      const archived = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.rootId, state: 'archived' },
        CONNECTION_CONTEXT,
      );
      assert.equal(archived.ok, true);
      await assertFamilyLifecycle(harness, true);
      assert.deepEqual(new Set(harness.actions.refreshed), new Set(harness.familyIds));
    });
  });

  test('commits against metadata refreshed after backend disposal', async () => {
    await withHarness(async (harness) => {
      harness.updateMetadataDuringNextDispose = true;
      const archived = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.rootId, state: 'archived' },
        CONNECTION_CONTEXT,
      );
      assert.equal(archived.ok, true);
      await assertFamilyLifecycle(harness, true);
    });
  });

  test('rolls back owner fences when the durable remove commit fails', async () => {
    await withHarness(async (harness) => {
      harness.failRemoveCommit = true;
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      const outcome = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.error.code, 'persistence_failed');
      assert.equal(harness.actions.goalRollbacks, 1);
      assert.equal(harness.actions.automationRollbacks, 1);
      assert.equal(harness.actions.goalCommits, 0);
      assert.equal(harness.actions.automationCommits, 0);
      assert.deepEqual(harness.actions.retiredCapabilities, []);
      assert.deepEqual(harness.actions.retiredMessages, []);
      for (const sessionId of harness.familyIds) {
        assert.equal((await harness.store.probeSessionRemoval(sessionId)).kind, 'present');
      }
    });
  });

  test('joins family backend disposal failures and drains the Host', async () => {
    await withHarness(async (harness) => {
      let releaseSibling!: () => void;
      const siblingRelease = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      let siblingSettled = false;
      harness.disposeBackend = async (sessionId) => {
        harness.actions.disposed.push(sessionId);
        if (sessionId === harness.rootId) throw new Error('injected backend disposal failure');
        await siblingRelease;
        siblingSettled = true;
      };
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      let removalSettled = false;
      const removal = harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      ).then((outcome) => {
        removalSettled = true;
        return outcome;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(removalSettled, false);
      releaseSibling();
      const outcome = await removal;
      assert.equal(siblingSettled, true);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.error.code, 'persistence_failed');
      assert.equal(harness.actions.drains, 1);
      assert.equal(harness.actions.goalRollbacks, 1);
      assert.equal(harness.actions.automationRollbacks, 1);
      assert.equal((await harness.store.probeSessionRemoval(harness.rootId)).kind, 'present');
    });
  });

  test('keeps aggregate cleanup retryable without changing a committed remove result', async () => {
    await withHarness(async (harness) => {
      harness.failArtifactCleanup = true;
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      const removed = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(removed, {
        ok: true,
        result: { kind: 'removed', sessionId: harness.rootId },
      });
      assert.equal(harness.actions.drains, 0);
      await waitFor(
        () => harness.actions.purgedTasks.length === harness.familyIds.length,
        'retirement cleanup was not attempted',
      );
      assert.deepEqual(
        new Set(await harness.store.listPendingSessionRetirementCleanupIds()),
        new Set(harness.familyIds),
      );

      harness.failArtifactCleanup = false;
      await harness.coordinator.recover();
      await waitFor(
        async () => (await harness.store.listPendingSessionRetirementCleanupIds()).length === 0,
        'retirement cleanup was not retried',
      );
      assert.deepEqual(await harness.store.listPendingSessionRetirementCleanupIds(), []);
      assert.deepEqual(new Set(harness.actions.purgedArtifacts), new Set(harness.familyIds));
      assert.deepEqual(new Set(harness.actions.purgedTasks), new Set(harness.familyIds));
      assert.deepEqual(new Set(harness.actions.purgedOperationalState), new Set(harness.familyIds));
    });
  });

  test('returns after the tombstone commit and joins active cleanup on close', async () => {
    await withHarness(async (harness) => {
      let enterCleanup!: () => void;
      const cleanupEntered = new Promise<void>((resolve) => {
        enterCleanup = resolve;
      });
      let releaseCleanup!: () => void;
      const cleanupRelease = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      harness.purgeArtifact = async (sessionId) => {
        harness.actions.purgedArtifacts.push(sessionId);
        enterCleanup();
        await cleanupRelease;
      };

      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      assert.deepEqual(
        await harness.coordinator.handlers['session.remove'](
          { sessionId: harness.rootId, expectedRevision: target.revision },
          CONNECTION_CONTEXT,
        ),
        { ok: true, result: { kind: 'removed', sessionId: harness.rootId } },
      );
      await cleanupEntered;

      let closeSettled = false;
      const closing = harness.coordinator.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false);
      releaseCleanup();
      await closing;
      assert.equal(closeSettled, true);
      assert.deepEqual(await harness.store.listPendingSessionRetirementCleanupIds(), []);
    });
  });

  test('projects a sibling metadata race as a family operation conflict', async () => {
    await withHarness(async (harness) => {
      await harness.store.updateHeader(harness.revisionId, { name: 'Different revision' });
      harness.updateSiblingBeforeRemoveCommit = true;
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      const outcome = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.error.code, 'operation_conflict');
      assert.equal(harness.actions.drains, 0);
    });
  });

  test('drains after post-commit publication failure and converges on tombstone retry', async () => {
    await withHarness(async (harness) => {
      harness.failRemovalPublication = true;
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      const uncertain = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.equal(uncertain.ok, false);
      if (uncertain.ok) return;
      assert.equal(uncertain.error.code, 'commit_outcome_unknown');
      assert.equal(harness.actions.drains, 1);
      for (const sessionId of harness.familyIds) {
        assert.deepEqual(await harness.store.probeSessionRemoval(sessionId), {
          kind: 'removed',
        });
      }

      assert.deepEqual(
        await harness.coordinator.handlers['session.remove'](
          { sessionId: harness.rootId, expectedRevision: target.revision },
          CONNECTION_CONTEXT,
        ),
        { ok: true, result: { kind: 'removed', sessionId: harness.rootId } },
      );
      assert.equal(harness.actions.drains, 1);
    });
  });

  test('concurrent equivalent removes converge after waiting on the family lane', async () => {
    await withHarness(async (harness) => {
      const target = await harness.store.readHeaderRecordSnapshot(harness.revisionId);
      const input = {
        sessionId: harness.revisionId,
        expectedRevision: target.revision,
      };
      const outcomes = await Promise.all([
        harness.coordinator.handlers['session.remove'](input, CONNECTION_CONTEXT),
        harness.coordinator.handlers['session.remove'](input, CONNECTION_CONTEXT),
      ]);
      assert.deepEqual(outcomes, [
        { ok: true, result: { kind: 'removed', sessionId: harness.revisionId } },
        { ok: true, result: { kind: 'removed', sessionId: harness.revisionId } },
      ]);
      assert.equal(harness.actions.goalCommits, 1);
      assert.equal(harness.actions.automationCommits, 1);
    });
  });
});

interface RetirementActions {
  readonly disposed: string[];
  readonly refreshed: string[];
  readonly removedContinuity: string[];
  readonly retiredCapabilities: string[];
  readonly retiredMessages: string[];
  readonly purgedArtifacts: string[];
  readonly purgedTasks: string[];
  readonly purgedOperationalState: string[];
  goalCommits: number;
  goalRollbacks: number;
  automationCommits: number;
  automationRollbacks: number;
  drains: number;
}

async function withHarness(
  operation: (harness: RetirementHarness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-retirement-'));
  const store = createSessionStore(root);
  let coordinator: HostSessionRetirementCoordinator | undefined;
  try {
    const rootSession = await store.create(sessionInput('Revision root'));
    const revision = await store.create(
      sessionInput('Revision child', {
        revisionRootSessionId: rootSession.id,
        revisionParentSessionId: rootSession.id,
        revisionOfTurnId: 'turn-1',
        revisionIndex: 2,
        revisionState: 'committed',
      }),
    );
    const actions: RetirementActions = {
      disposed: [],
      refreshed: [],
      removedContinuity: [],
      retiredCapabilities: [],
      retiredMessages: [],
      purgedArtifacts: [],
      purgedTasks: [],
      purgedOperationalState: [],
      goalCommits: 0,
      goalRollbacks: 0,
      automationCommits: 0,
      automationRollbacks: 0,
      drains: 0,
    };
    const blockers = {
      root: new Set<string>(),
      message: new Set<string>(),
      interaction: new Set<string>(),
      goal: new Set<string>(),
      resource: new Set<string>(),
      automation: new Set<string>(),
    };
    const harness: RetirementHarness = {
      store,
      rootId: rootSession.id,
      revisionId: revision.id,
      familyIds: [rootSession.id, revision.id],
      actions,
      blockers,
      failRemoveCommit: false,
      failRemovalPublication: false,
      failArtifactCleanup: false,
      purgeArtifact: undefined,
      hideRevisionFromNextFamilyRead: false,
      updateMetadataDuringNextDispose: false,
      updateSiblingBeforeRemoveCommit: false,
      disposeBackend: undefined,
      coordinator: undefined as unknown as HostSessionRetirementCoordinator,
    };
    harness.coordinator = new HostSessionRetirementCoordinator({
      stores: {
        listHeaders: async () => {
          const headers = await store.listHeaders();
          if (!harness.hideRevisionFromNextFamilyRead) return headers;
          harness.hideRevisionFromNextFamilyRead = false;
          return headers.filter((header) => header.id !== revision.id);
        },
        probeSessionRemoval: (sessionId) => store.probeSessionRemoval(sessionId),
        readCatalogRecord: (sessionId) => store.readCatalogRecord(sessionId),
        readHeaderRecordSnapshot: (sessionId) => store.readHeaderRecordSnapshot(sessionId),
        listPendingSessionRetirementCleanupIds: (sessionId) =>
          store.listPendingSessionRetirementCleanupIds(sessionId),
        purgeRemovedSessionTranscript: (sessionId) =>
          store.purgeRemovedSessionTranscript(sessionId),
        completeSessionRetirementCleanup: (sessionId) =>
          store.completeSessionRetirementCleanup(sessionId),
        setSessionsLifecycleVersioned: (sessions, state) =>
          store.setSessionsLifecycleVersioned(sessions, state),
        removeSessionsVersioned: async (sessions) => {
          if (harness.failRemoveCommit) throw new Error('injected remove failure');
          if (harness.updateSiblingBeforeRemoveCommit) {
            harness.updateSiblingBeforeRemoveCommit = false;
            await store.updateHeader(harness.revisionId, { name: 'Racing sibling update' });
          }
          return store.removeSessionsVersioned(sessions);
        },
      },
      admission: new SessionAdmissionGate(),
      root: {
        readRootState: (sessionId) =>
          blockers.root.has(sessionId)
            ? ({ kind: 'reserved' } as const)
            : ({ kind: 'idle' } as const),
      },
      messages: {
        hasLiveSessionState: (sessionId) => blockers.message.has(sessionId),
        retireSessions: (sessionIds) => actions.retiredMessages.push(...sessionIds),
      },
      interactions: {
        hasPendingSession: async (sessionId) => blockers.interaction.has(sessionId),
      },
      goals: {
        hasLiveGoal: (sessionId) => blockers.goal.has(sessionId),
        beginSessionRetirement: () => retirementHandle(actions, 'goal'),
        unarchiveSessions: () => undefined,
      },
      automation: {
        beginSessionRetirement: async (sessionIds) => {
          if (sessionIds.some((sessionId) => blockers.automation.has(sessionId))) {
            throw new HostAutomationSessionBusyError('Session has a live Automation');
          }
          return retirementHandle(actions, 'automation');
        },
      },
      resources: {
        hasLiveSessionResources: async (sessionId) => blockers.resource.has(sessionId),
      },
      manager: {
        disposeSessionBackend: async (sessionId) => {
          if (harness.disposeBackend) return harness.disposeBackend(sessionId);
          actions.disposed.push(sessionId);
          if (harness.updateMetadataDuringNextDispose) {
            harness.updateMetadataDuringNextDispose = false;
            await store.updateHeader(sessionId, { name: 'Disposed backend' });
          }
        },
      },
      capabilities: {
        retireSessions: (sessionIds) => actions.retiredCapabilities.push(...sessionIds),
      },
      continuity: {
        refreshCanonical: async (sessionId) => {
          actions.refreshed.push(sessionId);
        },
        retireSessions: async (sessionIds) => {
          if (harness.failRemovalPublication) {
            throw new Error('injected publication failure');
          }
          actions.removedContinuity.push(...sessionIds);
        },
      },
      artifacts: {
        purgeSessionArtifacts: async (sessionId) => {
          if (harness.purgeArtifact) return harness.purgeArtifact(sessionId);
          if (harness.failArtifactCleanup) throw new Error('injected Artifact cleanup failure');
          actions.purgedArtifacts.push(sessionId);
        },
      },
      taskLedger: {
        purgeConversationTaskLedger: async (sessionId) => {
          actions.purgedTasks.push(sessionId);
        },
      },
      purgeOperationalState: async (sessionId) => {
        actions.purgedOperationalState.push(sessionId);
      },
      requestDrain: () => {
        actions.drains += 1;
      },
    });
    coordinator = harness.coordinator;
    await operation(harness);
  } finally {
    await coordinator?.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

interface RetirementHarness {
  readonly store: ReturnType<typeof createSessionStore>;
  readonly rootId: string;
  readonly revisionId: string;
  readonly familyIds: readonly string[];
  readonly actions: RetirementActions;
  readonly blockers: {
    readonly root: Set<string>;
    readonly message: Set<string>;
    readonly interaction: Set<string>;
    readonly goal: Set<string>;
    readonly resource: Set<string>;
    readonly automation: Set<string>;
  };
  coordinator: HostSessionRetirementCoordinator;
  failRemoveCommit: boolean;
  failRemovalPublication: boolean;
  failArtifactCleanup: boolean;
  purgeArtifact: ((sessionId: string) => Promise<void>) | undefined;
  hideRevisionFromNextFamilyRead: boolean;
  updateMetadataDuringNextDispose: boolean;
  updateSiblingBeforeRemoveCommit: boolean;
  disposeBackend: ((sessionId: string) => Promise<void>) | undefined;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function retirementHandle(
  actions: RetirementActions,
  owner: 'goal' | 'automation',
): HostAutomationSessionRetirement {
  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      settled = true;
      if (owner === 'goal') actions.goalCommits += 1;
      else actions.automationCommits += 1;
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      if (owner === 'goal') actions.goalRollbacks += 1;
      else actions.automationRollbacks += 1;
    },
  };
}

async function assertFamilyLifecycle(harness: RetirementHarness, archived: boolean): Promise<void> {
  for (const sessionId of harness.familyIds) {
    const header = await harness.store.readHeaderSnapshot(sessionId);
    assert.equal(header.isArchived, archived);
    assert.equal(header.status === 'archived', archived);
  }
}

function sessionInput(
  name: string,
  overrides: Partial<CreateSessionInput> = {},
): CreateSessionInput {
  return {
    cwd: '/workspace',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name,
    labels: [],
    ...overrides,
  };
}
