import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type RequestFrame,
  type SubscriptionFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('registers a subscription before receiving a coalesced first frame', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-ordered');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      assert.deepEqual(await subscription[Symbol.asyncIterator]().next(), {
        done: false,
        value: deltaFrame(connection.hostEpoch, subscription.subscriptionId, 1),
      });
      await subscription.close();
    },
  );
});

test('isolates a sequence gap and continues requests on the same connection', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-gap');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 2)),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
      await answerStatus(transport, hostEpoch);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        hasSubscriptionReason('sequence_gap'),
      );
      assert.equal((await connection.status()).hostEpoch, connection.hostEpoch);
    },
  );
});

test('rejects epoch and Session correlation changes per subscription', async () => {
  for (const changed of ['epoch', 'session'] as const) {
    await withProtocolPeer(
      async (transport, hostEpoch) => {
        const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
        const opened = openResult(hostEpoch, `subscription-${changed}`);
        await transport.write({
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        });
        await transport.write({
          ...deltaFrame(
            changed === 'epoch' ? 'different-epoch' : hostEpoch,
            opened.subscriptionId,
            1,
          ),
          ...(changed === 'session' ? { sessionId: 'session-2' } : {}),
        });
        await answerClose(transport, opened.subscriptionId);
        await answerStatus(transport, hostEpoch);
      },
      async (connection) => {
        const subscription = await connection.openSessionSubscription({
          sessionId: 'session-1',
        });
        await assert.rejects(
          () => subscription[Symbol.asyncIterator]().next(),
          hasSubscriptionReason(changed === 'epoch' ? 'host_epoch_changed' : 'correlation_changed'),
        );
        assert.equal((await connection.status()).hostEpoch, connection.hostEpoch);
      },
    );
  }
});

test('evicts a locally slow iterator and keeps the connection usable', async () => {
  const closeObserved = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-slow');
      const frames = [
        encodeProtocolFrame({
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        }),
      ];
      for (let sequence = 1; sequence <= 33; sequence += 1) {
        frames.push(encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, sequence)));
      }
      await transport.writeEncoded(Buffer.concat(frames));
      await answerClose(transport, opened.subscriptionId, closeObserved.resolve);
      await answerStatus(transport, hostEpoch);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      await closeObserved.promise;
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        hasSubscriptionReason('slow_consumer'),
      );
      assert.equal((await connection.status()).hostEpoch, connection.hostEpoch);
    },
  );
});

test('ends every active subscription with connection_closed on EOF', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      await transport.write({
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: openResult(hostEpoch, 'subscription-eof'),
      });
      transport.destroyAfterFlush();
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        hasSubscriptionReason('connection_closed'),
      );
    },
  );
});

async function withProtocolPeer(
  serve: (transport: FramedTransport, hostEpoch: string) => Promise<void>,
  run: (connection: RuntimeHostConnection) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-subscription-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const hostEpoch = randomUUID();
  const endpoint = await prepareRuntimeHostEndpoint({
    rootId: capability.rootId,
    hostEpoch,
  });
  const serverTask = deferred<void>();
  const server = createServer((socket) => {
    void serve(new FramedTransport(socket), hostEpoch).then(serverTask.resolve, serverTask.reject);
  });
  try {
    await listen(server, endpoint.path);
    await endpoint.prepareAfterListen();
    await writeHostRegistration(controlDirectory, {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: capability.rootId,
      hostEpoch,
      endpoint: endpoint.path,
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      state: 'ready',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const connected = await connectRuntimeHost({
      rootPath: join(base, 'root'),
      surface: 'tui',
      protocol: PROTOCOL,
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') return;
    try {
      await run(connected.connection);
    } finally {
      await connected.connection.close();
    }
    await serverTask.promise;
  } finally {
    await closeServer(server);
    await removeHostRegistration(controlDirectory, hostEpoch).catch(() => undefined);
    await endpoint.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function acceptConnectionAndReadOpen(
  transport: FramedTransport,
  hostEpoch: string,
): Promise<Extract<RequestFrame, { operation: 'subscription.open' }>> {
  const hello = decodeClientFrame(await transport.read(1_000));
  assert.ok('kind' in hello && hello.kind === 'hello');
  await transport.write({
    kind: 'accepted',
    hostEpoch,
    connectionId: 'connection-1',
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    state: 'ready',
  });
  const request = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in request));
  assert.equal(request.operation, 'subscription.open');
  return request as Extract<RequestFrame, { operation: 'subscription.open' }>;
}

async function answerClose(
  transport: FramedTransport,
  subscriptionId: string,
  onObserved?: () => void,
): Promise<void> {
  const request = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in request));
  assert.equal(request.operation, 'subscription.close');
  assert.deepEqual(request.input, { subscriptionId });
  onObserved?.();
  await transport.write({
    requestId: request.requestId,
    operation: 'subscription.close',
    ok: true,
    result: { subscriptionId },
  });
}

async function answerStatus(transport: FramedTransport, hostEpoch: string): Promise<void> {
  const request = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in request));
  assert.equal(request.operation, 'host.status');
  await transport.write({
    requestId: request.requestId,
    operation: 'host.status',
    ok: true,
    result: {
      hostEpoch,
      state: 'ready',
      connections: 1,
      activeOperations: 1,
      activeResidencies: 0,
    },
  });
}

function openResult(hostEpoch: string, subscriptionId: string) {
  return {
    hostEpoch,
    subscriptionId,
    nextSequence: 1,
    snapshot: {
      schemaVersion: 1 as const,
      session: {
        sessionId: 'session-1',
        status: 'running' as const,
        createdAt: 1,
        lastUsedAt: 2,
        isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running' as const,
      },
      queue: { hostEpoch, queueRevision: 1, steering: [], followup: [] },
    },
  };
}

function deltaFrame(
  hostEpoch: string,
  subscriptionId: string,
  sequence: number,
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch,
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      text: `chunk-${sequence}`,
    },
  };
}

function hasSubscriptionReason(reason: RuntimeHostSubscriptionError['reason']) {
  return (error: unknown) =>
    error instanceof RuntimeHostSubscriptionError && error.reason === reason;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
