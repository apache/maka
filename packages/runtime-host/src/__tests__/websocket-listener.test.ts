import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { consumeAccessCredentialDeliveryFromControlDirectory } from '../control/access-credential-delivery.js';
import {
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import { openRuntimeHostAccessAuthority } from '../server/access-authority.js';
import { startRuntimeHostWebSocketListener } from '../server/websocket-listener.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';

test('WebSocket admission, health, Origin, and message policy fail closed', {
  timeout: 5_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-websocket-listener-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  const issued = await authority.issue({
    principalId: 'native-client',
    operationGrants: ['session.catalog.query'],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  });
  const credential = await consumeAccessCredentialDeliveryFromControlDirectory(
    directory,
    issued.deliveryId,
    issued.credentialId,
  );
  const accepted = deferred<RuntimeHostMessageTransport>();
  let ready = false;
  const listener = await startRuntimeHostWebSocketListener({
    host: '127.0.0.1',
    port: 0,
    accessAuthority: authority,
    isReady: () => ready,
    accept: ({ transport }) => accepted.resolve(transport),
  });
  let client: WebSocket | undefined;
  let survivor: WebSocket | undefined;
  let partial: Socket | undefined;
  try {
    const httpBase = listener.endpoint.replace('ws://', 'http://').replace('/runtime-host', '');
    assert.equal((await fetch(`${httpBase}/healthz`)).status, 200);
    assert.equal((await fetch(`${httpBase}/readyz`)).status, 503);
    ready = true;
    assert.equal((await fetch(`${httpBase}/readyz`)).status, 200);

    await assert.rejects(openWebSocket(listener.endpoint));
    await assert.rejects(openWebSocket(`${listener.endpoint}?route=forbidden`, credential));
    await assert.rejects(openWebSocket(listener.endpoint, credential, 'https://browser.invalid'));

    client = await openWebSocket(listener.endpoint, credential);
    const transport = await accepted.promise;
    client.send(JSON.stringify({ message: 'hello' }));
    assert.deepEqual(await transport.read(1_000), { message: 'hello' });

    const reply = onceMessage(client);
    await transport.write(encodeProtocolMessage({ kind: 'draining', hostEpoch: 'host-1' }));
    const received = await reply;
    assert.equal(received.isBinary, false);
    assert.deepEqual(JSON.parse(received.data.toString()), {
      kind: 'draining',
      hostEpoch: 'host-1',
    });

    client.send(JSON.stringify({ queued: true }));
    client.send(Buffer.from('{}'));
    await transport.closed;
    await assert.rejects(
      transport.read(1_000),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
    );

    client = await openWebSocket(listener.endpoint, credential);
    const invalidUtf8Closed = waitForClose(client, 'invalid UTF-8 Client');
    client.send(Buffer.from([0xff]), { binary: false });
    await invalidUtf8Closed;

    client = await openWebSocket(listener.endpoint, credential);
    const oversizedClosed = waitForClose(client, 'oversized Client');
    client.send('x'.repeat(RUNTIME_HOST_MAX_MESSAGE_BYTES + 1));
    await oversizedClosed;

    survivor = await openWebSocket(listener.endpoint, credential);
    const target = new URL(listener.endpoint);
    partial = connect({ host: target.hostname, port: Number(target.port) });
    await once(partial, 'connect');
    partial.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\n`);
    const partialClosed = waitForClose(partial, 'partial HTTP Client');
    await Promise.all([
      withTimeout(listener.closeAdmission(), 'listener admission close'),
      partialClosed,
    ]);
    assert.equal(survivor.readyState, WebSocket.OPEN);
    const survivorClosed = waitForClose(survivor, 'upgraded Client');
    await listener.cleanup();
    await survivorClosed;
  } finally {
    client?.terminate();
    survivor?.terminate();
    partial?.destroy();
    await listener.closeAdmission().catch(() => undefined);
    await listener.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

function openWebSocket(url: string, credential?: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...(credential ? { headers: { authorization: `Bearer ${credential}` } } : {}),
      ...(origin ? { origin } : {}),
      perMessageDeflate: false,
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function onceMessage(socket: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (data, isBinary) => resolve({ data, isBinary }));
  });
}

function waitForClose(socket: WebSocket | Socket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not close`)), 1_000);
    socket.once('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 1_000);
      timer.unref();
    }),
  ]);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
