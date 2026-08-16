import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRuntimeHostReconnectingConnection,
  remoteRuntimeHostUnavailableError,
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRequestInterruptedError,
  startRuntimeHostReconnectLifecycle,
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

  assert.equal(
    await connection.openSessionSubscription({
      sessionId: 'session-1',
      transcript: { kind: 'none' },
    }),
    subscription,
  );
  assert.equal(first.openedSubscriptions, 1);
  assert.equal(replacement.openedSubscriptions, 1);
  await connection.close();
});

test('a reconnecting Client rejects a different Host composition permanently', async () => {
  const first = connectionHarness('first', () => undefined);
  const replacement = connectionHarness('replacement', () => undefined, undefined, {
    id: 'maka.interactive',
    revision: '2',
  });
  let fatalError: Error | undefined;
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => replacement.connection,
    onFatalError: (error) => {
      fatalError = error;
    },
  });

  first.disconnect();
  await connection.closed;

  assert.ok(fatalError instanceof RuntimeHostPermanentReconnectError);
  assert.match(fatalError.message, /composition changed/u);
  await connection.close();
});

test('a reconnecting Client stops after its remote credential is rejected', async () => {
  const first = connectionHarness('first', () => undefined);
  let attempts = 0;
  let fatalError: Error | undefined;
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => {
      attempts += 1;
      throw remoteRuntimeHostUnavailableError(
        'Runtime Host profile office',
        'authentication_failed',
      );
    },
    backoff: { minMs: 0, maxMs: 0 },
    onFatalError: (error) => {
      fatalError = error;
    },
  });

  first.disconnect();
  await connection.closed;

  assert.equal(attempts, 1);
  assert.ok(fatalError instanceof RuntimeHostPermanentReconnectError);
  assert.match(fatalError.message, /rejected its access credential/u);
  await connection.close();
});

test('reconnect lifecycle close waits for a resource returned after cancellation', async () => {
  const first = connectionHarness('first', () => undefined);
  const connectStarted = deferred();
  const lateResource = deferredValue<RuntimeHostConnection>();
  const lateCloseStarted = deferred();
  const releaseLateClose = deferred();
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      connectStarted.resolve();
      return lateResource.promise;
    },
  });
  first.disconnect();
  await connectStarted.promise;

  let closeSettled = false;
  const closeTask = lifecycle.close().then(() => {
    closeSettled = true;
  });
  const late = connectionHarness('late', () => undefined).connection;
  lateResource.resolve({
    ...late,
    close: async () => {
      lateCloseStarted.resolve();
      await releaseLateClose.promise;
    },
  });
  await lateCloseStarted.promise;
  await Promise.resolve();
  assert.equal(closeSettled, false);

  releaseLateClose.resolve();
  await closeTask;
  assert.equal(closeSettled, true);
});

test('reconnect lifecycle quiescence suppresses replacement until it is resumed', async () => {
  const first = connectionHarness('first', () => undefined);
  const replacement = connectionHarness('replacement', () => undefined);
  const connected = deferred();
  let connectCalls = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      connectCalls += 1;
      connected.resolve();
      return replacement.connection;
    },
  });

  const quiescence = lifecycle.quiesce();
  assert.equal(quiescence.current, first.connection);
  first.disconnect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);

  quiescence.resume();
  await connected.promise;
  assert.equal(connectCalls, 1);
  await lifecycle.close();
});

function connectionHarness(
  id: string,
  request: (operation: DirectRequestOperationKey, input: unknown) => unknown,
  openSubscription: () => Promise<unknown> = async () => {
    throw new Error('subscription is not available in this fixture');
  },
  composition: { readonly id: string; readonly revision: string } = {
    id: 'maka.interactive',
    revision: '1',
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
    compositionId: composition.id,
    compositionRevision: composition.revision,
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
    subscribeScheduledTaskChanges: () => () => {},
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

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
