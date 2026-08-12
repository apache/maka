import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { AgentGraphOperatorProvisionRequest } from '@maka/core/agent-graph-topology';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { createSessionStore } from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import {
  HostScheduledTaskSessionBusyError,
  type HostScheduledTaskSessionRetirement,
} from '../server/scheduled-task-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { MemoryExtractionSessionLane } from '../server/memory-extraction-session-lane.js';
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

  test('retires graph operators with their root family and purges graph sidecars', async () => {
    await withHarness(async (harness) => {
      const childSessionIds = [
        await createClosedGraphOperator(harness, harness.rootId, 'a'),
        await createClosedGraphOperator(harness, harness.revisionId, 'b'),
      ];

      const child = await harness.store.readHeaderRecordSnapshot(childSessionIds[0]!);
      for (const outcome of [
        await harness.coordinator.handlers['session.lifecycle.set'](
          { sessionId: child.header.id, state: 'archived' },
          CONNECTION_CONTEXT,
        ),
        await harness.coordinator.handlers['session.remove'](
          { sessionId: child.header.id, expectedRevision: child.revision },
          CONNECTION_CONTEXT,
        ),
      ]) {
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');
      }
      assert.equal((await harness.store.readHeaderSnapshot(child.header.id)).status, 'active');

      const archived = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.revisionId, state: 'archived' },
        CONNECTION_CONTEXT,
      );
      assert.equal(archived.ok, true);
      for (const childSessionId of childSessionIds) {
        assert.equal((await harness.store.readHeaderSnapshot(childSessionId)).status, 'archived');
      }

      const restored = await harness.coordinator.handlers['session.lifecycle.set'](
        { sessionId: harness.revisionId, state: 'active' },
        CONNECTION_CONTEXT,
      );
      assert.equal(restored.ok, true);
      for (const childSessionId of childSessionIds) {
        assert.equal((await harness.store.readHeaderSnapshot(childSessionId)).status, 'active');
      }

      const target = await harness.store.readHeaderRecordSnapshot(harness.revisionId);
      const removed = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.revisionId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(removed, {
        ok: true,
        result: { kind: 'removed', sessionId: harness.revisionId },
      });
      for (const sessionId of [...harness.familyIds, ...childSessionIds]) {
        assert.deepEqual(await harness.store.probeSessionRemoval(sessionId), {
          kind: 'removed',
        });
      }
      const graphIds = harness.familyIds.map(agentGraphIdForRootSession);
      await waitFor(
        async () =>
          (
            await Promise.all(
              graphIds.map((graphId) => harness.graphStore.listAgentGraphScheduleUpdates(graphId)),
            )
          ).every((updates) => updates.length === 0),
        'Agent Graph sidecar cleanup did not run',
      );
      for (const graphId of graphIds) {
        assert.deepEqual(await harness.graphStore.listAgentGraphOperatorProvisions(graphId), []);
      }
      assert.ok(harness.actions.purgedAgentGraphs.includes(harness.rootId));
      assert.ok(harness.actions.purgedAgentGraphs.includes(harness.revisionId));
    });
  });

  test('recovers graph operators orphaned by an interrupted retirement', async () => {
    await withHarness(async (harness) => {
      const childSessionId = await createClosedGraphOperator(harness, harness.rootId, 'a');
      const database = new DatabaseSync(join(harness.workspaceRoot, 'runtime.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        for (const sessionId of harness.familyIds) {
          database.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId);
          database
            .prepare(
              `
              INSERT INTO session_metadata_tombstones(
                session_id,
                deleted_at,
                retirement_unit_id,
                cleanup_pending
              )
              VALUES (?, ?, ?, 0)
            `,
            )
            .run(sessionId, 1, harness.rootId);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        database.close();
      }
      await harness.coordinator.recover();

      await waitFor(
        async () =>
          (await harness.store.probeSessionRemoval(childSessionId)).kind === 'removed' &&
          (await harness.store.listPendingSessionRetirementCleanupIds()).length === 0,
        'Agent Graph retirement did not converge',
      );
      const graphId = agentGraphIdForRootSession(harness.rootId);
      assert.deepEqual(await harness.graphStore.listAgentGraphScheduleUpdates(graphId), []);
      assert.deepEqual(await harness.graphStore.listAgentGraphOperatorProvisions(graphId), []);
      assert.ok(harness.actions.purgedAgentGraphs.includes(harness.rootId));
    });
  });

  test('recovers graph sidecars without operator provisions', async () => {
    await withHarness(async (harness) => {
      const projectionGraphId = agentGraphIdForRootSession(harness.rootId);
      const finishedGraphId = agentGraphIdForRootSession(harness.revisionId);
      await harness.graphStore.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId: projectionGraphId,
        rootSessionId: harness.rootId,
        expectedSnapshotVersion: null,
        snapshotVersion: 'projection-only-snapshot',
        snapshot: { status: 'idle' },
        replaceOperators: true,
        operators: [],
        terminalActivities: [],
        activityRecords: [],
      });
      await harness.graphStore.commitAgentGraphScheduleUpdate({
        schemaVersion: 1,
        updateId: `graph_update_${'7'.repeat(32)}`,
        updateFingerprint: `sha256:${'8'.repeat(64)}`,
        graphId: finishedGraphId,
        source: {
          sessionId: harness.revisionId,
          runId: 'legacy-finish-run',
          turnId: 'legacy-finish-turn',
          toolCallId: 'legacy-finish-call',
        },
        addWork: [],
        stop: [],
        finish: {
          resultIds: ['legacy-result'],
          reason: 'The result is complete.',
        },
      });

      const database = new DatabaseSync(join(harness.workspaceRoot, 'runtime.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        for (const sessionId of harness.familyIds) {
          database.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId);
          database
            .prepare(
              `
              INSERT INTO session_metadata_tombstones(
                session_id,
                deleted_at,
                retirement_unit_id,
                cleanup_pending
              )
              VALUES (?, ?, ?, 0)
            `,
            )
            .run(sessionId, 1, harness.rootId);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        database.close();
      }
      await harness.coordinator.recover();

      await waitFor(
        async () => (await harness.store.listPendingSessionRetirementCleanupIds()).length === 0,
        'Agent Graph sidecar cleanup did not converge',
      );
      assert.equal(
        await harness.graphStore.readAgentGraphClientProjection(projectionGraphId),
        undefined,
      );
      assert.deepEqual(await harness.graphStore.listAgentGraphScheduleUpdates(finishedGraphId), []);
      assert.ok(harness.actions.purgedAgentGraphs.includes(harness.rootId));
      assert.ok(harness.actions.purgedAgentGraphs.includes(harness.revisionId));
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
        harness.blockers.effect,
        harness.blockers.graph,
        harness.blockers.graphWake,
        harness.blockers.scheduledTasks,
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

  test('retires a bound child worktree only after the Session tombstone commits', async () => {
    await withHarness(async (harness) => {
      const binding = {
        schemaVersion: 1 as const,
        kind: 'git_worktree' as const,
        leaseId: `subagent_worktree_${'a'.repeat(32)}`,
        gitCommonDir: '/tmp/project/.git',
        worktreePath: '/tmp/maka-subagent-worktree',
        branch: `maka/subagent/${'a'.repeat(32)}`,
        baseCommit: 'b'.repeat(40),
      };
      const { header: child } = await harness.store.createSubagent(
        sessionInput('Worktree child', {
          permissionMode: 'execute',
          subagentParent: {
            kind: 'subagent',
            parentSessionId: harness.rootId,
            spawnedBy: {
              parentRunId: 'parent-run',
              parentTurnId: 'parent-turn',
              toolCallId: 'spawn-call',
            },
            lifecycle: 'foreground',
          },
          subagentRuntime: {
            schemaVersion: 1,
            definitionVersion: 1,
            agentId: 'implementation',
            agentName: 'Implementation',
            profile: 'implementation',
            systemPrompt: 'Implement the task.',
            toolNames: ['Read', 'Write'],
            categoryPolicy: {},
          },
          subagentSpawn: {
            schemaVersion: 1,
            requestFingerprint: 'c'.repeat(64),
            initialTurnId: 'child-turn',
            initialRunId: 'child-run',
          },
          cwd: binding.worktreePath,
          subagentWorkspace: binding,
        }),
      );
      harness.retireWorktree = async (retired) => {
        assert.deepEqual(harness.actions.finalizedWorkspacePatches, [child.id]);
        assert.deepEqual(await harness.store.probeSessionRemoval(child.id), {
          kind: 'removed',
        });
        harness.actions.retiredWorktrees.push(retired.leaseId);
      };
      const target = await harness.store.readHeaderRecordSnapshot(child.id);

      const removed = await harness.coordinator.handlers['session.remove'](
        { sessionId: child.id, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );

      assert.equal(removed.ok, true);
      assert.deepEqual(await harness.store.probeSessionRemoval(child.id), {
        kind: 'removed',
      });
      await waitFor(
        () => harness.actions.retiredWorktrees.length === 1,
        'Worktree cleanup did not run',
      );
      assert.deepEqual(harness.actions.retiredWorktrees, [binding.leaseId]);
    });
  });

  test('keeps the Session when workspace patch finalization fails', async () => {
    await withHarness(async (harness) => {
      harness.finalizeWorkspacePatches = async () => {
        throw new Error('injected write-back failure');
      };
      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);

      const removed = await harness.coordinator.handlers['session.remove'](
        { sessionId: harness.rootId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );

      assert.equal(removed.ok, false);
      assert.equal((await harness.store.probeSessionRemoval(harness.rootId)).kind, 'present');
      assert.deepEqual(harness.actions.disposed, []);
      assert.deepEqual(harness.actions.retiredWorktrees, []);
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
      assert.equal(harness.actions.scheduledTaskRollbacks, 1);
      assert.equal(harness.actions.goalCommits, 0);
      assert.equal(harness.actions.scheduledTaskCommits, 0);
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
      assert.equal(harness.actions.scheduledTaskRollbacks, 1);
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

  test('drains cleanup retries accepted before close', async () => {
    await withHarness(async (harness) => {
      let entered = 0;
      let releaseCleanup!: () => void;
      const cleanupRelease = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const firstAttempts = new Set<string>();
      harness.purgeArtifact = async (sessionId) => {
        if (firstAttempts.has(sessionId)) {
          harness.actions.purgedArtifacts.push(sessionId);
          return;
        }
        firstAttempts.add(sessionId);
        entered += 1;
        await cleanupRelease;
        throw new Error('injected first cleanup failure');
      };

      const target = await harness.store.readHeaderRecordSnapshot(harness.rootId);
      assert.deepEqual(
        await harness.coordinator.handlers['session.remove'](
          { sessionId: harness.rootId, expectedRevision: target.revision },
          CONNECTION_CONTEXT,
        ),
        { ok: true, result: { kind: 'removed', sessionId: harness.rootId } },
      );
      await waitFor(
        () => entered === harness.familyIds.length,
        'initial retirement cleanup did not start',
      );

      await harness.coordinator.recover();
      const closing = harness.coordinator.close();
      releaseCleanup();
      await closing;

      assert.deepEqual(await harness.store.listPendingSessionRetirementCleanupIds(), []);
      assert.deepEqual(new Set(harness.actions.purgedArtifacts), new Set(harness.familyIds));
    });
  });

  test('projects a sibling metadata race as a family operation conflict', async () => {
    await withHarness(async (harness) => {
      await harness.store.updateHeader(harness.revisionId, {
        name: 'Different revision',
      });
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
      await waitFor(
        async () => (await harness.store.listPendingSessionRetirementCleanupIds()).length === 0,
        'tombstone retry did not recover the retirement-unit cleanup',
      );
      assert.deepEqual(new Set(harness.actions.purgedArtifacts), new Set(harness.familyIds));
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
        {
          ok: true,
          result: { kind: 'removed', sessionId: harness.revisionId },
        },
        {
          ok: true,
          result: { kind: 'removed', sessionId: harness.revisionId },
        },
      ]);
      assert.equal(harness.actions.goalCommits, 1);
      assert.equal(harness.actions.scheduledTaskCommits, 1);
    });
  });

  test('waits for an in-flight Memory Extraction before retiring its Session family', async () => {
    await withHarness(async (harness) => {
      let releaseExtraction!: () => void;
      let markExtractionStarted!: () => void;
      const extractionStarted = new Promise<void>((resolve) => {
        markExtractionStarted = resolve;
      });
      const extractionRelease = new Promise<void>((resolve) => {
        releaseExtraction = resolve;
      });
      const extraction = harness.memoryExtractionLane.run(harness.rootId, async () => {
        markExtractionStarted();
        await extractionRelease;
      });
      await extractionStarted;

      const target = await harness.store.readHeaderRecordSnapshot(harness.revisionId);
      const retirement = harness.coordinator.handlers['session.remove'](
        { sessionId: harness.revisionId, expectedRevision: target.revision },
        CONNECTION_CONTEXT,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(harness.actions.disposed, []);

      releaseExtraction();
      await extraction;
      assert.deepEqual(await retirement, {
        ok: true,
        result: { kind: 'removed', sessionId: harness.revisionId },
      });
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
  readonly purgedAgentGraphs: string[];
  readonly retiredWorktrees: string[];
  readonly finalizedWorkspacePatches: string[];
  readonly retiredGraphWakes: string[];
  goalCommits: number;
  goalRollbacks: number;
  scheduledTaskCommits: number;
  scheduledTaskRollbacks: number;
  drains: number;
}

async function withHarness(
  operation: (harness: RetirementHarness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-retirement-'));
  const store = createSessionStore(root);
  const graphStore = createAgentGraphControlStore(root);
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
      purgedAgentGraphs: [],
      retiredWorktrees: [],
      finalizedWorkspacePatches: [],
      retiredGraphWakes: [],
      goalCommits: 0,
      goalRollbacks: 0,
      scheduledTaskCommits: 0,
      scheduledTaskRollbacks: 0,
      drains: 0,
    };
    const blockers = {
      root: new Set<string>(),
      message: new Set<string>(),
      interaction: new Set<string>(),
      goal: new Set<string>(),
      resource: new Set<string>(),
      effect: new Set<string>(),
      graph: new Set<string>(),
      graphWake: new Set<string>(),
      scheduledTasks: new Set<string>(),
    };
    const memoryExtractionLane = new MemoryExtractionSessionLane();
    const harness: RetirementHarness = {
      workspaceRoot: root,
      store,
      graphStore,
      rootId: rootSession.id,
      revisionId: revision.id,
      familyIds: [rootSession.id, revision.id],
      actions,
      blockers,
      memoryExtractionLane,
      failRemoveCommit: false,
      failRemovalPublication: false,
      failArtifactCleanup: false,
      purgeArtifact: undefined,
      hideRevisionFromNextFamilyRead: false,
      updateMetadataDuringNextDispose: false,
      updateSiblingBeforeRemoveCommit: false,
      disposeBackend: undefined,
      finalizeWorkspacePatches: undefined,
      retireWorktree: undefined,
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
        reconcileOrphanedAgentGraphRetirements: () =>
          store.reconcileOrphanedAgentGraphRetirements(),
        listPendingSessionRetirementCleanupIds: (sessionId) =>
          store.listPendingSessionRetirementCleanupIds(sessionId),
        completeSessionRetirementCleanup: (sessionId) =>
          store.completeSessionRetirementCleanup(sessionId),
        setSessionsLifecycleVersioned: (sessions, state) =>
          store.setSessionsLifecycleVersioned(sessions, state),
        removeSessionsVersioned: async (sessions) => {
          if (harness.failRemoveCommit) throw new Error('injected remove failure');
          if (harness.updateSiblingBeforeRemoveCommit) {
            harness.updateSiblingBeforeRemoveCommit = false;
            await store.updateHeader(harness.revisionId, {
              name: 'Racing sibling update',
            });
          }
          return store.removeSessionsVersioned(sessions);
        },
      },
      admission: new SessionAdmissionGate(),
      memoryExtractionLane,
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
        beginSessionRetirement: async () => retirementHandle(actions, 'goal'),
        unarchiveSessions: () => undefined,
      },
      scheduledTasks: {
        beginSessionRetirement: async (sessionIds) => {
          if (sessionIds.some((sessionId) => blockers.scheduledTasks.has(sessionId))) {
            throw new HostScheduledTaskSessionBusyError('Session has a bound ScheduledTask');
          }
          return retirementHandle(actions, 'scheduledTasks');
        },
      },
      resources: {
        hasLiveSessionResources: async (sessionId) => blockers.resource.has(sessionId),
      },
      sessionEffects: {
        hasLiveSessionState: (sessionId) => blockers.effect.has(sessionId),
      },
      graph: {
        hasLiveSessionState: async (sessionId) => blockers.graph.has(sessionId),
      },
      graphWake: {
        hasLiveSessionState: (sessionId) => blockers.graphWake.has(sessionId),
        retireSessions: async (sessionIds) => {
          actions.retiredGraphWakes.push(...sessionIds);
          return sessionIds.length;
        },
      },
      manager: {
        finalizeChildWorkspacePatches: async (sessionId) => {
          if (harness.finalizeWorkspacePatches) {
            await harness.finalizeWorkspacePatches(sessionId);
          }
          actions.finalizedWorkspacePatches.push(sessionId);
        },
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
      purgeAgentGraphState: async (sessionId) => {
        actions.purgedAgentGraphs.push(sessionId);
        await graphStore.purgeAgentGraphControlState(agentGraphIdForRootSession(sessionId));
      },
      worktrees: {
        retire: async (binding) => {
          if (harness.retireWorktree) return harness.retireWorktree(binding);
          actions.retiredWorktrees.push(binding.leaseId);
        },
      },
      requestDrain: () => {
        actions.drains += 1;
      },
    });
    coordinator = harness.coordinator;
    await operation(harness);
  } finally {
    await coordinator?.close();
    graphStore.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

interface RetirementHarness {
  readonly workspaceRoot: string;
  readonly store: ReturnType<typeof createSessionStore>;
  readonly graphStore: ReturnType<typeof createAgentGraphControlStore>;
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
    readonly effect: Set<string>;
    readonly graph: Set<string>;
    readonly graphWake: Set<string>;
    readonly scheduledTasks: Set<string>;
  };
  readonly memoryExtractionLane: MemoryExtractionSessionLane;
  coordinator: HostSessionRetirementCoordinator;
  failRemoveCommit: boolean;
  failRemovalPublication: boolean;
  failArtifactCleanup: boolean;
  purgeArtifact: ((sessionId: string) => Promise<void>) | undefined;
  hideRevisionFromNextFamilyRead: boolean;
  updateMetadataDuringNextDispose: boolean;
  updateSiblingBeforeRemoveCommit: boolean;
  disposeBackend: ((sessionId: string) => Promise<void>) | undefined;
  finalizeWorkspacePatches: ((sessionId: string) => Promise<void>) | undefined;
  retireWorktree:
    | ((binding: import('@maka/core/subagent-workspace').SubagentWorkspaceBinding) => Promise<void>)
    | undefined;
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
  owner: 'goal' | 'scheduledTasks',
): HostScheduledTaskSessionRetirement {
  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      settled = true;
      if (owner === 'goal') actions.goalCommits += 1;
      else actions.scheduledTaskCommits += 1;
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      if (owner === 'goal') actions.goalRollbacks += 1;
      else actions.scheduledTaskRollbacks += 1;
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

async function createClosedGraphOperator(
  harness: RetirementHarness,
  rootSessionId: string,
  seed: 'a' | 'b',
): Promise<string> {
  const identity = (suffix: string) => `${seed.repeat(31)}${suffix}`;
  const graphId = agentGraphIdForRootSession(rootSessionId);
  const workId = `graph_work_${identity('1')}`;
  const operatorId = `graph_operator_${identity('2')}`;
  const rootRunId = `root-run-${seed}`;
  const rootTurnId = `root-turn-${seed}`;
  await harness.graphStore.commitAgentGraphScheduleUpdate({
    schemaVersion: 1,
    updateId: `graph_update_${identity('3')}`,
    updateFingerprint: `sha256:${seed.repeat(63)}4`,
    graphId,
    source: {
      sessionId: rootSessionId,
      runId: rootRunId,
      turnId: rootTurnId,
      toolCallId: 'schedule-call',
    },
    addWork: [
      {
        workId,
        target: { kind: 'agent', agentId: 'implementation' },
        instruction: 'Implement the assigned task.',
        inputIds: [],
      },
    ],
    stop: [],
  });
  const request: AgentGraphOperatorProvisionRequest = {
    schemaVersion: 1,
    provisionId: `graph_provision_${identity('5')}`,
    provisionFingerprint: `sha256:${seed.repeat(63)}6`,
    graphId,
    workId,
    agentId: 'implementation',
    operatorId,
    initialTurnId: `operator-turn-${seed}`,
    initialRunId: `operator-run-${seed}`,
    edges: [],
  };
  const child = await harness.store.createAgentGraphOperator(
    sessionInput('Graph operator', {
      permissionMode: 'execute',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: rootSessionId,
        spawnedBy: {
          parentRunId: rootRunId,
          parentTurnId: rootTurnId,
          toolCallId: 'schedule-call',
        },
        graph: { graphId, workId, operatorId },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: 1,
        agentId: 'implementation',
        agentName: 'Implementation',
        profile: 'implementation',
        systemPrompt: 'Implement the assigned task.',
        toolNames: ['Read', 'Write'],
        categoryPolicy: {},
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: seed.repeat(64),
        initialTurnId: request.initialTurnId,
        initialRunId: request.initialRunId,
      },
    }),
    request,
    1,
  );
  await harness.graphStore.commitAgentGraphScheduleUpdate({
    schemaVersion: 1,
    updateId: `graph_update_${identity('8')}`,
    updateFingerprint: `sha256:${seed.repeat(63)}9`,
    graphId,
    source: {
      sessionId: rootSessionId,
      runId: rootRunId,
      turnId: rootTurnId,
      toolCallId: 'finish-call',
    },
    addWork: [],
    stop: [],
    finish: { resultIds: ['operator-result'], reason: 'complete' },
  });
  return child.header.id;
}
