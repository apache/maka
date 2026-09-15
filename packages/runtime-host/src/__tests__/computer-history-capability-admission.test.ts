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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { ClientCapabilityAdmissionEvidence } from '../protocol/index.js';
import {
  HostClientCapabilityCoordinator,
  type ClientCapabilitySnapshot,
} from '../server/client-capability-coordinator.js';
import type { ClientCapabilityConnection } from '../server/client-capability-service.js';
import { HostInteractionCoordinator } from '../server/interaction-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';

const SERVER = 'desktop_computer_history';
const TOOLS = [
  'ComputerHistoryStatus',
  'ComputerHistorySearch',
  'ComputerHistoryRead',
  'ComputerHistoryReadEvents',
] as const;
const RUN = { sessionId: 'history-session', turnId: 'turn-1', runId: 'run-1' };
const context = {
  hostEpoch: 'host-1',
  connectionId: 'desktop-1',
  principal: 'local_os_user' as const,
  acquireResidency: () => ({ release: () => undefined }),
};

test('History status is grant-free and all data tools share a persisted managed Session grant', async () => {
  await withHistory(async (harness) => {
    const status = await harness.prepare('ComputerHistoryStatus');
    assert.deepEqual(await status.execute(harness.callContext()), {
      content: [{ type: 'text', text: 'result' }],
    });
    assert.equal((await harness.store.listSessionPending(RUN.sessionId)).length, 0);

    const search = harness.prepare('ComputerHistorySearch');
    const request = await harness.pending();
    assert.equal(request.request.kind, 'client_capability');
    if (request.request.kind !== 'client_capability')
      throw new Error('Expected capability request');
    const target = request.request.target;
    assert.equal(target.capability, 'computer_history');
    assert.deepEqual(target.scope, { kind: 'capability' });
    assert.equal(target.serverId, SERVER);
    assert.equal(harness.admitted.length, 1, 'only the safe status was admitted');
    await harness.answer(request.requestId, 'allow');
    const prepared = await search;
    const key = { sessionId: RUN.sessionId, ...target };
    assert.equal(
      (await harness.store.readClientCapabilitySessionGrant(key))?.capability,
      'computer_history',
    );
    await prepared.execute(harness.callContext());
    for (const tool of ['ComputerHistoryRead', 'ComputerHistoryReadEvents']) {
      const next = await harness.prepare(tool);
      await next.execute(harness.callContext());
      assert.equal((await harness.store.listSessionPending(RUN.sessionId)).length, 0);
    }
    assert.equal(harness.admitted.length, 4);
    for (const override of [
      { sessionId: 'other-session' },
      { providerId: 'other-provider' },
      { contractId: 'other-contract' },
      { capability: 'computer_use' as const },
    ]) {
      assert.equal(
        await harness.store.readClientCapabilitySessionGrant({ ...key, ...override }),
        undefined,
      );
    }

    await harness.purge();
    assert.equal(await harness.store.readClientCapabilitySessionGrant(key), undefined);
    const retry = harness.prepare('ComputerHistoryRead');
    const rejection = assert.rejects(retry, /request was denied/u);
    const nextRequest = await harness.pending();
    await harness.answer(nextRequest.requestId, 'deny');
    await rejection;
    assert.equal(harness.admitted.length, 4, 'purged authority is not cached by the coordinator');
  });
});

test('History denial never admits or publishes a grant; retry creates a new approval', async () => {
  await withHistory(async (harness) => {
    const first = harness.prepare('ComputerHistoryReadEvents');
    const firstRejected = assert.rejects(first, /request was denied/u);
    const request = await harness.pending();
    assert.equal(request.request.kind, 'client_capability');
    if (request.request.kind !== 'client_capability')
      throw new Error('Expected capability request');
    await harness.answer(request.requestId, 'deny');
    await firstRejected;
    assert.equal(
      await harness.store.readClientCapabilitySessionGrant({
        sessionId: RUN.sessionId,
        ...request.request.target,
      }),
      undefined,
    );
    assert.equal(harness.cancelled.length, 1);
    assert.equal(harness.admitted.length, 0);
    const retry = harness.prepare('ComputerHistoryRead');
    const next = await harness.pending();
    assert.notEqual(next.requestId, request.requestId);
    await harness.answer(next.requestId, 'allow');
    await (await retry).execute(harness.callContext());
    assert.equal(harness.admitted.length, 1);
  });
});

test('provider withdrawal closes a pending History approval and blocks late approval', async () => {
  await withHistory(async (harness) => {
    const pending = harness.prepare('ComputerHistorySearch');
    const rejected = assert.rejects(pending);
    const request = await harness.pending();
    await harness.connection.close();
    await rejected;
    const closed = await harness.store.readInteraction(request.requestId);
    assert.equal(closed?.outcome?.outcome.kind, 'closure');
    const late = await harness.interactions.handlers['interaction.answer'](
      {
        sessionId: RUN.sessionId,
        interactionId: request.requestId,
        answer: { kind: 'client_capability', decision: 'allow' },
      },
      context,
    );
    assert.equal(late.ok, false);
    assert.equal(harness.admitted.length, 0);
  });
});

test('provider disconnect after approval prevents a prepared History call from executing', async () => {
  await withHistory(async (harness) => {
    const pending = harness.prepare('ComputerHistoryRead');
    const request = await harness.pending();
    await harness.answer(request.requestId, 'allow');
    const prepared = await pending;
    await harness.connection.close();
    await assert.rejects(async () => prepared.execute(harness.callContext()));
    assert.equal(harness.admitted.length, 0);
  });
});

for (const scenario of [
  {
    name: 'untrusted provider',
    principalKind: 'remote_owner' as const,
    error: /trusted Desktop provider/u,
  },
  { name: 'unknown tool', tool: 'ComputerHistoryEnable', error: /no managed admission policy/u },
  { name: 'unknown offer', offerId: 'history_extension', error: /no managed admission policy/u },
  {
    name: 'fake Desktop MCP offer',
    offerId: 'desktop_mcp_history',
    error: /no managed admission policy/u,
  },
  { name: 'wrong server', serverId: 'history_extension', error: /no managed admission policy/u },
  {
    name: 'URL evidence for data',
    evidence: { kind: 'browser_url', url: 'https://example.com' } as const,
    error: /does not accept scope evidence/u,
  },
  {
    name: 'URL evidence for safe status',
    tool: 'ComputerHistoryStatus',
    evidence: { kind: 'browser_url', url: 'https://example.com' } as const,
    error: /does not accept scope evidence/u,
  },
  {
    name: 'host path access',
    principalKind: 'local_owner' as const,
    hostPathAccess: 'cwd' as const,
    error: /no managed admission policy/u,
  },
]) {
  test(`managed History denies ${scenario.name} before approval and admission`, async () => {
    await withHistory(async (harness) => {
      await assert.rejects(
        () => harness.prepare(scenario.tool ?? 'ComputerHistorySearch'),
        scenario.error,
      );
      assert.equal((await harness.store.listSessionPending(RUN.sessionId)).length, 0);
      assert.equal(harness.admitted.length, 0);
      assert.equal(harness.cancelled.length, 1);
    }, scenario);
  });
}

test('managed History cannot use a grant in explore mode or without a run owner', async () => {
  await withHistory(async (harness) => {
    for (const tool of ['ComputerHistoryStatus', 'ComputerHistoryReadEvents']) {
      await assert.rejects(
        () => harness.prepare(tool, { permissionMode: 'explore' }),
        /unavailable in the current permission mode/u,
      );
      await assert.rejects(
        () => harness.prepare(tool, { runId: undefined }),
        /unavailable in the current permission mode/u,
      );
    }
    assert.equal(harness.admitted.length, 0);
    assert.equal((await harness.store.listSessionPending(RUN.sessionId)).length, 0);
  });
});

interface HistoryOptions {
  principalKind?: 'capability_provider' | 'local_owner' | 'remote_owner';
  offerId?: string;
  serverId?: string;
  tool?: string;
  evidence?: ClientCapabilityAdmissionEvidence;
  hostPathAccess?: 'none' | 'cwd';
}

async function withHistory(
  run: (harness: Awaited<ReturnType<typeof createHistoryHarness>>) => Promise<void>,
  options: HistoryOptions = {},
) {
  const harness = await createHistoryHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function createHistoryHarness(options: HistoryOptions) {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-admission-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const store = stores.interactionStore;
  const interactions = new HostInteractionCoordinator({
    store,
    sandboxBoundaries: {
      createSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected OS boundary request');
      },
      readSandboxBoundaryRequest: async () => undefined,
      listPendingSandboxBoundaryRequests: async () => [],
      settleSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected OS boundary settlement');
      },
      listHeaders: async () => [],
    },
    sessionAdmission: new SessionAdmissionGate(),
    sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
    now: Date.now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: async () => undefined,
    onPoison: () => undefined,
    onSandboxBoundarySettled: async () => undefined,
  });
  const runOwner = interactions.bindRun(RUN);
  let notifyApproval!: () => void;
  let approvalPublished = new Promise<void>((resolve) => {
    notifyApproval = resolve;
  });
  const coordinator = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
    grants: store,
    interactions: {
      requestClientCapabilityApproval: (input) => {
        const result = interactions.requestClientCapabilityApproval(input);
        notifyApproval();
        return result;
      },
    },
  });
  const admitted: string[] = [];
  const cancelled: string[] = [];
  let connection!: ClientCapabilityConnection;
  connection = coordinator.attachConnection(
    clientCapabilityConnectionIdentity(
      context.connectionId,
      'history-client',
      'desktop',
      options.principalKind ?? 'capability_provider',
    ),
    {
      send: async (frame) => {
        if (frame.kind === 'client.capability.call') {
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
            admissionEvidence: options.evidence ?? { kind: 'none' },
          });
        } else if (frame.kind === 'client.capability.admitted') {
          admitted.push(frame.invocationId);
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: { content: [{ type: 'text', text: 'result' }] },
          });
        } else if (frame.kind === 'client.capability.cancel') {
          cancelled.push(frame.invocationId);
        }
      },
    },
  );
  let snapshot: ClientCapabilitySnapshot | undefined;
  const close = async () => {
    snapshot?.release();
    await connection.close();
    await coordinator.close();
    await runOwner.close('turn_terminal');
    runOwner.release();
    await interactions.close();
    await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  };
  try {
    const registered = await coordinator.handlers['client.capability.replace'](
      {
        registrationId: 'history-registration',
        offers: [
          {
            offerId: options.offerId ?? SERVER,
            version: '1',
            affinity: 'session',
            hostPathAccess: options.hostPathAccess ?? 'none',
            label: 'Computer History',
            tools: (options.tool ? [options.tool] : TOOLS).map((name) => ({
              serverId: options.serverId ?? SERVER,
              name,
              inputSchema: { type: 'object', additionalProperties: false },
            })),
          },
        ],
      },
      context,
    );
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.deepEqual(await coordinator.bindSession(RUN.sessionId, context.connectionId), {
      ok: true,
    });
    snapshot = coordinator.snapshotForSession(RUN.sessionId);
    assert.ok(snapshot);
    const tools = new Map(snapshot.tools.map((tool) => [tool.displayName, tool]));
    let callId = 0;
    const callContext = () => ({
      ...RUN,
      cwd: root,
      toolCallId: `history-call-${++callId}`,
      permissionMode: 'ask' as const,
      executionBoundary: createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
      abortSignal: new AbortController().signal,
      emitOutput: () => undefined,
    });
    return {
      root,
      store,
      coordinator,
      connection,
      interactions,
      admitted,
      cancelled,
      close,
      callContext,
      purge: () => stores.purgeConversationOperationalState(RUN.sessionId),
      prepare: (name: string, override: { permissionMode?: 'explore'; runId?: undefined } = {}) => {
        const tool = tools.get(name);
        assert.equal(tool?.hostAdmission, 'client_capability');
        assert.ok(tool.prepareExecution);
        return tool.prepareExecution({}, { ...callContext(), ...override });
      },
      pending: async () => {
        await approvalPublished;
        approvalPublished = new Promise<void>((resolve) => {
          notifyApproval = resolve;
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const pending = await store.listSessionPending(RUN.sessionId);
          if (pending[0]) return pending[0];
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error('History approval was not published');
      },
      answer: async (requestId: string, decision: 'allow' | 'deny') => {
        const answered = await interactions.handlers['interaction.answer'](
          {
            sessionId: RUN.sessionId,
            interactionId: requestId,
            answer: { kind: 'client_capability', decision },
          },
          context,
        );
        assert.equal(answered.ok, true, JSON.stringify(answered));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
