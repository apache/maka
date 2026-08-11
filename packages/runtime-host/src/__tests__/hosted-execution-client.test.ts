import assert from 'node:assert/strict';
import test from 'node:test';
import { runHostedExecutionWithDependencies } from '../client/hosted-execution.js';

test('diagnostics disconnect after settlement preserves the canonical result', async () => {
  for (const status of ['completed', 'failed'] as const) {
    const projection = settled(status);
    const connected = ownedHost({
      request: async () => projection,
      queryHostDiagnostics: async () => {
        throw new Error('connection closed');
      },
    });

    const result = await runHostedExecutionWithDependencies(input(), {
      connectOwnedRuntimeHost: async () => connected as never,
    });

    assert.deepEqual(result, projection);
  }
});

test('abort observed with a completed response does not replace the result', async () => {
  const abort = new AbortController();
  const projection = settled('completed');
  const connected = ownedHost({
    request: async (operation: string) => {
      if (operation === 'hosted.execution.start') {
        abort.abort();
        return projection;
      }
      return {
        executionId: ID,
        kind: 'indeterminate' as const,
        failureReason: 'Hosted execution is not active',
      };
    },
  });

  const result = await runHostedExecutionWithDependencies(input(abort.signal), {
    connectOwnedRuntimeHost: async () => connected as never,
  });

  assert.deepEqual(result, projection);
});

const ID = '00000000-0000-4000-8000-000000000001';

function input(signal?: AbortSignal) {
  return {
    rootPath: '/runtime-host',
    execution: {
      executionId: ID,
      session: {
        workspace: { kind: 'host_path' as const, path: '/workspace' },
        modelTarget: { kind: 'default' as const },
      },
      content: { text: 'solve' },
    },
    ...(signal ? { signal } : {}),
  };
}

function settled(status: 'completed' | 'failed') {
  return {
    executionId: ID,
    kind: 'settled' as const,
    status,
    ...(status === 'failed' ? { failureReason: 'subject failed' } : {}),
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      totalTokens: 18,
    },
    costUsd: 0.25,
  };
}

function ownedHost(connection: Record<string, unknown>) {
  return {
    kind: 'connected' as const,
    connection: { ...connection, close: async () => {} },
    host: {
      releaseToEnvironment: () => {},
      settle: async () => false,
    },
  };
}
