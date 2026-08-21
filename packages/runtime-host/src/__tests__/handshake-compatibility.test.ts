import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverMarkedStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  STORAGE_ROOT_MARKER_SCHEMA_VERSION,
} from '@maka/storage/root-authority';
import { connectResolvedRuntimeHost, type ConnectRuntimeHostResult } from '../client/connection.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostFrame,
  type RequestFrame,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('emits the legacy desktop surface shim in the raw Client hello', async () => {
  await withForgedHandshakePeer(
    async (transport, hostEpoch, rootId) => {
      const rawHello = await transport.read(2_000);
      assert.ok(rawHello && typeof rawHello === 'object');
      assert.equal((rawHello as Record<string, unknown>).surface, 'desktop');
      const hello = decodeClientFrame(rawHello);
      assert.ok('kind' in hello && hello.kind === 'hello');
      await writeProtocolFrame(transport, {
        kind: 'accepted',
        rootId,
        hostEpoch,
        connectionId: 'forged-current-connection',
        selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
      });
      await transport.closed;
    },
    async (result) => {
      assert.equal(result.kind, 'connected');
    },
  );
});

test('rejects an epoch-23 Host before any domain command', async () => {
  let admittedRequest: RequestFrame | undefined;
  await withForgedHandshakePeer(
    async (transport, hostEpoch, rootId) => {
      const hello = decodeClientFrame(await transport.read(2_000));
      assert.ok('kind' in hello && hello.kind === 'hello');
      await writeProtocolFrame(transport, {
        kind: 'accepted',
        rootId,
        hostEpoch,
        connectionId: 'forged-epoch-connection',
        selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: 23,
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
      });
      try {
        const next = decodeClientFrame(await transport.read(1_000));
        if (!('kind' in next)) admittedRequest = next;
      } catch (error) {
        assert.ok(
          error instanceof RuntimeHostTransportError &&
            (error.code === 'closed' || error.code === 'read_eof'),
        );
      }
    },
    async (result) => {
      assert.equal(result.kind, 'unavailable');
      if (result.kind === 'unavailable') {
        assert.equal(result.reason, 'handshake_failed');
      }
    },
  );
  assert.equal(admittedRequest, undefined);
});

async function withForgedHandshakePeer(
  serve: (transport: FramedTransport, hostEpoch: string, rootId: string) => Promise<void>,
  run: (result: ConnectRuntimeHostResult) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-handshake-'));
  const rootPath = join(base, 'root');
  const controlDirectory = join(base, 'control');
  await mkdir(rootPath, { mode: 0o700 });
  await mkdir(controlDirectory, { mode: 0o700 });
  const rootStat = await stat(rootPath, { bigint: true });
  await writeFile(
    join(rootPath, STORAGE_ROOT_MARKER_FILE),
    `${JSON.stringify({
      schemaVersion: STORAGE_ROOT_MARKER_SCHEMA_VERSION,
      kind: 'interactive',
      rootId: randomBytes(32).toString('hex'),
      rootIdentity: {
        dev: rootStat.dev.toString(),
        ino: rootStat.ino.toString(),
      },
    })}\n`,
    { mode: 0o600 },
  );
  const capability = await discoverMarkedStorageRoot({
    path: rootPath,
  });
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
    const resolved = await connectResolvedRuntimeHost({
      capability,
      controlDirectory,
      clientInstanceId: randomUUID(),
      protocol: PROTOCOL,
    });
    if (resolved.kind === 'election_deadline_elapsed') {
      throw new Error('Unexpected Runtime Host election deadline');
    }
    const result = resolved;
    try {
      await run(result);
    } finally {
      if (result.kind === 'connected') await result.connection.close();
    }
    await serverTask.promise;
  } finally {
    await closeServer(server);
    await removeHostRegistration(controlDirectory, hostEpoch).catch(() => undefined);
    await endpoint.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function writeProtocolFrame(transport: FramedTransport, frame: HostFrame): Promise<void> {
  return transport.write(encodeProtocolMessage(frame));
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
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    }),
    resolve,
    reject,
  };
}
