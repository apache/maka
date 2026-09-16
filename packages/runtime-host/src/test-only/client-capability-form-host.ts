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
import { z } from 'zod';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type { InteractionFormResult } from '@maka/core/interaction';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import { bindRuntimeInteractionRun } from '@maka/runtime/interaction-authority';
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
  HostInteractionCoordinator,
  type HostInteractionCoordinatorOptions,
} from '../server/interaction-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { ClientCapabilityChannel } from '../client/client-capability-channel.js';
import type { ClientCapabilityProvider } from '../client/client-capability.js';
import { ClientCapabilityInvocationBroker } from '../server/client-capability-invocation-broker.js';

const RUN = Object.freeze({ sessionId: 'session_1', turnId: 'turn_1', runId: 'run_1' });

/** Real Runtime/Host form authority and production capability transport, with an in-memory wire. */
export async function withClientCapabilityFormHost(
  provider: ClientCapabilityProvider,
  run: (host: Awaited<ReturnType<typeof createFormHost>>) => Promise<void>,
): Promise<void> {
  await withStore(async ({ store }) => {
    const host = await createFormHost(provider, store);
    try {
      await run(host);
    } finally {
      await host.close();
    }
  });
}

async function createFormHost(
  provider: ClientCapabilityProvider,
  store: InteractiveInteractionStoreWriterFacade,
) {
  const interactions = createInteractionCoordinator(store);
  const binding = await bindRuntimeInteractionRun(interactions, RUN);
  const events: SessionEvent[] = [];
  const timers = new Set<() => void>();
  let registrationId = '';
  let channel!: ClientCapabilityChannel;
  const broker = new ClientCapabilityInvocationBroker({
    senderFor: () => ({
      send: async (frame) => {
        queueMicrotask(() => channel.accept(frame));
      },
    }),
    onRegistrationIdle: () => {},
    scheduleTimeout: (callback, timeoutMs) => {
      timers.add(callback);
      const timer = setTimeout(() => {
        timers.delete(callback);
        callback();
      }, timeoutMs);
      return () => {
        clearTimeout(timer);
        timers.delete(callback);
      };
    },
  });
  channel = new ClientCapabilityChannel({
    write: async (frame) => {
      broker.accept('provider', frame);
    },
    replace: async (input) => {
      registrationId = input.registrationId;
      return { registrationId, revision: 1 };
    },
    unregister: async (input) => ({ registrationId: input.registrationId, revision: 2 }),
    onFailure: (error) => {
      throw error;
    },
  });
  await channel.replace(provider, 1_000);
  const offer = provider.offers()[0];
  assert.ok(offer);
  const descriptor = offer.tools[0];
  assert.ok(descriptor);
  const header = sessionHeader();
  const runtime = new ToolRuntime({
    sessionId: RUN.sessionId,
    header,
    connection: llmConnection(),
    modelId: 'model-1',
    readExecutionBoundary: async () =>
      createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
    readPermissionMode: async () => header.permissionMode,
    newId: nextId(),
    now: nextNow(),
    getPermissionPauseTarget: () => null,
    turnId: RUN.turnId,
    runId: RUN.runId,
    invocationId: 'invocation-1',
    hostedInteraction: binding,
    runtimeCommitSink: {
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    },
  });
  const controller = new AbortController();
  let current: ReturnType<ToolRuntime['settleToolCall']> | undefined;
  return {
    events,
    store,
    timers,
    start() {
      current = runtime.settleToolCall({
        tool: {
          name: 'CapabilityForm',
          description: 'Invoke a published capability through the real broker.',
          parameters: z.object({}),
          nesting: 'direct_only',
          impl: (args, context) =>
            broker.invoke(
              { connectionId: 'provider', registrationId },
              { offerId: offer.offerId, hostPathAccess: offer.hostPathAccess, descriptor },
              args,
              { ...RUN, toolCallId: 'tool-1', cwd: '/tmp' },
              context.abortSignal,
              1_000,
              undefined,
              context.requestUserForm,
            ),
        },
        turnId: RUN.turnId,
        stepId: 'step-1',
        toolCallId: 'tool-1',
        input: {},
        abortSignal: controller.signal,
        eventSink: {
          push: (event) => {
            if (event.type === 'form_request') binding.assertPendingAdmission(event);
            events.push(event);
          },
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      });
      return current;
    },
    async pending() {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const pending = await store.listSessionPending(RUN.sessionId);
        if (
          pending[0] &&
          events.some(
            (event) => event.type === 'form_request' && event.requestId === pending[0]?.requestId,
          )
        )
          return pending[0];
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('MCP form was not published by the Host');
    },
    answer(interactionId: string, result: InteractionFormResult) {
      return interactions.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId,
          answer: { kind: 'form', ...result },
        },
        connectionContext(),
      );
    },
    async disconnectProvider() {
      channel.close(new Error('Provider disconnected'));
      await broker.releaseConnection('provider');
    },
    async stop() {
      controller.abort(new DOMException('Turn stopped', 'AbortError'));
      await binding.close('turn_stopped');
      await binding.settleLocalClosures();
      await current;
    },
    async close() {
      controller.abort(new DOMException('Test finished', 'AbortError'));
      await binding.close('turn_terminal');
      await binding.settleLocalClosures();
      await current;
      channel.close(new Error('Test finished'));
      broker.close();
      binding.release();
      await interactions.close();
    },
  };
}

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

function connectionContext(connectionId = 'form-ui'): ConnectionContext {
  return {
    hostEpoch: 'host_epoch_1',
    connectionId,
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
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
