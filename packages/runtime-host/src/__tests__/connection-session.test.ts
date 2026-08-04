import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { readHostRegistration } from '../control/registration.js';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostFrame,
  type ResponseFrame,
  type TurnSnapshot,
} from '../protocol/index.js';
import { RuntimeHostKernel, type RuntimeHostComposition } from '../server/index.js';
import { RuntimeHostConnectionSession } from '../server/connection-session.js';
import {
  createUnavailableDomainOperationHandlers,
  type OperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import {
  BoundedSerialOutboundWriter,
  RuntimeHostOutboundQueueError,
} from '../server/serial-outbound-writer.js';
import { FramedTransport } from '../transport/framed-transport.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

type TurnQueryHandler = RuntimeHostComposition['handlers']['turn.query'];

test('concurrent responses remain framed and correlated in reverse completion order', async () => {
  const requestCount = 16;
  const entered = Array.from({ length: requestCount }, () => deferred());
  const release = Array.from({ length: requestCount }, () => deferred());
  await withRuntimeHost(
    async (input) => {
      const index = Number(input.turnId.slice('turn-'.length));
      entered[index]?.resolve();
      await release[index]?.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const requests = Array.from({ length: requestCount }, (_, index) =>
        client.queryTurn({ sessionId: 'session', turnId: `turn-${index}` }, 5_000),
      );
      try {
        await withTimeout(
          Promise.all(entered.map((item) => item.promise)),
          1_000,
          'concurrent handlers were not all admitted',
        );

        for (let index = requestCount - 1; index >= 0; index -= 1) {
          release[index]?.resolve();
          const result = await requests[index];
          assert.equal(result?.turnId, `turn-${index}`);
          assert.equal(result?.runId, `run-turn-${index}`);
        }
        const results = await Promise.all(requests);
        assert.deepEqual(
          results.map((result) => result.turnId),
          Array.from({ length: requestCount }, (_, index) => `turn-${index}`),
        );
      } finally {
        for (const gate of release) gate.resolve();
        await Promise.allSettled(requests);
      }
    },
  );
});

test('serial outbound writer flushes accepted frames in FIFO order over a real socket', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, () => {
    failureCalls += 1;
  });
  try {
    const frames = ['first', 'second', 'third'].map(statusResponse);
    const receipts = frames.map((frame) => writer.enqueue(frame));
    await Promise.all(receipts.map((receipt) => receipt.flushed));
    for (const expected of frames) {
      const received = decodeHostFrame(await pair.serverTransport.read(1_000));
      assert.equal('kind' in received, false);
      if (!('kind' in received)) assert.equal(received.requestId, expected.requestId);
    }
    assert.equal(failureCalls, 0);

    writer.close();
    assert.throws(() => writer.enqueue(statusResponse('after-close')), /writer is closed/);
  } finally {
    writer.close();
    await pair.close();
  }
});

test('serial outbound writer fails once when its real transport is closed', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, () => {
    failureCalls += 1;
  });
  try {
    pair.clientTransport.destroy();
    await pair.clientTransport.closed;
    const receipt = writer.enqueue(statusResponse('closed-transport'));
    await assert.rejects(receipt.flushed);
    assert.equal(failureCalls, 1);
    assert.throws(() => writer.enqueue(statusResponse('after-failure')), /writer is closed/);
    assert.equal(failureCalls, 1);
  } finally {
    writer.close();
    await pair.close();
  }
});

test('serial outbound writer reports its 2 MiB byte bound before its frame bound', async () => {
  const pair = await openTransportPair();
  let failureCalls = 0;
  const writer = new BoundedSerialOutboundWriter(pair.clientTransport, () => {
    failureCalls += 1;
  });
  const settlements: Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: Error }>[] = [];
  let overload: unknown;
  let acceptedFrames = 0;
  try {
    for (let index = 0; index < 64; index += 1) {
      try {
        const receipt = writer.enqueue(largeFailureResponse(`byte-bound-${index}`));
        acceptedFrames += 1;
        settlements.push(
          receipt.flushed.then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error: asError(error) }),
          ),
        );
      } catch (error) {
        overload = error;
        break;
      }
    }

    assert.ok(overload instanceof RuntimeHostOutboundQueueError);
    assert.equal(overload.code, 'byte_limit');
    assert.ok(acceptedFrames < 64, 'frame bound fired before the 2 MiB byte bound');
    assert.equal(failureCalls, 1);
    const results = await Promise.all(settlements);
    assert.equal(results.length, acceptedFrames);
    assert.equal(
      results.every((result) => result.status === 'rejected' && result.error === overload),
      true,
    );
  } finally {
    writer.close();
    await pair.close();
  }
});

test('clean read EOF drains an already dispatched response before closing', async () => {
  const fixture = await openHalfClosedDispatchedSession('half-close');
  try {
    fixture.releaseHandler.resolve();
    const response = decodeHostFrame(await fixture.pair.clientTransport.read(1_000));
    if ('kind' in response || response.operation !== 'turn.query') {
      assert.fail('Expected the dispatched turn.query response');
    }
    assert.equal(response.ok, true);
    await withTimeout(fixture.run, 1_000, 'connection did not close after draining its response');
    assert.equal(fixture.teardownCalls(), 1);
  } finally {
    await fixture.close();
  }
});

test('a fatal transport close during clean EOF drain tears down exactly once', async () => {
  const fixture = await openHalfClosedDispatchedSession('fatal-close-after-eof');
  try {
    fixture.pair.serverTransport.destroy(new Error('forced transport failure'));
    await withTimeout(
      fixture.teardownObserved.promise,
      1_000,
      'fatal transport close did not interrupt EOF drain',
    );
    assert.equal(fixture.teardownCalls(), 1);

    fixture.releaseHandler.resolve();
    await withTimeout(fixture.run, 1_000, 'connection did not settle after its handler completed');
    assert.equal(fixture.teardownCalls(), 1);
  } finally {
    await fixture.close();
  }
});

test('a connection accepted before composition exists resolves ready handlers without reconnecting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-pre-ready-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const factoryEntered = deferred();
  const releaseFactory = deferred();
  const hostTask = RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    compositionFactory: async () => {
      factoryEntered.resolve();
      await releaseFactory.promise;
      return {
        handlers: createHandlers(async (input) => ({
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        })),
        beginDrain() {},
        async recover() {},
        async close() {},
      };
    },
  });
  let transport: FramedTransport | undefined;
  let host: RuntimeHostKernel | undefined;
  try {
    await withTimeout(factoryEntered.promise, 1_000, 'Runtime Host did not enter composition');
    const registration = await readHostRegistration(owner.controlDirectory);
    assert.ok(registration);
    assert.equal(registration.state, 'recovering');
    transport = await openAcceptedTransport(registration.endpoint, 'pre-ready-client');

    await transport.write({
      requestId: 'before-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const beforeReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in beforeReady) assert.fail('Expected an operation response');
    if (beforeReady.ok) assert.fail('Pre-ready request unexpectedly succeeded');
    assert.equal(beforeReady.error.code, 'host_not_ready');

    releaseFactory.resolve();
    host = await withTimeout(hostTask, 1_000, 'Runtime Host did not become ready');
    await transport.write({
      requestId: 'after-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const afterReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in afterReady || afterReady.operation !== 'turn.query') {
      assert.fail('Expected a turn.query response');
    }
    if (!afterReady.ok) assert.fail(afterReady.error.message);
    assert.equal(afterReady.result.runId, 'run-turn');
  } finally {
    releaseFactory.resolve();
    transport?.destroy();
    host ??= await hostTask.catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('connection reset while operation admission is pending does not execute the handler', async () => {
  const pair = await openTransportPair();
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  const teardownObserved = deferred();
  let handlerCalls = 0;
  let finishCalls = 0;
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        state: 'ready',
        connections: 1,
        activeOperations: 1,
        activeResidencies: 0,
      },
    }),
    ...createHandlers(async (input) => {
      handlerCalls += 1;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    }),
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: {
      hostEpoch: 'host-epoch',
      connectionId: 'pending-admission',
      surface: 'tui',
      principal: 'local_os_user',
    },
    resolveHandlers: () => handlers,
    resolveContinuity: () => undefined,
    beginOperation: async () => {
      admissionEntered.resolve();
      await releaseAdmission.promise;
      return {
        acquireResidency: () => ({ release() {} }),
        seal() {},
        finish() {
          finishCalls += 1;
        },
      };
    },
    onTeardown: () => teardownObserved.resolve(),
  });
  const run = session.run();
  try {
    await pair.clientTransport.write({
      requestId: 'pending-request',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    await withTimeout(admissionEntered.promise, 1_000, 'operation did not enter admission');
    pair.clientTransport.socket.resetAndDestroy();
    await withTimeout(
      teardownObserved.promise,
      1_000,
      'connection did not tear down while admission was pending',
    );
    releaseAdmission.resolve();
    await withTimeout(run, 1_000, 'connection did not settle after admission completed');
    assert.equal(handlerCalls, 0);
    assert.equal(finishCalls, 1);
  } finally {
    releaseAdmission.resolve();
    pair.clientTransport.destroy();
    await Promise.allSettled([run, pair.close()]);
  }
});

test('an admitted operation settles without connection or residency leakage after disconnect', async () => {
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  const handlerSettled = deferred();
  await withRuntimeHost(
    async (input, context) => {
      const residency = context.acquireResidency();
      handlerEntered.resolve();
      try {
        await releaseHandler.promise;
        return {
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        };
      } finally {
        residency.release();
        handlerSettled.resolve();
      }
    },
    async ({ connectClient }) => {
      const client = await connectClient();
      const requestFailure = client
        .queryTurn({ sessionId: 'session', turnId: 'disconnect' }, 5_000)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        await withTimeout(handlerEntered.promise, 1_000, 'handler was not admitted');
        await client.close();
        releaseHandler.resolve();
        await withTimeout(handlerSettled.promise, 1_000, 'handler did not settle after disconnect');
        assert.ok((await requestFailure) instanceof Error);

        const observer = await connectClient();
        const status = await waitForStatus(
          observer,
          (value) =>
            value.connections === 1 &&
            value.activeOperations === 1 &&
            value.activeResidencies === 0,
        );
        assert.equal(status.connections, 1);
        assert.equal(status.activeOperations, 1);
        assert.equal(status.activeResidencies, 0);
      } finally {
        releaseHandler.resolve();
        await client.close().catch(() => undefined);
        await Promise.allSettled([requestFailure]);
      }
    },
  );
});

test('a duplicate active request id tears down only the offending connection', async () => {
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  let handlerCalls = 0;
  await withRuntimeHost(
    async (input) => {
      handlerCalls += 1;
      handlerEntered.resolve();
      await releaseHandler.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient, endpoint }) => {
      const transport = await openAcceptedTransport(endpoint, 'duplicate-request-client');
      try {
        await transport.write({
          requestId: 'duplicate-request',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'first' },
        });
        await withTimeout(handlerEntered.promise, 1_000, 'first request was not admitted');
        await transport.write({
          requestId: 'duplicate-request',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'second' },
        });
        await withTimeout(
          transport.closed,
          1_000,
          'duplicate request id did not close its connection',
        );
        assert.equal(handlerCalls, 1);
      } finally {
        releaseHandler.resolve();
        transport.destroy();
      }

      const observer = await connectClient();
      const status = await waitForStatus(
        observer,
        (value) =>
          value.connections === 1 && value.activeOperations === 1 && value.activeResidencies === 0,
      );
      assert.equal(status.state, 'ready');
    },
  );
});

test('a sixty-fifth in-flight request tears down only the overflowing connection', async () => {
  const releaseHandlers = deferred();
  await withRuntimeHost(
    async (input) => {
      await releaseHandlers.promise;
      return {
        ok: true,
        result: runningSnapshot(input.sessionId, input.turnId),
      };
    },
    async ({ connectClient, endpoint }) => {
      const transport = await openAcceptedTransport(endpoint, 'overflowing-client');
      const observer = await connectClient();
      try {
        const requests = Array.from({ length: 64 }, (_, index) =>
          JSON.stringify({
            requestId: `overflow-${index}`,
            operation: 'turn.query',
            input: { sessionId: 'session', turnId: `turn-${index}` },
          }),
        ).join('\n');
        transport.socket.write(`${requests}\n`);
        await waitForStatus(
          observer,
          (value) =>
            value.connections === 2 &&
            value.activeOperations === 65 &&
            value.activeResidencies === 0,
        );
        await transport.write({
          requestId: 'overflow-64',
          operation: 'turn.query',
          input: { sessionId: 'session', turnId: 'turn-64' },
        });
        await withTimeout(
          transport.closed,
          1_000,
          'in-flight overflow did not close its connection',
        );
      } finally {
        releaseHandlers.resolve();
        transport.destroy();
      }
      const status = await waitForStatus(
        observer,
        (value) =>
          value.connections === 1 && value.activeOperations === 1 && value.activeResidencies === 0,
      );
      assert.equal(status.state, 'ready');
    },
  );
});

test('evicting one slow subscription keeps sibling subscriptions and requests usable', async () => {
  const pair = await openTransportPair();
  const coordinator = new SessionContinuityCoordinator(
    'host-epoch',
    async (sessionId) => canonicalProjection(sessionId),
    new SessionAdmissionGate(),
  );
  const handlers: OperationHandlerMap = {
    'host.status': async () => ({
      ok: true,
      result: {
        hostEpoch: 'host-epoch',
        state: 'ready',
        connections: 1,
        activeOperations: 1,
        activeResidencies: 0,
      },
    }),
    ...createHandlers(async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    })),
    ...coordinator.handlers,
  };
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: {
      hostEpoch: 'host-epoch',
      connectionId: 'shared-subscription-connection',
      surface: 'tui',
      principal: 'local_os_user',
    },
    resolveHandlers: () => handlers,
    resolveContinuity: () => coordinator,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown() {},
  });
  const run = session.run();
  const slow = await openSubscription(pair.clientTransport, 'slow-session', 'open-slow');
  const sibling = await openSubscription(pair.clientTransport, 'sibling-session', 'open-sibling');
  const originalWrite = pair.serverTransport.writeEncoded.bind(pair.serverTransport);
  const writeBlocked = deferred();
  const releaseWrite = deferred();
  pair.serverTransport.writeEncoded = async (encoded) => {
    writeBlocked.resolve();
    await releaseWrite.promise;
    return originalWrite(encoded);
  };

  try {
    for (let index = 1; index <= 32; index += 1) {
      await coordinator.acceptRuntimeEvent(
        'slow-session',
        'run-slow-session',
        connectionTextEvent('slow-session', index),
      );
    }
    await withTimeout(writeBlocked.promise, 1_000, 'slow subscription never blocked in-flight');
    releaseWrite.resolve();

    await coordinator.acceptRuntimeEvent(
      'sibling-session',
      'run-sibling-session',
      connectionTextEvent('sibling-session', 1),
    );
    await pair.clientTransport.write({
      requestId: 'status-after-eviction',
      operation: 'host.status',
      input: {},
    });

    const observed: HostFrame[] = [];
    while (
      !observed.some(
        (frame) =>
          'kind' in frame &&
          frame.kind === 'subscription.closed' &&
          frame.subscriptionId === slow.subscriptionId,
      ) ||
      !observed.some(
        (frame) =>
          'kind' in frame &&
          frame.kind === 'subscription.session_delta' &&
          frame.subscriptionId === sibling.subscriptionId,
      ) ||
      !observed.some((frame) => !('kind' in frame) && frame.requestId === 'status-after-eviction')
    ) {
      observed.push(decodeHostFrame(await pair.clientTransport.read(1_000)));
    }

    const slowClosed = observed.find(
      (frame) =>
        'kind' in frame &&
        frame.kind === 'subscription.closed' &&
        frame.subscriptionId === slow.subscriptionId,
    );
    assert.ok(slowClosed && 'kind' in slowClosed);
    if (slowClosed && 'kind' in slowClosed && slowClosed.kind === 'subscription.closed') {
      assert.equal(slowClosed.reason, 'slow_consumer');
      assert.equal(slowClosed.sequence, 2);
    }
    assert.equal(pair.serverTransport.socket.destroyed, false);
  } finally {
    releaseWrite.resolve();
    pair.serverTransport.writeEncoded = originalWrite;
    pair.clientTransport.destroy();
    await Promise.allSettled([run, pair.close()]);
    coordinator.close();
  }
});

interface RuntimeHostTestFixture {
  connectClient(): Promise<RuntimeHostConnection>;
  endpoint: string;
}

async function withRuntimeHost(
  queryTurn: TurnQueryHandler,
  run: (fixture: RuntimeHostTestFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-continuity-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const connections = new Set<RuntimeHostConnection>();
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    compositionFactory: async () => ({
      handlers: createHandlers(queryTurn),
      beginDrain() {},
      async recover() {},
      async close() {},
    }),
  });
  try {
    await run({
      endpoint: host.endpoint,
      connectClient: async () => {
        const result = await connectRuntimeHost({
          rootPath: root,
          surface: 'tui',
          protocol: CURRENT_PROTOCOL,
        });
        assert.equal(result.kind, 'connected');
        connections.add(result.connection);
        return result.connection;
      },
    });
  } finally {
    await Promise.allSettled([...connections].map((connection) => connection.close()));
    await host.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
}

async function openAcceptedTransport(
  endpoint: string,
  clientInstanceId: string,
): Promise<FramedTransport> {
  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const transport = new FramedTransport(socket);
  await transport.write({
    kind: 'hello',
    clientInstanceId,
    surface: 'tui',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
  });
  const handshake = decodeHostFrame(await transport.read(1_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  return transport;
}

interface TransportPair {
  clientTransport: FramedTransport;
  serverTransport: FramedTransport;
  close(): Promise<void>;
}

interface HalfClosedDispatchedSession {
  pair: TransportPair;
  releaseHandler: Deferred;
  teardownObserved: Deferred;
  run: Promise<void>;
  teardownCalls(): number;
  close(): Promise<void>;
}

async function openTransportPair(): Promise<TransportPair> {
  const listener = createServer({ allowHalfOpen: true });
  const accepted = new Promise<Socket>((resolve) => listener.once('connection', resolve));
  await listenServer(listener);
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const clientSocket = connect(address.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    clientSocket.once('connect', resolve);
    clientSocket.once('error', reject);
  });
  const serverSocket = await accepted;
  const clientTransport = new FramedTransport(clientSocket);
  const serverTransport = new FramedTransport(serverSocket);
  return {
    clientTransport,
    serverTransport,
    close: async () => {
      clientTransport.destroy();
      serverTransport.destroy();
      await Promise.all([clientTransport.closed, serverTransport.closed]);
      await closeServer(listener);
    },
  };
}

async function openHalfClosedDispatchedSession(
  turnId: string,
): Promise<HalfClosedDispatchedSession> {
  const pair = await openTransportPair();
  const handlerEntered = deferred();
  const releaseHandler = deferred();
  const teardownObserved = deferred();
  let teardownCalls = 0;
  const session = new RuntimeHostConnectionSession({
    transport: pair.serverTransport,
    connection: {
      hostEpoch: 'host-epoch',
      connectionId: `${turnId}-client`,
      surface: 'tui',
      principal: 'local_os_user',
    },
    resolveHandlers: () => ({
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: 'host-epoch',
          state: 'ready',
          connections: 1,
          activeOperations: 1,
          activeResidencies: 0,
        },
      }),
      ...createHandlers(async (input) => {
        handlerEntered.resolve();
        await releaseHandler.promise;
        return {
          ok: true,
          result: runningSnapshot(input.sessionId, input.turnId),
        };
      }),
    }),
    resolveContinuity: () => undefined,
    beginOperation: async () => ({
      acquireResidency: () => ({ release() {} }),
      seal() {},
      finish() {},
    }),
    onTeardown: () => {
      teardownCalls += 1;
      teardownObserved.resolve();
    },
  });
  const run = session.run();
  try {
    await pair.clientTransport.write({
      requestId: `${turnId}-request`,
      operation: 'turn.query',
      input: { sessionId: 'session', turnId },
    });
    await withTimeout(handlerEntered.promise, 1_000, 'handler was not dispatched');
    const readEnded = onceSocketEnd(pair.serverTransport.socket);
    pair.clientTransport.socket.end();
    await withTimeout(readEnded, 1_000, 'Host did not observe Client read EOF');
    return {
      pair,
      releaseHandler,
      teardownObserved,
      run,
      teardownCalls: () => teardownCalls,
      close: async () => {
        releaseHandler.resolve();
        pair.clientTransport.destroy();
        await Promise.allSettled([run, pair.close()]);
      },
    };
  } catch (error) {
    releaseHandler.resolve();
    pair.clientTransport.destroy();
    await Promise.allSettled([run, pair.close()]);
    throw error;
  }
}

function onceSocketEnd(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('end', resolve));
}

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createHandlers(queryTurn: TurnQueryHandler): RuntimeHostComposition['handlers'] {
  const unavailable: Awaited<ReturnType<OperationHandlerMap['turn.message.submit']>> = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  };
  const subscriptionUnavailable = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  } as const;
  const taskLedgerUnavailable: Awaited<ReturnType<OperationHandlerMap['task.ledger.query']>> = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  };
  const interactionUnavailable = {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'not available in this test composition',
    },
  } as const;
  return {
    ...createUnavailableDomainOperationHandlers(),
    'turn.start': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    'turn.query': queryTurn,
    'turn.stop': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    'turn.message.submit': async () => unavailable,
    'queue.retract': async () => unavailable,
    'turn.interrupt': async () => unavailable,
    'interaction.query': async () => interactionUnavailable,
    'interaction.answer': async () => interactionUnavailable,
    'subscription.open': async () => subscriptionUnavailable,
    'subscription.close': async () => subscriptionUnavailable,
    'task.ledger.query': async () => taskLedgerUnavailable,
  };
}

function statusResponse(requestId: string): ResponseFrame {
  return {
    requestId,
    operation: 'host.status',
    ok: true,
    result: {
      hostEpoch: 'host-epoch',
      state: 'ready',
      connections: 1,
      activeOperations: 0,
      activeResidencies: 0,
    },
  };
}

function largeFailureResponse(requestId: string): ResponseFrame {
  return {
    requestId,
    operation: 'host.status',
    ok: false,
    error: {
      code: 'internal_failure',
      message: 'x'.repeat(48 * 1024),
    },
  };
}

function runningSnapshot(sessionId: string, turnId: string): TurnSnapshot {
  return {
    sessionId,
    turnId,
    runId: `run-${turnId}`,
    status: 'running',
  };
}

async function openSubscription(transport: FramedTransport, sessionId: string, requestId: string) {
  await transport.write({
    requestId,
    operation: 'subscription.open',
    input: { sessionId },
  });
  const response = decodeHostFrame(await transport.read(1_000));
  if ('kind' in response || response.operation !== 'subscription.open' || !response.ok) {
    throw new Error(`Unable to open ${sessionId} subscription`);
  }
  return response.result;
}

function canonicalProjection(sessionId: string): CanonicalSessionProjection {
  return {
    session: {
      sessionId,
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    rootTurn: {
      sessionId,
      turnId: `turn-${sessionId}`,
      runId: `run-${sessionId}`,
      status: 'running',
    },
    goal: null,
    queue: {
      hostEpoch: 'host-epoch',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}

function connectionTextEvent(sessionId: string, index: number) {
  return {
    type: 'text_delta' as const,
    id: `event-${sessionId}-${index}`,
    turnId: `turn-${sessionId}`,
    ts: index,
    messageId: `message-${sessionId}`,
    text: `chunk-${index}`,
  };
}

async function waitForStatus(
  connection: RuntimeHostConnection,
  predicate: (status: Awaited<ReturnType<RuntimeHostConnection['status']>>) => boolean,
): Promise<Awaited<ReturnType<RuntimeHostConnection['status']>>> {
  const deadline = Date.now() + 1_000;
  let status = await connection.status(1_000);
  while (!predicate(status) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    status = await connection.status(1_000);
  }
  assert.equal(predicate(status), true, 'Host operation counters did not settle');
  return status;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
