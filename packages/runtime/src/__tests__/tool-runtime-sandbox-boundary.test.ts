import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createWorkspaceWritePermissionProfile,
  type ExecutionBoundary,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
  type SessionEvent,
  type SessionHeader,
} from '@maka/core';

import { PermissionEngine } from '../permission-engine.js';
import { buildRequestSandboxBoundaryTool } from '../sandbox-boundary-tool.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime session sandbox boundary', () => {
  test('does not consult the legacy permission engine for ordinary tools', async () => {
    let executed = false;
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      permissionEngine: new Proxy(
        {},
        {
          get() {
            throw new Error('legacy permission engine must not be consulted');
          },
        },
      ),
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
      name: 'Write',
      description: 'test',
      parameters: {},
      impl: () => {
        executed = true;
        return { ok: true };
      },
    };

    await settle(runtime, tool, 'tool-legacy-policy');

    assert.equal(executed, true);
  });

  test('reads the authoritative boundary for every tool invocation', async () => {
    const observed: ExecutionBoundary[] = [];
    let revision = 0;
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      permissionEngine,
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
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      permissionEngine,
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
    });
    runtime.beginTurn('turn-1');
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
    await runtime.respondToSandboxBoundaryRequest('turn-1', {
      requestId: requestEvent.requestId,
      decision: 'allow',
    });
    const result = (await pending).result as SandboxBoundarySettlement;
    assert.equal(result.request.status, 'approved');
    assert.equal(result.boundary.revision, 1);
  });

  test('returns a structured boundary requirement to the agent', async () => {
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'test' } as never,
      modelId: 'test',
      appendMessage: async () => {},
      permissionEngine,
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

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
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
