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
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { type AgentGraphOperatorProvisionRequest } from '@maka/core/agent-graph-topology';
import { type AgentRunHeader } from '@maka/core/agent-run';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';
import { requireStartedTurn } from './fixtures/execution-host-suite.js';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type SessionCatalogItem,
  type SessionCatalogProjection,
} from '../protocol/index.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 10_000;
const REVISION_TARGET_ID = 'revision-target';
const ADMITTED_REVISION_TARGET_ID = 'admitted-revision-target';
const LINEAGE_REVISION_TARGET_ID = 'lineage-revision-target';
const LINEAGE_BRANCH_TARGET_ID = 'lineage-branch-target';
const GRAPH_REVISION_TARGET_ID = 'graph-revision-target';

test('two Clients share exact retryable Session branch and revision authority', {
  skip: process.platform === 'win32' ? 'Windows SQLite shutdown lifecycle' : false,
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-session-revision-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const {
    sourceSessionId,
    busySessionId,
    linkedChildSourceSessionId,
    metadataLinkedSourceSessionId,
    ordinaryLinkedChildSessionId,
    archivedOwnedSourceSessionId,
    graphChildSessionId,
    continuationSourceSessionId,
  } = await seedSource(root, capability);
  let host: ExecutionHostHandle | undefined;
  try {
    host = await startHost(root, capability.rootId);
    await verifyConcurrentRevisionAuthority(
      root,
      sourceSessionId,
      busySessionId,
      linkedChildSourceSessionId,
      metadataLinkedSourceSessionId,
      ordinaryLinkedChildSessionId,
      archivedOwnedSourceSessionId,
      graphChildSessionId,
      continuationSourceSessionId,
    );
    await stopHost(host);
    host = undefined;

    host = await startHost(root, capability.rootId);
    await verifyRestartRecoveryAndAdmission(root, sourceSessionId);
    await stopHost(host);
    host = undefined;

    host = await startHost(root, capability.rootId);
    await verifySecondRestartRetention(root, sourceSessionId);
    await stopHost(host);
    host = undefined;

    await verifyDurableBranch(
      capability,
      sourceSessionId,
      'branch-target',
      ADMITTED_REVISION_TARGET_ID,
      LINEAGE_REVISION_TARGET_ID,
      LINEAGE_BRANCH_TARGET_ID,
      GRAPH_REVISION_TARGET_ID,
      graphChildSessionId,
    );
  } finally {
    await terminateHost(host);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(capability.rootId);
    await rm(base, { recursive: true, force: true });
  }
});

async function verifyConcurrentRevisionAuthority(
  root: string,
  sourceSessionId: string,
  busySessionId: string,
  linkedChildSourceSessionId: string,
  metadataLinkedSourceSessionId: string,
  ordinaryLinkedChildSessionId: string,
  archivedOwnedSourceSessionId: string,
  graphChildSessionId: string,
  continuationSourceSessionId: string,
): Promise<void> {
  const desktop = await connectClient(root);
  const tui = await connectClient(root);
  try {
    const source = await querySession(desktop, sourceSessionId);
    const continuationSource = await querySession(desktop, continuationSourceSessionId);
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: continuationSourceSessionId,
        targetSessionId: 'continuation-copy-target',
        sourceTurnId: 'continuation-parent-turn',
        expectedSourceRevision: continuationSource.revision,
      }),
      operationError('operation_unavailable'),
    );
    assert.deepEqual(
      await tui.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'continuation-copy-target',
      }),
      { kind: 'session', session: null },
    );
    const linkedChildSource = await querySession(desktop, linkedChildSourceSessionId);
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: linkedChildSourceSessionId,
        targetSessionId: 'linked-child-copy-target',
        sourceTurnId: 'linked-turn',
        expectedSourceRevision: linkedChildSource.revision,
      }),
      operationError('operation_unavailable'),
    );
    assert.deepEqual(
      await tui.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'linked-child-copy-target',
      }),
      { kind: 'session', session: null },
    );
    const graphRevision = await desktop.request('session.revision.create', {
      sourceSessionId: linkedChildSourceSessionId,
      targetSessionId: GRAPH_REVISION_TARGET_ID,
      sourceTurnId: 'linked-after-turn',
      expectedSourceRevision: linkedChildSource.revision,
    });
    assert.equal(graphRevision.kind, 'committed');
    if (graphRevision.kind !== 'committed') assert.fail('Graph revision must commit');
    const copiedGraph = await tui.request('agent.graph.query', {
      rootSessionId: GRAPH_REVISION_TARGET_ID,
    });
    assert.equal(copiedGraph.status, 'empty');
    assert.deepEqual(copiedGraph.operators, []);
    const sourceGraph = await desktop.request('agent.graph.query', {
      rootSessionId: linkedChildSourceSessionId,
    });
    assert.equal(sourceGraph.status, 'completed');
    assert.equal(sourceGraph.operators[0]?.childSessionId, graphChildSessionId);
    await desktop.startTurn({
      sessionId: GRAPH_REVISION_TARGET_ID,
      turnId: 'graph-revision-new-turn',
      content: { text: 'continue independently' },
    });
    const metadataLinkedSource = await querySession(desktop, metadataLinkedSourceSessionId);
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: metadataLinkedSourceSessionId,
        targetSessionId: 'metadata-linked-copy-target',
        sourceTurnId: 'metadata-linked-turn',
        expectedSourceRevision: metadataLinkedSource.revision,
      }),
      operationError('operation_unavailable'),
    );
    const ordinaryLinkedChild = await querySession(desktop, ordinaryLinkedChildSessionId);
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: ordinaryLinkedChildSessionId,
        targetSessionId: 'ordinary-linked-child-branch-target',
        sourceTurnId: 'metadata-child-turn',
        expectedSourceRevision: ordinaryLinkedChild.revision,
      }),
      operationError('operation_conflict'),
    );
    await assert.rejects(
      desktop.request('session.revision.create', {
        sourceSessionId: ordinaryLinkedChildSessionId,
        targetSessionId: 'ordinary-linked-child-revision-target',
        sourceTurnId: 'metadata-child-turn',
        expectedSourceRevision: ordinaryLinkedChild.revision,
      }),
      operationError('operation_conflict'),
    );
    const archivedOwnedSource = await querySession(desktop, archivedOwnedSourceSessionId);
    await assert.rejects(
      desktop.request('session.branch.create', {
        sourceSessionId: archivedOwnedSourceSessionId,
        targetSessionId: 'archived-owned-copy-target',
        sourceTurnId: 'archived-owned-turn',
        expectedSourceRevision: archivedOwnedSource.revision,
      }),
      operationError('operation_unavailable'),
    );
    for (const sessionId of ['metadata-linked-copy-target', 'archived-owned-copy-target']) {
      assert.deepEqual(
        await tui.request('session.catalog.query', {
          kind: 'get',
          sessionId,
        }),
        { kind: 'session', session: null },
      );
    }
    const branchInput = {
      sourceSessionId,
      targetSessionId: 'branch-target',
      sourceTurnId: 'turn-1',
      expectedSourceRevision: source.revision,
    };
    const [desktopBranch, tuiBranch] = await Promise.all([
      desktop.request('session.branch.create', branchInput),
      tui.request('session.branch.create', branchInput),
    ]);
    assert.deepEqual(desktopBranch, tuiBranch);
    assert.equal(desktopBranch.kind, 'committed');
    if (desktopBranch.kind !== 'committed') assert.fail('Branch must commit');
    const branch = requireSessionProjection(desktopBranch.session);
    assert.equal(branch.parentSessionId, sourceSessionId);
    assert.equal(branch.branchOfTurnId, 'turn-1');
    assert.equal(branch.isFlagged, true);
    assert.equal(branch.connectionLocked, true);

    const artifactPage = await desktop.request('artifact.query', {
      kind: 'list_start',
      sessionId: branch.id,
    });
    assert.equal(artifactPage.kind, 'page');
    if (artifactPage.kind !== 'page') assert.fail('Branch Artifact query must return a page');
    assert.equal(artifactPage.artifacts.length, 2);
    assert.notEqual(artifactPage.artifacts[0]?.id, 'source-artifact');
    const taskPage = await tui.request('task.ledger.query', {
      kind: 'list_start',
      sessionId: branch.id,
    });
    assert.equal(taskPage.kind, 'page');
    if (taskPage.kind !== 'page') assert.fail('Branch Task Ledger query must return a page');
    assert.deepEqual(taskPage.tasks.map((task) => task.subject).sort(), [
      'Legacy child task',
      'Retained task',
    ]);

    const renamed = await desktop.request('session.metadata.update', {
      sessionId: sourceSessionId,
      expectedRevision: source.revision,
      patch: { name: 'Renamed source' },
    });
    assert.equal(renamed.kind, 'committed');
    if (renamed.kind !== 'committed') assert.fail('Source rename must commit');
    const renamedSource = requireSessionProjection(renamed.session);
    assert.deepEqual(await tui.request('session.branch.create', branchInput), desktopBranch);
    assert.deepEqual(
      await tui.request('session.branch.create', {
        ...branchInput,
        expectedSourceRevision: renamedSource.revision,
      }),
      desktopBranch,
    );

    const revisionInput = {
      sourceSessionId,
      targetSessionId: REVISION_TARGET_ID,
      sourceTurnId: 'turn-2',
      expectedSourceRevision: renamedSource.revision,
    };
    const revised = await desktop.request('session.revision.create', revisionInput);
    assert.equal(revised.kind, 'committed');
    if (revised.kind !== 'committed') assert.fail('Revision must commit');
    const revision = requireSessionProjection(revised.session);
    assert.equal(revision.revisionRootSessionId, sourceSessionId);
    assert.equal(revision.revisionParentSessionId, sourceSessionId);
    assert.equal(revision.revisionOfTurnId, 'turn-2');
    assert.equal(revision.revisionIndex, 2);
    assert.equal(revision.revisionState, 'preparing');

    const abandonedTargetId = 'abandoned-revision-target';
    const abandonedRevision = await desktop.request('session.revision.create', {
      ...revisionInput,
      targetSessionId: abandonedTargetId,
    });
    assert.equal(abandonedRevision.kind, 'committed');
    assert.deepEqual(
      await desktop.request('session.revision.abandon', {
        targetSessionId: abandonedTargetId,
      }),
      { kind: 'abandoned', sessionId: abandonedTargetId },
    );
    assert.equal((await querySession(desktop, sourceSessionId)).id, sourceSessionId);
    assert.equal((await querySession(desktop, REVISION_TARGET_ID)).id, REVISION_TARGET_ID);
    assert.deepEqual(
      await desktop.request('session.catalog.query', {
        kind: 'get',
        sessionId: abandonedTargetId,
      }),
      { kind: 'session', session: null },
    );

    const sourceAfterRevision = await querySession(tui, sourceSessionId);
    const staleExpectedRevision = sourceAfterRevision.revision + 1;
    const stale = await tui.request('session.revision.create', {
      ...revisionInput,
      targetSessionId: 'stale-revision-target',
      expectedSourceRevision: staleExpectedRevision,
    });
    assert.deepEqual(stale, {
      kind: 'source_revision_conflict',
      expectedRevision: staleExpectedRevision,
      actualRevision: sourceAfterRevision.revision,
    });
    await assert.rejects(
      desktop.request('session.branch.create', {
        ...branchInput,
        sourceTurnId: 'turn-2',
      }),
      operationError('operation_conflict'),
    );

    const busyTurn = requireStartedTurn(
      await desktop.startTurn({
        sessionId: busySessionId,
        turnId: 'busy-turn',
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
    // This case only needs a live Turn to prove `session_busy`. Leaving the
    // parked ask-question continuation for Host SIGTERM leaves live
    // interactions at close, which poisons composition shutdown (#2295).
    // Cleanup must still run if the assertion fails, but it must not replace
    // that failure with a stopTurn error.
    let assertionError: unknown;
    try {
      const busy = await querySession(desktop, busySessionId);
      await assert.rejects(
        tui.request('session.branch.create', {
          sourceSessionId: busySessionId,
          targetSessionId: 'busy-source-copy',
          sourceTurnId: 'busy-turn',
          expectedSourceRevision: busy.revision,
        }),
        operationError('session_busy'),
      );
    } catch (error) {
      assertionError = error;
    }
    try {
      const stopped = await desktop.stopTurn(
        {
          sessionId: busySessionId,
          turnId: 'busy-turn',
          runId: busyTurn.runId,
        },
        PROCESS_TIMEOUT_MS,
      );
      assert.equal(stopped.status, 'cancelled');
    } catch (cleanupError) {
      if (assertionError !== undefined) {
        throw new AggregateError(
          [assertionError, cleanupError],
          'session_busy check failed and parked-turn cleanup failed',
        );
      }
      throw cleanupError;
    }
    if (assertionError !== undefined) throw assertionError;
  } finally {
    await Promise.allSettled([desktop.close(), tui.close()]);
  }
}

async function verifyRestartRecoveryAndAdmission(
  root: string,
  sourceSessionId: string,
): Promise<void> {
  const restarted = await connectClient(root);
  try {
    assert.deepEqual(
      await restarted.request('session.catalog.query', {
        kind: 'get',
        sessionId: REVISION_TARGET_ID,
      }),
      { kind: 'session', session: null },
    );
    const source = await querySession(restarted, sourceSessionId);
    const retried = await restarted.request('session.revision.create', {
      sourceSessionId,
      targetSessionId: REVISION_TARGET_ID,
      sourceTurnId: 'turn-2',
      expectedSourceRevision: source.revision,
    });
    assert.equal(retried.kind, 'committed');
    if (retried.kind !== 'committed') assert.fail('Recovered revision retry must commit');
    assert.equal(requireSessionProjection(retried.session).revisionIndex, 2);

    const admitted = await restarted.request('session.revision.create', {
      sourceSessionId,
      targetSessionId: ADMITTED_REVISION_TARGET_ID,
      sourceTurnId: 'turn-2',
      expectedSourceRevision: source.revision,
    });
    assert.equal(admitted.kind, 'committed');
    if (admitted.kind !== 'committed') assert.fail('Admitted revision must commit');
    assert.equal(requireSessionProjection(admitted.session).revisionIndex, 3);
    await restarted.startTurn({
      sessionId: ADMITTED_REVISION_TARGET_ID,
      turnId: 'turn-3',
      content: { text: 'commit this revision' },
    });
    assert.equal(
      (await querySession(restarted, ADMITTED_REVISION_TARGET_ID)).revisionState,
      'committed',
    );
    assert.deepEqual(
      await restarted.request('session.revision.abandon', {
        targetSessionId: ADMITTED_REVISION_TARGET_ID,
      }),
      { kind: 'retained', sessionId: ADMITTED_REVISION_TARGET_ID },
    );
    assert.equal(
      (await querySession(restarted, ADMITTED_REVISION_TARGET_ID)).id,
      ADMITTED_REVISION_TARGET_ID,
    );

    const lineageRevision = await restarted.request('session.revision.create', {
      sourceSessionId,
      targetSessionId: LINEAGE_REVISION_TARGET_ID,
      sourceTurnId: 'turn-2',
      expectedSourceRevision: source.revision,
    });
    assert.equal(lineageRevision.kind, 'committed');
    if (lineageRevision.kind !== 'committed') assert.fail('Lineage revision must commit');
    const lineageSource = requireSessionProjection(lineageRevision.session);
    assert.equal(lineageSource.revisionState, 'preparing');
    const lineageBranch = await restarted.request('session.branch.create', {
      sourceSessionId: LINEAGE_REVISION_TARGET_ID,
      targetSessionId: LINEAGE_BRANCH_TARGET_ID,
      sourceTurnId: 'turn-1',
      expectedSourceRevision: lineageSource.revision,
    });
    assert.equal(lineageBranch.kind, 'committed');
    assert.deepEqual(
      await restarted.request('session.revision.abandon', {
        targetSessionId: LINEAGE_REVISION_TARGET_ID,
      }),
      { kind: 'retained', sessionId: LINEAGE_REVISION_TARGET_ID },
    );
    assert.equal(
      (await querySession(restarted, LINEAGE_REVISION_TARGET_ID)).id,
      LINEAGE_REVISION_TARGET_ID,
    );
    assert.equal(
      (await querySession(restarted, LINEAGE_BRANCH_TARGET_ID)).id,
      LINEAGE_BRANCH_TARGET_ID,
    );
  } finally {
    await restarted.close();
  }
}

async function verifySecondRestartRetention(root: string, sourceSessionId: string): Promise<void> {
  const recovered = await connectClient(root);
  try {
    assert.deepEqual(
      await recovered.request('session.catalog.query', {
        kind: 'get',
        sessionId: REVISION_TARGET_ID,
      }),
      { kind: 'session', session: null },
    );
    assert.equal(
      (await querySession(recovered, ADMITTED_REVISION_TARGET_ID)).revisionState,
      'committed',
    );
    assert.equal(
      (await querySession(recovered, LINEAGE_REVISION_TARGET_ID)).revisionState,
      'committed',
    );
    assert.equal(
      (await querySession(recovered, GRAPH_REVISION_TARGET_ID)).revisionState,
      'committed',
    );
    const archivedGraphRevision = requireSessionProjection(
      await recovered.request('session.lifecycle.set', {
        sessionId: GRAPH_REVISION_TARGET_ID,
        state: 'archived',
      }),
    );
    assert.equal(archivedGraphRevision.isArchived, true);
    const restoredGraphRevision = requireSessionProjection(
      await recovered.request('session.lifecycle.set', {
        sessionId: GRAPH_REVISION_TARGET_ID,
        state: 'active',
      }),
    );
    assert.equal(restoredGraphRevision.isArchived, false);
    assert.equal(
      (await querySession(recovered, LINEAGE_BRANCH_TARGET_ID)).parentSessionId,
      LINEAGE_REVISION_TARGET_ID,
    );
    const archived = requireSessionProjection(
      await recovered.request('session.lifecycle.set', {
        sessionId: sourceSessionId,
        state: 'archived',
      }),
    );
    assert.equal(archived.isArchived, true);
    await assert.rejects(
      recovered.request('session.revision.create', {
        sourceSessionId,
        targetSessionId: 'archived-revision-target',
        sourceTurnId: 'turn-2',
        expectedSourceRevision: archived.revision,
      }),
      operationError('operation_conflict'),
    );
    assert.deepEqual(
      await recovered.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'archived-revision-target',
      }),
      { kind: 'session', session: null },
    );
    const restored = requireSessionProjection(
      await recovered.request('session.lifecycle.set', {
        sessionId: sourceSessionId,
        state: 'active',
      }),
    );
    assert.equal(restored.isArchived, false);
  } finally {
    await recovered.close();
  }
}

async function seedSource(
  root: string,
  capability: StorageRootCapability<'interactive'>,
): Promise<{
  sourceSessionId: string;
  busySessionId: string;
  linkedChildSourceSessionId: string;
  metadataLinkedSourceSessionId: string;
  ordinaryLinkedChildSessionId: string;
  archivedOwnedSourceSessionId: string;
  graphChildSessionId: string;
  continuationSourceSessionId: string;
}> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for Session setup');
  const graph = createAgentGraphControlStore(root);
  try {
    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const tasks = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await artifacts.recover();
    const source = await execution.sessionStore.create({
      cwd: root,
      name: 'Source Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const busy = await execution.sessionStore.create({
      cwd: root,
      name: 'Busy Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const linkedChildSource = await execution.sessionStore.create({
      cwd: root,
      name: 'Linked Child Source Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const metadataLinkedSource = await execution.sessionStore.create({
      cwd: root,
      name: 'Metadata-linked Source Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const archivedOwnedSource = await execution.sessionStore.create({
      cwd: root,
      name: 'Archived-owned Source Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const continuationSource = await execution.sessionStore.create({
      cwd: root,
      name: 'Continuation Source Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await execution.sessionStore.appendMessage(continuationSource.id, {
      type: 'user',
      id: 'continuation-parent-user',
      turnId: 'continuation-parent-turn',
      ts: 1,
      text: 'retain the child continuation closure',
    });
    const continuationParent = agentRunHeader(
      root,
      continuationSource.id,
      'continuation-parent-run',
      'continuation-parent-invocation',
      'continuation-parent-turn',
    );
    const continuationChild: AgentRunHeader = {
      ...agentRunHeader(
        root,
        continuationSource.id,
        'continuation-child-run',
        'continuation-child-invocation',
        'continuation-child-turn',
      ),
      parentRunId: continuationParent.runId,
      agentId: 'child-agent',
      agentName: 'Child Agent',
      retriedFromRunId: continuationParent.runId,
      retriedFromTurnId: continuationParent.turnId,
      continuationSource: {
        sourceInvocationId: continuationParent.invocationId!,
        sourceRunId: continuationParent.runId,
        sourceTurnId: continuationParent.turnId,
        sourceRuntimeEventHighWater: 1,
      },
    };
    for (const run of [continuationParent, continuationChild]) {
      await execution.agentRunStore.createRun(run);
      if (run.runId === continuationParent.runId) {
        await execution.runtimeEventStore.appendRuntimeEvent(
          run.sessionId,
          run.runId,
          runtimeEvent(run.sessionId, run.runId, run.invocationId!, run.turnId, {
            id: 'continuation-parent-user',
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'retain the child continuation closure' },
          }),
        );
      }
      await execution.runtimeEventStore.appendRuntimeEvent(
        run.sessionId,
        run.runId,
        runtimeEvent(run.sessionId, run.runId, run.invocationId!, run.turnId, {
          id: `${run.runId}-terminal`,
          status: 'completed',
        }),
      );
    }
    const persistedContinuationRuns = await execution.agentRunStore.listSessionRuns(
      continuationSource.id,
    );
    const persistedContinuationChild = persistedContinuationRuns.find(
      (run) => run.runId === continuationChild.runId,
    );
    assert.equal(persistedContinuationChild?.agentId, continuationChild.agentId);
    assert.deepEqual(
      persistedContinuationChild?.continuationSource,
      continuationChild.continuationSource,
    );
    const artifact = await artifacts.create({
      id: 'source-artifact',
      sessionId: source.id,
      turnId: 'turn-1',
      name: 'source.txt',
      kind: 'file',
      content: 'retained bytes',
      mimeType: 'text/plain',
      source: 'user_upload',
      now: 1,
    });
    await artifacts.create({
      id: 'legacy-child-artifact',
      sessionId: source.id,
      turnId: 'legacy-child-turn',
      name: 'legacy-child.txt',
      kind: 'file',
      content: 'legacy child bytes',
      mimeType: 'text/plain',
      source: 'tool_result',
      now: 2,
    });
    await execution.sessionStore.appendMessages(source.id, [
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'first',
        attachments: [
          {
            kind: 'code',
            name: 'source.txt',
            mimeType: 'text/plain',
            bytes: 14,
            ref: {
              kind: 'session_file',
              sessionId: source.id,
              relativePath: artifact.relativePath,
            },
          },
        ],
      },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 2,
        text: 'first response',
        modelId: 'fake-model',
      },
      { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 3, text: 'second' },
      {
        type: 'assistant',
        id: 'assistant-2',
        turnId: 'turn-2',
        ts: 4,
        text: 'second response',
        modelId: 'fake-model',
      },
    ]);
    await execution.sessionStore.updateHeader(source.id, {
      isFlagged: true,
      titleIsManual: true,
    });
    const sourceRuns = [
      agentRunHeader(root, source.id, 'run-turn-1', 'invocation-turn-1', 'turn-1'),
      agentRunHeader(root, source.id, 'run-turn-2', 'invocation-turn-2', 'turn-2'),
      {
        ...agentRunHeader(
          root,
          source.id,
          'legacy-child-run',
          'legacy-child-invocation',
          'legacy-child-turn',
        ),
        parentRunId: 'run-turn-1',
      },
    ];
    for (const run of sourceRuns) await execution.agentRunStore.createRun(run);
    const sourceRuntimeEvents = [
      runtimeEvent(source.id, 'run-turn-1', 'invocation-turn-1', 'turn-1', {
        id: 'user-1',
        ts: 1,
        role: 'user',
        author: 'user',
        content: {
          kind: 'text',
          text: 'first',
          attachments: [
            {
              kind: 'code',
              name: 'source.txt',
              mimeType: 'text/plain',
              bytes: 14,
              ref: {
                kind: 'session_file',
                sessionId: source.id,
                relativePath: artifact.relativePath,
              },
            },
          ],
        },
      }),
      runtimeEvent(source.id, 'run-turn-1', 'invocation-turn-1', 'turn-1', {
        id: 'assistant-1',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'first response' },
      }),
      runtimeEvent(source.id, 'run-turn-1', 'invocation-turn-1', 'turn-1', {
        id: 'terminal-1',
        ts: 2.5,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
      runtimeEvent(source.id, 'run-turn-2', 'invocation-turn-2', 'turn-2', {
        id: 'user-2',
        ts: 3,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'second' },
      }),
      runtimeEvent(source.id, 'run-turn-2', 'invocation-turn-2', 'turn-2', {
        id: 'assistant-2',
        ts: 4,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'second response' },
      }),
      runtimeEvent(source.id, 'run-turn-2', 'invocation-turn-2', 'turn-2', {
        id: 'terminal-2',
        ts: 4.5,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
      runtimeEvent(source.id, 'legacy-child-run', 'legacy-child-invocation', 'legacy-child-turn', {
        id: 'legacy-child-output',
        ts: 2.1,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'legacy child output' },
      }),
      runtimeEvent(source.id, 'legacy-child-run', 'legacy-child-invocation', 'legacy-child-turn', {
        id: 'legacy-child-terminal',
        ts: 2.2,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    for (const event of sourceRuntimeEvents) {
      await execution.runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const graphId = agentGraphIdForRootSession(linkedChildSource.id);
    const graphWorkId = `graph_work_${'1'.repeat(32)}`;
    const graphOperatorId = `graph_operator_${'2'.repeat(32)}`;
    await graph.commitAgentGraphScheduleUpdate({
      schemaVersion: 1,
      updateId: `graph_update_${'3'.repeat(32)}`,
      updateFingerprint: `sha256:${'4'.repeat(64)}`,
      graphId,
      source: {
        sessionId: linkedChildSource.id,
        runId: 'graph-root-run',
        turnId: 'linked-turn',
        toolCallId: 'graph-schedule-call',
      },
      addWork: [
        {
          workId: graphWorkId,
          target: { kind: 'agent', agentId: 'worker' },
          instruction: 'Complete the delegated task.',
          inputIds: [],
        },
      ],
      stop: [],
    });
    const graphProvision: AgentGraphOperatorProvisionRequest = {
      schemaVersion: 1,
      provisionId: `graph_provision_${'5'.repeat(32)}`,
      provisionFingerprint: `sha256:${'6'.repeat(64)}`,
      graphId,
      workId: graphWorkId,
      agentId: 'worker',
      operatorId: graphOperatorId,
      initialTurnId: 'graph-child-turn',
      initialRunId: 'graph-child-run',
      edges: [],
    };
    const graphChild = await execution.sessionStore.createAgentGraphOperator(
      {
        cwd: root,
        name: 'Graph Worker',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: linkedChildSource.id,
          spawnedBy: {
            parentRunId: 'graph-root-run',
            parentTurnId: 'linked-turn',
            toolCallId: 'graph-schedule-call',
          },
          graph: { graphId, workId: graphWorkId, operatorId: graphOperatorId },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'worker',
          agentName: 'Graph Worker',
          profile: 'default',
          systemPrompt: 'Complete the delegated task.',
          toolNames: [],
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: '6'.repeat(64),
          initialTurnId: 'graph-child-turn',
          initialRunId: 'graph-child-run',
        },
      },
      graphProvision,
      1,
    );
    await artifacts.create({
      id: 'graph-child-artifact',
      sessionId: graphChild.header.id,
      turnId: 'graph-child-turn',
      name: 'graph-result.txt',
      kind: 'file',
      content: 'graph child result',
      mimeType: 'text/plain',
      source: 'tool_result',
      now: 3,
    });
    await execution.agentRunStore.createRun(
      agentRunHeader(
        root,
        graphChild.header.id,
        'graph-child-run',
        'graph-child-invocation',
        'graph-child-turn',
      ),
    );
    for (const event of [
      runtimeEvent(
        graphChild.header.id,
        'graph-child-run',
        'graph-child-invocation',
        'graph-child-turn',
        {
          id: 'graph-child-output',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'graph child output' },
        },
      ),
      runtimeEvent(
        graphChild.header.id,
        'graph-child-run',
        'graph-child-invocation',
        'graph-child-turn',
        { id: 'graph-child-terminal', ts: 2, status: 'completed' },
      ),
    ]) {
      await execution.runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const graphResult = {
      kind: 'agent_swarm' as const,
      status: 'completed' as const,
      items: [
        {
          itemId: 'graph-item',
          index: 0,
          profile: 'default',
          started: true,
          childSessionId: graphChild.header.id,
          agentId: 'worker',
          agentName: 'Graph Worker',
          turnId: 'graph-child-turn',
          runId: 'graph-child-run',
          status: 'completed' as const,
          summary: 'done',
          artifactIds: ['graph-child-artifact'],
        },
      ],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };
    await execution.sessionStore.appendMessages(linkedChildSource.id, [
      {
        type: 'user',
        id: 'linked-user',
        turnId: 'linked-turn',
        ts: 1,
        text: 'delegate this',
      },
      {
        type: 'tool_result',
        id: 'linked-result',
        turnId: 'linked-turn',
        ts: 2,
        toolUseId: 'linked-call',
        isError: false,
        content: graphResult,
      },
      {
        type: 'user',
        id: 'linked-after-user',
        turnId: 'linked-after-turn',
        ts: 3,
        text: 'revise this later turn',
      },
      {
        type: 'assistant',
        id: 'linked-after-assistant',
        turnId: 'linked-after-turn',
        ts: 4,
        text: 'later response',
        modelId: 'fake-model',
      },
    ]);
    for (const run of [
      agentRunHeader(
        root,
        linkedChildSource.id,
        'graph-root-run',
        'graph-root-invocation',
        'linked-turn',
      ),
      agentRunHeader(
        root,
        linkedChildSource.id,
        'graph-after-run',
        'graph-after-invocation',
        'linked-after-turn',
      ),
    ]) {
      await execution.agentRunStore.createRun(run);
    }
    const graphRootEvents = [
      runtimeEvent(linkedChildSource.id, 'graph-root-run', 'graph-root-invocation', 'linked-turn', {
        id: 'graph-root-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'delegate this' },
      }),
      runtimeEvent(linkedChildSource.id, 'graph-root-run', 'graph-root-invocation', 'linked-turn', {
        id: 'graph-root-call',
        ts: 1.5,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'linked-call',
          name: 'agent_graph',
          args: { task: 'delegate this' },
        },
      }),
      runtimeEvent(linkedChildSource.id, 'graph-root-run', 'graph-root-invocation', 'linked-turn', {
        id: 'graph-root-result',
        ts: 2,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'linked-call',
          name: 'agent_graph',
          isError: false,
          result: graphResult,
        },
      }),
      runtimeEvent(linkedChildSource.id, 'graph-root-run', 'graph-root-invocation', 'linked-turn', {
        id: 'graph-root-terminal',
        ts: 2.5,
        status: 'completed',
      }),
      runtimeEvent(
        linkedChildSource.id,
        'graph-after-run',
        'graph-after-invocation',
        'linked-after-turn',
        {
          id: 'graph-after-user',
          ts: 3,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'revise this later turn' },
        },
      ),
      runtimeEvent(
        linkedChildSource.id,
        'graph-after-run',
        'graph-after-invocation',
        'linked-after-turn',
        { id: 'graph-after-terminal', ts: 4, status: 'completed' },
      ),
    ];
    for (const event of graphRootEvents) {
      await execution.runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    await graph.commitAgentGraphScheduleUpdate({
      schemaVersion: 1,
      updateId: `graph_update_${'7'.repeat(32)}`,
      updateFingerprint: `sha256:${'8'.repeat(64)}`,
      graphId,
      source: {
        sessionId: linkedChildSource.id,
        runId: 'graph-root-run',
        turnId: 'linked-turn',
        toolCallId: 'graph-finish-call',
      },
      addWork: [],
      stop: [],
      finish: { resultIds: ['graph-item'], reason: 'complete' },
    });
    await execution.sessionStore.appendMessage(metadataLinkedSource.id, {
      type: 'user',
      id: 'metadata-linked-user',
      turnId: 'metadata-linked-turn',
      ts: 1,
      text: 'delegate without a committed result',
    });
    const ordinaryLinkedChild = await execution.sessionStore.createSubagent({
      cwd: root,
      name: 'Metadata-linked Child Session',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: metadataLinkedSource.id,
        spawnedBy: {
          parentRunId: 'metadata-parent-run',
          parentTurnId: 'metadata-linked-turn',
          toolCallId: 'metadata-tool-call',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: 1,
        agentId: 'worker',
        agentName: 'Worker',
        profile: 'default',
        systemPrompt: 'Complete the delegated task.',
        toolNames: [],
        categoryPolicy: {},
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'a'.repeat(64),
        initialTurnId: 'metadata-child-turn',
        initialRunId: 'metadata-child-run',
      },
    });
    const archivedBody = JSON.stringify({
      kind: 'subagent',
      agentName: 'Worker',
      turnId: 'archived-owned-child-turn',
      runId: 'archived-owned-child-run',
      status: 'completed',
      permissionMode: 'ask',
      summary: 'done',
      artifactIds: [],
    });
    const archivedBodySha256 = createHash('sha256').update(archivedBody).digest('hex');
    await artifacts.create({
      id: 'archived-owned-result',
      sessionId: archivedOwnedSource.id,
      turnId: 'archived-owned-child-turn',
      name: 'archived-owned-result.json',
      kind: 'file',
      content: archivedBody,
      mimeType: 'application/json',
      source: 'tool_result_archive',
      now: 1,
    });
    await execution.sessionStore.appendMessages(archivedOwnedSource.id, [
      {
        type: 'user',
        id: 'archived-owned-user',
        turnId: 'archived-owned-turn',
        ts: 1,
        text: 'reuse the archived result',
      },
    ]);
    const archivedOwnedRuns = [
      agentRunHeader(
        root,
        archivedOwnedSource.id,
        'archived-owned-parent-run',
        'archived-owned-parent-invocation',
        'archived-owned-turn',
      ),
      {
        ...agentRunHeader(
          root,
          archivedOwnedSource.id,
          'archived-owned-child-run',
          'archived-owned-child-invocation',
          'archived-owned-child-turn',
        ),
        parentRunId: 'archived-owned-parent-run',
      },
    ];
    for (const run of archivedOwnedRuns) await execution.agentRunStore.createRun(run);
    const archivedOwnedRuntimeEvents = [
      runtimeEvent(
        archivedOwnedSource.id,
        'archived-owned-parent-run',
        'archived-owned-parent-invocation',
        'archived-owned-turn',
        {
          id: 'archived-owned-parent-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'reuse the archived result' },
        },
      ),
      runtimeEvent(
        archivedOwnedSource.id,
        'archived-owned-parent-run',
        'archived-owned-parent-invocation',
        'archived-owned-turn',
        {
          id: 'archived-owned-parent-terminal',
          ts: 3,
          status: 'completed',
        },
      ),
      runtimeEvent(
        archivedOwnedSource.id,
        'archived-owned-child-run',
        'archived-owned-child-invocation',
        'archived-owned-child-turn',
        {
          id: 'archived-owned-child-call',
          ts: 1.5,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'archived-owned-tool-call',
            name: 'subagent',
            args: { task: 'summarize' },
          },
        },
      ),
      runtimeEvent(
        archivedOwnedSource.id,
        'archived-owned-child-run',
        'archived-owned-child-invocation',
        'archived-owned-child-turn',
        {
          id: 'archived-owned-child-result',
          ts: 2,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'archived-owned-tool-call',
            name: 'subagent',
            isError: false,
            result: {
              kind: 'maka.archived_tool_result',
              rewriteVersion: 1,
              artifactId: 'archived-owned-result',
              runtimeEventId: 'archived-owned-child-result',
              toolCallId: 'archived-owned-tool-call',
              toolName: 'subagent',
              bodySha256: archivedBodySha256,
              originalEstimatedTokens: 20,
              originalBytes: Buffer.byteLength(archivedBody, 'utf8'),
              reason: 'stale_tool_result_pruned_before_compact',
            },
          },
        },
      ),
      runtimeEvent(
        archivedOwnedSource.id,
        'archived-owned-child-run',
        'archived-owned-child-invocation',
        'archived-owned-child-turn',
        {
          id: 'archived-owned-child-terminal',
          ts: 2.5,
          status: 'completed',
        },
      ),
    ];
    for (const event of archivedOwnedRuntimeEvents) {
      await execution.runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    await tasks.create(source.id, [{ subject: 'Retained task' }], {
      turnId: 'turn-1',
      source: 'tool',
      actor: 'main_agent',
    });
    await tasks.create(source.id, [{ subject: 'Legacy child task' }], {
      turnId: 'legacy-child-turn',
      runId: 'legacy-child-run',
      source: 'tool',
      actor: 'child_agent',
    });
    await tasks.update(
      source.id,
      (await tasks.list(source.id))[0]!.id,
      { status: 'in_progress' },
      {
        turnId: 'turn-2',
        source: 'tool',
        actor: 'main_agent',
      },
    );
    return {
      sourceSessionId: source.id,
      busySessionId: busy.id,
      linkedChildSourceSessionId: linkedChildSource.id,
      metadataLinkedSourceSessionId: metadataLinkedSource.id,
      ordinaryLinkedChildSessionId: ordinaryLinkedChild.header.id,
      archivedOwnedSourceSessionId: archivedOwnedSource.id,
      graphChildSessionId: graphChild.header.id,
      continuationSourceSessionId: continuationSource.id,
    };
  } finally {
    graph.close();
    await owner.close();
  }
}

async function verifyDurableBranch(
  capability: StorageRootCapability<'interactive'>,
  sourceSessionId: string,
  branchSessionId: string,
  admittedRevisionTargetId: string,
  lineageRevisionTargetId: string,
  lineageBranchTargetId: string,
  graphRevisionTargetId: string,
  graphChildSessionId: string,
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to reacquire execution root');
  try {
    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const tasks = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await artifacts.recover();
    const messages = await execution.sessionStore.readMessagesSnapshot(branchSessionId);
    assert.equal(messages.length, 3);
    const user = messages.find((message) => message.type === 'user');
    assert.ok(user?.attachments?.[0]);
    const ref = user?.attachments?.[0]?.ref;
    assert.equal(ref?.kind, 'session_file');
    if (ref?.kind !== 'session_file') assert.fail('Copied attachment must remain session-backed');
    assert.equal(ref.sessionId, branchSessionId);
    assert.notEqual(ref.relativePath, `${sourceSessionId}/source-artifact-source.txt`);
    assert.equal((await artifacts.listPage(branchSessionId, { offset: 0, limit: 10 })).total, 2);
    assert.deepEqual((await tasks.list(branchSessionId)).map((task) => task.subject).sort(), [
      'Legacy child task',
      'Retained task',
    ]);
    assert.ok((await tasks.list(branchSessionId)).every((task) => task.status === 'pending'));
    const copiedRuns = await execution.agentRunStore.listSessionRuns(branchSessionId);
    assert.equal(copiedRuns.length, 2);
    const copiedChild = copiedRuns.find((run) => run.turnId === 'legacy-child-turn');
    const copiedParent = copiedRuns.find((run) => run.turnId === 'turn-1');
    assert.ok(copiedChild);
    assert.ok(copiedParent);
    assert.equal(copiedChild.parentRunId, copiedParent.runId);
    assert.equal((await artifacts.listPage('revision-target', { offset: 0, limit: 10 })).total, 0);
    assert.deepEqual(await tasks.list('revision-target'), []);
    assert.deepEqual(await execution.agentRunStore.listSessionRuns('revision-target'), []);
    await assert.rejects(
      () => execution.sessionStore.readHeaderSnapshot('revision-target'),
      /not found/i,
    );
    assert.equal(
      (await execution.sessionStore.readHeaderSnapshot(admittedRevisionTargetId)).revisionState,
      'committed',
    );
    assert.equal(
      (await execution.sessionStore.readHeaderSnapshot(lineageRevisionTargetId)).revisionState,
      'committed',
    );
    assert.equal(
      (await execution.sessionStore.readHeaderSnapshot(lineageBranchTargetId)).parentSessionId,
      lineageRevisionTargetId,
    );
    const graphRevisionMessages =
      await execution.sessionStore.readMessagesSnapshot(graphRevisionTargetId);
    const graphResult = graphRevisionMessages.find(
      (message) => message.type === 'tool_result' && message.content.kind === 'agent_swarm',
    );
    assert.ok(graphResult?.type === 'tool_result');
    if (graphResult?.type !== 'tool_result' || graphResult.content.kind !== 'agent_swarm') {
      assert.fail('Copied Graph revision must retain its canonical result');
    }
    assert.equal(graphResult.content.items[0]?.childSessionId, graphChildSessionId);
    assert.equal(graphResult.content.items[0]?.runId, 'graph-child-run');
    assert.deepEqual(graphResult.content.items[0]?.artifactIds, ['graph-child-artifact']);
    const graphRevisionRuns = await execution.agentRunStore.listSessionRuns(graphRevisionTargetId);
    const graphRevisionRun = graphRevisionRuns.find((run) => run.turnId === 'linked-turn');
    assert.ok(graphRevisionRun);
    const graphRuntimeResult = (
      await execution.runtimeEventStore.readRuntimeEvents(
        graphRevisionTargetId,
        graphRevisionRun.runId,
      )
    ).find((event) => event.content?.kind === 'function_response')?.content;
    assert.ok(graphRuntimeResult?.kind === 'function_response');
    if (graphRuntimeResult?.kind !== 'function_response') {
      assert.fail('Copied Graph revision must retain its RuntimeEvent result');
    }
    const runtimeGraphResult = decodeCanonicalToolResultContent(graphRuntimeResult.result);
    assert.equal(runtimeGraphResult.kind, 'agent_swarm');
    if (runtimeGraphResult.kind !== 'agent_swarm') {
      assert.fail('Copied RuntimeEvent result must remain an Agent Graph result');
    }
    const runtimeGraphItem = runtimeGraphResult.items[0];
    assert.equal(runtimeGraphItem?.childSessionId, graphChildSessionId);
    assert.equal(runtimeGraphItem?.runId, 'graph-child-run');
    assert.deepEqual(runtimeGraphItem?.artifactIds, ['graph-child-artifact']);
    assert.equal(
      (await artifacts.getInSession(graphChildSessionId, 'graph-child-artifact')).record?.id,
      'graph-child-artifact',
    );
    assert.equal(
      (await artifacts.listPage(graphRevisionTargetId, { offset: 0, limit: 10 })).total,
      0,
    );
  } finally {
    await owner.close();
  }
}

async function querySession(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<SessionCatalogProjection> {
  const result = await connection.request('session.catalog.query', {
    kind: 'get',
    sessionId,
  });
  assert.equal(result.kind, 'session');
  if (result.kind !== 'session' || !result.session) {
    assert.fail('Session catalog get must return the Session');
  }
  return requireSessionProjection(result.session);
}

function requireSessionProjection(item: SessionCatalogItem): SessionCatalogProjection {
  if ('kind' in item) assert.fail(`Expected a representable Session, received ${item.kind}`);
  return item;
}

interface ExecutionHostHandle {
  readonly child: ChildProcess;
  readonly hostEpoch: string;
  readonly endpoint: string;
}

async function startHost(root: string, rootId: string): Promise<ExecutionHostHandle> {
  const child = fork(
    new URL('./fixtures/execution-host.js', import.meta.url),
    [root, rootId, '60000'],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  try {
    return { child, ...(await waitForHostReady(child)) };
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function stopHost(host: ExecutionHostHandle): Promise<void> {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
  }
  const exit = await withTimeout(
    waitForExit(host.child),
    PROCESS_TIMEOUT_MS,
    'execution Host did not stop',
  );
  assert.deepEqual(exit, { code: 0, signal: null });
}

async function terminateHost(host: ExecutionHostHandle | undefined): Promise<void> {
  if (host) await terminateChild(host.child);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await withTimeout(waitForExit(child), PROCESS_TIMEOUT_MS, 'execution Host did not exit').then(
    () => undefined,
    () => undefined,
  );
}

async function connectClient(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Runtime Host did not accept the Client');
  return result.connection;
}

function waitForHostReady(child: ChildProcess): Promise<{
  hostEpoch: string;
  endpoint: string;
}> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`execution Host exited before readiness: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isHostReadyMessage(message)) return;
        cleanup();
        resolve({ hostEpoch: message.hostEpoch, endpoint: message.endpoint });
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }),
    PROCESS_TIMEOUT_MS,
    'execution Host did not become ready',
  );
}

function isHostReadyMessage(
  value: unknown,
): value is { type: 'ready'; hostEpoch: string; endpoint: string } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string'
  );
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}

function agentRunHeader(
  cwd: string,
  sessionId: string,
  runId: string,
  invocationId: string,
  turnId: string,
): AgentRunHeader {
  return {
    runId,
    invocationId,
    sessionId,
    turnId,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd,
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 5,
    completedAt: 5,
  };
}

function runtimeEvent(
  sessionId: string,
  runId: string,
  invocationId: string,
  turnId: string,
  overrides: Partial<RuntimeEvent>,
): RuntimeEvent {
  return {
    id: 'event',
    invocationId,
    runId,
    sessionId,
    turnId,
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
