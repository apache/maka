import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRuntimeHostReconnectingConnection,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type DirectRequestOperationKey,
  type RuntimeHostConnection,
} from '../client/index.js';
import type { OperationInput, OperationKey, OperationOutput } from '../protocol/index.js';

test('a reconnecting Client retries an interrupted query on the replacement connection', async () => {
  const first = connectionHarness('first', (operation) => {
    first.disconnect();
    throw interrupted(operation, 'query', 'dispatched');
  });
  const unstable = connectionHarness('unstable', (operation) => {
    throw interrupted(operation, 'query', 'dispatched');
  });
  unstable.disconnect();
  const replacement = connectionHarness('replacement', (operation, input) => {
    assert.equal(operation, 'goal.query');
    const sessionId = (input as OperationInput<'goal.query'>).sessionId;
    return { sessionId, goal: null } satisfies OperationOutput<'goal.query'>;
  });
  const reconnected = deferred();
  let attempts = 0;
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => {
      attempts += 1;
      if (attempts === 1) return unstable.connection;
      reconnected.resolve();
      return replacement.connection;
    },
  });
  assert.deepEqual(await connection.request('goal.query', { sessionId: 'session-1' }), {
    sessionId: 'session-1',
    goal: null,
  });
  await reconnected.promise;
  assert.deepEqual(first.operations, ['goal.query']);
  assert.deepEqual(unstable.operations, ['goal.query']);
  assert.deepEqual(replacement.operations, ['goal.query']);
  await connection.close();
});

test('a reconnecting Client never replays an admitted command with an unknown outcome', async () => {
  const first = connectionHarness('first', (operation) => {
    first.disconnect();
    throw interrupted(operation, 'command', 'dispatched');
  });
  const replacement = connectionHarness('replacement', () => {
    throw new Error('command must not reach the replacement connection');
  });
  const reconnected = deferred();
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => {
      reconnected.resolve();
      return replacement.connection;
    },
  });

  await assert.rejects(
    connection.request('turn.start', {
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: { text: 'hello' },
    }),
    (error: unknown) =>
      error instanceof RuntimeHostRequestInterruptedError &&
      error.mode === 'command' &&
      error.dispatch === 'dispatched' &&
      error.retryable === false,
  );
  await reconnected.promise;
  assert.deepEqual(first.operations, ['turn.start']);
  assert.deepEqual(replacement.operations, []);
  await connection.close();
});

test('a reconnecting Client waits for a replacement after a draining query rejection', async () => {
  const first = connectionHarness('first', (operation) => {
    first.disconnect();
    throw new RuntimeHostOperationError(operation, 'host_draining', 'Runtime Host is draining');
  });
  const replacement = connectionHarness('replacement', (operation, input) => {
    assert.equal(operation, 'goal.query');
    const sessionId = (input as OperationInput<'goal.query'>).sessionId;
    return { sessionId, goal: null } satisfies OperationOutput<'goal.query'>;
  });
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => replacement.connection,
  });

  assert.deepEqual(await connection.request('goal.query', { sessionId: 'session-1' }), {
    sessionId: 'session-1',
    goal: null,
  });
  assert.deepEqual(first.operations, ['goal.query']);
  assert.deepEqual(replacement.operations, ['goal.query']);
  await connection.close();
});

test('a Session observation reopens safely after its first connection starts draining', async () => {
  const first = connectionHarness(
    'first',
    () => undefined,
    async () => {
      first.disconnect();
      throw new RuntimeHostOperationError(
        'subscription.open',
        'host_draining',
        'Runtime Host is draining',
      );
    },
  );
  const subscription = { subscriptionId: 'replacement-subscription' };
  const replacement = connectionHarness(
    'replacement',
    () => undefined,
    async () => subscription,
  );
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => replacement.connection,
  });

  assert.equal(await connection.openSessionSubscription({ sessionId: 'session-1' }), subscription);
  assert.equal(first.openedSubscriptions, 1);
  assert.equal(replacement.openedSubscriptions, 1);
  await connection.close();
});

function connectionHarness(
  id: string,
  request: (operation: DirectRequestOperationKey, input: unknown) => unknown,
  openSubscription: () => Promise<unknown> = async () => {
    throw new Error('subscription is not available in this fixture');
  },
) {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const operations: DirectRequestOperationKey[] = [];
  let openedSubscriptions = 0;
  const connection = {
    rootId: 'root-id',
    hostEpoch: `host-${id}`,
    connectionId: id,
    selectedProtocol: 0,
    closed,
    request: async (operation: DirectRequestOperationKey, input: unknown) => {
      operations.push(operation);
      return request(operation, input);
    },
    openSessionSubscription: async () => {
      openedSubscriptions += 1;
      return openSubscription();
    },
    subscribeConfigurationChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    close: async () => resolveClosed(),
  } as unknown as RuntimeHostConnection;
  return {
    connection,
    operations,
    disconnect: resolveClosed,
    get openedSubscriptions() {
      return openedSubscriptions;
    },
  };
}

function interrupted(
  operation: OperationKey,
  mode: 'query' | 'command' | 'control',
  dispatch: 'not_dispatched' | 'dispatched',
): RuntimeHostRequestInterruptedError {
  return new RuntimeHostRequestInterruptedError(operation, mode, dispatch, 'connection_lost');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
