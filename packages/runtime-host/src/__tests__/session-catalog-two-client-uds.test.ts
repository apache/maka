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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEEP_RESEARCH_SESSION_LABEL, DEEP_RESEARCH_SESSION_NAME } from '@maka/core/explore-agent';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  type ClientFrame,
  type SessionCatalogItem,
  type SessionCatalogProjection,
  type SessionCreateInput,
  type SubscriptionFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 10_000;
const WIRE_OVERSIZED_MODEL_ID = '😀'.repeat(256);
const KNOWN_EMPTY_LIVE_RUN_STATE = {
  schemaVersion: SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  runningTurnIds: [],
} as const;

test('two Clients share stable Session creation, CAS configuration, and catalog continuity', {
  skip: process.platform === 'win32' ? 'Windows SQLite shutdown lifecycle' : false,
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-session-catalog-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const {
    connectionId,
    largeLabelSessionId,
    oversizedSessionId,
    unreadSessionId,
    retirementSessionId,
    retirementRevision,
    recoverySessionId,
  } = await seedAuthority(root, capability);
  let host: ExecutionHostHandle | undefined;
  try {
    host = await startHost(root, capability.rootId);
    const desktop = await connectClient(root);
    const tui = await connectClient(root);
    try {
      const catalogChanged = new Promise<string>((resolve) => {
        tui.subscribeSessionCatalogChanges(({ sessionId }) => resolve(sessionId));
      });
      const createInput: SessionCreateInput = {
        sessionId: 'stable-session',
        workspace: { kind: 'host_path', path: root },
        name: 'Stable Session',
        labels: ['catalog'],
        modelTarget: { kind: 'default' },
      };
      const created = requireSessionProjection(
        await desktop.request('session.create', createInput),
      );
      assert.equal(
        await withTimeout(catalogChanged, PROCESS_TIMEOUT_MS, 'Session catalog change timed out'),
        createInput.sessionId,
      );
      assert.equal(created.id, createInput.sessionId);
      assert.equal(created.permissionMode, 'ask');
      assert.equal(created.labelsTruncated, false);
      assert.deepEqual(
        await desktop.request('runtime.resource.query', {
          kind: 'list_start',
          sessionId: created.id,
        }),
        await tui.request('runtime.resource.query', {
          kind: 'list_start',
          sessionId: created.id,
        }),
      );
      const largeLabels = await querySession(desktop, largeLabelSessionId);
      assert.equal(largeLabels.labels.length, 32);
      assert.equal(largeLabels.labelsTruncated, true);
      assert.deepEqual(largeLabels.labels.slice(0, 2), ['visible', 'label-0']);
      assert.deepEqual(
        await desktop.request('session.catalog.query', {
          kind: 'get',
          sessionId: oversizedSessionId,
        }),
        {
          kind: 'session',
          session: {
            kind: 'unsupported_legacy_record',
            id: oversizedSessionId,
            revision: 1,
            reason: 'not_wire_representable',
          },
        },
      );
      assert.deepEqual(
        await desktop.request('session.metadata.update', {
          sessionId: oversizedSessionId,
          expectedRevision: 1,
          patch: { isFlagged: true },
        }),
        {
          kind: 'committed',
          session: {
            kind: 'unsupported_legacy_record',
            id: oversizedSessionId,
            revision: 2,
            reason: 'not_wire_representable',
          },
        },
      );
      assert.deepEqual(
        await desktop.request('session.lifecycle.set', {
          sessionId: oversizedSessionId,
          state: 'archived',
        }),
        {
          kind: 'unsupported_legacy_record',
          id: oversizedSessionId,
          revision: 3,
          reason: 'not_wire_representable',
        },
      );
      assert.deepEqual(
        await tui.request('session.lifecycle.set', {
          sessionId: oversizedSessionId,
          state: 'active',
        }),
        {
          kind: 'unsupported_legacy_record',
          id: oversizedSessionId,
          revision: 4,
          reason: 'not_wire_representable',
        },
      );
      assert.deepEqual(
        await desktop.request('session.catalog.query', {
          kind: 'get',
          sessionId: oversizedSessionId,
        }),
        {
          kind: 'session',
          session: {
            kind: 'unsupported_legacy_record',
            id: oversizedSessionId,
            revision: 4,
            reason: 'not_wire_representable',
          },
        },
      );
      await assert.rejects(
        desktop.request('session.create', {
          sessionId: 'relative-session',
          workspace: { kind: 'host_path', path: '.' },
          modelTarget: { kind: 'default' },
        }),
        (error: unknown) =>
          error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
      );
      const planSession = await desktop.request('session.create', {
        sessionId: 'plan-session',
        workspace: { kind: 'host_path', path: root },
        modelTarget: { kind: 'default' },
        collaborationMode: 'plan',
      });
      if ('kind' in planSession) assert.fail('Plan Session must be wire-representable');
      assert.equal(planSession.collaborationMode, 'plan');
      const researchSession = requireSessionProjection(
        await desktop.request('session.create', {
          sessionId: 'deep-research-session',
          workspace: { kind: 'host_path', path: root },
          mode: 'deep_research',
          name: 'Caller override',
          labels: ['customer-label'],
          modelTarget: { kind: 'default' },
          permissionMode: 'bypass',
        }),
      );
      assert.equal(researchSession.name, DEEP_RESEARCH_SESSION_NAME);
      assert.deepEqual(researchSession.labels, ['customer-label', DEEP_RESEARCH_SESSION_LABEL]);
      assert.equal(researchSession.permissionMode, 'explore');

      const policy = await tui.request('runtime.policy.query', {});
      const changedPolicy = await tui.request('runtime.policy.mutate', {
        expectedRevision: policy.revision,
        operation: {
          kind: 'set_chat_defaults',
          value: { permissionMode: 'bypass' },
        },
      });
      assert.equal(changedPolicy.kind, 'committed');
      assert.deepEqual(await tui.request('session.create', createInput), created);

      const subscription = await tui.openSessionSubscription({
        sessionId: created.id,
        transcript: { kind: 'none' },
      });
      const iterator = subscription[Symbol.asyncIterator]();
      assert.equal(subscription.snapshot.session.metadataRevision, created.revision);
      await assert.rejects(
        desktop.request('session.metadata.update', {
          sessionId: created.id,
          expectedRevision: created.revision,
          patch: { name: '\u200d' },
        }),
        operationError('invalid_request'),
      );

      const renamed = await desktop.request('session.metadata.update', {
        sessionId: created.id,
        expectedRevision: created.revision,
        patch: { name: 'Renamed Session', isFlagged: true },
      });
      assert.equal(renamed.kind, 'committed');
      if (renamed.kind !== 'committed') assert.fail('Session rename must commit');
      const renamedSession = requireSessionProjection(renamed.session);
      assert.equal(renamedSession.revision, created.revision + 1);
      assert.equal(renamedSession.name, 'Renamed Session');
      const continuity = await nextProjection(iterator);
      assert.equal(continuity.snapshot.session.metadataRevision, renamedSession.revision);

      const configurationRevision = renamedSession.revision;
      const configurationOutcomes = await Promise.all([
        desktop.request('session.configuration.update', {
          sessionId: created.id,
          expectedRevision: configurationRevision,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'agent',
            orchestrationMode: 'graph',
          },
        }),
        tui.request('session.configuration.update', {
          sessionId: created.id,
          expectedRevision: configurationRevision,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        }),
      ]);
      assert.deepEqual(configurationOutcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const committedConfiguration = configurationOutcomes.find(
        (outcome) => outcome.kind === 'committed',
      );
      assert.ok(committedConfiguration);
      if (committedConfiguration?.kind !== 'committed') {
        assert.fail('One Session configuration must commit');
      }
      const configuredSession = requireSessionProjection(committedConfiguration.session);
      assert.deepEqual(await querySession(desktop, created.id), {
        ...configuredSession,
        liveRunState: KNOWN_EMPTY_LIVE_RUN_STATE,
      });
      const unchangedConfiguration = await desktop.request('session.configuration.update', {
        sessionId: configuredSession.id,
        expectedRevision: configuredSession.revision,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: configuredSession.llmConnectionSlug,
            model: configuredSession.model,
          },
          thinkingLevel: configuredSession.thinkingLevel ?? null,
          permissionMode: configuredSession.permissionMode,
          collaborationMode: configuredSession.collaborationMode,
          orchestrationMode: configuredSession.orchestrationMode,
        },
      });
      assert.deepEqual(unchangedConfiguration, {
        kind: 'committed',
        session: configuredSession,
      });
      const narrowedConfiguration = await desktop.request('session.configuration.update', {
        sessionId: configuredSession.id,
        expectedRevision: configuredSession.revision,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: configuredSession.llmConnectionSlug,
            model: configuredSession.model,
          },
          thinkingLevel: configuredSession.thinkingLevel ?? null,
          permissionMode: 'explore',
          collaborationMode: configuredSession.collaborationMode,
          orchestrationMode: configuredSession.orchestrationMode,
        },
      });
      assert.equal(narrowedConfiguration.kind, 'committed');
      if (narrowedConfiguration.kind !== 'committed') {
        assert.fail('Runtime Resource authority must permit a quiescent permission narrowing');
      }
      const narrowedSession = requireSessionProjection(narrowedConfiguration.session);
      assert.equal(narrowedSession.permissionMode, 'explore');

      const firstCwd = join(base, 'workspace-first');
      const secondCwd = join(base, 'workspace-second');
      await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);
      const relocationOutcomes = await Promise.all([
        desktop.relocateSessionWorkspace({
          sessionId: narrowedSession.id,
          expectedRevision: narrowedSession.revision,
          workspace: { kind: 'host_path', path: firstCwd },
        }),
        tui.relocateSessionWorkspace({
          sessionId: narrowedSession.id,
          expectedRevision: narrowedSession.revision,
          workspace: { kind: 'host_path', path: secondCwd },
        }),
      ]);
      assert.deepEqual(relocationOutcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const relocated = relocationOutcomes.find((outcome) => outcome.kind === 'committed');
      assert.ok(relocated);
      if (relocated?.kind !== 'committed') assert.fail('One Session relocation must commit');
      const relocatedSession = requireSessionProjection(relocated.session);
      assert.ok(
        relocatedSession.workspace.hostCwd === (await realpath(firstCwd)) ||
          relocatedSession.workspace.hostCwd === (await realpath(secondCwd)),
      );
      assert.deepEqual(await querySession(tui, narrowedSession.id), {
        ...relocatedSession,
        liveRunState: KNOWN_EMPTY_LIVE_RUN_STATE,
      });

      await setDefaultModel(desktop, connectionId, WIRE_OVERSIZED_MODEL_ID);
      const rejectedSessionId = 'wire-oversized-default-model';
      await assert.rejects(
        desktop.request('session.create', {
          sessionId: rejectedSessionId,
          workspace: { kind: 'host_path', path: root },
          modelTarget: { kind: 'default' },
        }),
        operationError('invalid_request'),
      );
      assert.deepEqual(
        await desktop.request('session.catalog.query', {
          kind: 'get',
          sessionId: rejectedSessionId,
        }),
        { kind: 'session', session: null },
      );
      await assert.rejects(
        desktop.request('session.configuration.update', {
          sessionId: relocatedSession.id,
          expectedRevision: relocatedSession.revision,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: relocatedSession.permissionMode,
            collaborationMode: relocatedSession.collaborationMode,
            orchestrationMode: relocatedSession.orchestrationMode,
          },
        }),
        operationError('invalid_request'),
      );
      assert.deepEqual(await querySession(desktop, relocatedSession.id), {
        ...relocatedSession,
        liveRunState: KNOWN_EMPTY_LIVE_RUN_STATE,
      });
      await setDefaultModel(tui, connectionId, 'gpt-5');

      const read = requireSessionProjection(
        await desktop.request('session.read_marker.set', {
          sessionId: unreadSessionId,
          readThroughMessageId: 'message-2',
        }),
      );
      assert.equal(read.hasUnread, false);
      assert.equal(read.lastReadMessageId, 'message-2');
      const readFromTui = await querySession(tui, unreadSessionId);
      assert.equal(readFromTui.hasUnread, false);
      assert.equal(readFromTui.lastReadMessageId, 'message-2');

      const catalogBeforeBulk = await desktop.request('session.catalog.query', {
        kind: 'list_start',
      });
      if (catalogBeforeBulk.kind !== 'page' || catalogBeforeBulk.nextCursor !== null) {
        assert.fail('Pre-bulk Session catalog must fit on one page');
      }
      const bulk = (
        await Promise.all(
          Array.from({ length: 34 }, (_, index) =>
            desktop.request('session.create', {
              sessionId: `bulk-${String(index).padStart(2, '0')}`,
              workspace: { kind: 'host_path', path: root },
              labels: ['paged'],
              modelTarget: { kind: 'default' },
            }),
          ),
        )
      ).map(requireSessionProjection);
      const firstPage = await desktop.request('session.catalog.query', {
        kind: 'list_start',
      });
      assert.equal(firstPage.kind, 'page');
      if (firstPage.kind !== 'page') assert.fail('Session catalog must return a page');
      assert.equal(firstPage.sessions.length, 32);
      assert.ok(firstPage.nextCursor);
      const continuation = await tui.request('session.catalog.query', {
        kind: 'list_continue',
        revision: firstPage.revision,
        cursor: firstPage.nextCursor,
      });
      assert.equal(continuation.kind, 'page');
      if (continuation.kind !== 'page') {
        assert.fail('Stable Session catalog continuation must return a page');
      }
      assert.equal(
        firstPage.sessions.length + continuation.sessions.length,
        bulk.length + catalogBeforeBulk.sessions.length,
      );

      const staleStart = await desktop.request('session.catalog.query', {
        kind: 'list_start',
      });
      assert.equal(staleStart.kind, 'page');
      if (staleStart.kind !== 'page' || !staleStart.nextCursor) {
        assert.fail('Session catalog must provide a continuation');
      }
      const bulkSession = bulk[0]!;
      const pinned = await tui.request('session.metadata.update', {
        sessionId: bulkSession.id,
        expectedRevision: bulkSession.revision,
        patch: { isFlagged: true },
      });
      assert.equal(pinned.kind, 'committed');
      const staleContinuation = await desktop.request('session.catalog.query', {
        kind: 'list_continue',
        revision: staleStart.revision,
        cursor: staleStart.nextCursor,
      });
      assert.equal(staleContinuation.kind, 'revision_changed');

      await subscription.close();
      const retirementSubscription = await tui.openSessionSubscription({
        sessionId: created.id,
        transcript: { kind: 'none' },
      });
      const retirementIterator = retirementSubscription[Symbol.asyncIterator]();
      const beforeArchive = await querySession(desktop, created.id);
      assert.equal(beforeArchive.status, 'active');
      const heartbeat = await desktop.request('scheduled-task.mutate', {
        kind: 'create',
        input: {
          title: 'Retirement blocker',
          intentBody: 'Remain attached to this Session.',
          schedule: { kind: 'interval', everySeconds: 3_600, startAt: Date.now() },
          effect: { kind: 'session_resume', sessionId: created.id },
        },
      });
      assert.equal(heartbeat.kind, 'task');
      if (heartbeat.kind !== 'task') {
        assert.fail('ScheduledTask creation must commit');
      }
      await assert.rejects(
        tui.request('session.lifecycle.set', {
          sessionId: created.id,
          state: 'archived',
        }),
        operationError('session_busy'),
      );
      const deletedHeartbeat = await tui.request('scheduled-task.mutate', {
        kind: 'delete',
        taskId: heartbeat.task.id,
      });
      assert.equal(deletedHeartbeat.kind, 'deleted');
      const archived = requireSessionProjection(
        await desktop.request('session.lifecycle.set', {
          sessionId: created.id,
          state: 'archived',
        }),
      );
      assert.equal(archived.isArchived, true);
      assert.equal(archived.status, beforeArchive.status);
      assert.equal((await querySession(tui, created.id)).isArchived, true);
      const archivedContinuity = await nextProjection(retirementIterator);
      assert.equal(archivedContinuity.snapshot.session.isArchived, true);
      assert.equal(archivedContinuity.snapshot.session.status, beforeArchive.status);
      assert.ok(archived.revision > beforeArchive.revision);

      const restored = requireSessionProjection(
        await tui.request('session.lifecycle.set', {
          sessionId: created.id,
          state: 'active',
        }),
      );
      assert.equal(restored.isArchived, false);
      assert.equal(restored.status, beforeArchive.status);
      const restoredContinuity = await nextProjection(retirementIterator);
      assert.equal(restoredContinuity.snapshot.session.isArchived, false);
      assert.equal(restoredContinuity.snapshot.session.status, beforeArchive.status);

      assert.deepEqual(
        await desktop.request('session.remove', {
          sessionId: created.id,
          expectedRevision: restored.revision,
        }),
        { kind: 'removed', sessionId: created.id },
      );
      const closed = await withTimeout(
        retirementIterator.next(),
        PROCESS_TIMEOUT_MS,
        'Session removal did not close continuity',
      );
      assert.equal(closed.done, false);
      assert.equal(closed.value?.kind, 'subscription.closed');
      if (closed.value?.kind !== 'subscription.closed') {
        assert.fail('Session removal must close its continuity subscription');
      }
      assert.equal(closed.value.reason, 'session_removed');
      assert.deepEqual(
        await tui.request('session.catalog.query', {
          kind: 'get',
          sessionId: created.id,
        }),
        { kind: 'session', session: null },
      );
      await assert.rejects(
        desktop.request('runtime.resource.query', {
          kind: 'list_start',
          sessionId: created.id,
        }),
        operationError('not_found'),
      );
      assert.deepEqual(
        await tui.request('session.remove', {
          sessionId: created.id,
          expectedRevision: restored.revision,
        }),
        { kind: 'removed', sessionId: created.id },
      );

      const artifactBeforeRemoval = await desktop.request('artifact.query', {
        kind: 'get',
        sessionId: retirementSessionId,
        artifactId: 'retirement-artifact',
      });
      assert.equal(artifactBeforeRemoval.kind, 'artifact');
      if (artifactBeforeRemoval.kind !== 'artifact') {
        assert.fail('Retirement Artifact must be readable before Session removal');
      }
      assert.equal(artifactBeforeRemoval.artifact?.id, 'retirement-artifact');
      const tasksBeforeRemoval = await tui.request('task.ledger.query', {
        kind: 'list_start',
        sessionId: retirementSessionId,
      });
      assert.equal(tasksBeforeRemoval.kind, 'page');
      if (tasksBeforeRemoval.kind !== 'page') {
        assert.fail('Retirement Task Ledger must be readable before Session removal');
      }
      assert.equal(tasksBeforeRemoval.tasks.length, 1);

      assert.deepEqual(
        await desktop.request('session.remove', {
          sessionId: retirementSessionId,
          expectedRevision: retirementRevision,
        }),
        { kind: 'removed', sessionId: retirementSessionId },
      );
      for (const connection of [desktop, tui]) {
        await assert.rejects(
          connection.request('artifact.query', {
            kind: 'get',
            sessionId: retirementSessionId,
            artifactId: 'retirement-artifact',
          }),
          operationError('not_found'),
        );
        await assert.rejects(
          connection.request('task.ledger.query', {
            kind: 'list_start',
            sessionId: retirementSessionId,
          }),
          operationError('not_found'),
        );
      }
      await assert.rejects(
        desktop.request('artifact.query', {
          kind: 'get',
          sessionId: recoverySessionId,
          artifactId: 'recovery-artifact',
        }),
        operationError('not_found'),
      );
      await assert.rejects(
        tui.request('task.ledger.query', {
          kind: 'list_start',
          sessionId: recoverySessionId,
        }),
        operationError('not_found'),
      );
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
    }
    await stopHost(host);
    host = undefined;
    await assertRetirementCleanup(root, capability, [retirementSessionId, recoverySessionId]);
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

test('stable Session creation survives response loss and Host restart', {
  skip: process.platform === 'win32' ? 'Windows SQLite shutdown lifecycle' : false,
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-session-create-retry-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  await seedAuthority(root, capability);
  let host: ExecutionHostHandle | undefined;
  let dropped: FramedTransport | undefined;
  try {
    host = await startHost(root, capability.rootId);
    const input: SessionCreateInput = {
      sessionId: 'response-loss-session',
      workspace: { kind: 'host_path', path: root },
      name: 'Response Loss Session',
      labels: ['catalog'],
      modelTarget: { kind: 'default' },
    };
    dropped = await sendCreateWithoutReadingResponse(host.endpoint, input);
    const observer = await connectClient(root);
    const committed = await waitForSession(observer, input.sessionId);
    dropped.abort();
    dropped = undefined;
    await observer.close();

    await terminateHost(host);
    host = await startHost(root, capability.rootId);
    const retrying = await connectClient(root);
    try {
      const retried = requireSessionProjection(await retrying.request('session.create', input));
      const { liveRunState, ...persistedCommitted } = committed;
      assert.deepEqual(liveRunState, KNOWN_EMPTY_LIVE_RUN_STATE);
      assert.deepEqual(retried, persistedCommitted);
    } finally {
      await retrying.close();
    }
    await stopHost(host);
    host = undefined;
  } finally {
    dropped?.abort();
    await terminateHost(host);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(capability.rootId);
    await rm(base, { recursive: true, force: true });
  }
});

async function seedAuthority(
  root: string,
  capability: StorageRootCapability<'interactive'>,
): Promise<{
  readonly connectionId: string;
  readonly largeLabelSessionId: string;
  readonly oversizedSessionId: string;
  readonly unreadSessionId: string;
  readonly retirementSessionId: string;
  readonly retirementRevision: number;
  readonly recoverySessionId: string;
}> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for Session setup');
  try {
    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const unread = await execution.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await execution.sessionStore.appendMessages(unread.id, [
      { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'one' },
      {
        type: 'assistant',
        id: 'message-2',
        turnId: 'turn-1',
        ts: 2,
        text: 'two',
        modelId: 'fake-model',
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'Read',
        args: {},
      },
    ]);
    await execution.sessionStore.updateHeader(unread.id, {
      hasUnread: true,
      lastMessageAt: 2,
    });
    const largeLabels = await execution.sessionStore.create({
      cwd: root,
      labels: [
        'visible',
        ' invalid ',
        'x'.repeat(129),
        'visible',
        ...Array.from({ length: 700 }, (_, index) => `label-${index}`),
      ],
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const oversized = await execution.sessionStore.create({
      cwd: root,
      projectId: 'p'.repeat(257),
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const retirement = await execution.sessionStore.create({
      cwd: root,
      name: 'Retirement sidecars',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const recovery = await execution.sessionStore.create({
      cwd: root,
      name: 'Retirement recovery',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const tasks = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await artifacts.recover();
    await Promise.all([
      artifacts.create({
        id: 'retirement-artifact',
        sessionId: retirement.id,
        turnId: 'retirement-turn',
        name: 'retirement.txt',
        kind: 'file',
        content: 'remove me',
        mimeType: 'text/plain',
        source: 'fixture',
        now: 1,
      }),
      artifacts.create({
        id: 'recovery-artifact',
        sessionId: recovery.id,
        turnId: 'recovery-turn',
        name: 'recovery.txt',
        kind: 'file',
        content: 'recover cleanup',
        mimeType: 'text/plain',
        source: 'fixture',
        now: 2,
      }),
      tasks.create(retirement.id, [{ subject: 'Remove retirement task' }]),
      tasks.create(recovery.id, [{ subject: 'Recover retirement task cleanup' }]),
    ]);
    const retirementSnapshot = await execution.sessionStore.readHeaderRecordSnapshot(retirement.id);
    await execution.sessionStore.remove(recovery.id);

    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const initial = await policy.connectionCatalog.getSnapshot();
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: initial.revision,
      connection: {
        slug: 'session-catalog-openai',
        name: 'Session Catalog OpenAI',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: ['gpt-5', WIRE_OVERSIZED_MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Connection setup did not commit');
    const connection = created.snapshot.connections.find(
      (candidate) => candidate.slug === 'session-catalog-openai',
    );
    assert.ok(connection);
    if (!connection) throw new Error('Connection setup omitted its connection');
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: 'session-catalog-test-key',
    });
    assert.equal(credential.kind, 'committed');
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') throw new Error('Model discovery setup was not ready');
    const discovered = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [
        { id: 'gpt-5', apiProtocol: 'openai-responses' },
        { id: WIRE_OVERSIZED_MODEL_ID, apiProtocol: 'openai-responses' },
      ],
      source: 'fetched',
      fetchedAt: 1,
    });
    assert.equal(discovered.kind, 'committed');
    if (discovered.kind !== 'committed') {
      throw new Error('Model discovery setup did not commit');
    }
    const target = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: discovered.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: 'gpt-5' },
    });
    assert.equal(target.kind, 'committed');
    return {
      connectionId: connection.connectionId,
      largeLabelSessionId: largeLabels.id,
      oversizedSessionId: oversized.id,
      unreadSessionId: unread.id,
      retirementSessionId: retirement.id,
      retirementRevision: retirementSnapshot.revision,
      recoverySessionId: recovery.id,
    };
  } finally {
    await owner.close();
  }
}

async function assertRetirementCleanup(
  root: string,
  capability: StorageRootCapability<'interactive'>,
  sessionIds: readonly string[],
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to inspect Session retirement cleanup');
  try {
    const execution = await openInteractiveExecutionStoresForWrite(owner.lease);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    const tasks = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await artifacts.recover();
    assert.deepEqual(await execution.sessionStore.listPendingSessionRetirementCleanupIds(), []);
    for (const sessionId of sessionIds) {
      assert.equal((await artifacts.listPage(sessionId, { offset: 0, limit: 1 })).total, 0);
      assert.deepEqual(await tasks.list(sessionId, { includeTerminal: true }), []);
    }
  } finally {
    await owner.close();
  }
}

async function setDefaultModel(
  connection: RuntimeHostConnection,
  connectionId: string,
  modelId: string,
): Promise<void> {
  const catalog = await connection.request('connection.catalog.query', { kind: 'start' });
  assert.equal(catalog.kind, 'page');
  if (catalog.kind !== 'page') assert.fail('Connection catalog must return a page');
  const result = await connection.request('connection.catalog.set-default-target', {
    expectedCatalogRevision: catalog.revision,
    target: { connectionId, modelId },
  });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') assert.fail('Default model update must commit');
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

async function waitForSession(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<SessionCatalogProjection> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await connection.request('session.catalog.query', {
      kind: 'get',
      sessionId,
    });
    if (result.kind === 'session' && result.session) {
      return requireSessionProjection(result.session);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Session creation did not become durable before the deadline');
}

function requireSessionProjection(item: SessionCatalogItem): SessionCatalogProjection {
  if ('kind' in item) {
    assert.fail(`Expected a representable Session, received ${item.kind}`);
  }
  return item;
}

async function nextProjection(
  iterator: AsyncIterator<SubscriptionFrame>,
): Promise<Extract<SubscriptionFrame, { kind: 'subscription.session_projection' }>> {
  const result = await withTimeout(
    iterator.next(),
    PROCESS_TIMEOUT_MS,
    'Session continuity projection did not arrive',
  );
  assert.equal(result.done, false);
  assert.equal(result.value?.kind, 'subscription.session_projection');
  if (result.value?.kind !== 'subscription.session_projection') {
    assert.fail('Expected a Session continuity projection');
  }
  return result.value;
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

async function sendCreateWithoutReadingResponse(
  endpoint: string,
  input: SessionCreateInput,
): Promise<FramedTransport> {
  const transport = new FramedTransport(await openSocket(endpoint));
  await writeClientFrame(transport, {
    kind: 'hello',
    clientInstanceId: randomUUID(),
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
  });
  const handshake = decodeHostFrame(await transport.read(2_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  await writeClientFrame(transport, {
    requestId: randomUUID(),
    operation: 'session.create',
    input,
  });
  return transport;
}

function writeClientFrame(transport: FramedTransport, frame: ClientFrame): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
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
