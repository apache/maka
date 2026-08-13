import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as delayImmediate } from 'node:timers/promises';
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
import { ClientSessionSubscription } from '../client/session-subscription.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SessionTranscriptBootstrap,
  type SessionTranscriptFragment,
  type SessionTranscriptPage,
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
        transcript: { kind: 'none' },
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
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
        transcript: { kind: 'none' },
      });
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
        transcript: { kind: 'none' },
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
          transcript: { kind: 'none' },
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
        transcript: { kind: 'none' },
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
        transcript: { kind: 'none' },
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
      const opened = openResult(
        hostEpoch,
        'subscription-transcript',
        transcriptBootstrap(Buffer.from(JSON.stringify(message), 'utf8')),
      );
      await writeRawLocalIpc(
        transport,
        Buffer.concat([
          encodeLocalIpcTestFrame({
            requestId: openRequest.requestId,
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
        transcript: { kind: 'tail', maxBytes: 16 * 1024 },
      });
      assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [message]);
      assert.deepEqual(await subscription[Symbol.asyncIterator]().next(), {
        done: false,
        value: deltaFrame(connection.hostEpoch, subscription.subscriptionId, 1),
      });
      await subscription.close();
    },
  );
});

test('reassembles a large message from bounded backward pages', async () => {
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
      const opened = openResult(hostEpoch, 'subscription-fragmented', {
        throughSequence: 0,
        overlayMessageCount: 0,
        durable: transcriptPage({
          rawBytes: encoded.byteLength - splitAt,
          fragments: [
            {
              kind: 'durable',
              sequence: 0,
              byteOffset: splitAt,
              totalBytes: encoded.byteLength,
              payloadDigest: null,
              data: encoded.subarray(splitAt).toString('base64'),
            },
          ],
          nextCursor: 'cursor-1',
        }),
        overlay: transcriptPage({ source: 'overlay' }),
      });
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const continuationRequest = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in continuationRequest));
      assert.equal(continuationRequest.operation, 'session.transcript.page');
      assert.deepEqual(continuationRequest.input, {
        subscriptionId: opened.subscriptionId,
        source: 'durable',
        direction: 'older',
        throughSequence: 0,
        cursor: 'cursor-1',
        anchorSequence: null,
        maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      });
      await writeProtocolFrame(transport, {
        requestId: continuationRequest.requestId,
        operation: 'session.transcript.page',
        ok: true,
        result: transcriptPage({
          rawBytes: splitAt,
          fragments: [
            {
              kind: 'durable',
              sequence: 0,
              byteOffset: 0,
              totalBytes: encoded.byteLength,
              payloadDigest: null,
              data: encoded.subarray(0, splitAt).toString('base64'),
            },
          ],
        }),
      });
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
        transcript: { kind: 'tail', maxBytes: 16 * 1024 },
      });
      assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [message]);
      await subscription.close();
    },
  );
});

test('releases a materialized overlay through the connection-bound control operation', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'overlay' }),
    'utf8',
  );
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const openRequest = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(
        hostEpoch,
        'subscription-overlay-release',
        overlayBootstrap(message),
      );
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const release = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in release));
      assert.equal(release.operation, 'session.transcript.overlay.release');
      assert.deepEqual(release.input, { subscriptionId: opened.subscriptionId });
      await writeProtocolFrame(transport, {
        requestId: release.requestId,
        operation: 'session.transcript.overlay.release',
        ok: true,
        result: { subscriptionId: opened.subscriptionId },
      });
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
        transcript: { kind: 'tail', maxBytes: 16 * 1024 },
      });
      assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'overlay' },
      ]);
      await subscription.close();
    },
  );
});

test('fails the connection when overlay release is not confirmed', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'overlay' }),
    'utf8',
  );
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const openRequest = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(
        hostEpoch,
        'subscription-overlay-release-failure',
        overlayBootstrap(message),
      );
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const release = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in release));
      assert.equal(release.operation, 'session.transcript.overlay.release');
      await writeProtocolFrame(transport, {
        requestId: release.requestId,
        operation: 'session.transcript.overlay.release',
        ok: false,
        error: { code: 'internal_failure', message: 'release failed' },
      });
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
        transcript: { kind: 'tail', maxBytes: 16 * 1024 },
      });
      await assert.rejects(
        () => subscription.loadTranscript(decodeStoredMessage),
        hasSubscriptionReason('transcript_release_failed'),
      );
      await assert.rejects(() => connection.request('host.status', {}));
    },
  );
});

test('keeps the connection usable when close wins the overlay release race', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'overlay' }),
    'utf8',
  );
  await withProtocolPeer(
    async (transport, hostEpoch, rootId) => {
      const openRequest = await acceptConnectionAndReadOpen(transport, hostEpoch, rootId);
      const opened = openResult(
        hostEpoch,
        'subscription-overlay-release-after-close',
        overlayBootstrap(message),
      );
      await writeProtocolFrame(transport, {
        requestId: openRequest.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const close = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in close));
      assert.equal(close.operation, 'subscription.close');
      await writeProtocolFrame(transport, {
        requestId: close.requestId,
        operation: 'subscription.close',
        ok: true,
        result: { subscriptionId: opened.subscriptionId },
      });
      const release = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in release));
      assert.equal(release.operation, 'session.transcript.overlay.release');
      await writeProtocolFrame(transport, {
        requestId: release.requestId,
        operation: 'session.transcript.overlay.release',
        ok: true,
        result: { subscriptionId: opened.subscriptionId },
      });
      const status = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in status));
      assert.equal(status.operation, 'host.status');
      await writeProtocolFrame(transport, {
        requestId: status.requestId,
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
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
        transcript: { kind: 'tail', maxBytes: 16 * 1024 },
      });
      const loading = subscription.loadTranscript(decodeStoredMessage);
      await subscription.close();
      assert.deepEqual(await loading, [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'overlay' },
      ]);
      assert.equal((await connection.request('host.status', {})).hostEpoch, connection.hostEpoch);
    },
  );
});

test('rejects a durable sequence gap', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' }),
    'utf8',
  );
  const fragment = {
    kind: 'durable' as const,
    sequence: 0,
    byteOffset: 0,
    totalBytes: message.byteLength,
    payloadDigest: null,
    data: message.toString('base64'),
  };
  const gap = new ClientSessionSubscription(
    openResult('host-1', 'subscription-gap', {
      throughSequence: 1,
      overlayMessageCount: 0,
      durable: {
        ...transcriptPage({
          rawBytes: message.byteLength,
          fragments: [{ ...fragment, sequence: 1 }],
        }),
        throughSequence: 1,
      },
      overlay: { ...transcriptPage({ source: 'overlay' }), throughSequence: 1 },
    }),
    async () => undefined,
    async () => {
      throw new Error('unexpected page request');
    },
  );
  await assert.rejects(
    () => gap.loadTranscript(decodeStoredMessage),
    hasSubscriptionReason('correlation_changed'),
  );
});

test('rejects a durable message that does not match its payload digest', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' }),
    'utf8',
  );
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-digest-mismatch', {
      throughSequence: 0,
      overlayMessageCount: 0,
      durable: transcriptPage({
        rawBytes: message.byteLength,
        fragments: [
          {
            kind: 'durable',
            sequence: 0,
            byteOffset: 0,
            totalBytes: message.byteLength,
            payloadDigest: `sha256:${createHash('sha256').update('different').digest('hex')}`,
            data: message.toString('base64'),
          },
        ],
      }),
      overlay: transcriptPage({ source: 'overlay' }),
    }),
    async () => undefined,
    async () => {
      throw new Error('unexpected page request');
    },
  );

  await assert.rejects(
    () => subscription.loadTranscript(decodeStoredMessage),
    hasSubscriptionReason('correlation_changed'),
  );
});

test('rejects a transcript cursor that does not advance', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' }),
    'utf8',
  );
  const repeated = transcriptPage({
    rawBytes: message.byteLength,
    nextCursor: 'stuck-cursor',
    fragments: [
      {
        kind: 'durable',
        sequence: 0,
        byteOffset: 0,
        totalBytes: message.byteLength,
        payloadDigest: null,
        data: message.toString('base64'),
      },
    ],
  });
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-stuck-cursor', {
      throughSequence: 0,
      overlayMessageCount: 0,
      durable: repeated,
      overlay: transcriptPage({ source: 'overlay' }),
    }),
    async () => undefined,
    async () => repeated,
  );

  await assert.rejects(subscription.loadTranscript(decodeStoredMessage), {
    name: 'RuntimeHostSubscriptionError',
    reason: 'correlation_changed',
    message: 'Session transcript cursor did not advance',
  });
});

test('rejects an overlay that terminates before its declared high-water', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 1, text: '' }),
    'utf8',
  );
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-truncated-overlay', {
      throughSequence: null,
      overlayMessageCount: 2,
      durable: { ...transcriptPage(), throughSequence: null },
      overlay: {
        ...transcriptPage({
          source: 'overlay',
          rawBytes: message.byteLength,
          fragments: [
            {
              kind: 'overlay',
              messageIndex: 0,
              byteOffset: 0,
              totalBytes: message.byteLength,
              data: message.toString('base64'),
            },
          ],
        }),
        throughSequence: null,
      },
    }),
    async () => undefined,
    async () => {
      throw new Error('unexpected page request');
    },
  );

  await assert.rejects(
    () => subscription.loadTranscript((value) => value),
    hasSubscriptionReason('correlation_changed'),
  );
});

test('acknowledges the overlay only after complete materialization', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'ok' }),
    'utf8',
  );
  let releases = 0;
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-overlay-release', overlayBootstrap(message)),
    async () => undefined,
    async () => {
      throw new Error('unexpected page request');
    },
    async () => {
      releases += 1;
    },
  );

  assert.deepEqual(await subscription.loadTranscript(decodeStoredMessage), [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'ok' },
  ]);
  assert.equal(releases, 1);
  await subscription.loadTranscript(decodeStoredMessage);
  assert.equal(releases, 1);
});

test('acknowledges a complete overlay before waiting for durable continuation pages', async () => {
  const durableMessage = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'history' }),
    'utf8',
  );
  const overlayMessage = Buffer.from(
    JSON.stringify({
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 2,
      text: 'partial',
      modelId: 'test-model',
    }),
    'utf8',
  );
  const split = Math.floor(durableMessage.byteLength / 2);
  const durablePageStarted = deferred<void>();
  const continueDurablePage = deferred<void>();
  let releases = 0;
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-overlay-release-before-durable', {
      throughSequence: 0,
      overlayMessageCount: 1,
      durable: transcriptPage({
        rawBytes: durableMessage.byteLength - split,
        fragments: [
          {
            kind: 'durable',
            sequence: 0,
            byteOffset: split,
            totalBytes: durableMessage.byteLength,
            payloadDigest: null,
            data: durableMessage.subarray(split).toString('base64'),
          },
        ],
        nextCursor: 'durable-cursor-1',
      }),
      overlay: overlayBootstrap(overlayMessage).overlay,
    }),
    async () => undefined,
    async () => {
      durablePageStarted.resolve();
      await continueDurablePage.promise;
      return transcriptPage({
        rawBytes: split,
        fragments: [
          {
            kind: 'durable',
            sequence: 0,
            byteOffset: 0,
            totalBytes: durableMessage.byteLength,
            payloadDigest: null,
            data: durableMessage.subarray(0, split).toString('base64'),
          },
        ],
      });
    },
    async () => {
      releases += 1;
    },
  );

  const loading = subscription.loadTranscript(decodeStoredMessage);
  await durablePageStarted.promise;
  assert.equal(releases, 1);
  continueDurablePage.resolve();
  assert.deepEqual(await loading, [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'history' },
    {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 2,
      text: 'partial',
      modelId: 'test-model',
    },
  ]);
});

test('close stops transcript pagination after the in-flight page', async () => {
  const message = Buffer.from(
    JSON.stringify({ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' }),
    'utf8',
  );
  const page = deferred<ReturnType<typeof transcriptPage>>();
  let pageRequests = 0;
  const subscription = new ClientSessionSubscription(
    openResult('host-1', 'subscription-closing', {
      throughSequence: 0,
      overlayMessageCount: 0,
      durable: transcriptPage({
        rawBytes: Math.floor(message.byteLength / 2),
        fragments: [
          {
            kind: 'durable',
            sequence: 0,
            byteOffset: Math.ceil(message.byteLength / 2),
            totalBytes: message.byteLength,
            payloadDigest: null,
            data: message.subarray(Math.ceil(message.byteLength / 2)).toString('base64'),
          },
        ],
        nextCursor: 'cursor-1',
      }),
      overlay: transcriptPage({ source: 'overlay' }),
    }),
    async () => undefined,
    async () => {
      pageRequests += 1;
      return page.promise;
    },
  );
  const loading = subscription.loadTranscript(decodeStoredMessage);
  await delayImmediate();
  await subscription.close();
  page.resolve(transcriptPage());
  await assert.rejects(() => loading, hasSubscriptionReason('connection_closed'));
  assert.equal(pageRequests, 1);
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

function openResult(
  hostEpoch: string,
  subscriptionId: string,
  transcript: SessionTranscriptBootstrap | null = null,
) {
  return {
    hostEpoch,
    subscriptionId,
    nextSequence: 1,
    activeAssistantStreams: [],
    transcript,
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

function transcriptBootstrap(message: Buffer): SessionTranscriptBootstrap {
  return {
    throughSequence: 0,
    overlayMessageCount: 0,
    durable: transcriptPage({
      rawBytes: message.byteLength,
      fragments: [
        {
          kind: 'durable',
          sequence: 0,
          byteOffset: 0,
          totalBytes: message.byteLength,
          payloadDigest: null,
          data: message.toString('base64'),
        },
      ],
    }),
    overlay: transcriptPage({ source: 'overlay' }),
  };
}

function overlayBootstrap(message: Buffer): SessionTranscriptBootstrap {
  return {
    throughSequence: null,
    overlayMessageCount: 1,
    durable: { ...transcriptPage(), throughSequence: null },
    overlay: {
      ...transcriptPage({
        source: 'overlay',
        rawBytes: message.byteLength,
        fragments: [
          {
            kind: 'overlay',
            messageIndex: 0,
            byteOffset: 0,
            totalBytes: message.byteLength,
            data: message.toString('base64'),
          },
        ],
      }),
      throughSequence: null,
    },
  };
}

function transcriptPage(
  options: {
    source?: 'durable' | 'overlay';
    rawBytes?: number;
    fragments?: readonly SessionTranscriptFragment[];
    nextCursor?: string | null;
  } = {},
): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId: 'session-1',
    source: options.source ?? 'durable',
    direction: 'older',
    throughSequence: 0,
    rawBytes: options.rawBytes ?? 0,
    fragments: options.fragments ?? [],
    nextCursor: options.nextCursor ?? null,
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
