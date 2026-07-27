import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  AdditionalPermissionRequestEvent,
  LlmConnection,
  SessionEvent,
  SessionHeader,
  StoredMessage,
} from '@maka/core';

import {
  AdditionalPermissionError,
  buildAdditionalPermissionProposal,
  normalizeAdditionalPermissionProfile,
  type AdditionalPermissionProposal,
} from '../additional-permissions.js';
import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool, type MakaToolContext } from '../tool-runtime.js';

interface Harness {
  runtime: ToolRuntime;
  permissionEngine: PermissionEngine;
  events: SessionEvent[];
  messages: StoredMessage[];
}

function createHarness(cwd = '/tmp'): Harness {
  let id = 0;
  const events: SessionEvent[] = [];
  const messages: StoredMessage[] = [];
  const permissionEngine = new PermissionEngine({
    newId: () => `permission-${++id}`,
    now: () => 100,
  });
  permissionEngine.beginTurn('turn-1');
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header: testHeader(cwd),
    connection: testConnection(),
    modelId: 'test-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    permissionEngine,
    newId: () => `runtime-${++id}`,
    now: () => 100,
    getPermissionPauseTarget: () => null,
  });
  return { runtime, permissionEngine, events, messages };
}

function settle(harness: Harness, tool: MakaTool, input: unknown): Promise<unknown> {
  return harness.runtime
    .settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => harness.events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          harness.events.push(event);
        },
      },
    })
    .then((settlement) => settlement.result);
}

function networkProposal(input: {
  toolName: string;
  args: unknown;
  cwd?: string;
}): AdditionalPermissionProposal {
  return buildAdditionalPermissionProposal({
    profile: { network: { enabled: true } },
    normalizedPaths: [],
    justification: 'Access the requested network service.',
    toolName: input.toolName,
    args: input.args,
    workspaceRoots: [input.cwd ?? '/tmp'],
  });
}

describe('ToolRuntime additional permission orchestration', () => {
  test('forces one-shot approval, consumes the grant, and exposes it to one implementation', async () => {
    const harness = createHarness();
    const args = { command: 'curl http://127.0.0.1:8080' };
    const proposal = networkProposal({ toolName: 'Bash', args });
    let receivedContext: MakaToolContext['permissionContext'];
    let plannerCalls = 0;
    const tool: MakaTool<typeof args> = {
      name: 'Bash',
      description: 'test',
      parameters: {},
      permissionRequired: false,
      planAdditionalPermissions: (plannerArgs, context) => {
        plannerCalls += 1;
        assert.equal(Object.isFrozen(plannerArgs), true);
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(context.args), true);
        assert.equal(context.category, 'shell_unsafe');
        assert.equal(context.toolUseId, 'tool-1');
        return { kind: 'request', proposal };
      },
      impl: (_implementationArgs, context) => {
        receivedContext = context.permissionContext;
        return { ok: true };
      },
    };
    const pending = settle(harness, tool, args);
    const request = await waitForAdditionalRequest(harness.events);
    assert.equal(request.alsoApprovesToolExecution, false);
    harness.permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'allow',
    });

    assert.deepEqual(await pending, { ok: true });
    assert.equal(plannerCalls, 1);
    assert.equal(receivedContext?.additionalGrant?.permissionsHash, proposal.permissionsHash);
    assert.equal(receivedContext?.additionalGrant?.toolUseId, 'tool-1');
    assert.equal(Object.isFrozen(receivedContext), true);
    assert.throws(
      () =>
        harness.permissionEngine.consumeAdditionalPermissionGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          intentHash: proposal.intentHash,
        }),
      (error: unknown) =>
        error instanceof AdditionalPermissionError && error.reason === 'grant_already_consumed',
    );
  });

  test('denial never invokes the implementation', async () => {
    const harness = createHarness();
    const args = { command: 'curl http://127.0.0.1:8080' };
    const proposal = networkProposal({ toolName: 'Bash', args });
    let implementationCalled = false;
    const tool: MakaTool<typeof args> = {
      name: 'Bash',
      description: 'test',
      parameters: {},
      planAdditionalPermissions: () => ({ kind: 'request', proposal }),
      impl: () => {
        implementationCalled = true;
        return { ok: true };
      },
    };
    const pending = settle(harness, tool, args);

    const request = await waitForAdditionalRequest(harness.events);
    harness.permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
    });

    assert.deepEqual(await pending, { error: '用户已拒绝权限请求' });
    assert.equal(implementationCalled, false);
  });

  test('fails closed when an approved grant cannot be consumed', async () => {
    const harness = createHarness();
    const args = { command: 'curl http://127.0.0.1:8080' };
    const proposal = networkProposal({ toolName: 'Bash', args });
    let implementationCalled = false;
    const tool: MakaTool<typeof args> = {
      name: 'Bash',
      description: 'test',
      parameters: {},
      planAdditionalPermissions: () => ({ kind: 'request', proposal }),
      impl: () => {
        implementationCalled = true;
        return { ok: true };
      },
    };
    const pending = settle(harness, tool, args);

    const request = await waitForAdditionalRequest(harness.events);
    harness.permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'allow',
    });
    harness.permissionEngine.consumeAdditionalPermissionGrant = () => undefined;

    const result = await pending;
    assert.equal(implementationCalled, false);
    assert.match(JSON.stringify(result), /grant was unavailable/);
  });

  test('planner blocks and malformed planner results fail closed', async () => {
    for (const planAdditionalPermissions of [
      () => ({
        kind: 'block' as const,
        reason: 'additional_permissions_conflict_with_deny' as const,
        message: 'The requested path is explicitly denied.',
      }),
      () => undefined as never,
    ]) {
      const harness = createHarness();
      let implementationCalled = false;
      const tool: MakaTool<{ path: string }> = {
        name: 'Write',
        description: 'test',
        parameters: {},
        permissionRequired: false,
        planAdditionalPermissions,
        impl: () => {
          implementationCalled = true;
          return { ok: true };
        },
      };

      const result = await settle(harness, tool, { path: '/outside/file.txt' });

      assert.equal(implementationCalled, false);
      assert.equal(
        harness.events.some((event) => event.type === 'permission_request'),
        false,
      );
      assert.match(JSON.stringify(result), /explicitly denied|invalid result/);
    }
  });

  test('revalidates approved paths immediately before grant consumption', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-tool-runtime-additional-'));
    try {
      const target = join(cwd, 'created-after-approval.txt');
      const normalized = await normalizeAdditionalPermissionProfile({
        profile: {
          fileSystem: {
            entries: [{ path: target, access: 'write', scope: 'exact' }],
          },
        },
        cwd,
      });
      const args = { path: target, content: 'ok' };
      const proposal = buildAdditionalPermissionProposal({
        profile: normalized.profile,
        normalizedPaths: normalized.normalizedPaths,
        justification: 'Write the requested file.',
        toolName: 'Write',
        args,
        workspaceRoots: [cwd],
      });
      const harness = createHarness(cwd);
      let implementationCalled = false;
      const tool: MakaTool<typeof args> = {
        name: 'Write',
        description: 'test',
        parameters: {},
        planAdditionalPermissions: () => ({ kind: 'request', proposal }),
        impl: () => {
          implementationCalled = true;
          return { ok: true };
        },
      };
      const pending = settle(harness, tool, args);

      const request = await waitForAdditionalRequest(harness.events);
      await writeFile(target, 'changed target type', 'utf8');
      harness.permissionEngine.recordResponse('turn-1', {
        requestId: request.requestId,
        decision: 'allow',
      });

      const result = await pending;
      assert.equal(implementationCalled, false);
      assert.match(JSON.stringify(result), /changed type/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function waitForAdditionalRequest(
  events: readonly SessionEvent[],
): Promise<AdditionalPermissionRequestEvent> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = events.find(
      (event): event is AdditionalPermissionRequestEvent =>
        event.type === 'permission_request' && event.kind === 'additional_permissions',
    );
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for an additional permission request.');
}

function testHeader(cwd: string): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: cwd,
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'anthropic',
    defaultModel: 'test-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
