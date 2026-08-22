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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';
import {
  MCP_CONFIG_VERSION,
  type McpConfigFile,
  type McpProtocolPreference,
  type McpToolBinding,
} from '@maka/core/mcp';
import { McpClientManager } from '../index.js';

const managers: McpClientManager[] = [];
const fixtures: FallbackFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager Streamable HTTP fallback contract', () => {
  test('falls back from a pre-handshake 404 or 405 to a real legacy SSE server', async () => {
    for (const status of [404, 405] as const) {
      const fixture = await createFallbackFixture({ streamable: { kind: 'status', status } });
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url, 'auto'));

      assert.equal(manager.status('remote')?.state, 'connected');
      assert.equal(manager.status('remote')?.transport, 'sse');
      assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
        era: 'legacy',
        revision: '2025-11-25',
      });
      assert.equal(fixture.sseGets, 1);
      assert.deepEqual(fixture.streamableMethods, ['server/discover', 'initialize']);
      assert.ok(fixture.sseMethods.includes('initialize'));
      assert.ok(fixture.sseMethods.includes('tools/list'));
      assert.deepEqual(
        manager.status('remote')?.tools.find((tool) => tool.name === 'echo')?.inputSchema,
        {
          type: 'object',
          properties: {
            value: { type: 'string' },
            ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
          },
        },
        'legacy discovery must not apply modern x-mcp-header exclusion',
      );
      assert.deepEqual(
        await manager.callTool(bindingFor(manager, 'echo'), { value: `fallback-${status}` }),
        {
          content: [{ type: 'text', text: `fallback-${status}` }],
          structuredContent: undefined,
        },
      );

      await manager.close();
      await fixture.close();
    }
  });

  test('does not fall back for non-404/405 HTTP responses', async () => {
    const statuses = [400, 401, 403, 408, 409, 415, 429, 500] as const;
    for (const status of statuses) {
      const fixture = await createFallbackFixture({ streamable: { kind: 'status', status } });
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url, 'auto'));

      // A 401 is an authorization demand, not a dead transport: the manager
      // surfaces needs-auth so the UI can offer a login instead of an error.
      // Either way the probe must not fall back to legacy SSE.
      const expectedState = status === 401 ? 'needs-auth' : 'error';
      assert.equal(manager.status('remote')?.state, expectedState, `HTTP ${status}`);
      assert.equal(fixture.streamableMethods[0], 'server/discover', `HTTP ${status}`);
      assert.ok(fixture.streamablePosts >= 1, `HTTP ${status}`);
      assert.equal(fixture.sseGets, 0, `HTTP ${status}`);

      await manager.close();
      await fixture.close();
    }
  });

  test('does not fall back from an unexpected successful response body', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'unexpected-success' } });
    const manager = createManager();

    await manager.sync(remoteConfig(fixture.url, 'auto'));

    assert.equal(manager.status('remote')?.state, 'error');
    assert.equal(fixture.streamablePosts, 1);
    assert.equal(fixture.sseGets, 0);
  });

  test('does not fall back from a network failure', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'network-error' } });
    const manager = createManager();

    await manager.sync(remoteConfig(fixture.url, 'auto'));

    assert.equal(manager.status('remote')?.state, 'error');
    assert.equal(fixture.streamablePosts, 1);
    assert.equal(fixture.sseGets, 0);
  });

  test('aborts a hanging auto or pinned probe without waiting for the server', async () => {
    for (const protocol of ['auto', '2026-07-28'] as const) {
      const fixture = await createFallbackFixture({ streamable: { kind: 'hang' } });
      const manager = createManager();

      const sync = manager.sync(remoteConfig(fixture.url, protocol));
      await waitFor(() => fixture.streamablePosts === 1);
      assert.equal(manager.cancelConnect('remote'), true);
      try {
        await settlesWithin(sync);
      } finally {
        fixture.releaseStreamable();
      }

      assert.equal(manager.status('remote')?.state, 'disconnected');
      assert.equal(fixture.sseGets, 0);

      await manager.close();
      await fixture.close();
    }
  });

  test('does not start a remote probe after a connecting listener cancels synchronously', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'hang' } });
    const manager = createManager();
    let cancelResult: boolean | undefined;
    manager.onChange((status) => {
      if (status.serverId === 'remote' && status.state === 'connecting') {
        cancelResult = manager.cancelConnect('remote');
      }
    });

    try {
      await settlesWithin(manager.sync(remoteConfig(fixture.url, 'auto')));
    } finally {
      fixture.releaseStreamable();
    }

    assert.equal(cancelResult, true);
    assert.equal(fixture.streamablePosts, 0);
    assert.equal(fixture.sseGets, 0);
    assert.equal(manager.status('remote')?.state, 'disconnected');
  });

  test('does not fall back after the Streamable HTTP probe times out', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'hang' } });
    const manager = createManager(50);

    await manager.sync(remoteConfig(fixture.url, 'auto'));
    fixture.releaseStreamable();

    assert.equal(manager.status('remote')?.state, 'error');
    assert.equal(fixture.streamablePosts, 1);
    assert.equal(fixture.sseGets, 0);
  });

  test('does not fall back after legacy initialize succeeded but initialized returned 404 or 405', async () => {
    for (const status of [404, 405] as const) {
      const fixture = await createFallbackFixture({
        streamable: { kind: 'initialized-status', status },
      });
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url, 'auto'));

      assert.equal(manager.status('remote')?.state, 'error', `HTTP ${status}`);
      assert.deepEqual(
        fixture.streamableMethods.slice(0, 3),
        ['server/discover', 'initialize', 'notifications/initialized'],
        `HTTP ${status}`,
      );
      assert.equal(fixture.sseGets, 0, `HTTP ${status}`);

      await manager.close();
      await fixture.close();
    }
  });

  test('an exact modern pin never attempts legacy SSE', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'status', status: 404 } });
    const manager = createManager();

    await manager.sync(remoteConfig(fixture.url, '2026-07-28'));

    assert.equal(manager.status('remote')?.state, 'error');
    assert.equal(fixture.streamablePosts, 1);
    assert.equal(fixture.sseGets, 0);
  });

  test('an explicit Streamable HTTP transport never attempts legacy SSE', async () => {
    const fixture = await createFallbackFixture({ streamable: { kind: 'status', status: 404 } });
    const manager = createManager();

    await manager.sync(remoteConfig(fixture.url, 'legacy', 'streamable-http'));

    assert.equal(manager.status('remote')?.state, 'error');
    assert.equal(fixture.streamablePosts, 1);
    assert.equal(fixture.sseGets, 0);
  });

  test('preserves both failures behind one stable public error when SSE also fails', async () => {
    for (const status of [404, 405] as const) {
      const fixture = await createFallbackFixture({
        streamable: { kind: 'status', status },
        sse: 'fail',
      });
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url, 'auto'));
      const postsBefore = fixture.streamablePosts;
      const getsBefore = fixture.sseGets;

      let rejection: unknown;
      try {
        await manager.connect('remote');
      } catch (error) {
        rejection = error;
      }

      assert.ok(rejection instanceof Error);
      assert.equal(
        rejection.message,
        'MCP server "remote" connection failed: Streamable HTTP and legacy SSE connection attempts failed',
      );
      // The rejection leaves the manager (reconnect → IPC → renderer): its
      // cause survives as a SANITIZED copy — the per-transport aggregate
      // shape is preserved for diagnosability, but each member is rebuilt
      // with a scrubbed message and no deeper chain or payload fields.
      const cause = (rejection as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof AggregateError);
      assert.equal(cause.errors.length, 2);
      for (const member of cause.errors) {
        assert.ok(member instanceof Error);
        assert.equal((member as Error & { cause?: unknown }).cause, undefined);
      }
      assert.equal(fixture.streamablePosts, postsBefore + 2);
      assert.equal(fixture.sseGets, getsBefore + 1);

      await manager.close();
      await fixture.close();
    }
  });
});

function createManager(remoteConnectMs = 5_000): McpClientManager {
  const manager = new McpClientManager({
    timeouts: { remoteConnectMs, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  managers.push(manager);
  return manager;
}

function remoteConfig(
  url: string,
  protocol: McpProtocolPreference,
  transport: 'auto' | 'streamable-http' = 'auto',
): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      remote: {
        url,
        transport,
        protocol,
      },
    },
  };
}

function bindingFor(manager: McpClientManager, toolName: string): McpToolBinding {
  const match = manager
    .toolSnapshot()
    .tools.find(
      ({ descriptor }) => descriptor.serverId === 'remote' && descriptor.name === toolName,
    );
  assert.ok(match, `missing bound MCP tool remote/${toolName}`);
  return match.binding;
}

type StreamableBehavior =
  | { kind: 'status'; status: number }
  | { kind: 'unexpected-success' }
  | { kind: 'network-error' }
  | { kind: 'hang' }
  | { kind: 'initialized-status'; status: 404 | 405 };

interface FallbackFixture {
  url: string;
  streamablePosts: number;
  sseGets: number;
  streamableMethods: string[];
  sseMethods: string[];
  releaseStreamable(): void;
  close(): Promise<void>;
}

async function createFallbackFixture(options: {
  streamable: StreamableBehavior;
  sse?: 'valid' | 'fail';
}): Promise<FallbackFixture> {
  let streamablePosts = 0;
  let sseGets = 0;
  const streamableMethods: string[] = [];
  const sseMethods: string[] = [];
  let releaseStreamable = () => {};
  const streamableRelease = new Promise<void>((resolve) => {
    releaseStreamable = resolve;
  });
  const sockets = new Set<Socket>();
  const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/mcp' && req.method === 'POST') {
        streamablePosts += 1;
        const body = await readJsonBody(req);
        const methods = readProtocolMethods(body);
        streamableMethods.push(...methods);
        const behavior = options.streamable;
        if (behavior.kind === 'network-error') {
          req.socket.destroy();
          return;
        }
        if (behavior.kind === 'hang') {
          await streamableRelease;
          writeHttpFailure(res, 404);
          return;
        }
        if (behavior.kind === 'unexpected-success') {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end('<!doctype html><title>not MCP</title>');
          return;
        }
        if (behavior.kind === 'status') {
          writeHttpFailure(res, behavior.status);
          return;
        }
        if (methods.includes('notifications/initialized')) {
          writeHttpFailure(res, behavior.status);
          return;
        }
        await handleLegacyStreamableRequest(req, res, body);
        return;
      }
      if (url.pathname === '/mcp' && req.method === 'GET') {
        sseGets += 1;
        if (options.sse === 'fail') {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('unavailable');
          return;
        }
        const transport = new SSEServerTransport('/messages', res);
        const server = createLegacyServer();
        sseTransports.set(transport.sessionId, { transport, server });
        res.once('close', () => sseTransports.delete(transport.sessionId));
        await server.connect(transport);
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const body = await readJsonBody(req);
        sseMethods.push(...readProtocolMethods(body));
        const entry = sseTransports.get(url.searchParams.get('sessionId') ?? '');
        if (!entry) {
          res.writeHead(400).end('unknown SSE session');
          return;
        }
        await entry.transport.handlePostMessage(req, res, body);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('fallback fixture did not bind TCP');
  let closed = false;
  const fixture: FallbackFixture = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    get streamablePosts() {
      return streamablePosts;
    },
    get sseGets() {
      return sseGets;
    },
    streamableMethods,
    sseMethods,
    releaseStreamable,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...sseTransports.values()].map(async ({ transport, server }) => {
          await transport.close().catch(() => {});
          await server.close().catch(() => {});
        }),
      );
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function handleLegacyStreamableRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createLegacyServer();
  await server.connect(transport);
  res.once('close', () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}

function createLegacyServer(): McpServer {
  const server = new McpServer(
    { name: 'maka-fallback-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo text',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
          },
        },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async ({ params }) => ({
    content: [{ type: 'text', text: String(params.arguments?.value ?? '') }],
  }));
  return server;
}

function writeHttpFailure(res: ServerResponse, status: number): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify({ error: `HTTP ${status}` }));
}

function readProtocolMethods(body: unknown): string[] {
  return (Array.isArray(body) ? body : [body]).flatMap((message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'method' in message &&
      typeof message.method === 'string'
    ) {
      return [message.method];
    }
    return [];
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('operation did not settle after abort')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
