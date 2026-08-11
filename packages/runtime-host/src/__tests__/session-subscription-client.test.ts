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
import { decodeStoredMessage } from '@maka/core/session';
import {
  connectRuntimeHost,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type HostFrame,
  type RequestFrame,
  type SubscriptionFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';
import { frameLocalIpcProtocolMessage } from '../transport/local-ipc-framing.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('registers a subscription before receiving a coalesced first frame', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-ordered');
      await writeRawLocalIpc(
        transport,
        Buffer.concat([
          encodeLocalIpcTestFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeLocalIpcTestFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
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

test('delivers Runtime Resource PTY frames without closing the connection', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-pty');
      const frame = {
        kind: 'subscription.runtime_resource_pty_data' as const,
        hostEpoch,
        subscriptionId: opened.subscriptionId,
        sequence: 1,
        sessionId: 'session-1',
        ref: 'maka://runtime/background-tasks/shell-1',
        ptySequence: 7,
        data: 'ready',
      };
      await writeRawLocalIpc(
        transport,
        Buffer.concat([
          encodeLocalIpcTestFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeLocalIpcTestFrame(frame),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({ sessionId: 'session-1' });
      assert.deepEqual(await subscription[Symbol.asyncIterator]().next(), {
        done: false,
        value: {
          kind: 'subscription.runtime_resource_pty_data',
          hostEpoch: connection.hostEpoch,
          subscriptionId: subscription.subscriptionId,
          sequence: 1,
          sessionId: 'session-1',
          ref: 'maka://runtime/background-tasks/shell-1',
          ptySequence: 7,
          data: 'ready',
        },
      });
      await subscription.close();
    },
  );
});

test('isolates a sequence gap and continues requests on the same connection', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-gap');
      await writeRawLocalIpc(
        transport,
        Buffer.concat([
          encodeLocalIpcTestFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeLocalIpcTestFrame(deltaFrame(hostEpoch, opened.subscriptionId, 2)),
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
  for (const changed of ['epoch', 'session', 'graph'] as const) {
    await withProtocolPeer(
      async (transport, hostEpoch, rootId) => {
        const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
        const opened = openResult(hostEpoch, `subscription-${changed}`);
        await writeProtocolFrame(transport, {
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        });
        await writeProtocolFrame(
          transport,
          changed === 'graph'
            ? {
                kind: 'subscription.agent_graph_changed',
                hostEpoch,
                subscriptionId: opened.subscriptionId,
                sequence: 1,
                rootSessionId: 'session-2',
                graphId: 'agent_graph_1',
                reason: 'observation',
              }
            : {
                ...deltaFrame(
                  changed === 'epoch' ? 'different-epoch' : hostEpoch,
                  opened.subscriptionId,
                  1,
                ),
                ...(changed === 'session' ? { sessionId: 'session-2' } : {}),
              },
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
    async (transport, hostEpoch, rootId) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-slow');
      const frames = [
        encodeLocalIpcTestFrame({
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        }),
      ];
      for (let sequence = 1; sequence <= 33; sequence += 1) {
        frames.push(
          encodeLocalIpcTestFrame(deltaFrame(hostEpoch, opened.subscriptionId, sequence)),
        );
      }
      await writeRawLocalIpc(transport, Buffer.concat(frames));
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
    async (transport, hostEpoch, rootId) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      await writeProtocolFrame(transport, {
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: openResult(hostEpoch, 'subscription-eof'),
      });
      transport.closeAfterFlush();
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

test('loads a canonical transcript while live frames continue on the same connection', async () => {
  const message = {
    type: 'assistant' as const,
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'snapshot text',
    modelId: 'test-model',
  };
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const openRequest = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-transcript');
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const transcriptRequest = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in transcriptRequest));
      assert.equal(transcriptRequest.operation, 'session.transcript.query');
      assert.deepEqual(transcriptRequest.input, {
        kind: 'start',
        subscriptionId: opened.subscriptionId,
      });
      await writeRawLocalIpc(
        transport,
        Buffer.concat([
          encodeLocalIpcTestFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
          encodeLocalIpcTestFrame({
            requestId: transcriptRequest.requestId,
            operation: 'session.transcript.query',
            ok: true,
            result: {
              kind: 'chunk',
              snapshotId: 'snapshot-1',
              sessionId: 'session-1',
              messageCount: 1,
              messageIndex: 0,
              byteOffset: 0,
              data: Buffer.from(JSON.stringify(message), 'utf8').toString('base64'),
              next: null,
            },
          }),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({ sessionId: 'session-1' });
      assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [message]);
      assert.deepEqual(await subscription[Symbol.asyncIterator]().next(), {
        done: false,
        value: deltaFrame(connection.hostEpoch, subscription.subscriptionId, 1),
      });
      await subscription.close();
    },
  );
});

test('restarts transcript loading after an expired snapshot', async () => {
  const message = {
    type: 'user' as const,
    id: 'user-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'hello',
  };
  const encoded = Buffer.from(JSON.stringify(message), 'utf8');
  const splitAt = Math.floor(encoded.byteLength / 2);
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const openRequest = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(hostEpoch, 'subscription-retry');
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const startRequest = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in startRequest));
      assert.deepEqual(startRequest.input, {
        kind: 'start',
        subscriptionId: opened.subscriptionId,
      });
      await writeProtocolFrame(transport, {
        requestId: startRequest.requestId,
        operation: 'session.transcript.query',
        ok: true,
        result: {
          kind: 'chunk',
          snapshotId: 'expired-snapshot',
          sessionId: 'session-1',
          messageCount: 1,
          messageIndex: 0,
          byteOffset: 0,
          data: encoded.subarray(0, splitAt).toString('base64'),
          next: { messageIndex: 0, byteOffset: splitAt },
        },
      });
      const continuationRequest = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in continuationRequest));
      assert.deepEqual(continuationRequest.input, {
        kind: 'continue',
        subscriptionId: opened.subscriptionId,
        snapshotId: 'expired-snapshot',
        messageIndex: 0,
        byteOffset: splitAt,
      });
      await writeProtocolFrame(transport, {
        requestId: continuationRequest.requestId,
        operation: 'session.transcript.query',
        ok: true,
        result: { kind: 'snapshot_expired', snapshotId: 'expired-snapshot' },
      });
      const retryStartRequest = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in retryStartRequest));
      assert.deepEqual(retryStartRequest.input, {
        kind: 'start',
        subscriptionId: opened.subscriptionId,
      });
      await writeProtocolFrame(transport, {
        requestId: retryStartRequest.requestId,
        operation: 'session.transcript.query',
        ok: true,
        result: {
          kind: 'chunk',
          snapshotId: 'snapshot-retry',
          sessionId: 'session-1',
          messageCount: 1,
          messageIndex: 0,
          byteOffset: 0,
          data: encoded.toString('base64'),
          next: null,
        },
      });
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({ sessionId: 'session-1' });
      await assert.rejects(
        () => subscription.loadTranscript(decodeStoredMessage),
        hasSubscriptionReason('transcript_expired'),
      );
      assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [message]);
      await subscription.close();
    },
  );
});

async function withProtocolPeer(
  serve: (transport: FramedTransport, hostEpoch: string, rootId: string) => Promise<void>,
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
    void serve(new FramedTransport(socket), hostEpoch, capability.rootId).then(
      serverTask.resolve,
      serverTask.reject,
    );
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
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
      compositionRevision: '1',
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
  rootId: string,
): Promise<Extract<RequestFrame, { operation: 'subscription.open' }>> {
  const hello = decodeClientFrame(await transport.read(1_000));
  assert.ok('kind' in hello && hello.kind === 'hello');
  await writeProtocolFrame(transport, {
    kind: 'accepted',
    rootId,
    hostEpoch,
    connectionId: 'connection-1',
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
    compositionRevision: '1',
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
  await writeProtocolFrame(transport, {
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
  await writeProtocolFrame(transport, {
    requestId: request.requestId,
    operation: 'host.status',
    ok: true,
    result: {
      hostEpoch,
      compositionId: 'maka.interactive',
      compositionRevision: '1',
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
    activeAssistantStreams: [],
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId: 'session-1',
        metadataRevision: 1,
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
      goal: null,
      queue: { hostEpoch, queueRevision: 1, steering: [], followup: [] },
      interactions: { pending: [] },
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
      startOffset: 0,
      text: `chunk-${sequence}`,
    },
  };
}

function hasSubscriptionReason(reason: RuntimeHostSubscriptionError['reason']) {
  return (error: unknown) =>
    error instanceof RuntimeHostSubscriptionError && error.reason === reason;
}

function writeProtocolFrame(transport: FramedTransport, frame: HostFrame): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
}

function encodeLocalIpcTestFrame(frame: HostFrame): Buffer {
  return frameLocalIpcProtocolMessage(encodeProtocolMessage(frame));
}

function writeRawLocalIpc(transport: FramedTransport, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    transport.socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
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
