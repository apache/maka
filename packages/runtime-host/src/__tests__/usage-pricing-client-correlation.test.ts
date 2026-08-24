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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolMessage,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostFrame,
  type OperationInput,
  type OperationOutput,
  type RequestFrame,
  type ResponseFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const REQUEST_TIMEOUT_MS = 1_000;

const mismatchCases = [
  {
    name: 'usage offset',
    operation: 'usage.query',
    input: {
      kind: 'logs',
      source: 'tool',
      query: { range: 'all' },
      offset: 50,
    },
    result: {
      kind: 'logs',
      source: 'tool',
      rows: [],
      offset: 49,
      total: 49,
      nextOffset: null,
    },
  },
  {
    name: 'usage log source',
    operation: 'usage.query',
    input: {
      kind: 'logs',
      source: 'tool',
      query: { range: 'all' },
      offset: 50,
    },
    result: {
      kind: 'logs',
      source: 'llm',
      rows: [],
      offset: 50,
      total: 50,
      nextOffset: null,
    },
  },
  {
    name: 'usage result kind',
    operation: 'usage.query',
    input: {
      kind: 'logs',
      source: 'tool',
      query: { range: 'all' },
      offset: 50,
    },
    result: {
      kind: 'buckets',
      buckets: [],
      offset: 50,
      total: 50,
      nextOffset: null,
    },
  },
  {
    name: 'pricing revision',
    operation: 'pricing.query',
    input: { kind: 'continue', revision: 7, offset: 50 },
    result: {
      kind: 'page',
      revision: 8,
      offset: 50,
      entries: [],
      nextOffset: null,
    },
  },
  {
    name: 'pricing start result kind',
    operation: 'pricing.query',
    input: { kind: 'start' },
    result: {
      kind: 'revision_changed',
      expectedRevision: 7,
      actualRevision: 8,
    },
  },
  {
    name: 'pricing revision-change expectation',
    operation: 'pricing.query',
    input: { kind: 'continue', revision: 7, offset: 50 },
    result: {
      kind: 'revision_changed',
      expectedRevision: 8,
      actualRevision: 9,
    },
  },
  {
    name: 'pricing mutation expectation',
    operation: 'pricing.mutate',
    input: {
      expectedRevision: 7,
      mutation: { kind: 'delete', modelKey: 'provider:model' },
    },
    result: {
      kind: 'revision_conflict',
      expectedRevision: 8,
      actualRevision: 9,
    },
  },
  {
    name: 'pricing non-conflicting revision conflict',
    operation: 'pricing.mutate',
    input: {
      expectedRevision: 7,
      mutation: { kind: 'delete', modelKey: 'provider:model' },
    },
    result: {
      kind: 'revision_conflict',
      expectedRevision: 7,
      actualRevision: 7,
    },
  },
] as const;

describe('Usage/Pricing client response correlation', () => {
  for (const mismatch of mismatchCases) {
    test(`fails the connection for a canonical response with mismatched ${mismatch.name}`, {
      skip: process.platform === 'win32',
    }, async () => {
      await withProtocolPeer(
        async (transport, hostEpoch, rootId) => {
          const request = await acceptConnectionAndReadRequest(transport, hostEpoch, rootId);
          assert.equal(request.operation, mismatch.operation);
          await writeHostFrame(transport, {
            requestId: request.requestId,
            operation: mismatch.operation,
            ok: true,
            result: mismatch.result,
          } as ResponseFrame);
          await transport.closed;
        },
        async (connection) => {
          const request = requestUnchecked(connection, mismatch.operation, mismatch.input);
          await assert.rejects(request, isInvalidFrame);
          await connection.closed;
          await assert.rejects(requestUnchecked(connection, 'host.status', {}), isInvalidFrame);
        },
      );
    });
  }

  test('rejects local invalid input without poisoning transport and correlates a private canonical copy', {
    skip: process.platform === 'win32',
  }, async () => {
    await withProtocolPeer(
      async (transport, hostEpoch, rootId) => {
        const request = await acceptConnectionAndReadRequest(transport, hostEpoch, rootId);
        assert.equal(request.operation, 'usage.query');
        assert.deepEqual(request.input, {
          kind: 'logs',
          source: 'tool',
          query: { range: 'all', toolName: 'Read' },
          offset: 50,
          limit: 10,
        });
        await writeHostFrame(transport, {
          requestId: request.requestId,
          operation: 'usage.query',
          ok: true,
          result: {
            kind: 'logs',
            source: 'tool',
            rows: [],
            offset: 50,
            total: 50,
            nextOffset: null,
          },
        });
        await transport.closed;
      },
      async (connection) => {
        let invalidRequest!: Promise<OperationOutput<'usage.query'>>;
        assert.doesNotThrow(() => {
          invalidRequest = connection.request('usage.query', {
            kind: 'logs',
            source: 'tool',
            query: { range: 'all', providerId: 'not-a-tool-filter' },
          } as unknown as OperationInput<'usage.query'>);
        });
        await assert.rejects(invalidRequest, isInvalidFrame);

        const input = {
          kind: 'logs' as const,
          source: 'tool' as const,
          query: { range: 'all' as const, toolName: 'Read' },
          offset: 50,
          limit: 10,
        };
        const response = connection.request('usage.query', input, REQUEST_TIMEOUT_MS);
        input.offset = 51;
        input.query.toolName = 'Write';
        assert.deepEqual(await response, {
          kind: 'logs',
          source: 'tool',
          rows: [],
          offset: 50,
          total: 50,
          nextOffset: null,
        });
      },
    );
  });
});

function requestUnchecked(
  connection: RuntimeHostConnection,
  operation: RequestFrame['operation'],
  input: unknown,
): Promise<unknown> {
  const request = connection.request as unknown as (
    operation: RequestFrame['operation'],
    input: unknown,
    timeoutMs: number,
  ) => Promise<unknown>;
  return request.call(connection, operation, input, REQUEST_TIMEOUT_MS);
}

async function withProtocolPeer(
  serve: (transport: FramedTransport, hostEpoch: string, rootId: string) => Promise<void>,
  run: (connection: RuntimeHostConnection) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-pricing-correlation-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const hostEpoch = randomUUID();
  const endpoint = await prepareRuntimeHostEndpoint({
    rootId: capability.rootId,
    hostEpoch,
  });
  let resolveServer!: () => void;
  let rejectServer!: (error: unknown) => void;
  const serverTask = new Promise<void>((resolve, reject) => {
    resolveServer = resolve;
    rejectServer = reject;
  });
  const server = createServer((socket) => {
    void serve(new FramedTransport(socket), hostEpoch, capability.rootId).then(
      resolveServer,
      rejectServer,
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
      rootPath: root,
      protocol: PROTOCOL,
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Protocol peer did not connect');
    try {
      await run(connected.connection);
    } finally {
      await connected.connection.close();
    }
    await serverTask;
  } finally {
    await closeServer(server);
    await removeHostRegistration(controlDirectory, hostEpoch).catch(() => undefined);
    await endpoint.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function acceptConnectionAndReadRequest(
  transport: FramedTransport,
  hostEpoch: string,
  rootId: string,
): Promise<RequestFrame> {
  const hello = decodeClientFrame(await transport.read(REQUEST_TIMEOUT_MS));
  assert.ok('kind' in hello && hello.kind === 'hello');
  await writeHostFrame(transport, {
    kind: 'accepted',
    rootId,
    hostEpoch,
    connectionId: 'usage-pricing-correlation',
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
    compositionRevision: '1',
    state: 'ready',
  });
  const request = decodeClientFrame(await transport.read(REQUEST_TIMEOUT_MS));
  assert.ok(!('kind' in request));
  return request as RequestFrame;
}

function writeHostFrame(transport: FramedTransport, frame: HostFrame): Promise<void> {
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
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
