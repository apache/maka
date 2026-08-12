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

test('explicit target mutation settles the first Host before execution reconnects', async () => {
  const projection = settled('completed');
  const events: string[] = [];
  const first = mutatingFirstHost(events);
  const second = ownedHost({
    request: async (operation: string) => {
      events.push(`second:${operation}`);
      assert.equal(operation, 'hosted.execution.start');
      return projection;
    },
  });
  second.connection.close = async () => {
    events.push('second:close');
  };
  second.host.releaseToEnvironment = () => {
    events.push('second:release');
  };
  const hosts = [first, second];
  let connects = 0;

  const result = await runHostedExecutionWithDependencies(explicitInput(), {
    connectOwnedRuntimeHost: async () => {
      connects += 1;
      events.push(`connect:${connects}`);
      return hosts.shift() as never;
    },
  });

  assert.deepEqual(result, projection);
  assert.deepEqual(events, [
    'connect:1',
    'first:connection.catalog.query',
    'first:connection.models.fetch',
    'first:connection.catalog.query',
    'first:close',
    'first:settle',
    'connect:2',
    'second:hosted.execution.start',
    'second:close',
    'second:release',
  ]);
});

test('explicit target already admitted executes without reconnecting', async () => {
  const projection = settled('completed');
  const events: string[] = [];
  const host = ownedHost({
    request: async (operation: string) => {
      events.push(operation);
      if (operation === 'connection.catalog.query') return catalogPage(true);
      if (operation === 'hosted.execution.start') return projection;
      throw new Error(`Unexpected operation ${operation}`);
    },
  });
  host.host.releaseToEnvironment = () => {
    events.push('release');
  };
  let connects = 0;

  const result = await runHostedExecutionWithDependencies(explicitInput(), {
    connectOwnedRuntimeHost: async () => {
      connects += 1;
      return host as never;
    },
  });

  assert.deepEqual(result, projection);
  assert.equal(connects, 1);
  assert.deepEqual(events, [
    'connection.catalog.query',
    'connection.catalog.query',
    'hosted.execution.start',
    'release',
  ]);
});

test('explicit target reconnect failure reports the second Host startup cause', async () => {
  const first = mutatingFirstHost([]);
  let connects = 0;

  const result = await runHostedExecutionWithDependencies(explicitInput(), {
    connectOwnedRuntimeHost: async () => {
      connects += 1;
      return connects === 1
        ? (first as never)
        : { kind: 'failed' as const, reason: 'host_unresponsive' };
    },
  });

  assert.equal(result.failureReason, 'Runtime Host did not start: host_unresponsive');
  assert.equal(connects, 2);
});

test('explicit target reconnect cancellation preserves the cancelled outcome', async () => {
  const abort = new AbortController();
  const first = mutatingFirstHost([]);
  let connects = 0;

  const result = await runHostedExecutionWithDependencies(explicitInput(abort.signal), {
    connectOwnedRuntimeHost: async () => {
      connects += 1;
      if (connects === 1) return first as never;
      abort.abort(new Error('cancelled'));
      return { kind: 'failed' as const, reason: 'host_unresponsive' };
    },
  });

  assert.equal(result.failureReason, 'Hosted execution was cancelled');
  assert.equal(connects, 2);
});

const ID = '00000000-0000-4000-8000-000000000001';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000002';

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

function explicitInput(signal?: AbortSignal) {
  return {
    ...input(signal),
    baseUrl: 'https://api.deepseek.com',
    execution: {
      ...input().execution,
      session: {
        ...input().execution.session,
        modelTarget: {
          kind: 'explicit' as const,
          connectionSlug: 'env-deepseek',
          model: 'deepseek-v4-flash',
        },
      },
    },
  };
}

function mutatingFirstHost(events: string[]) {
  let catalogQueries = 0;
  const first = ownedHost({
    request: async (operation: string) => {
      events.push(`first:${operation}`);
      if (operation === 'connection.catalog.query') {
        catalogQueries += 1;
        return catalogPage(catalogQueries > 1);
      }
      if (operation === 'connection.models.fetch') {
        return {
          kind: 'committed',
          catalogRevision: 2,
          connection: { connectionId: CONNECTION_ID, revision: 2 },
          modelCount: 1,
          source: 'fetched',
          fetchedAt: 1,
        };
      }
      throw new Error(`Unexpected first Host operation ${operation}`);
    },
  });
  first.connection.close = async () => {
    events.push('first:close');
  };
  first.host.settle = async () => {
    events.push('first:settle');
    return true;
  };
  return first;
}

function catalogPage(admitted: boolean) {
  return {
    kind: 'page' as const,
    revision: admitted ? 2 : 1,
    defaultTarget: { connectionId: CONNECTION_ID, modelId: 'deepseek-v4-flash' },
    connectionCount: 1,
    items: [
      {
        kind: 'connection' as const,
        connectionIndex: 0,
        connectionId: CONNECTION_ID,
        revision: admitted ? 2 : 1,
        slug: 'env-deepseek',
        name: 'DeepSeek',
        providerType: 'deepseek' as const,
        baseUrl: 'https://api.deepseek.com/',
        enabled: true,
        enabledModelIdCount: 1,
        modelCount: admitted ? 1 : 0,
      },
      {
        kind: 'enabled_model_id' as const,
        connectionIndex: 0,
        itemIndex: 0,
        modelId: 'deepseek-v4-flash',
      },
      ...(admitted
        ? [
            {
              kind: 'model' as const,
              connectionIndex: 0,
              itemIndex: 0,
              model: { id: 'deepseek-v4-flash' },
            },
          ]
        : []),
    ],
    nextCursor: null,
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
