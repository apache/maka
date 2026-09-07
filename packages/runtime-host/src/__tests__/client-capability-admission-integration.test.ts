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
import { test } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import type { InteractiveInteractionStoreWriterFacade } from '@maka/storage/interaction-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  HostClientCapabilityCoordinator,
  type ClientCapabilitySnapshot,
} from '../server/client-capability-coordinator.js';
import type { ClientCapabilityConnection } from '../server/client-capability-service.js';
import { clientCapabilityProviderId } from '../server/client-capability-provider-id.js';
import {
  HostInteractionCoordinator,
  type HostInteractionCoordinatorOptions,
} from '../server/interaction-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const RUN = Object.freeze({
  sessionId: 'session_1',
  turnId: 'turn_1',
  runId: 'run_1',
});
const IDENTITY = Object.freeze({
  connectionId: 'desktop-connection-1',
  principalKind: 'capability_provider' as const,
  principalId: 'desktop:installation-secret',
  clientInstanceId: 'desktop-client-secret',
});

test('cancels managed approval owners and joiners with the canonical provider identity', async () => {
  await withStore(async ({ store }) => {
    const order: string[] = [];
    const toolCallByInvocation = new Map<string, string>();
    const cancelledToolCalls: string[] = [];
    let acceptedCount = 0;
    let resolveThirdAccepted!: () => void;
    const thirdAccepted = new Promise<void>((resolve) => {
      resolveThirdAccepted = resolve;
    });
    const interactions = createInteractionCoordinator(store);
    const runOwner = interactions.bindRun(RUN);
    const capabilities = new HostClientCapabilityCoordinator({
      activation: new RuntimePolicyActivationGate(),
      onModelToolsChanged: () => undefined,
      interactions,
      grants: store,
    });
    let connection!: ClientCapabilityConnection;
    connection = capabilities.attachConnection(IDENTITY, {
      send: async (frame) => {
        if (frame.kind === 'client.capability.call') {
          toolCallByInvocation.set(frame.invocationId, frame.toolCallId);
          order.push('accepted');
          acceptedCount += 1;
          if (acceptedCount === 3) resolveThirdAccepted();
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
            admissionEvidence: {
              kind: 'browser_url',
              url: 'https://example.com/private?token=secret',
            },
          });
        } else if (frame.kind === 'client.capability.cancel') {
          const toolCallId = toolCallByInvocation.get(frame.invocationId);
          if (toolCallId) cancelledToolCalls.push(toolCallId);
        } else if (frame.kind === 'client.capability.admitted') {
          order.push('admitted');
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: { content: [{ type: 'text', text: 'snapshot' }] },
          });
        }
      },
    });
    let snapshot: ClientCapabilitySnapshot | undefined;
    try {
      const replaced = await capabilities.handlers['client.capability.replace'](
        {
          registrationId: 'desktop-native-registration',
          offers: [
            {
              offerId: 'desktop_browser',
              version: '1',
              affinity: 'session',
              hostPathAccess: 'none',
              label: 'Desktop Browser',
              tools: [
                {
                  serverId: 'desktop_browser',
                  name: 'browser_snapshot',
                  inputSchema: { type: 'object', additionalProperties: false },
                },
              ],
            },
          ],
        },
        connectionContext(IDENTITY.connectionId),
      );
      assert.equal(replaced.ok, true, JSON.stringify(replaced));
      assert.deepEqual(await capabilities.bindSession(RUN.sessionId, IDENTITY.connectionId), {
        ok: true,
      });
      snapshot = capabilities.snapshotForSession(RUN.sessionId);
      assert.ok(snapshot);
      const tool = snapshot.tools[0];
      assert.ok(tool);
      assert.equal(tool.hostAdmission, 'client_capability');
      assert.equal(tool.categoryHint, 'custom_tool');
      const runtime = new ToolRuntime({
        sessionId: RUN.sessionId,
        header: sessionHeader(),
        connection: llmConnection(),
        modelId: 'model-1',
        appendMessage: async () => undefined,
        readExecutionBoundary: async () =>
          createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        turnId: RUN.turnId,
        runId: RUN.runId,
        invocationId: 'invocation-1',
        runtimeCommitSink: {
          commitToolPrepared: async () => {
            order.push('T1');
            return { created: true, runtimeEventSeq: 1 };
          },
          commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
        },
      });
      const caller = new AbortController();
      const cancelled = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-1',
        toolCallId: 'browser-call-1',
        input: {},
        abortSignal: caller.signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      const request = await waitForPending(store);
      assert.equal(request.request.kind, 'client_capability');
      if (request.request.kind !== 'client_capability') return;

      const providerId = clientCapabilityProviderId(IDENTITY);
      assert.equal(request.request.target.providerId, providerId);
      assert.equal(JSON.stringify(request).includes(IDENTITY.principalId), false);
      assert.equal(JSON.stringify(request).includes(IDENTITY.clientInstanceId), false);

      caller.abort(new DOMException('Code Mode deadline reached', 'TimeoutError'));
      await cancelled;
      const closed = await store.readInteraction(request.requestId);
      assert.equal(closed?.outcome?.outcome.kind, 'closure');
      if (closed?.outcome?.outcome.kind === 'closure') {
        assert.equal(closed.outcome.outcome.reason, 'timed_out');
      }
      assert.deepEqual(order, ['accepted']);

      const settling = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-2',
        toolCallId: 'browser-call-2',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      const retryRequest = await waitForPending(store);
      assert.notEqual(retryRequest.requestId, request.requestId);
      assert.equal(retryRequest.request.kind, 'client_capability');
      if (retryRequest.request.kind !== 'client_capability') return;

      const joinedCaller = new AbortController();
      const joined = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-3',
        toolCallId: 'browser-call-3',
        input: {},
        abortSignal: joinedCaller.signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      await thirdAccepted;
      assert.deepEqual(
        (await store.listSessionPending(RUN.sessionId)).map((pending) => pending.requestId),
        [retryRequest.requestId],
      );

      joinedCaller.abort(new DOMException('Joined caller stopped', 'AbortError'));
      await joined;
      assert.deepEqual(cancelledToolCalls, ['browser-call-1', 'browser-call-3']);
      assert.deepEqual(order, ['accepted', 'accepted', 'accepted']);
      assert.equal((await store.readInteraction(retryRequest.requestId))?.outcome, undefined);

      const answered = await interactions.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: retryRequest.requestId,
          answer: { kind: 'client_capability', decision: 'allow' },
        },
        connectionContext('desktop-ui'),
      );
      assert.equal(answered.ok, true);
      order.push('approved');
      const settlement = await settling;
      const grant = await store.readClientCapabilitySessionGrant({
        sessionId: RUN.sessionId,
        ...retryRequest.request.target,
      });
      assert.equal(grant?.providerId, providerId);
      assert.deepEqual(settlement.result, { content: [{ type: 'text', text: 'snapshot' }] });
      assert.deepEqual(order, ['accepted', 'accepted', 'accepted', 'approved', 'T1', 'admitted']);
    } finally {
      snapshot?.release();
      await connection.close();
      await capabilities.close();
      await runOwner.close('turn_terminal');
      runOwner.release();
      await interactions.close();
    }
  });
});

function sessionHeader(): SessionHeader {
  return {
    id: RUN.sessionId,
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    createdAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function llmConnection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `event-${++value}`;
}

function nextNow(): () => number {
  let value = 100;
  return () => ++value;
}

function connectionContext(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'host_epoch_1',
    connectionId,
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function waitForPending(store: InteractiveInteractionStoreWriterFacade) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = await store.listSessionPending(RUN.sessionId);
    if (pending[0]) return pending[0];
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Client Capability approval was not published');
}

function createInteractionCoordinator(
  store: InteractiveInteractionStoreWriterFacade,
): HostInteractionCoordinator {
  let now = 100;
  const options: HostInteractionCoordinatorOptions = {
    store,
    sandboxBoundaries: {
      createSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary publication');
      },
      readSandboxBoundaryRequest: async () => undefined,
      listPendingSandboxBoundaryRequests: async () => [],
      settleSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary settlement');
      },
      listHeaders: async () => [],
    },
    sessionAdmission: new SessionAdmissionGate(),
    sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
    now: () => ++now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: async () => undefined,
    onPoison: () => undefined,
    onSandboxBoundarySettled: async () => undefined,
  };
  return new HostInteractionCoordinator(options);
}

interface StoreContext {
  readonly owner: InteractiveRootOwner;
  readonly store: InteractiveInteractionStoreWriterFacade;
  readonly stores: ExecutionStoresWriter<'interactive'>;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-client-capability-admission-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    await run({ owner, store: stores.interactionStore, stores });
  } finally {
    if (!owner.closed) await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}
