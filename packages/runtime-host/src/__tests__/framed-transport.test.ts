import assert from 'node:assert/strict';
import { createServer, Socket, type Server } from 'node:net';
import { test } from 'node:test';
import { RUNTIME_HOST_MAX_FRAME_BYTES, RuntimeHostProtocolError } from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';

test('drains clean half-open input before reporting typed read EOF', async () => {
  await withSocketPair(async (transport, peer) => {
    const ended = endSocket(peer, Buffer.from(`${JSON.stringify({ accepted: true })}\n`));
    assert.deepEqual(await transport.read(1_000), { accepted: true });
    await assert.rejects(
      transport.read(1_000),
      (error: unknown) => error instanceof RuntimeHostTransportError && error.code === 'read_eof',
    );

    const reply = Buffer.from(`${JSON.stringify({ reply: true })}\n`);
    const received = readSocket(peer, reply.byteLength);
    await transport.writeEncoded(reply);
    assert.deepEqual(await received, reply);
    await ended;

    const failure = new Error('forced transport failure');
    transport.destroy(failure);
    await transport.closed;
    await assert.rejects(transport.read(0), (error: unknown) => error === failure);
  });
});

test('drains a paused frame burst before reporting a terminal partial frame', async () => {
  await withSocketPair(async (transport, peer) => {
    const frames = Array.from({ length: 96 }, (_, index) => ({ index }));
    const ended = endSocket(
      peer,
      Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n{"partial":`),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const expected of frames) {
      assert.deepEqual(await transport.read(2_000), expected);
    }
    await assert.rejects(
      transport.read(2_000),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
    );
    await ended;
    await transport.closed;
  });
});

test('applies byte backpressure without dropping large valid frames', async () => {
  await withSocketPair(async (transport, peer) => {
    const payload = 'x'.repeat(60 * 1024);
    const frames = Array.from({ length: 40 }, (_, index) => ({ index, payload }));
    const sent = writeSocket(
      peer,
      Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const expected of frames) {
      assert.deepEqual(await transport.read(5_000), expected);
    }
    await sent;
    await writeSocket(peer, Buffer.from(`${JSON.stringify({ resumed: true })}\n`));
    assert.deepEqual(await transport.read(2_000), { resumed: true });
  });
});

test('fails closed on an oversized unterminated frame over a real socket', async () => {
  await withSocketPair(async (transport, peer) => {
    const read = transport.read(1_000);
    peer.write(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61));
    await assert.rejects(
      read,
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
    await transport.closed;
  });
});

test('returns a rejected Promise for an oversized outbound frame', async () => {
  await withSocketPair(async (transport) => {
    await assert.rejects(
      transport.write({
        kind: 'draining',
        hostEpoch: 'x'.repeat(RUNTIME_HOST_MAX_FRAME_BYTES),
      }),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
  });
});

async function withSocketPair(
  run: (transport: FramedTransport, peer: Socket) => Promise<void>,
): Promise<void> {
  const accepted = deferred<Socket>();
  const server = createServer(accepted.resolve);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new Socket({ allowHalfOpen: true });
  socket.connect(address.port, '127.0.0.1');
  await onceConnected(socket);
  const peer = await accepted.promise;
  const transport = new FramedTransport(socket);
  try {
    await run(transport, peer);
  } finally {
    transport.destroy();
    peer.destroy();
    await transport.closed;
    await closeServer(server);
  }
}

function readSocket(socket: Socket, expectedBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      receivedBytes += chunk.byteLength;
      if (receivedBytes < expectedBytes) return;
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function endSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.end(bytes, () => {
      socket.off('error', onError);
      resolve();
    });
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
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
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
