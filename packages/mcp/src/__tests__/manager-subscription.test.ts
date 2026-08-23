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
import { afterEach, describe, test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, InMemoryServerEventBus, Server } from '@modelcontextprotocol/server';
import { MCP_CONFIG_VERSION, type McpConfigFile, type McpServerStatus } from '@maka/core/mcp';
import { McpClientManager } from '../index.js';

const managers: McpClientManager[] = [];
const fixtures: SubscriptionFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager modern tool-list subscriptions', () => {
  test('coalesces an honored notification burst into one bounded trailing refresh', async () => {
    const fixture = await createSubscriptionFixture();
    const manager = createManager();
    const connectedSnapshots: string[][] = [];
    manager.onChange((status) => {
      if (status.state === 'connected') connectedSnapshots.push(toolNames(status));
    });
    await manager.sync(modernConfig(fixture.url));

    fixture.setTools(['middle']);
    const gate = fixture.blockNextToolList();
    fixture.notifyToolsChanged();
    await gate.entered;

    fixture.setTools(['final']);
    for (let index = 0; index < 20; index += 1) fixture.notifyToolsChanged();
    await settleEventLoop();
    gate.release();

    await waitFor(
      () => fixture.toolListCalls === 3 && toolNames(manager.status('remote'))[0] === 'final',
    );

    assert.equal(fixture.toolListCalls, 3);
    assert.deepEqual(connectedSnapshots, [['initial'], ['final']]);
    assert.equal(manager.status('remote')?.error, undefined);
  });

  test('coalesces a change received during initial discovery before publishing connected state', async () => {
    const fixture = await createSubscriptionFixture();
    const initialList = fixture.blockNextToolList();
    const manager = createManager();
    const connectedSnapshots: string[][] = [];
    manager.onChange((status) => {
      if (status.state === 'connected') connectedSnapshots.push(toolNames(status));
    });

    const syncing = manager.sync(modernConfig(fixture.url));
    await initialList.entered;
    await waitFor(() => fixture.subscriptionListeners === 1);
    fixture.setTools(['changed-during-connect']);
    fixture.notifyToolsChanged();
    await settleEventLoop();
    initialList.release();
    await syncing;

    assert.equal(fixture.toolListCalls, 2);
    assert.deepEqual(connectedSnapshots, [['changed-during-connect']]);
    assert.deepEqual(toolNames(manager.status('remote')), ['changed-during-connect']);
  });

  for (const mode of ['missing', 'unhonored', 'rejected'] as const) {
    test(`keeps the connection usable when the subscription acknowledgement is ${mode}`, async () => {
      const fixture = await createSubscriptionFixture({ subscriptionMode: mode });
      const manager = createManager(mode === 'missing' ? 150 : 2_000);

      await manager.sync(modernConfig(fixture.url));

      const status = manager.status('remote');
      assert.equal(status?.state, 'connected');
      assert.deepEqual(status?.negotiatedProtocol, {
        era: 'modern',
        revision: '2026-07-28',
      });
      assert.deepEqual(toolNames(status), ['initial']);
      assert.deepEqual(
        manager.toolSnapshot().tools.map(({ descriptor }) => descriptor.name),
        ['initial'],
      );
      assert.match(status?.error ?? '', /tool-list subscription/u);
      if (mode === 'unhonored') {
        assert.match(status?.error ?? '', /did not honor/u);
      } else {
        assert.match(status?.error ?? '', /unavailable/u);
      }
    });
  }

  test('does not wait for an unhonored subscription cancellation response during setup', async () => {
    const fixture = await createSubscriptionFixture({
      subscriptionMode: 'unhonored',
      hangCancellation: true,
    });
    const manager = createManager();

    try {
      await settlesWithin(manager.sync(modernConfig(fixture.url)));
    } finally {
      fixture.releaseCancellation();
    }

    assert.equal(manager.status('remote')?.state, 'connected');
    assert.match(manager.status('remote')?.error ?? '', /did not honor/u);
  });

  for (const operation of ['disconnect', 'close'] as const) {
    test(`${operation} aborts an unanswered subscription cancellation request`, async () => {
      const fixture = await createSubscriptionFixture({ hangCancellation: true });
      const manager = createManager();
      await manager.sync(modernConfig(fixture.url));

      try {
        await settlesWithin(
          operation === 'disconnect' ? manager.disconnect('remote') : manager.close(),
        );
      } finally {
        fixture.releaseCancellation();
      }

      if (operation === 'disconnect') {
        assert.equal(manager.status('remote')?.state, 'disconnected');
      }
    });
  }

  test('does not attribute a normal tool transport failure to the subscription', async () => {
    const fixture = await createSubscriptionFixture();
    const manager = createManager();
    await manager.sync(modernConfig(fixture.url));
    const tool = manager.toolSnapshot().tools[0];
    assert.ok(tool);

    fixture.failToolCalls(true);
    await assert.rejects(manager.callTool(tool.binding, {}));

    assert.equal(manager.status('remote')?.state, 'connected');
    assert.equal(manager.status('remote')?.error, undefined);
    assert.equal(fixture.subscriptionListeners, 1);

    fixture.failToolCalls(false);
    assert.deepEqual(await manager.callTool(tool.binding, {}), {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: undefined,
    });
    assert.equal(manager.status('remote')?.error, undefined);
  });

  test('keeps subscription and refresh diagnostics in separate lifecycle slots', async () => {
    const fixture = await createSubscriptionFixture();
    const manager = createManager();
    await manager.sync(modernConfig(fixture.url));
    const original = manager.toolSnapshot().tools[0];
    assert.ok(original);
    const snapshotBeforeFailure = manager.toolSnapshot();
    let refreshDiagnosticUpdates = 0;
    const unsubscribe = manager.onChange((status) => {
      if (/tool refresh failed/u.test(status.error ?? '')) refreshDiagnosticUpdates += 1;
    });

    fixture.failToolLists(true);
    fixture.notifyToolsChanged();
    await waitFor(() => /tool refresh failed/u.test(manager.status('remote')?.error ?? ''));
    await settleEventLoop();

    assert.equal(refreshDiagnosticUpdates, 1);
    assert.strictEqual(manager.toolSnapshot(), snapshotBeforeFailure);
    unsubscribe();

    fixture.failToolLists(false);
    await fixture.rotateHandler();
    await waitFor(() =>
      /tool-list subscription closed (?:graceful|remote)/u.test(
        manager.status('remote')?.error ?? '',
      ),
    );

    const degraded = manager.status('remote');
    assert.equal(degraded?.state, 'connected');
    assert.deepEqual(degraded?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    assert.deepEqual(toolNames(degraded), ['initial']);
    assert.equal(manager.toolSnapshot().tools[0]?.binding, original.binding);
    assert.match(degraded?.error ?? '', /tool refresh failed/u);
    assert.match(degraded?.error ?? '', /tool-list subscription closed/u);

    fixture.setTools(['after-recovery']);
    await manager.refreshTools('remote');

    const refreshed = manager.status('remote');
    assert.deepEqual(toolNames(refreshed), ['after-recovery']);
    assert.doesNotMatch(refreshed?.error ?? '', /tool refresh failed/u);
    assert.match(refreshed?.error ?? '', /tool-list subscription closed/u);

    await manager.reconnect('remote');

    const reconnected = manager.status('remote');
    assert.equal(reconnected?.state, 'connected');
    assert.deepEqual(toolNames(reconnected), ['after-recovery']);
    assert.deepEqual(reconnected?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    assert.equal(reconnected?.error, undefined);
  });
});

function createManager(remoteConnectMs = 2_000): McpClientManager {
  const manager = new McpClientManager({
    timeouts: { remoteConnectMs, listToolsMs: 2_000, callToolMs: 2_000 },
  });
  managers.push(manager);
  return manager;
}

function modernConfig(url: string): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      remote: {
        url,
        transport: 'streamable-http',
        protocol: 'auto',
      },
    },
  };
}

function toolNames(status: McpServerStatus | undefined): string[] {
  return status?.tools.map((tool) => tool.name) ?? [];
}

type SubscriptionMode = 'honored' | 'missing' | 'unhonored' | 'rejected';

interface ToolListGate {
  entered: Promise<void>;
  release(): void;
}

interface SubscriptionFixture {
  readonly url: string;
  readonly toolListCalls: number;
  readonly subscriptionListeners: number;
  setTools(names: string[]): void;
  failToolLists(value: boolean): void;
  failToolCalls(value: boolean): void;
  blockNextToolList(): ToolListGate;
  notifyToolsChanged(): void;
  rotateHandler(): Promise<void>;
  releaseCancellation(): void;
  close(): Promise<void>;
}

async function createSubscriptionFixture(
  options: { subscriptionMode?: SubscriptionMode; hangCancellation?: boolean } = {},
): Promise<SubscriptionFixture> {
  const subscriptionMode = options.subscriptionMode ?? 'honored';
  let tools = ['initial'];
  let shouldFailToolLists = false;
  let shouldFailToolCalls = false;
  let toolListCalls = 0;
  let nextToolListGate: InternalGate | undefined;
  const toolListGates = new Set<InternalGate>();
  const rawSubscriptions = new Set<ServerResponse>();
  const handlers = new Set<ReturnType<typeof createMcpHandler>>();
  let releaseCancellation = () => {};
  const cancellationRelease = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });

  const createHandlerGeneration = () => {
    const bus = new InMemoryServerEventBus();
    const handler = createMcpHandler(
      () => {
        const server = new Server(
          { name: 'maka-subscription-fixture', version: '1.0.0' },
          { capabilities: { tools: { listChanged: true } } },
        );
        server.setRequestHandler('tools/list', async () => {
          toolListCalls += 1;
          const result = tools.map((name) => ({
            name,
            inputSchema: { type: 'object' as const },
          }));
          const gate = nextToolListGate;
          nextToolListGate = undefined;
          if (gate) {
            gate.markEntered();
            try {
              await gate.wait;
            } finally {
              toolListGates.delete(gate);
            }
          }
          if (shouldFailToolLists) throw new Error('fixture tool list failed');
          return { tools: result };
        });
        server.setRequestHandler('tools/call', async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }));
        return server;
      },
      {
        legacy: 'reject',
        keepAliveMs: 0,
        bus,
        ...(subscriptionMode === 'rejected' ? { maxSubscriptions: 0 } : {}),
      },
    );
    handlers.add(handler);
    return { bus, handler, nodeHandler: toNodeHandler(handler) };
  };

  let current = createHandlerGeneration();
  const httpServer = createServer(async (req, res) => {
    try {
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readJsonBody(req);
      const method = requestMethod(body);
      if (options.hangCancellation && method === 'notifications/cancelled') {
        await cancellationRelease;
        res.writeHead(204).end();
        return;
      }
      if (shouldFailToolCalls && method === 'tools/call') {
        res
          .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          .end('tool failed upstream');
        return;
      }
      if (
        (subscriptionMode === 'missing' || subscriptionMode === 'unhonored') &&
        method === 'subscriptions/listen'
      ) {
        serveRawSubscription(res, body, subscriptionMode, rawSubscriptions);
        return;
      }
      await current.nodeHandler(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('subscription fixture did not bind');

  const fixture: SubscriptionFixture = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    get toolListCalls() {
      return toolListCalls;
    },
    get subscriptionListeners() {
      return current.bus.listenerCount;
    },
    setTools(names) {
      tools = [...names];
    },
    failToolLists(value) {
      shouldFailToolLists = value;
    },
    failToolCalls(value) {
      shouldFailToolCalls = value;
    },
    blockNextToolList() {
      if (nextToolListGate) throw new Error('a tool-list gate is already pending');
      const gate = createGate();
      toolListGates.add(gate);
      nextToolListGate = gate;
      return { entered: gate.entered, release: gate.release };
    },
    notifyToolsChanged() {
      current.handler.notify.toolsChanged();
    },
    async rotateHandler() {
      const previous = current;
      current = createHandlerGeneration();
      await previous.handler.close();
    },
    releaseCancellation,
    async close() {
      releaseCancellation();
      for (const gate of toolListGates) gate.release();
      toolListGates.clear();
      for (const response of rawSubscriptions) response.end();
      rawSubscriptions.clear();
      await Promise.all([...handlers].map((handler) => handler.close()));
      const closed = new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      httpServer.closeAllConnections();
      await closed;
    },
  };
  fixtures.push(fixture);
  return fixture;
}

interface InternalGate {
  entered: Promise<void>;
  wait: Promise<void>;
  markEntered(): void;
  release(): void;
}

function createGate(): InternalGate {
  let markEntered = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, wait, markEntered, release };
}

function serveRawSubscription(
  response: ServerResponse,
  body: unknown,
  mode: 'missing' | 'unhonored',
  open: Set<ServerResponse>,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  open.add(response);
  response.once('close', () => open.delete(response));
  if (mode === 'missing') {
    response.write(': acknowledgement intentionally withheld\n\n');
    return;
  }
  const id = requestId(body);
  response.write(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: {},
        _meta: { 'io.modelcontextprotocol/subscriptionId': id },
      },
    })}\n\n`,
  );
}

function requestMethod(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('method' in body)) return undefined;
  return typeof body.method === 'string' ? body.method : undefined;
}

function requestId(body: unknown): string | number {
  if (typeof body !== 'object' || body === null || !('id' in body)) {
    throw new Error('subscription request did not include an id');
  }
  if (typeof body.id !== 'string' && typeof body.id !== 'number') {
    throw new Error('subscription request had an invalid id');
  }
  return body.id;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'condition was not met before timeout');
}

async function settleEventLoop(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('subscription lifecycle did not settle')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
