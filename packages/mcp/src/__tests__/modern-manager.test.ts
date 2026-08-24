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
import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, test } from 'node:test';
import { SdkError, SdkErrorCode, type Tool } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, inputRequired, Server } from '@modelcontextprotocol/server';
import {
  MCP_CONFIG_VERSION,
  type McpConfigFile,
  type McpProtocolPreference,
  type McpToolBinding,
} from '@maka/core/mcp';
import { McpClientManager, McpToolCallError } from '../index.js';

const managers: McpClientManager[] = [];
const fixtures: ModernRemoteFixture[] = [];
const HOSTILE_HEADER_PATH = `token=sk-live-secret-token-value\r\n${'x'.repeat(1_000)}`;

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager modern Streamable HTTP E2E', () => {
  test('auto negotiates 2026-07-28 and clears live protocol status on disconnect', async () => {
    const fixture = await createModernRemoteFixture();
    const manager = createManager();

    await manager.sync(modernConfig(fixture.url, 'auto'));

    assert.equal(fixture.protocolMethods[0], 'server/discover');
    assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    assert.equal(manager.status('remote')?.transport, 'streamable-http');
    assert.deepEqual(
      manager.status('remote')?.tools.map((tool) => tool.name),
      ['echo', 'structured', 'needs-input'],
    );

    await manager.disconnect('remote');

    assert.equal(manager.status('remote')?.state, 'disconnected');
    assert.equal(manager.status('remote')?.negotiatedProtocol, undefined);
    assert.deepEqual(manager.status('remote')?.tools, []);
  });

  test('pins the exact 2026-07-28 revision', async () => {
    const fixture = await createModernRemoteFixture();
    const manager = createManager();

    await manager.sync(modernConfig(fixture.url, '2026-07-28'));

    assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    assert.equal(fixture.protocolMethods[0], 'server/discover');
  });

  test('does not issue tools/list when a modern server omits the tools capability', async () => {
    const fixture = await createModernRemoteFixture({ advertiseTools: false });
    let now = 1;
    const manager = createManager({ now: () => now });

    await manager.sync(modernConfig(fixture.url, 'auto'));

    assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    assert.equal(manager.status('remote')?.toolCount, 0);
    assert.deepEqual(manager.toolSnapshot().tools, []);
    assert.equal(fixture.protocolMethods.includes('tools/list'), false);

    now = 2;
    assert.deepEqual(await manager.refreshTools('remote'), []);
    assert.equal(manager.status('remote')?.updatedAt, 2);
    now = 3;
    assert.deepEqual(await manager.refreshTools('remote'), []);
    assert.equal(manager.status('remote')?.updatedAt, 3);
    assert.equal(fixture.protocolMethods.includes('tools/list'), false);
  });

  test('preserves every modern structuredContent JSON shape', async () => {
    const fixture = await createModernRemoteFixture();
    const manager = createManager();
    await manager.sync(modernConfig(fixture.url, 'auto'));
    const binding = bindingFor(manager, 'structured');

    const cases = [
      ['object', { ok: true }],
      ['array', [1, 'two']],
      ['scalar', 'ready'],
      ['null', null],
    ] as const;
    for (const [kind, expected] of cases) {
      const result = await manager.callTool(binding, { kind });
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(result.content, [{ type: 'text', text: kind }]);
    }
  });

  test('surfaces input_required without silently retrying the tool', async () => {
    const fixture = await createModernRemoteFixture();
    const manager = createManager();
    await manager.sync(modernConfig(fixture.url, 'auto'));

    await assert.rejects(
      manager.callTool(bindingFor(manager, 'needs-input'), {}),
      (error: unknown) =>
        error instanceof McpToolCallError &&
        error.serverId === 'remote' &&
        error.toolName === 'needs-input' &&
        SdkError.isInstance(error.cause) &&
        error.cause.code === SdkErrorCode.UnsupportedResultType &&
        /unsupported deferred tool result/u.test(error.message),
    );
    assert.equal(fixture.toolCalls.get('needs-input'), 1);
    assert.equal(fixture.protocolMethods.filter((method) => method === 'tools/call').length, 1);
  });

  test('partitions SEP-2243 definitions and mirrors safe arguments on the wire', async () => {
    const fixture = await createModernRemoteFixture({ includeHeaderTools: true });
    const manager = createManager();

    await manager.sync(modernConfig(fixture.url, 'auto'));

    assert.deepEqual(
      manager
        .toolSnapshot()
        .tools.map(({ descriptor }) => descriptor.name)
        .sort(),
      ['echo', 'header-echo', 'needs-input', 'structured'],
    );
    assert.equal(bindingForOptional(manager, 'invalid-header'), undefined);

    const binding = bindingFor(manager, 'header-echo');
    assert.deepEqual(await manager.callTool(binding, { shard: 42, value: 'safe' }), {
      content: [{ type: 'text', text: 'safe' }],
      structuredContent: undefined,
    });
    assert.equal(fixture.toolCallHeaders.get('header-echo'), '42');
    assert.equal(fixture.toolCalls.get('header-echo'), 1);

    const methodsBeforeUnsafeCall = fixture.protocolMethods.length;
    await assert.rejects(
      manager.callTool(binding, { shard: Number.MAX_SAFE_INTEGER + 1, value: 'unsafe' }),
      (error: unknown) =>
        error instanceof McpToolCallError &&
        error.serverId === 'remote' &&
        error.toolName === 'header-echo' &&
        /unsafe integer argument at shard/u.test(error.message),
    );
    await assert.rejects(
      manager.callTool(binding, { [HOSTILE_HEADER_PATH]: Number.MAX_SAFE_INTEGER + 1 }),
      (error: unknown) =>
        error instanceof McpToolCallError &&
        error.message.length <= 600 &&
        !/[\r\n]|sk-live|secret-token/u.test(error.message),
    );
    assert.equal(fixture.protocolMethods.length, methodsBeforeUnsafeCall);
    assert.equal(fixture.toolCalls.get('header-echo'), 1);
  });
});

function createManager(options: { now?: () => number } = {}): McpClientManager {
  const manager = new McpClientManager({
    ...options,
    timeouts: { remoteConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  managers.push(manager);
  return manager;
}

function bindingFor(manager: McpClientManager, toolName: string): McpToolBinding {
  const binding = bindingForOptional(manager, toolName);
  assert.ok(binding, `missing bound MCP tool remote/${toolName}`);
  return binding;
}

function bindingForOptional(
  manager: McpClientManager,
  toolName: string,
): McpToolBinding | undefined {
  return manager
    .toolSnapshot()
    .tools.find(
      ({ descriptor }) => descriptor.serverId === 'remote' && descriptor.name === toolName,
    )?.binding;
}

function modernConfig(url: string, protocol: McpProtocolPreference): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      remote: {
        url,
        transport: 'streamable-http',
        protocol,
      },
    },
  };
}

interface ModernRemoteFixture {
  url: string;
  protocolMethods: string[];
  toolCalls: Map<string, number>;
  toolCallHeaders: Map<string, string | undefined>;
  close(): Promise<void>;
}

async function createModernRemoteFixture(
  options: { advertiseTools?: boolean; includeHeaderTools?: boolean } = {},
): Promise<ModernRemoteFixture> {
  const advertiseTools = options.advertiseTools !== false;
  const protocolMethods: string[] = [];
  const toolCalls = new Map<string, number>();
  const toolCallHeaders = new Map<string, string | undefined>();
  const errors: Error[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'maka-modern-fixture', version: '1.0.0' },
        { capabilities: advertiseTools ? { tools: {} } : {} },
      );
      if (advertiseTools) {
        server.setRequestHandler('tools/list', async () => {
          const tools: Tool[] = [
            modernTool('echo'),
            modernTool('structured', {}),
            modernTool('needs-input'),
          ];
          if (options.includeHeaderTools) {
            tools.push(
              {
                name: 'header-echo',
                inputSchema: {
                  type: 'object',
                  properties: {
                    shard: { type: 'integer', 'x-mcp-header': 'Shard' },
                    value: { type: 'string' },
                    [HOSTILE_HEADER_PATH]: { type: 'integer', 'x-mcp-header': 'Hostile' },
                  },
                },
              },
              {
                name: 'invalid-header',
                inputSchema: {
                  type: 'object',
                  properties: {
                    ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
                  },
                },
              },
            );
          }
          return { tools };
        });
        server.setRequestHandler('tools/call', async ({ params }) => {
          toolCalls.set(params.name, (toolCalls.get(params.name) ?? 0) + 1);
          const args = params.arguments ?? {};
          if (params.name === 'needs-input') {
            return inputRequired({ requestState: 'awaiting-confirmation' });
          }
          if (params.name === 'structured') {
            const kind = args.kind;
            return {
              content: [{ type: 'text', text: String(kind) }],
              structuredContent:
                kind === 'object'
                  ? { ok: true }
                  : kind === 'array'
                    ? [1, 'two']
                    : kind === 'scalar'
                      ? 'ready'
                      : null,
            };
          }
          return {
            content: [{ type: 'text', text: String(args.value ?? '') }],
          };
        });
      }
      return server;
    },
    {
      legacy: 'reject',
      keepAliveMs: 0,
      onerror: (error) => errors.push(error),
    },
  );
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => errors.push(error) });
  const httpServer = createServer(async (req, res) => {
    try {
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readJsonBody(req);
      const methods = readProtocolMethods(body);
      protocolMethods.push(...methods);
      for (const toolName of readToolCallNames(body)) {
        toolCallHeaders.set(toolName, headerValue(req, 'mcp-param-shard'));
      }
      await nodeHandler(req, res, body);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) res.writeHead(500);
      res.end('modern fixture failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('modern fixture did not bind TCP');
  const fixture: ModernRemoteFixture = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    protocolMethods,
    toolCalls,
    toolCallHeaders,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      assert.deepEqual(errors, []);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function modernTool(name: string, outputSchema?: Record<string, unknown>): Tool {
  return {
    name,
    inputSchema:
      name === 'structured'
        ? {
            type: 'object' as const,
            properties: {
              kind: { enum: ['object', 'array', 'scalar', 'null'] },
            },
            required: ['kind'],
          }
        : { type: 'object' as const },
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
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

function readToolCallNames(body: unknown): string[] {
  return (Array.isArray(body) ? body : [body]).flatMap((message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'method' in message &&
      message.method === 'tools/call' &&
      'params' in message &&
      typeof message.params === 'object' &&
      message.params !== null &&
      'name' in message.params &&
      typeof message.params.name === 'string'
    ) {
      return [message.params.name];
    }
    return [];
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}
