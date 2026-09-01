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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRuntimeHostReconnectingConnection,
  remoteRuntimeHostUnavailableError,
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRemoteCompatibilityError,
  RuntimeHostRequestInterruptedError,
  startRuntimeHostReconnectLifecycle,
  type DirectRequestOperationKey,
  type RuntimeHostConnection,
  type RuntimeHostConnectionAvailability,
} from '../client/index.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostIncompatible,
  type HostStatusResult,
  type OperationInput,
  type OperationKey,
  type OperationOutput,
} from '../protocol/index.js';
import { waitFor } from '@maka/core/test-only/async-primitives';

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

test('a reconnecting Client reports the connection generation used by direct operations', async () => {
  const first = connectionHarness('first', () => undefined);
  const replacement = connectionHarness('replacement', () => undefined);
  const reconnecting = deferredValue<RuntimeHostConnection>();
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => reconnecting.promise,
  });
  const availability: RuntimeHostConnectionAvailability[] = [];
  const unsubscribe = connection.subscribeConnectionAvailability((current) => {
    availability.push(current);
  });

  assert.deepEqual(availability, [
    { kind: 'connected', hostEpoch: 'host-first', connectionId: 'first' },
  ]);
  first.disconnect();
  await waitForCondition(() => availability.length === 2);
  const unavailable: RuntimeHostConnectionAvailability[] = [];
  const unsubscribeUnavailable = connection.subscribeConnectionAvailability((value) => {
    unavailable.push(value);
  });
  assert.deepEqual(unavailable, [{ kind: 'unavailable' }]);
  unsubscribeUnavailable();
  reconnecting.resolve(replacement.connection);
  await waitForCondition(() => availability.length === 3);
  assert.deepEqual(availability, [
    { kind: 'connected', hostEpoch: 'host-first', connectionId: 'first' },
    { kind: 'unavailable' },
    { kind: 'connected', hostEpoch: 'host-replacement', connectionId: 'replacement' },
  ]);

  const current: RuntimeHostConnectionAvailability[] = [];
  const unsubscribeCurrent = connection.subscribeConnectionAvailability((value) => {
    current.push(value);
  });
  assert.deepEqual(current, [
    { kind: 'connected', hostEpoch: 'host-replacement', connectionId: 'replacement' },
  ]);
  unsubscribeCurrent();

  unsubscribe();
  replacement.disconnect();
  await yieldToEventLoop();
  assert.equal(availability.length, 3);
  await connection.close();
});

test('a reconnecting Client retries status through the validated status surface', async () => {
  let firstStatusCalls = 0;
  let replacementStatusCalls = 0;
  const first = connectionHarness(
    'first',
    () => {
      throw new Error('status must not use request()');
    },
    undefined,
    undefined,
    async () => {
      firstStatusCalls += 1;
      first.disconnect();
      throw interrupted('host.status', 'query', 'dispatched');
    },
  );
  const replacement = connectionHarness(
    'replacement',
    () => {
      throw new Error('status must not use request()');
    },
    undefined,
    undefined,
    async () => {
      replacementStatusCalls += 1;
      return hostStatus('replacement');
    },
  );
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => replacement.connection,
  });

  assert.deepEqual(await connection.status(), hostStatus('replacement'));
  assert.equal(firstStatusCalls, 1);
  assert.equal(replacementStatusCalls, 1);
  assert.deepEqual(first.operations, []);
  assert.deepEqual(replacement.operations, []);
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

test('a reconnecting Client does not retry an incompatible remote Host or replay queued queries', async () => {
  const first = connectionHarness('first', () => {
    throw new Error('query must not reach the disconnected connection');
  });
  const connecting = deferred();
  const releaseIncompatible = deferred();
  let attempts = 0;
  let fatalError: Error | undefined;
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection: first.connection,
    connect: async () => {
      attempts += 1;
      connecting.resolve();
      await releaseIncompatible.promise;
      throw new RuntimeHostRemoteCompatibilityError('office', incompatibleHandshake());
    },
    backoff: { minMs: 0, maxMs: 0 },
    onFatalError: (error) => {
      fatalError = error;
    },
  });

  first.disconnect();
  await connecting.promise;
  const query = connection.request('goal.query', { sessionId: 'session-1' });
  releaseIncompatible.resolve();
  await assert.rejects(query, (error: unknown) => error === fatalError);
  await connection.closed;

  assert.equal(attempts, 1);
  assert.ok(fatalError instanceof RuntimeHostRemoteCompatibilityError);
  assert.deepEqual(first.operations, []);
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

  const quiescence = await lifecycle.quiesce();
  assert.equal(quiescence.current, first.connection);
  first.disconnect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);

  quiescence.resume();
  await connected.promise;
  assert.equal(connectCalls, 1);
  await lifecycle.close();
});

test('reconnect lifecycle quiescence waits through a connection gap before freezing', async () => {
  const first = connectionHarness('first', () => undefined);
  const replacement = connectionHarness('replacement', () => undefined);
  const reconnecting = deferredValue<RuntimeHostConnection>();
  const connectStarted = deferred();
  let connectCalls = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      connectCalls += 1;
      connectStarted.resolve();
      return reconnecting.promise;
    },
  });

  first.disconnect();
  await connectStarted.promise;
  const quiescenceTask = lifecycle.quiesce();
  reconnecting.resolve(replacement.connection);
  const quiescence = await quiescenceTask;
  assert.equal(quiescence.current, replacement.connection);

  replacement.disconnect();
  await yieldToEventLoop();
  assert.equal(connectCalls, 1);
  quiescence.resume();
  await lifecycle.close();
});

test('reconnect lifecycle suspension admits recovery while no connection exists', async () => {
  const first = connectionHarness('first', () => undefined);
  const replacement = connectionHarness('replacement', () => undefined);
  const reconnectStarted = deferred();
  let connectCalls = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async (signal) => {
      connectCalls += 1;
      if (connectCalls === 1) {
        reconnectStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return replacement.connection;
    },
  });

  first.disconnect();
  await reconnectStarted.promise;
  const suspension = await lifecycle.suspend();
  assert.equal(suspension.current, undefined);
  assert.equal(connectCalls, 1);

  suspension.resume();
  assert.equal(await lifecycle.waitForCurrent(), replacement.connection);
  assert.equal(connectCalls, 2);
  await lifecycle.close();
});

test('reconnect delay escalates past maxMs while the Host never stabilizes', async () => {
  const first = connectionHarness('first', () => undefined);
  const delays: number[] = [];
  let attempts = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      attempts += 1;
      throw new Error('connect failed');
    },
    backoff: {
      minMs: 1,
      maxMs: 2,
      unstableMaxMs: 20,
      random: () => 0.5,
      wait: async (delayMs) => {
        await yieldToEventLoop();
        delays.push(delayMs);
      },
    },
  });
  try {
    first.disconnect();
    await waitForCondition(() => attempts >= 8);
    assert.deepEqual(delays.slice(0, 3), [1, 2, 4]);
    assert.ok(Math.max(...delays) > 2);
    assert.equal(Math.max(...delays), 20);
  } finally {
    await lifecycle.close();
  }
});

test('a stabilized connection restarts the reconnect delay ladder', async () => {
  let clock = 1_000_000;
  const first = connectionHarness('first', () => undefined);
  const second = connectionHarness('second', () => undefined);
  const reconnected = deferred();
  const delays: number[] = [];
  let attempts = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      attempts += 1;
      if (attempts === 1) {
        reconnected.resolve();
        return second.connection;
      }
      throw new Error('connect failed');
    },
    backoff: {
      minMs: 3,
      maxMs: 5,
      unstableMaxMs: 40,
      stableConnectionMs: 50,
      now: () => clock,
      random: () => 0.5,
      wait: async (delayMs) => {
        await yieldToEventLoop();
        clock += delayMs;
        delays.push(delayMs);
      },
    },
  });
  try {
    first.disconnect();
    await reconnected.promise;
    clock += 60;
    second.disconnect();
    await waitForCondition(() => delays.length >= 3);
    // The regular ladder clamps at maxMs (5) before the never-stabilized
    // escalation engages on the next doubling.
    assert.deepEqual(delays.slice(0, 2), [3, 5]);
    assert.ok(delays[2]! > 5);
  } finally {
    await lifecycle.close();
  }
});

test('reconnect backoff rejects an unstable ceiling below maxMs', async () => {
  const first = connectionHarness('first', () => undefined);
  await assert.rejects(
    startRuntimeHostReconnectLifecycle({
      initial: first.connection,
      connect: async () => first.connection,
      backoff: { minMs: 1, maxMs: 10, unstableMaxMs: 5 },
    }),
    (error: unknown) => error instanceof RangeError && /unstableMaxMs/u.test(error.message),
  );
});

test('an omitted unstableMaxMs stays compatible with a large maxMs', async () => {
  // Pre-escalation callers could legally set maxMs above the 60s default
  // ceiling; omitting the new field must derive the ceiling from maxMs rather
  // than reject a previously valid configuration.
  const first = connectionHarness('first', () => undefined);
  const delays: number[] = [];
  let attempts = 0;
  const lifecycle = await startRuntimeHostReconnectLifecycle({
    initial: first.connection,
    connect: async () => {
      attempts += 1;
      throw new Error('connect failed');
    },
    backoff: {
      minMs: 100,
      maxMs: 90_000,
      random: () => 0.5,
      wait: async (delayMs) => {
        await yieldToEventLoop();
        delays.push(delayMs);
      },
    },
  });
  try {
    first.disconnect();
    // 100ms doubling reaches the derived 90s ceiling on the 11th attempt.
    await waitForCondition(() => attempts >= 12);
    assert.ok(delays.every((delay) => delay >= 100));
    // The derived ceiling is max(60_000, 90_000) = 90_000, not the 60s default.
    assert.equal(Math.max(...delays), 90_000);
    assert.ok(delays.slice(-1)[0]! >= 90_000);
  } finally {
    await lifecycle.close();
  }
});

function waitForCondition(condition: () => boolean): Promise<void> {
  return waitFor(condition, { attempts: 1_000 });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  status: () => Promise<HostStatusResult> = async () => hostStatus(id, composition),
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
    status,
    request: async (operation: DirectRequestOperationKey, input: unknown) => {
      operations.push(operation);
      return request(operation, input);
    },
    openSessionSubscription: async () => {
      openedSubscriptions += 1;
      return openSubscription();
    },
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
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

function hostStatus(
  id: string,
  composition: { readonly id: string; readonly revision: string } = {
    id: 'maka.interactive',
    revision: '1',
  },
): HostStatusResult {
  return {
    hostEpoch: `host-${id}`,
    compositionId: composition.id,
    compositionRevision: composition.revision,
    state: 'ready',
    connections: 1,
    activeOperations: 0,
    activeResidencies: 0,
  };
}

function interrupted(
  operation: OperationKey,
  mode: 'query' | 'command' | 'control',
  dispatch: 'not_dispatched' | 'dispatched',
): RuntimeHostRequestInterruptedError {
  return new RuntimeHostRequestInterruptedError(operation, mode, dispatch, 'connection_lost');
}
function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function incompatibleHandshake(): HostIncompatible {
  return {
    kind: 'incompatible',
    hostEpoch: 'host-epoch-secret',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 1,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 1,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'host-composition-revision',
    state: 'ready',
    replacement: 'blocked_by_residency',
  };
}
