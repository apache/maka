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

test('startup failure preserves its fixed safe cause', async () => {
  const result = await runHostedExecutionWithDependencies(input(), {
    connectOwnedRuntimeHost: async () => ({ kind: 'failed', reason: 'existing_host' }),
  });

  assert.equal(result.failureReason, 'Runtime Host did not start: existing_host');
});

test('startup cancellation closes admission with the cancelled result', async () => {
  const abort = new AbortController();
  const result = await runHostedExecutionWithDependencies(input(abort.signal), {
    connectOwnedRuntimeHost: async (request) => {
      assert.equal(request.signal, abort.signal);
      abort.abort();
      return { kind: 'failed', reason: 'host_unresponsive' };
    },
  });

  assert.equal(result.failureReason, 'Hosted execution was cancelled');
});

test('post-connect cancellation reports the owned Host settlement outcome', async () => {
  for (const [clean, failureReason] of [
    [true, 'Hosted execution was cancelled'],
    [false, 'Runtime Host did not exit cleanly'],
  ] as const) {
    const abort = new AbortController();
    const connected = ownedHost(
      {
        request: async () => {
          throw new Error('cancelled execution must not be admitted');
        },
      },
      clean,
    );

    const result = await runHostedExecutionWithDependencies(input(abort.signal), {
      connectOwnedRuntimeHost: async () => {
        abort.abort();
        return connected as never;
      },
    });

    assert.equal(result.failureReason, failureReason);
  }
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

function ownedHost(connection: Record<string, unknown>, clean = false) {
  return {
    kind: 'connected' as const,
    connection: { ...connection, close: async () => {} },
    host: {
      releaseToEnvironment: () => {},
      settle: async () => clean,
    },
  };
}
