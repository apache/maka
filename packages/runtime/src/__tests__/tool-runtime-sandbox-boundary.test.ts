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
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import {
  type ExecutionBoundary,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
} from '@maka/core/sandbox-boundary';
import { type SessionEvent } from '@maka/core/events';
import { type SessionHeader } from '@maka/core/session';
import type {
  HostedInteractionBridge,
  HostedSandboxBoundarySettlement,
} from '@maka/core/backend-types';
import type { SandboxBoundaryRequestEvent } from '@maka/core/events';

import {
  buildRequestSandboxBoundaryTool,
  SANDBOX_BOUNDARY_UNAVAILABLE,
} from '../sandbox-boundary-tool.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { SandboxCommandError } from '../sandbox/errors.js';
import { ToolRuntime, type MakaTool, type ToolRuntimeInput } from '../tool-runtime.js';

describe('ToolRuntime session sandbox boundary', () => {
  test('rejects an embedding without explicit execution boundary authority', () => {
    assert.throws(
      () =>
        new ToolRuntime({
          turnId: 'turn-1',
          sessionId: 'session-1',
          header: header(),
          connection: { providerType: 'openai', slug: 'test' } as never,
          modelId: 'test',
          appendMessage: async () => {},
          newId: nextId(),
          now: () => 1,
          getPermissionPauseTarget: () => null,
        } as unknown as ToolRuntimeInput),
      /explicit execution boundary authority/,
    );
  });

  test('reads the authoritative boundary for every tool invocation', async () => {
    const observed: ExecutionBoundary[] = [];
    let revision = 0;
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: revision++,
      }),
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const tool: MakaTool = {
      name: 'Read',
      description: 'test',
      parameters: {},
      impl: (_args, context) => {
        assert.ok(context.executionBoundary);
        observed.push(context.executionBoundary);
        return { ok: true };
      },
    };

    await settle(runtime, tool, 'tool-1');
    await settle(runtime, tool, 'tool-2');

    assert.deepEqual(
      observed.map((boundary) => boundary.revision),
      [0, 1],
    );
  });

  test('parks the dedicated request tool until the exact durable expansion is settled', async () => {
    const events: SessionEvent[] = [];
    const managed: ExecutionBoundary = {
      kind: 'managed',
      profile: createWorkspaceWritePermissionProfile(),
      revision: 0,
    };
    let created: SandboxBoundaryRequest | undefined;
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => managed,
      createSandboxBoundaryRequest: async (input) => {
        created = {
          ...input,
          status: 'pending',
          baseRevision: 0,
          createdAt: 1,
        };
        return created;
      },
      settleSandboxBoundaryRequest: async (input) => {
        assert.ok(created);
        const request: SandboxBoundaryRequest = {
          ...created,
          status: input.decision === 'allow' ? 'approved' : 'denied',
          settledAt: 2,
          ...(input.decision === 'allow' ? { appliedRevision: 1 } : {}),
        };
        const boundary: ExecutionBoundary =
          input.decision === 'allow' ? { ...managed, revision: 1 } : managed;
        return { request, boundary, changed: input.decision === 'allow' };
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      runId: 'run-1',
    });
    const tool = buildRequestSandboxBoundaryTool();
    const pending = runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-boundary',
      input: {
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        justification: 'Read the user-selected file.',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    const requestEvent = await waitForBoundaryRequest(events);
    assert.deepEqual(requestEvent.expansion, created?.expansion);
    // Provenance is committed with the row, before the request event is even
    // published, so a crash in between still leaves the request attributable.
    assert.equal(created?.turnId, 'turn-1');
    assert.equal(created?.runId, 'run-1');
    await runtime.respondToSandboxBoundaryRequest('turn-1', {
      requestId: requestEvent.requestId,
      decision: 'allow',
    });
    const result = (await pending).result as SandboxBoundarySettlement;
    assert.equal(result.request.status, 'approved');
    assert.equal(result.boundary.revision, 1);
  });

  test('publishes a hosted boundary only after admission and settles only through its continuation', async () => {
    const events: SessionEvent[] = [];
    const admissionStarted = deferred<void>();
    const releaseAdmission = deferred<void>();
    const managed: ExecutionBoundary = {
      kind: 'managed',
      profile: createWorkspaceWritePermissionProfile(),
      revision: 0,
    };
    let admittedRequest: SandboxBoundaryRequestEvent | undefined;
    let captured: HostedSandboxBoundarySettlement | undefined;
    const hostedInteraction: HostedInteractionBridge = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      admitUserQuestionRequest: async () => {
        throw new Error('Unexpected user question');
      },
      admitSandboxBoundaryRequest: async ({ request, settlement }) => {
        admittedRequest = request;
        captured = settlement;
        admissionStarted.resolve();
        await releaseAdmission.promise;
      },
    };
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      hostedInteraction,
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => managed,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      runId: 'run-1',
    });
    const pending = runtime.settleToolCall({
      tool: buildRequestSandboxBoundaryTool(),
      turnId: 'turn-1',
      toolCallId: 'tool-boundary',
      input: {
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        justification: 'Read the user-selected file.',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    await admissionStarted.promise;
    assert.equal(
      events.some((event) => event.type === 'sandbox_boundary_request'),
      false,
    );
    await assert.rejects(
      runtime.respondToSandboxBoundaryRequest('turn-1', {
        requestId: admittedRequest!.requestId,
        decision: 'allow',
      }),
      /captured continuation/,
    );
    releaseAdmission.resolve();
    const requestEvent = await waitForBoundaryRequest(events);
    assert.ok(captured);
    await captured.applyDecision({
      request: {
        sessionId: 'session-1',
        requestId: requestEvent.requestId,
        status: 'approved',
        baseRevision: 0,
        expansion: requestEvent.expansion,
        justification: requestEvent.justification,
        createdAt: requestEvent.ts,
        settledAt: 2,
        appliedRevision: 1,
        turnId: 'turn-1',
        runId: 'run-1',
      },
      boundary: { ...managed, revision: 1 },
      changed: true,
    });
    const result = (await pending).result as SandboxBoundarySettlement;
    assert.equal(result.request.status, 'approved');
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.type === 'sandbox_boundary_request' ||
            event.type === 'sandbox_boundary_decision_ack',
        )
        .map((event) => event.type),
      ['sandbox_boundary_request', 'sandbox_boundary_decision_ack'],
    );
  });

  test('rejects an invalid expansion before creating durable pending state', async () => {
    let createCalls = 0;
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      createSandboxBoundaryRequest: async () => {
        createCalls += 1;
        throw new Error('must not create');
      },
      settleSandboxBoundaryRequest: async () => {
        throw new Error('must not settle');
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });

    const settlement = await runtime.settleToolCall({
      tool: buildRequestSandboxBoundaryTool(),
      turnId: 'turn-1',
      toolCallId: 'tool-boundary',
      input: {
        expansion: {
          filesystem: {
            entries: [{ path: '../outside', access: 'read', scope: 'exact' }],
          },
        },
        justification: 'Read outside.',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.equal(createCalls, 0);
    assert.match((settlement.result as { error: string }).error, /absolute/i);
  });

  test('canonicalizes filesystem authority before creating durable pending state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-request-'));
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    const file = join(target, 'file.txt');
    await mkdir(target);
    await writeFile(file, 'ok');
    await symlink(target, alias, 'dir');
    const canonicalFile = await realpath(file);
    let created: SandboxBoundaryRequest | undefined;
    const events: SessionEvent[] = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(root),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      createSandboxBoundaryRequest: async (input) => {
        created = {
          ...input,
          status: 'pending',
          baseRevision: 0,
          createdAt: 1,
        };
        return created;
      },
      settleSandboxBoundaryRequest: async (input) => {
        assert.ok(created);
        return {
          request: {
            ...created,
            status: 'denied',
            settledAt: 2,
          },
          boundary: {
            kind: 'managed',
            profile: createWorkspaceWritePermissionProfile(),
            revision: 0,
          },
          changed: false,
        };
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });

    try {
      const pending = runtime.settleToolCall({
        tool: buildRequestSandboxBoundaryTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-boundary',
        input: {
          expansion: {
            filesystem: {
              entries: [{ path: join(alias, 'file.txt'), access: 'read', scope: 'exact' }],
            },
          },
          justification: 'Read the selected file.',
        },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => events.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      });
      const request = await waitForBoundaryRequest(events);
      assert.equal(request.expansion.filesystem?.entries[0]?.path, canonicalFile);
      assert.equal(created?.expansion.filesystem?.entries[0]?.path, canonicalFile);
      await runtime.respondToSandboxBoundaryRequest('turn-1', {
        requestId: request.requestId,
        decision: 'deny',
      });
      await pending;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects exact directory authority before creating durable pending state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-directory-'));
    let createCalls = 0;
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(root),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      createSandboxBoundaryRequest: async () => {
        createCalls += 1;
        throw new Error('must not create');
      },
      settleSandboxBoundaryRequest: async () => {
        throw new Error('must not settle');
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });

    try {
      const settlement = await runtime.settleToolCall({
        tool: buildRequestSandboxBoundaryTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-boundary',
        input: {
          expansion: {
            filesystem: {
              entries: [{ path: root, access: 'read', scope: 'exact' }],
            },
          },
          justification: 'Read one directory path.',
        },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => {},
          pushAndWaitUntilConsumed: async () => {},
        },
      });

      assert.equal(createCalls, 0);
      assert.match((settlement.result as { error: string }).error, /exact.*directory/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('durably denies a pending boundary request before an aborted turn closes', async () => {
    const events: SessionEvent[] = [];
    const managed: ExecutionBoundary = {
      kind: 'managed',
      profile: createWorkspaceWritePermissionProfile(),
      revision: 0,
    };
    let created: SandboxBoundaryRequest | undefined;
    const settlements: Array<{ requestId: string; decision: string }> = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => managed,
      createSandboxBoundaryRequest: async (input) => {
        created = {
          ...input,
          status: 'pending',
          baseRevision: 0,
          createdAt: 1,
        };
        return created;
      },
      settleSandboxBoundaryRequest: async (input) => {
        assert.ok(created);
        settlements.push({ requestId: input.requestId, decision: input.decision });
        return {
          request: {
            ...created,
            status: 'denied',
            settledAt: 2,
          },
          boundary: managed,
          changed: false,
        };
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const pending = runtime.settleToolCall({
      tool: buildRequestSandboxBoundaryTool(),
      turnId: 'turn-1',
      toolCallId: 'tool-boundary',
      input: {
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        justification: 'Read the user-selected file.',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    const request = await waitForBoundaryRequest(events);
    await runtime.endTurn('aborted');
    await pending;
    assert.deepEqual(settlements, [{ requestId: request.requestId, decision: 'deny' }]);
  });

  test('does not orphan a request created concurrently with turn shutdown', async () => {
    const managed: ExecutionBoundary = {
      kind: 'managed',
      profile: createWorkspaceWritePermissionProfile(),
      revision: 0,
    };
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let releaseCreate!: (request: SandboxBoundaryRequest) => void;
    const deferredCreate = new Promise<SandboxBoundaryRequest>((resolve) => {
      releaseCreate = resolve;
    });
    const settlements: string[] = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => managed,
      createSandboxBoundaryRequest: async () => {
        markCreateStarted();
        return deferredCreate;
      },
      settleSandboxBoundaryRequest: async (input) => {
        settlements.push(input.decision);
        return {
          request: {
            sessionId: input.sessionId,
            requestId: input.requestId,
            expansion: { network: { enabled: true } },
            justification: 'Use the network.',
            status: 'denied',
            baseRevision: 0,
            createdAt: 1,
            settledAt: 2,
          },
          boundary: managed,
          changed: false,
        };
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const pending = runtime.settleToolCall({
      tool: buildRequestSandboxBoundaryTool(),
      turnId: 'turn-1',
      toolCallId: 'tool-boundary',
      input: {
        expansion: { network: { enabled: true } },
        justification: 'Use the network.',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });
    await createStarted;
    const ending = runtime.endTurn('aborted');
    releaseCreate({
      sessionId: 'session-1',
      requestId: 'id-1',
      expansion: { network: { enabled: true } },
      justification: 'Use the network.',
      status: 'pending',
      baseRevision: 0,
      createdAt: 1,
    });

    await ending;
    await pending;
    assert.deepEqual(settlements, ['deny']);
  });

  test('returns a structured boundary requirement to the agent', async () => {
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const tool: MakaTool = {
      name: 'Read',
      description: 'test',
      parameters: {},
      impl: () => {
        throw new FilesystemWorkerClientError({
          reason: 'sandbox_boundary_required',
          stage: 'validation',
          recoverable: true,
          requiredExpansion: {
            filesystem: {
              entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
            },
          },
        });
      },
    };

    const settlement = await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.deepEqual(settlement.result, {
      error: 'Filesystem worker failed: sandbox_boundary_required.',
      sandbox: {
        domain: 'filesystem',
        stage: 'validation',
        reason: 'sandbox_boundary_required',
        recoverable: true,
        requiredExpansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      },
    });
  });

  test('cancels a suspended nested boundary wait when its cell aborts', async () => {
    const events: SessionEvent[] = [];
    const settlements: string[] = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      createSandboxBoundaryRequest: async (input) => ({
        ...input,
        status: 'pending',
        baseRevision: 0,
        createdAt: 1,
      }),
      settleSandboxBoundaryRequest: async (input) => {
        settlements.push(input.decision);
        return {
          request: {
            sessionId: 'session-1',
            requestId: input.requestId,
            expansion: { network: { enabled: true } },
            justification: 'Use the network.',
            status: 'denied',
            baseRevision: 0,
            createdAt: 1,
            settledAt: 2,
          },
          boundary: {
            kind: 'managed',
            profile: createWorkspaceWritePermissionProfile(),
            revision: 0,
          },
          changed: false,
        };
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const controller = new AbortController();
    const pending = runtime.settleToolCall({
      tool: {
        name: 'network_task',
        description: 'Request network authority',
        parameters: {},
        impl: async (_input, context) =>
          context.requestSandboxBoundary!({ network: { enabled: true } }, 'Use the network.'),
      },
      turnId: 'turn-1',
      toolCallId: 'network-1',
      input: {},
      abortSignal: controller.signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    while (!events.some((event) => event.type === 'sandbox_boundary_request')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error('cell aborted'));
    const outcome = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 50)),
    ]);
    if (outcome === 'timed_out') await runtime.endTurn('aborted');
    await pending;
    assert.equal(outcome, 'settled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(settlements, ['deny']);
  });

  test('keeps a durable deny failure attached to the aborted nested call', async () => {
    const events: SessionEvent[] = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      createSandboxBoundaryRequest: async (input) => ({
        ...input,
        status: 'pending',
        baseRevision: 0,
        createdAt: 1,
      }),
      settleSandboxBoundaryRequest: async () => {
        throw new Error('durable deny failed');
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const controller = new AbortController();
    const pending = runtime.settleToolCall({
      tool: {
        name: 'network_task',
        description: 'Request network authority',
        parameters: {},
        impl: async (_input, context) =>
          await context.requestSandboxBoundary!({ network: { enabled: true } }, 'Use the network.'),
      },
      turnId: 'turn-1',
      toolCallId: 'network-failing-deny',
      input: {},
      abortSignal: controller.signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    while (!events.some((event) => event.type === 'sandbox_boundary_request')) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error('cell aborted'));
    const outcome = await pending;
    assert.match(String((outcome.result as { error?: unknown }).error), /durable deny failed/);
  });

  test('returns structured requires_bypass without opening an interaction', async () => {
    const events: SessionEvent[] = [];
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'test',
      parameters: {},
      impl: () => {
        throw new SandboxCommandError({
          domain: 'command',
          stage: 'capability',
          reason: 'requires_bypass',
          recoverable: false,
        });
      },
    };

    const settlement = await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    assert.deepEqual(settlement.result, {
      error: 'Command sandbox failed: requires_bypass.',
      sandbox: {
        domain: 'command',
        stage: 'capability',
        reason: 'requires_bypass',
        recoverable: false,
      },
    });
    assert.equal(
      events.some((event) => event.type === 'sandbox_boundary_request'),
      false,
    );
    assert.deepEqual(events.find((event) => event.type === 'tool_result')?.content, {
      kind: 'text',
      text: 'Command sandbox failed: requires_bypass.',
      sandboxFailure: { reason: 'requires_bypass' },
    });
  });

  test('a surface without boundary storage refuses with the same sentence the tool carries', async () => {
    // The tool's own guard on `context.requestSandboxBoundary` cannot fire
    // here: ToolRuntime injects that callback unconditionally. This is the
    // branch a model actually reaches, and it used to say something different
    // from the tool the model called.
    const runtime = new ToolRuntime({
      turnId: 'turn-1',
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      readExecutionBoundary: async () => ({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });

    const settlement = await runtime.settleToolCall({
      tool: buildRequestSandboxBoundaryTool() as unknown as MakaTool,
      turnId: 'turn-1',
      toolCallId: 'call-boundary-unavailable',
      input: {
        expansion: { kind: 'path', path: join(process.cwd(), 'x'), access: 'write' },
        justification: 'need it',
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.deepEqual(settlement.modelOutput, {
      type: 'error-text',
      value: `Error: ${SANDBOX_BOUNDARY_UNAVAILABLE}`,
    });
  });
});

async function settle(runtime: ToolRuntime, tool: MakaTool, toolCallId: string): Promise<void> {
  const events: SessionEvent[] = [];
  await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId,
    input: {},
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });
}

function header(cwd = process.cwd()): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: cwd,
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

async function waitForBoundaryRequest(
  events: SessionEvent[],
): Promise<Extract<SessionEvent, { type: 'sandbox_boundary_request' }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = events.find((candidate) => candidate.type === 'sandbox_boundary_request');
    if (event?.type === 'sandbox_boundary_request') return event;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Sandbox boundary request was not emitted');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
