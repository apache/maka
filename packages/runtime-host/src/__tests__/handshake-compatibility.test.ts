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
import { connectResolvedRuntimeHost } from '../client/connection.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostFrame,
  type HostHandshakeResult,
  type RequestFrame,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';

const V0_1_11_HOST_COMPATIBILITY_EPOCH = 25;
const V0_1_11_HOST_REVISION = 'a3c4d0b2a6ca0c87bebebff135d40017558ae5b8';
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

test('receives structured incompatibility guidance from the released v0.1.11 Host', async () => {
  await withForgedHandshakePeer(
    async (transport, hostEpoch, rootId) => {
      const rawHello = await transport.read(2_000);
      assert.ok(rawHello && typeof rawHello === 'object');
      const { hello, response } = await admitV0_1_11ClientHello({
        rawHello,
        transport,
        hostEpoch,
        rootId,
      });
      assert.equal(hello.surface, 'desktop');
      assert.ok(hello.compatibilityEpoch > V0_1_11_HOST_COMPATIBILITY_EPOCH);
      assert.equal(hello.protocolMin, RUNTIME_HOST_PROTOCOL_VERSION + 1);
      assert.equal(hello.protocolMax, RUNTIME_HOST_PROTOCOL_VERSION + 1);
      assert.equal(response.kind, 'incompatible');
      await transport.closed;
    },
    async (result) => {
      assert.equal(result.kind, 'incompatible');
      if (result.kind === 'incompatible') {
        assert.equal(result.handshake.compatibilityEpoch, V0_1_11_HOST_COMPATIBILITY_EPOCH);
        assert.equal(result.handshake.compositionRevision, V0_1_11_HOST_REVISION);
        assert.equal(result.handshake.replacement, 'blocked_by_residency');
      }
    },
    { registrationCompatibilityEpoch: V0_1_11_HOST_COMPATIBILITY_EPOCH },
  );
});

test('rejects an epoch-39 Host before any domain command', async () => {
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
        compatibilityEpoch: 39,
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

test('records a registration root mismatch before connecting the endpoint', async () => {
  await withForgedHandshakePeer(
    async () => {
      assert.fail('registration mismatch must not connect to the endpoint');
    },
    async (result) => {
      assert.equal(result.kind, 'unavailable');
      if (result.kind !== 'unavailable') return;
      assert.equal(result.reason, 'root_mismatch');
      assert.equal(result.endpointConnected, false);
    },
    {
      registrationRootId: randomBytes(32).toString('hex'),
      expectConnection: false,
    },
  );
});

test('records a root mismatch returned after connecting and handshaking', async () => {
  await withForgedHandshakePeer(
    async (transport, hostEpoch) => {
      const hello = decodeClientFrame(await transport.read(2_000));
      assert.ok('kind' in hello && hello.kind === 'hello');
      await writeProtocolFrame(transport, {
        kind: 'accepted',
        rootId: randomBytes(32).toString('hex'),
        hostEpoch,
        connectionId: 'forged-root-mismatch-connection',
        selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        state: 'ready',
      });
      await transport.closed;
    },
    async (result) => {
      assert.equal(result.kind, 'unavailable');
      if (result.kind !== 'unavailable') return;
      assert.equal(result.reason, 'root_mismatch');
      assert.equal(result.endpointConnected, true);
    },
    { prepareAfterListen: false },
  );
});

interface V0_1_11ClientHello {
  readonly kind: 'hello';
  readonly clientInstanceId: string;
  readonly surface: V0_1_11ClientSurface;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly compatibilityEpoch: number;
  readonly compositionId: string;
}

/**
 * Minimal no-generation/no-takeover fixture copied from the released v0.1.11
 * Host at V0_1_11_HOST_REVISION. Keep its decoder, negotiation, and admission
 * independent of the current implementation so removing the private bootstrap
 * shim reproduces that Host's pre-admission transport abort.
 */
async function admitV0_1_11ClientHello(input: {
  readonly rawHello: unknown;
  readonly transport: FramedTransport;
  readonly hostEpoch: string;
  readonly rootId: string;
}): Promise<{
  readonly hello: V0_1_11ClientHello;
  readonly response: HostHandshakeResult;
}> {
  const hello = decodeV0_1_11ClientHello(input.rawHello);
  const selectedProtocol = negotiateV0_1_11Protocol(hello.protocolMin, hello.protocolMax);
  const incompatible =
    selectedProtocol === undefined ||
    hello.compatibilityEpoch !== V0_1_11_HOST_COMPATIBILITY_EPOCH ||
    hello.compositionId !== 'maka.interactive';
  const response: HostHandshakeResult = incompatible
    ? {
        kind: 'incompatible',
        hostEpoch: input.hostEpoch,
        protocolMin: 0,
        protocolMax: 0,
        compatibilityEpoch: V0_1_11_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
        compositionRevision: V0_1_11_HOST_REVISION,
        state: 'ready',
        replacement: 'blocked_by_residency',
      }
    : {
        kind: 'accepted',
        rootId: input.rootId,
        hostEpoch: input.hostEpoch,
        connectionId: 'v0.1.11-connection',
        selectedProtocol,
        compatibilityEpoch: V0_1_11_HOST_COMPATIBILITY_EPOCH,
        compositionId: 'maka.interactive',
        compositionRevision: V0_1_11_HOST_REVISION,
        state: 'ready',
      };
  await input.transport.write(encodeProtocolMessage(response));
  if (response.kind !== 'accepted') input.transport.closeAfterFlush();
  return { hello, response };
}

function decodeV0_1_11ClientHello(value: unknown): V0_1_11ClientHello {
  const frame = requireRecord(value, 'v0.1.11 Client hello');
  if (frame.kind !== 'hello') throw new Error('Expected a v0.1.11 Client hello');
  const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
  const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
  if (protocolMax < protocolMin) throw new Error('Invalid v0.1.11 Client protocol range');
  return {
    kind: 'hello',
    clientInstanceId: requireString(frame.clientInstanceId, 'clientInstanceId'),
    surface: requireV0_1_11Surface(frame.surface),
    protocolMin,
    protocolMax,
    compatibilityEpoch: requireProtocolVersion(frame.compatibilityEpoch, 'compatibilityEpoch'),
    compositionId: requireString(frame.compositionId, 'compositionId'),
  };
}

type V0_1_11ClientSurface =
  | 'desktop'
  | 'tui'
  | 'run'
  | 'activation'
  | 'bot'
  | 'inspect'
  | 'capability-provider';

function requireV0_1_11Surface(value: unknown): V0_1_11ClientSurface {
  if (
    value === 'desktop' ||
    value === 'tui' ||
    value === 'run' ||
    value === 'activation' ||
    value === 'bot' ||
    value === 'inspect' ||
    value === 'capability-provider'
  )
    return value;
  throw new Error('Invalid surface');
}

function negotiateV0_1_11Protocol(protocolMin: number, protocolMax: number): number | undefined {
  const selected = Math.min(protocolMax, 0);
  return selected >= Math.max(protocolMin, 0) ? selected : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireProtocolVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

type ResolvedConnectRuntimeHostResult = Exclude<
  Awaited<ReturnType<typeof connectResolvedRuntimeHost>>,
  { kind: 'election_deadline_elapsed' }
>;

async function withForgedHandshakePeer(
  serve: (transport: FramedTransport, hostEpoch: string, rootId: string) => Promise<void>,
  run: (result: ResolvedConnectRuntimeHostResult) => Promise<void>,
  options: {
    readonly registrationCompatibilityEpoch?: number;
    readonly registrationRootId?: string;
    readonly expectConnection?: boolean;
    readonly prepareAfterListen?: boolean;
  } = {},
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
    if (options.expectConnection !== false) {
      await listen(server, endpoint.path);
      if (options.prepareAfterListen !== false) await endpoint.prepareAfterListen();
    }
    await writeHostRegistration(controlDirectory, {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: options.registrationRootId ?? capability.rootId,
      hostEpoch,
      endpoint: endpoint.path,
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch:
        options.registrationCompatibilityEpoch ?? RUNTIME_HOST_COMPATIBILITY_EPOCH,
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
    if (options.expectConnection !== false) await serverTask.promise;
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
