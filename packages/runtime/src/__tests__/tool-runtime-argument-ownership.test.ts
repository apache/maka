import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';

import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

interface InvocationArgs {
  path: string;
  content: string;
  layout: {
    cols: number;
  };
}

describe('ToolRuntime argument ownership', () => {
  test('keeps each runtime owner isolated from the canonical invocation', async () => {
    const initialArgs: InvocationArgs = {
      path: 'notes.md',
      content: 'approved',
      layout: { cols: 120 },
    };
    const providerArgs = structuredClone(initialArgs);
    const observed = new Map<string, InvocationArgs>();
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');

    let resolvePermission!: (event: Extract<SessionEvent, { type: 'permission_request' }>) => void;
    const permissionRequested = new Promise<Extract<SessionEvent, { type: 'permission_request' }>>(
      (resolve) => {
        resolvePermission = resolve;
      },
    );
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header: testHeader(),
      connection: testConnection(),
      modelId: 'test-model',
      appendMessage: async (message) => {
        if (message.type !== 'tool_call') return;
        observeAndMutate(observed, 'storage', message.args);
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      recordToolArtifacts: (input) => {
        observeAndMutate(observed, 'artifact', input.args);
      },
    });
    const tool: MakaTool<InvocationArgs> = {
      name: 'Write',
      description: 'Write a file',
      parameters: {},
      permissionArgs: (args) => {
        observeAndMutate(observed, 'permissionProjection', args);
        return structuredClone(initialArgs);
      },
      sandbox: ({ args }) => {
        observeAndMutate(observed, 'sandbox', args);
        return { platformSandboxAvailable: false };
      },
      impl: async (args) => {
        observeAndMutate(observed, 'implementation', args);
        return { ok: true, path: '/tmp/maka/notes.md' };
      },
    };
    const pending = runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input: providerArgs,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => {
          if (event.type === 'tool_start') {
            observeAndMutate(observed, 'event', event.args);
          } else if (event.type === 'permission_request') {
            observed.set('permission', structuredClone(event.args) as InvocationArgs);
            resolvePermission(event);
          }
        },
        pushAndWaitUntilConsumed: async (event) => {
          if (event.type === 'tool_start') {
            observeAndMutate(observed, 'event', event.args);
          } else if (event.type === 'permission_request') {
            observed.set('permission', structuredClone(event.args) as InvocationArgs);
            resolvePermission(event);
          }
        },
      },
    });
    mutateArgs(providerArgs, 'provider');
    const request = await permissionRequested;
    permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'allow',
    });

    await pending;
    permissionEngine.endTurn('turn-1');

    const owners = [
      'storage',
      'event',
      'permissionProjection',
      'sandbox',
      'permission',
      'implementation',
      'artifact',
    ];
    for (const owner of owners) {
      assert.deepEqual(observed.get(owner), initialArgs);
    }
    assert.equal(providerArgs.content, 'provider');
  });
});

function observeAndMutate(
  observed: Map<string, InvocationArgs>,
  owner: string,
  value: unknown,
): void {
  observed.set(owner, structuredClone(value) as InvocationArgs);
  mutateArgs(value, owner);
}

function mutateArgs(value: unknown, owner: string): void {
  const mutable = value as InvocationArgs;
  mutable.content = owner;
  mutable.layout.cols = owner.length;
}

function testHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
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

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}
