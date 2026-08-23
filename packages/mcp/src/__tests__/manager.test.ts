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
import { fileURLToPath } from 'node:url';
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
import { buildStdioEnvironment, McpClientManager, McpToolCallError } from '../index.js';

const fixturePath = fileURLToPath(new URL('../__fixtures__/stdio-server.js', import.meta.url));
const managers: McpClientManager[] = [];
const remoteFixtures: RemoteFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(remoteFixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager E2E', { concurrency: false }, () => {
  describe('McpClientManager remote transport E2E', () => {
    test('connects with Streamable HTTP and forwards configured headers', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));

      assert.equal(manager.status('remote')?.transport, 'streamable-http');
      assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
        era: 'legacy',
        revision: '2025-11-25',
      });
      assert.doesNotMatch(JSON.stringify(manager.status('remote')), /mcpb1\./u);
      assert.deepEqual(
        await manager.callTool(bindingFor(manager, 'remote', 'echo'), {
          value: 'http',
        }),
        {
          content: [{ type: 'text', text: 'http' }],
          structuredContent: undefined,
        },
      );
      assert.ok(
        fixture.requests.some(
          (request) => request.path === '/mcp' && request.authorization === 'Bearer remote-test',
        ),
      );
      assertLegacyHandshake(fixture);
    });

    test('auto probes before negotiating a legacy Streamable HTTP server', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url, 'streamable-http', 'auto'));

      assert.equal(manager.status('remote')?.state, 'connected');
      assert.deepEqual(manager.status('remote')?.negotiatedProtocol, {
        era: 'legacy',
        revision: '2025-11-25',
      });
      const methods = fixture.requests.flatMap((request) => request.protocolMethods);
      assert.equal(methods[0], 'server/discover');
      assert.ok(methods.indexOf('initialize') > 0);
      assert.ok(methods.indexOf('tools/list') > methods.indexOf('initialize'));
    });

    test('does not downgrade an exact modern pin to a legacy Streamable HTTP server', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url, 'streamable-http', '2026-07-28'));

      assert.equal(manager.status('remote')?.state, 'error');
      assert.equal(manager.status('remote')?.negotiatedProtocol, undefined);
      assert.deepEqual(manager.toolSnapshot().tools, []);
      const methods = fixture.requests.flatMap((request) => request.protocolMethods);
      assert.equal(methods[0], 'server/discover');
      assert.equal(methods.includes('initialize'), false);
    });

    test('strips configured headers when a redirect leaves the endpoint origin', async () => {
      // Undici forwards custom headers (X-API-Key) across cross-origin
      // redirects; the manager's scoped fetch must not.
      const crossOriginSeen: Array<{ authorization?: string; apiKey?: string }> = [];
      const target = createServer((req, res) => {
        crossOriginSeen.push({
          ...(typeof req.headers.authorization === 'string'
            ? { authorization: req.headers.authorization }
            : {}),
          ...(typeof req.headers['x-api-key'] === 'string'
            ? { apiKey: req.headers['x-api-key'] as string }
            : {}),
        });
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      });
      await new Promise<void>((resolve, reject) => {
        target.once('error', reject);
        target.listen(0, '127.0.0.1', resolve);
      });
      const targetAddress = target.address();
      if (!targetAddress || typeof targetAddress === 'string') throw new Error('no target port');
      const redirector = createServer((req, res) => {
        res
          .writeHead(307, { location: `http://127.0.0.1:${targetAddress.port}${req.url ?? '/'}` })
          .end();
      });
      await new Promise<void>((resolve, reject) => {
        redirector.once('error', reject);
        redirector.listen(0, '127.0.0.1', resolve);
      });
      const redirectorAddress = redirector.address();
      if (!redirectorAddress || typeof redirectorAddress === 'string')
        throw new Error('no redirector port');

      try {
        const manager = createManager();
        await manager.sync({
          version: MCP_CONFIG_VERSION,
          mcpServers: {
            remote: {
              url: `http://127.0.0.1:${redirectorAddress.port}/mcp`,
              transport: 'streamable-http',
              headers: { Authorization: 'Bearer remote-test', 'X-API-Key': 'key-123456' },
            },
          },
        });
        assert.equal(manager.status('remote')?.state, 'error');
        assert.ok(crossOriginSeen.length > 0);
        for (const seen of crossOriginSeen) {
          assert.equal(seen.authorization, undefined);
          assert.equal(seen.apiKey, undefined);
        }
      } finally {
        target.closeAllConnections();
        redirector.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => target.close(() => resolve())),
          new Promise<void>((resolve) => redirector.close(() => resolve())),
        ]);
      }
    });

    test('refuses a redirect that downgrades to cleartext http off the machine', async () => {
      const redirector = createServer((_req, res) => {
        res.writeHead(307, { location: 'http://203.0.113.5/mcp' }).end();
      });
      await new Promise<void>((resolve, reject) => {
        redirector.once('error', reject);
        redirector.listen(0, '127.0.0.1', resolve);
      });
      const address = redirector.address();
      if (!address || typeof address === 'string') throw new Error('no redirector port');
      try {
        const manager = createManager();
        await manager.sync({
          version: MCP_CONFIG_VERSION,
          mcpServers: {
            remote: {
              url: `http://127.0.0.1:${address.port}/mcp`,
              transport: 'streamable-http',
              headers: { 'X-API-Key': 'key-123456' },
            },
          },
        });
        assert.equal(manager.status('remote')?.state, 'error');
        assert.match(manager.status('remote')?.error ?? '', /cleartext|https/iu);
      } finally {
        redirector.closeAllConnections();
        await new Promise<void>((resolve) => redirector.close(() => resolve()));
      }
    });

    test('auto falls back to legacy SSE without replacing protocol headers', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));

      assert.equal(manager.status('remote')?.transport, 'sse');
      const result = await manager.callTool(bindingFor(manager, 'remote', 'echo'), {
        value: 'legacy',
      });
      assert.deepEqual(result.content, [{ type: 'text', text: 'legacy' }]);
      const get = fixture.requests.find(
        (request) => request.method === 'GET' && request.path === '/sse',
      );
      assert.equal(get?.authorization, 'Bearer remote-test');
      assert.match(get?.accept ?? '', /text\/event-stream/u);
      assert.ok(
        fixture.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === '/messages' &&
            request.authorization === 'Bearer remote-test',
        ),
      );
      assertLegacyHandshake(fixture);
    });

    test('still sends low-level discovery when a legacy server omits tools capability', async () => {
      const fixture = await createRemoteFixture('streamable-http', {
        advertiseTools: false,
      });
      const manager = createManager();

      await manager.sync(remoteConfig(fixture.url));

      assert.ok(
        fixture.requests.some((request) => request.protocolMethods.includes('tools/list')),
        JSON.stringify({
          status: manager.status('remote'),
          methods: fixture.requests.flatMap((request) => request.protocolMethods),
        }),
      );
    });

    test('bounds and sanitizes connection errors before publishing status', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      fixture.setToolListMode('duplicate');
      const serverId = `remote\r\n\u206a token=sk-live-secret-token-value ${'x'.repeat(10_000)}`;
      const manager = createManager();

      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          [serverId]: { url: fixture.url, transport: 'streamable-http' },
        },
      });

      const error = manager.status(serverId)?.error ?? '';
      assert.match(error, /connection failed/u);
      assert.match(error, /diagnostic omitted/u);
      assert.doesNotMatch(error, /sk-live|secret-token/u);
      assert.doesNotMatch(error, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    });

    test('does not expose hostile HTTP bodies through refresh or reconnect errors', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const hostile = `remote\r\nforged\u2028token=sk-live-secret-token-value ${'x'.repeat(9_000)}`;

      fixture.setHttpFailure('tools/list', hostile);
      await assert.rejects(manager.refreshTools('remote'), isSafeMcpOperationError);
      assert.doesNotMatch(JSON.stringify(manager.status('remote')), /sk-live|forged/u);

      fixture.setHttpFailure('initialize', hostile);
      await assert.rejects(manager.reconnect('remote'), isSafeMcpOperationError);
      const statusError = manager.status('remote')?.error ?? '';
      assert.match(statusError, /connection failed/u);
      assert.doesNotMatch(statusError, /sk-live|forged/u);
      assert.doesNotMatch(statusError, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    });

    test('keeps the previous callable snapshot after an invalid refresh', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const before = manager.status('remote')?.tools;
      const binding = bindingFor(manager, 'remote', 'echo');

      fixture.setToolListMode('duplicate');
      await assert.rejects(manager.refreshTools('remote'), /duplicate tool "echo"/u);

      assert.deepEqual(manager.status('remote')?.tools, before);
      assert.equal(bindingFor(manager, 'remote', 'echo'), binding);
      assert.deepEqual(await manager.callTool(binding, { value: 'still-valid' }), {
        content: [{ type: 'text', text: 'still-valid' }],
        structuredContent: undefined,
      });
    });

    test('publishes one immutable callable snapshot after a real list-changed notification', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      const initial = manager.toolSnapshot();

      assert.equal(Object.isFrozen(initial), true);
      assert.equal(Object.isFrozen(initial.tools), true);
      assert.equal(Object.isFrozen(initial.tools[0]), true);
      assert.equal(Object.isFrozen(initial.tools[0]?.descriptor.inputSchema), true);

      fixture.setToolListMode('replacement');
      await fixture.notifyToolListChanged();
      await waitFor(() => manager.toolSnapshot().tools[0]?.descriptor.name === 'replacement');
      const replacement = manager.toolSnapshot();
      assert.equal(replacement.revision, initial.revision + 1);
      assert.deepEqual(
        replacement.tools.map(({ descriptor }) => descriptor.name),
        ['replacement'],
      );

      fixture.setToolListMode('duplicate');
      await fixture.notifyToolListChanged();
      await waitFor(() => manager.status('remote')?.error?.includes('duplicate tool') === true);
      assert.equal(manager.toolSnapshot(), replacement);
      assert.deepEqual(
        await manager.callTool(replacement.tools[0]!.binding, { value: 'retained' }),
        {
          content: [{ type: 'text', text: 'retained' }],
          structuredContent: undefined,
        },
      );
    });

    test('refreshes for legacy list-changed notifications without an advertised flag', async () => {
      const fixture = await createRemoteFixture('sse', { advertiseToolListChanges: false });
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto', 'legacy'));

      fixture.setToolListMode('replacement');
      await fixture.notifyToolListChanged();
      await waitFor(() => manager.toolSnapshot().tools[0]?.descriptor.name === 'replacement');

      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['replacement'],
      );
    });

    test('routes initial discovery through the refresh owner when list-changed precedes the first response', async () => {
      const fixture = await createRemoteFixture('sse');
      const gate = fixture.holdNextToolList();
      const manager = createManager();
      const publications: Array<{
        state: string;
        statusToolCount: number;
        snapshotToolCount: number;
      }> = [];
      manager.onChange((status) => {
        publications.push({
          state: status.state,
          statusToolCount: status.toolCount,
          snapshotToolCount: manager.toolSnapshot().tools.length,
        });
      });
      const syncPromise = manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      await gate.started;

      // The tool list changes while the first tools/list response is still in
      // flight, and the server answers with the list it captured before the
      // change. Dropping this notification would settle the connection on a
      // snapshot the server already declared stale.
      fixture.setToolListMode('replacement');
      await fixture.notifyToolListChanged();
      gate.release();

      await syncPromise;
      await waitFor(() => manager.toolSnapshot().tools[0]?.descriptor.name === 'replacement');
      assert.deepEqual(
        manager.toolSnapshot().tools.map(({ descriptor }) => descriptor.name),
        ['replacement'],
      );
      // Exactly one follow-up pass through the same single-flight owner: the
      // initial request plus the coalesced re-list the notification joined.
      assert.equal(
        fixture.requests.reduce(
          (count, request) =>
            count + request.protocolMethods.filter((method) => method === 'tools/list').length,
          0,
        ),
        2,
      );
      assert.equal(
        publications.some(
          ({ state, statusToolCount, snapshotToolCount }) =>
            state !== 'connected' && (statusToolCount > 0 || snapshotToolCount > 0),
        ),
        false,
      );
      assert.equal(
        publications.some(
          ({ state, statusToolCount, snapshotToolCount }) =>
            state === 'connected' && statusToolCount === 1 && snapshotToolCount === 1,
        ),
        true,
      );
    });

    test('joins an explicit refresh to initial discovery without queuing another list', async () => {
      const fixture = await createRemoteFixture('sse');
      const gate = fixture.holdNextToolList();
      const manager = createManager();
      const syncPromise = manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      await gate.started;

      const refreshPromise = manager.refreshTools('remote');
      gate.release();

      const [, descriptors] = await Promise.all([syncPromise, refreshPromise]);
      assert.deepEqual(
        descriptors.map(({ name }) => name),
        manager.toolSnapshot().tools.map(({ descriptor }) => descriptor.name),
      );
      assert.equal(countProtocolMethod(fixture, 'tools/list'), 1);
    });

    test('keeps the connection and latest initial snapshot when notifications exhaust the refresh budget', async () => {
      const fixture = await createRemoteFixture('sse');
      fixture.setNotifyBeforeEveryToolListResponse(true);
      const manager = createManager();

      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));

      assert.equal(manager.status('remote')?.state, 'connected');
      assert.equal(countProtocolMethod(fixture, 'tools/list'), 4);
      assert.match(manager.status('remote')?.error ?? '', /changed too frequently/u);
      const binding = bindingFor(manager, 'remote', 'echo');
      assert.deepEqual(await manager.callTool(binding, { value: 'still-callable' }), {
        content: [{ type: 'text', text: 'still-callable' }],
        structuredContent: undefined,
      });
    });

    test('bounds raw Tool definitions without replacing the callable snapshot', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const binding = bindingFor(manager, 'remote', 'echo');

      fixture.setToolListMode('oversized');
      await assert.rejects(manager.refreshTools('remote'), /tool definition exceeds/u);

      assert.equal(bindingFor(manager, 'remote', 'echo'), binding);
      await manager.callTool(binding, { value: 'retained' });
    });

    test('retains a binding for the same canonical definition on one connection', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const before = bindingFor(manager, 'remote', 'echo');
      const beforeSnapshot = manager.toolSnapshot();

      fixture.setToolListMode('reordered');
      await manager.refreshTools('remote');

      assert.equal(bindingFor(manager, 'remote', 'echo'), before);
      assert.equal(manager.toolSnapshot(), beforeSnapshot);
    });

    test('rotates a binding for a raw-only definition change and stale-fails before the wire', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const stale = bindingFor(manager, 'remote', 'echo');
      const publicDescriptor = manager.status('remote')?.tools.find((tool) => tool.name === 'echo');

      fixture.setToolListMode('output-schema-change');
      await manager.refreshTools('remote');
      const current = bindingFor(manager, 'remote', 'echo');
      assert.notEqual(current, stale);
      assert.deepEqual(
        manager.status('remote')?.tools.find((tool) => tool.name === 'echo'),
        publicDescriptor,
      );

      const callsBefore = countProtocolMethod(fixture, 'tools/call');
      await assert.rejects(
        manager.callTool(stale, { value: 'stale' }),
        (error: unknown) =>
          error instanceof McpToolCallError &&
          error.serverId === 'unknown' &&
          error.toolName === 'unknown' &&
          /tool binding is stale/u.test(error.message),
      );
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);

      assert.deepEqual(await manager.callTool(current, { value: 'current' }), {
        content: [{ type: 'text', text: 'current' }],
        structuredContent: { version: 2 },
      });
    });

    test('revokes a removed tool binding before the wire', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const removed = bindingFor(manager, 'remote', 'echo');

      fixture.setToolListMode('replacement');
      await manager.refreshTools('remote');

      const callsBefore = countProtocolMethod(fixture, 'tools/call');
      await assert.rejects(manager.callTool(removed, {}), /tool binding is stale/u);
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
    });

    test('rotates bindings across a replacement connection', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const stale = bindingFor(manager, 'remote', 'echo');

      await manager.reconnect('remote');
      const current = bindingFor(manager, 'remote', 'echo');
      assert.notEqual(current, stale);

      const callsBefore = countProtocolMethod(fixture, 'tools/call');
      await assert.rejects(manager.callTool(stale, {}), /tool binding is stale/u);
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
      await manager.callTool(current, { value: 'reconnected' });
    });

    test('revokes bindings synchronously when disconnect begins', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const stale = bindingFor(manager, 'remote', 'echo');
      const callsBefore = countProtocolMethod(fixture, 'tools/call');

      const disconnecting = manager.disconnect('remote');
      await assert.rejects(manager.callTool(stale, {}), /tool binding is stale/u);
      await assert.rejects(manager.connect('remote'), /server "remote" is closing/u);
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
      await disconnecting;
      assert.equal(manager.status('remote')?.state, 'disconnected');
    });

    test('revokes bindings and refresh authority as soon as close begins', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const stale = bindingFor(manager, 'remote', 'echo');
      const callsBefore = countProtocolMethod(fixture, 'tools/call');

      const closing = manager.close();
      assert.deepEqual(manager.toolSnapshot().tools, []);
      await assert.rejects(manager.callTool(stale, {}), /client manager is closed/u);
      await assert.rejects(manager.refreshTools('remote'), /client manager is closed/u);
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
      await closing;
    });

    test('binds the same tool name independently for each server', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          first: { url: fixture.url, transport: 'streamable-http' },
          second: { url: fixture.url, transport: 'streamable-http' },
        },
      });

      assert.notEqual(bindingFor(manager, 'first', 'echo'), bindingFor(manager, 'second', 'echo'));
    });

    test('keeps a stale candidate private when list-changed arrives before publication', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      const listsBefore = countProtocolMethod(fixture, 'tools/list');
      const retained = manager.toolSnapshot();
      const publishedToolNames: string[][] = [];
      manager.onChange((status) => {
        publishedToolNames.push(status.tools.map((tool) => tool.name));
      });

      fixture.setToolListMode('replacement');
      const gate = fixture.holdNextToolList();
      const refresh = manager.refreshTools('remote');
      await gate.started;
      fixture.setToolListMode('duplicate');
      await fixture.notifyToolListChanged();
      gate.release();

      await assert.rejects(refresh, /duplicate tool/u);
      assert.equal(manager.toolSnapshot(), retained);
      assert.equal(
        publishedToolNames.some((names) => names.includes('replacement')),
        false,
      );
      assert.equal(countProtocolMethod(fixture, 'tools/list') - listsBefore, 2);
    });

    test('starts a fresh list for a refresh queued during snapshot publication', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const listsBefore = countProtocolMethod(fixture, 'tools/list');

      fixture.setToolListMode('replacement');
      let queued: Promise<unknown> | undefined;
      manager.onChange((status) => {
        if (
          status.serverId === 'remote' &&
          status.tools[0]?.name === 'replacement' &&
          queued === undefined
        ) {
          queued = manager.refreshTools('remote');
        }
      });

      await manager.refreshTools('remote');
      await queued;

      assert.equal(countProtocolMethod(fixture, 'tools/list') - listsBefore, 2);
      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['replacement'],
      );
    });

    test('rejects descriptors retired synchronously during snapshot publication', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));

      fixture.setToolListMode('replacement');
      let disconnect: Promise<void> | undefined;
      manager.onChange((status) => {
        if (status.serverId === 'remote' && status.tools[0]?.name === 'replacement') {
          disconnect ??= manager.disconnect('remote');
        }
      });

      await assert.rejects(manager.refreshTools('remote'), /connection changed/u);
      await disconnect;
      assert.equal(manager.status('remote')?.state, 'disconnected');
      assert.deepEqual(manager.toolSnapshot().tools, []);
    });

    test('releases a failed refresh so the next one can publish a replacement', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));

      fixture.setToolListMode('duplicate');
      await assert.rejects(manager.refreshTools('remote'), /duplicate tool/u);

      fixture.setToolListMode('replacement');
      await manager.refreshTools('remote');
      assert.equal(manager.status('remote')?.error, undefined);
      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['replacement'],
      );
    });

    test('bounds response-followed-by-notification rediscovery during initial sync', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      fixture.setNotifyOnEveryToolList(true);

      const sync = manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      assert.equal(await settlesWithin(sync, 1_000), true);
      await sync;
      await waitFor(() => /changed too frequently/u.test(manager.status('remote')?.error ?? ''));

      const binding = bindingFor(manager, 'remote', 'echo');
      assert.equal(countProtocolMethod(fixture, 'tools/list'), 4);
      assert.match(manager.status('remote')?.error ?? '', /changed too frequently/u);
      assert.deepEqual(await manager.callTool(binding, { value: 'still-callable' }), {
        content: [{ type: 'text', text: 'still-callable' }],
        structuredContent: undefined,
      });

      fixture.setNotifyOnEveryToolList(false);
      await manager.refreshTools('remote');
      assert.equal(manager.status('remote')?.error, undefined);
    });

    test('bounds slow response-followed-by-notification rediscovery', async () => {
      const fixture = await createRemoteFixture('sse');
      let now = 0;
      const manager = createManager({ now: () => now });
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      fixture.setToolListResponseClockAdvance(() => {
        now += 1_100;
      });
      fixture.setNotifyOnEveryToolList(true);

      await fixture.notifyToolListChanged();
      await waitFor(
        () => /changed too frequently/u.test(manager.status('remote')?.error ?? ''),
        10_000,
      );

      assert.equal(countProtocolMethod(fixture, 'tools/list') <= 4, true);
      assert.match(manager.status('remote')?.error ?? '', /changed too frequently/u);
    });

    test('publishes the latest valid snapshot before suppressing rediscovery', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      fixture.setToolListMode('replacement');
      fixture.setNotifyOnEveryToolList(true);

      await fixture.notifyToolListChanged();
      await waitFor(() => /changed too frequently/u.test(manager.status('remote')?.error ?? ''));

      assert.equal(countProtocolMethod(fixture, 'tools/list'), 4);
      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['replacement'],
      );
    });

    test('coalesces a burst of legitimate list-changed notifications', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      const gate = fixture.holdNextToolList();
      fixture.setToolListMode('replacement');
      const refresh = manager.refreshTools('remote');
      await gate.started;

      const notifications = [
        fixture.notifyToolListChanged(),
        fixture.notifyToolListChanged(),
        fixture.notifyToolListChanged(),
      ];
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.release();
      await refresh;
      await Promise.all(notifications);

      assert.equal(countProtocolMethod(fixture, 'tools/list'), 3);
      assert.equal(manager.status('remote')?.error, undefined);
      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['replacement'],
      );
    });

    test('gives spaced list-changed notifications independent refresh budgets', async () => {
      const fixture = await createRemoteFixture('sse');
      let now = 0;
      const manager = createManager({ now: () => now });
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));

      for (let change = 1; change <= 4; change += 1) {
        now += 1_000;
        await fixture.notifyToolListChanged();
        await waitFor(() => countProtocolMethod(fixture, 'tools/list') === change + 1);
      }

      assert.equal(manager.status('remote')?.error, undefined);
      assert.equal(countProtocolMethod(fixture, 'tools/list'), 5);
    });

    test('lets configuration removal preempt active notification rediscovery', async () => {
      const fixture = await createRemoteFixture('sse');
      const manager = createManager();
      await manager.sync(remoteConfig(`${fixture.url}/sse`, 'auto'));
      const gate = fixture.holdNextToolList();
      fixture.setNotifyOnEveryToolList(true);
      await fixture.notifyToolListChanged();
      await gate.started;

      const removal = manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} });
      let removedBeforeRelease: boolean;
      try {
        removedBeforeRelease = await settlesWithin(removal, 1_000);
      } finally {
        gate.release();
      }
      await removal;

      assert.equal(removedBeforeRelease, true);
      assert.equal(manager.status('remote'), undefined);
    });

    test('retries when a synchronous diagnostic listener requests another refresh', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const snapshotBefore = manager.toolSnapshot();
      const listsBefore = countProtocolMethod(fixture, 'tools/list');
      let retry: Promise<unknown> | undefined;
      let failureDiagnostics = 0;
      const unsubscribe = manager.onChange((status) => {
        if (status.serverId !== 'remote' || status.state !== 'connected' || !status.error) return;
        failureDiagnostics += 1;
        retry ??= manager.refreshTools('remote');
      });

      fixture.failNextHttpRequest('tools/list', 'temporary list failure');
      const first = manager.refreshTools('remote');
      await first;
      assert.ok(retry);
      await retry;
      unsubscribe();

      assert.equal(countProtocolMethod(fixture, 'tools/list') - listsBefore, 2);
      assert.equal(failureDiagnostics, 1);
      assert.strictEqual(manager.toolSnapshot(), snapshotBefore);
      assert.equal(manager.status('remote')?.error, undefined);
    });

    test('does not leave a connected status after a synchronous listener retires the generation', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      const states: string[] = [];
      let retiring: Promise<void> | undefined;
      const unsubscribe = manager.onChange((status) => {
        if (status.serverId !== 'remote') return;
        states.push(status.state);
        if (status.state === 'connected' && retiring === undefined) {
          retiring = manager.disconnect('remote');
        }
      });

      await manager.sync(remoteConfig(fixture.url));
      unsubscribe();
      await retiring;

      assert.equal(manager.status('remote')?.state, 'disconnected');
      assert.deepEqual(manager.toolSnapshot().tools, []);
      assert.deepEqual(states, ['connecting', 'connected', 'disconnected']);
    });

    test('does not let an old client refresh overwrite a replacement connection', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const stale = bindingFor(manager, 'remote', 'echo');
      const gate = fixture.holdNextToolList();
      fixture.setToolListMode('replacement');
      const refresh = manager.refreshTools('remote');
      void refresh.catch(() => {});
      await gate.started;

      fixture.setToolListMode('valid');
      const reconnect = manager.reconnect('remote');
      let reconnectedBeforeRelease: boolean;
      try {
        reconnectedBeforeRelease = await settlesWithin(reconnect, 1_000);
      } finally {
        gate.release();
      }
      await reconnect;

      assert.equal(reconnectedBeforeRelease, true);
      await assert.rejects(refresh, (error: unknown) => {
        assert.match(String(error), /connection changed during tool refresh/u);
        assert.doesNotMatch(String(error), /undefined/u);
        return true;
      });
      assert.deepEqual(
        manager.status('remote')?.tools.map((tool) => tool.name),
        ['echo', 'invalid-output'],
      );
      assert.notEqual(bindingFor(manager, 'remote', 'echo'), stale);
    });

    test('uses the validated Tool definition for output checks', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const callsBefore = countProtocolMethod(fixture, 'tools/call');

      await assert.rejects(
        manager.callTool(bindingFor(manager, 'remote', 'invalid-output'), {}),
        (error: unknown) =>
          error instanceof McpToolCallError && /invalid tool result/u.test(error.message),
      );
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore + 1);
    });

    test('classifies decoded deferred markers before output-schema validation', async () => {
      const unsupportedResults = [
        { content: [], toolResult: { legacy: true } },
        {
          content: [],
          task: {
            taskId: 'legacy-task-with-output',
            status: 'working',
            ttl: null,
            createdAt: '2026-07-30T00:00:00Z',
            lastUpdatedAt: '2026-07-30T00:00:00Z',
          },
        },
        { content: [], inputRequests: {} },
        { content: [], requestState: 'input-required' },
      ];

      for (const legacyToolCallResult of unsupportedResults) {
        const fixture = await createRemoteFixture('streamable-http', {
          advertiseTools: false,
          legacyToolCallResult,
        });
        const manager = createManager();
        await manager.sync(remoteConfig(fixture.url));
        const callsBefore = countProtocolMethod(fixture, 'tools/call');

        await assert.rejects(
          manager.callTool(bindingFor(manager, 'remote', 'invalid-output'), {}),
          /unsupported deferred tool result/u,
        );
        assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore + 1);
      }
    });

    test('rejects a malformed output schema before invoking the Tool', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      fixture.setToolListMode('invalid-output-schema');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const callsBefore = countProtocolMethod(fixture, 'tools/call');

      await assert.rejects(
        manager.callTool(bindingFor(manager, 'remote', 'invalid-schema'), {}),
        /invalid output schema/u,
      );
      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
    });

    test('requires structured output only for successful output-schema calls', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const binding = bindingFor(manager, 'remote', 'invalid-output');

      await assert.rejects(manager.callTool(binding, { mode: 'missing' }), /invalid tool result/u);
      await assert.rejects(
        manager.callTool(binding, { mode: 'is-error' }),
        /deliberate output failure/u,
      );
      await assert.rejects(
        manager.callTool(binding, { mode: 'oversized-error' }),
        /oversized error content/u,
      );
      await assert.rejects(
        manager.callTool(binding, { mode: 'too-many-error-blocks' }),
        /oversized error content/u,
      );
    });

    test('rejects an invalid binding before the wire', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const callsBefore = countProtocolMethod(fixture, 'tools/call');

      await assert.rejects(
        manager.callTool('not-a-binding' as McpToolBinding, {}),
        (error: unknown) =>
          error instanceof McpToolCallError && /tool binding is invalid/u.test(error.message),
      );

      assert.equal(countProtocolMethod(fixture, 'tools/call'), callsBefore);
    });

    test('a failed tool call rejects with a sanitized cause, never the raw chain', async () => {
      // The scrubbed message is only half the boundary: the normalized
      // error's cause retains the RAW transport error, and an endpoint that
      // reflects the Authorization header into an HTTP failure would leak
      // it to any cause-aware logger or serializer past the manager. The
      // retained cause keeps its typed identity but loses the raw text and
      // the deeper chain.
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      await manager.sync(remoteConfig(fixture.url));
      const aborted = new AbortController();
      const reflected = new Error('carrier: Bearer remote-test', {
        cause: new Error('deeper: Bearer remote-test'),
      });
      aborted.abort(reflected);

      let rejection: unknown;
      try {
        await manager.callTool(
          bindingFor(manager, 'remote', 'echo'),
          { value: 'x' },
          {
            signal: aborted.signal,
          },
        );
      } catch (error) {
        rejection = error;
      }

      assert.ok(rejection instanceof McpToolCallError);
      assert.doesNotMatch(String((rejection as Error).message), /remote-test/u);
      const cause = (rejection as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.notEqual(cause, reflected);
      assert.doesNotMatch(cause.message, /remote-test/u);
      assert.equal((cause as Error & { cause?: unknown }).cause, undefined);
    });
  });

  describe('McpClientManager stdio E2E', () => {
    test('discovers paginated tools and calls structured content', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig());

      const status = manager.status('fixture');
      assert.equal(status?.state, 'connected');
      assert.equal(status?.transport, 'stdio');
      assert.deepEqual(
        status?.tools.map((tool) => tool.name),
        ['echo', 'rich', 'fail', 'slow'],
      );
      assert.equal(status?.tools[0]?.annotations?.readOnlyHint, true);

      const echo = await manager.callTool(bindingFor(manager, 'fixture', 'echo'), {
        value: 'Maka',
      });
      assert.deepEqual(echo.content, [{ type: 'text', text: 'Maka' }]);
      assert.deepEqual(echo.structuredContent, { echoed: 'Maka' });

      const rich = await manager.callTool(bindingFor(manager, 'fixture', 'rich'), {});
      assert.deepEqual(
        rich.content.map((block) => block.type),
        ['text', 'image', 'audio', 'resource', 'resource_link'],
      );
    });

    test('maps protocol isError to the Maka error path', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig());
      await assert.rejects(
        manager.callTool(bindingFor(manager, 'fixture', 'fail'), {}),
        (error: unknown) =>
          error instanceof McpToolCallError && /deliberate failure/u.test(error.message),
      );
    });

    test('a tool error echoing a configured env secret is scrubbed', async () => {
      const manager = createManager();
      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixturePath],
            env: { FIXTURE_LEAK_TOKEN: 'env-secret-value' },
          },
        },
      });
      await assert.rejects(
        manager.callTool(bindingFor(manager, 'fixture', 'fail'), {}),
        (error: unknown) => {
          assert.ok(error instanceof McpToolCallError);
          assert.doesNotMatch(error.message, /env-secret-value/u);
          assert.match(error.message, /\[redacted\]/u);
          return true;
        },
      );
    });

    test('a short sensitive env value is withheld wholesale from tool errors', async () => {
      const manager = createManager();
      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixturePath],
            // A 3-character credential cannot be spliced out; the key names
            // it as a secret, so the whole echoing message must be withheld.
            env: { FIXTURE_LEAK_TOKEN: 'k7#' },
          },
        },
      });
      await assert.rejects(
        manager.callTool(bindingFor(manager, 'fixture', 'fail'), {}),
        (error: unknown) => {
          assert.ok(error instanceof McpToolCallError);
          assert.doesNotMatch(error.message, /k7#/u);
          assert.match(error.message, /withheld/u);
          return true;
        },
      );
    });

    test('propagates caller abort to an in-flight tool call', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig());
      const controller = new AbortController();
      const call = manager.callTool(
        bindingFor(manager, 'fixture', 'slow'),
        {},
        {
          signal: controller.signal,
        },
      );
      controller.abort();
      await assert.rejects(call, /abort|cancel/iu);
    });

    test('enforces the configured tool call timeout', async () => {
      const manager = new McpClientManager({
        timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 25 },
      });
      managers.push(manager);
      await manager.sync(fixtureConfig());
      await assert.rejects(
        manager.callTool(bindingFor(manager, 'fixture', 'slow'), {}),
        /timed out|timeout/iu,
      );
    });

    test('captures bounded stderr diagnostics when stdio startup fails', async () => {
      const manager = createManager();
      const config = fixtureConfig(['--crash']);
      await manager.sync(config);
      const status = manager.status('fixture');
      assert.equal(status?.state, 'error');
      assert.match(status?.error ?? '', /fixture startup failed/u);
      assert.deepEqual(status?.stderrTail, ['fixture startup failed: deliberate diagnostic']);
    });

    test('excludes credential keys case-insensitively from a real stdio child', async () => {
      const key = 'XDG_MAKA_PROVIDER_CREDENTIAL';
      const previous = process.env[key];
      process.env[key] = 'provider-secret';
      const manager = new McpClientManager({
        excludedStdioEnvironmentKeys: ['xdg_maka_provider_credential'],
      });
      managers.push(manager);
      try {
        await manager.sync(fixtureConfig(['--environment']));
        const result = await manager.callTool(bindingFor(manager, 'fixture', 'environment'), {
          names: [key],
        });
        assert.deepEqual(
          JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : ''),
          { [key]: null },
        );
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    });

    test('cancels an in-flight installation connect without leaving tools visible', async () => {
      const manager = createManager();
      const sync = manager.sync(fixtureConfig(['--slow-start']));
      await waitFor(() => manager.status('fixture')?.state === 'connecting');
      assert.equal(manager.cancelConnect('fixture'), true);
      await sync;
      await manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} });
      assert.equal(manager.status('fixture'), undefined);
      assert.deepEqual(manager.toolSnapshot().tools, []);
    });

    test('cancels installation after remote tool discovery starts', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      const gate = fixture.holdNextToolList();
      const sync = manager.sync(remoteConfig(fixture.url));
      await gate.started;

      assert.equal(manager.status('remote')?.state, 'connecting');
      assert.equal(manager.cancelConnect('remote'), true);
      let settledBeforeRelease: boolean;
      try {
        settledBeforeRelease = await settlesWithin(sync, 500);
      } finally {
        gate.release();
      }
      await sync;

      assert.equal(settledBeforeRelease, true);
      assert.equal(manager.status('remote')?.state, 'disconnected');
      assert.deepEqual(manager.toolSnapshot().tools, []);
    });

    test('does not report a cancellable connect after connected status is published', async () => {
      const fixture = await createRemoteFixture('streamable-http');
      const manager = createManager();
      let cancelResult: boolean | undefined;
      manager.onChange((status) => {
        if (status.serverId === 'remote' && status.state === 'connected') {
          cancelResult = manager.cancelConnect('remote');
        }
      });

      await manager.sync(remoteConfig(fixture.url));

      assert.equal(cancelResult, false);
      assert.equal(manager.status('remote')?.state, 'connected');
      assert.equal(manager.toolSnapshot().tools.length > 0, true);
    });

    test('close aborts an in-flight connection before it can publish tools', async () => {
      const manager = createManager();
      const sync = manager.sync(fixtureConfig(['--slow-start']));
      await waitFor(() => manager.status('fixture')?.state === 'connecting');

      const closing = manager.close();
      assert.deepEqual(manager.toolSnapshot().tools, []);
      await Promise.all([sync, closing]);

      assert.equal(manager.status('fixture'), undefined);
      assert.deepEqual(manager.toolSnapshot().tools, []);
    });

    test('captures and redacts a final stderr fragment without a newline', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig(['--crash-secret-tail']));
      const status = manager.status('fixture');
      assert.equal(status?.state, 'error');
      assert.deepEqual(status?.stderrTail, ['token=[redacted]']);
      assert.doesNotMatch(status?.error ?? '', /sk-live/u);
    });

    test('redacts across stream chunks and discards oversized physical stderr lines', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig(['--crash-hostile-stderr']));
      const status = manager.status('fixture');
      const tail = status?.stderrTail ?? [];

      assert.equal(status?.state, 'error');
      assert.equal(tail.length, 6);
      assert.equal(tail[1], '[stderr line omitted: exceeds diagnostic limit]');
      assert.equal(tail[2], 'after\uFFFDline');
      assert.equal(tail[3], 'sk-live-\uFFFD12345678');
      assert.deepEqual(tail.slice(4), [
        '[stderr continuation omitted]',
        '[stderr continuation omitted]',
      ]);
      assert.ok([...tail[0]].length <= 2_000);
      assert.doesNotMatch(
        tail.join(''),
        /sk-live-secret-token-value|sk-live-12345678|environment-secret|continued-secret/u,
      );
      assert.doesNotMatch(tail.join(''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    });

    test('publishes a stderr chunk once instead of once per physical line', async () => {
      const manager = createManager();
      let updatesWithStderr = 0;
      manager.onChange((status) => {
        if (status.stderrTail?.length) updatesWithStderr += 1;
      });

      await manager.sync(fixtureConfig(['--crash-many-stderr-lines']));

      assert.deepEqual(manager.status('fixture')?.stderrTail, Array<string>(10).fill('x'));
      assert.ok(updatesWithStderr <= 5, `received ${updatesWithStderr} stderr-bearing updates`);
    });

    test('reconciles disable and removal without leaving tools visible', async () => {
      const manager = createManager();
      await manager.sync(fixtureConfig());
      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          fixture: { ...fixtureConfig().mcpServers.fixture, enabled: false },
        },
      });
      assert.equal(manager.status('fixture')?.state, 'disabled');
      assert.deepEqual(manager.toolSnapshot().tools, []);
      assert.equal((await manager.test('fixture')).ok, false);
      await manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} });
      assert.equal(manager.status('fixture'), undefined);
    });
  });
});

test('buildStdioEnvironment uses an allowlist and explicit values override it', () => {
  assert.deepEqual(
    buildStdioEnvironment(
      { API_TOKEN: 'explicit', PATH: '/custom' },
      {
        PATH: '/bin',
        HOME: '/home/u',
        AWS_SECRET_ACCESS_KEY: 'leak',
        LC_ALL: 'C',
        XDG_CONFIG_HOME: '/x',
      },
    ),
    {
      PATH: '/custom',
      HOME: '/home/u',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/x',
      API_TOKEN: 'explicit',
    },
  );
});

function createManager(
  options: ConstructorParameters<typeof McpClientManager>[0] = {},
): McpClientManager {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
    ...options,
  });
  managers.push(manager);
  return manager;
}

function bindingFor(manager: McpClientManager, serverId: string, toolName: string): McpToolBinding {
  const match = manager
    .toolSnapshot()
    .tools.find(
      ({ descriptor }) => descriptor.serverId === serverId && descriptor.name === toolName,
    );
  assert.ok(match, `missing bound MCP tool ${serverId}/${toolName}`);
  return match.binding;
}

function fixtureConfig(extraArgs: string[] = []): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath, ...extraArgs],
      },
    },
  };
}

function remoteConfig(
  url: string,
  transport: 'auto' | 'streamable-http' = 'streamable-http',
  protocol?: McpProtocolPreference,
): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      remote: {
        url,
        transport,
        ...(protocol === undefined ? {} : { protocol }),
        headers: { Authorization: 'Bearer remote-test' },
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RemoteRequest {
  method: string;
  path: string;
  protocolMethods: string[];
  authorization?: string;
  accept?: string;
}

interface RemoteFixture {
  url: string;
  requests: RemoteRequest[];
  setToolListMode(mode: ToolListMode): void;
  setHttpFailure(method: string, body: string): void;
  failNextHttpRequest(method: string, body: string): void;
  holdNextToolList(): { started: Promise<void>; release(): void };
  setNotifyBeforeEveryToolListResponse(enabled: boolean): void;
  setNotifyOnEveryToolList(enabled: boolean): void;
  setToolListClockAdvance(advance: () => void): void;
  setToolListResponseClockAdvance(advance: () => void): void;
  notifyToolListChanged(): Promise<void>;
  close(): Promise<void>;
}

type ToolListMode =
  | 'valid'
  | 'duplicate'
  | 'replacement'
  | 'reordered'
  | 'output-schema-change'
  | 'invalid-output-schema'
  | 'oversized';

async function createRemoteFixture(
  kind: 'streamable-http' | 'sse',
  options: {
    advertiseTools?: boolean;
    advertiseToolListChanges?: boolean;
    legacyToolCallResult?: unknown;
  } = {},
): Promise<RemoteFixture> {
  const requests: RemoteRequest[] = [];
  let toolListMode: ToolListMode = 'valid';
  let httpFailure: { method: string; body: string } | undefined;
  let nextHttpFailure: { method: string; body: string } | undefined;
  let nextToolListGate: InternalToolListGate | undefined;
  let notifyBeforeEveryToolListResponse = false;
  let notifyOnEveryToolList = false;
  let toolListClockAdvance = () => {};
  let toolListResponseClockAdvance = () => {};
  const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const beforeToolList = async () => {
    toolListClockAdvance();
    const gate = nextToolListGate;
    if (!gate) return;
    nextToolListGate = undefined;
    gate.markStarted();
    await gate.waitForRelease;
  };
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const request: RemoteRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      protocolMethods: [],
      ...(typeof req.headers.authorization === 'string'
        ? { authorization: req.headers.authorization }
        : {}),
      ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
    };
    requests.push(request);
    try {
      if (kind === 'streamable-http' && url.pathname === '/mcp' && req.method === 'POST') {
        const body = await readJsonBody(req);
        request.protocolMethods.push(...readProtocolMethods(body));
        const oneShotFailure = nextHttpFailure;
        if (
          oneShotFailure &&
          request.protocolMethods.some((method) => method === oneShotFailure.method)
        ) {
          nextHttpFailure = undefined;
          res
            .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            .end(oneShotFailure.body);
          return;
        }
        if (
          httpFailure &&
          request.protocolMethods.some((method) => method === httpFailure?.method)
        ) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(httpFailure.body);
          return;
        }
        if (options.advertiseTools === false) {
          handleCapabilityOmittingLegacyRequest(
            res,
            body,
            Object.hasOwn(options, 'legacyToolCallResult')
              ? options.legacyToolCallResult
              : undefined,
          );
          return;
        }
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = createProtocolServer({
          advertiseTools: true,
          toolListMode: () => toolListMode,
          beforeToolList,
          afterToolList: () => toolListResponseClockAdvance(),
          notifyBeforeEveryToolListResponse: () => notifyBeforeEveryToolListResponse,
          notifyOnEveryToolList: () => notifyOnEveryToolList,
        });
        await server.connect(transport);
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, body);
        return;
      }
      if (kind === 'sse' && url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        const server = createProtocolServer({
          advertiseTools: options.advertiseTools !== false,
          advertiseToolListChanges: options.advertiseToolListChanges !== false,
          toolListMode: () => toolListMode,
          beforeToolList,
          afterToolList: () => toolListResponseClockAdvance(),
          notifyBeforeEveryToolListResponse: () => notifyBeforeEveryToolListResponse,
          notifyOnEveryToolList: () => notifyOnEveryToolList,
        });
        sseTransports.set(transport.sessionId, { transport, server });
        res.once('close', () => sseTransports.delete(transport.sessionId));
        await server.connect(transport);
        return;
      }
      if (kind === 'sse' && url.pathname === '/messages' && req.method === 'POST') {
        const body = await readJsonBody(req);
        request.protocolMethods.push(...readProtocolMethods(body));
        const entry = sseTransports.get(url.searchParams.get('sessionId') ?? '');
        if (!entry) {
          res.writeHead(400).end('unknown SSE session');
          return;
        }
        await entry.transport.handlePostMessage(req, res, body);
        return;
      }
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'not found' }));
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
  if (!address || typeof address === 'string') throw new Error('remote fixture did not bind TCP');
  const fixture: RemoteFixture = {
    url: `http://127.0.0.1:${address.port}${kind === 'streamable-http' ? '/mcp' : ''}`,
    requests,
    setToolListMode: (mode) => {
      toolListMode = mode;
    },
    setHttpFailure: (method, body) => {
      httpFailure = { method, body };
    },
    failNextHttpRequest: (method, body) => {
      nextHttpFailure = { method, body };
    },
    holdNextToolList: () => {
      if (nextToolListGate) throw new Error('a tools/list gate is already pending');
      let markStarted = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextToolListGate = { markStarted, waitForRelease };
      return { started, release };
    },
    setNotifyBeforeEveryToolListResponse: (enabled) => {
      notifyBeforeEveryToolListResponse = enabled;
    },
    setNotifyOnEveryToolList: (enabled) => {
      notifyOnEveryToolList = enabled;
    },
    setToolListClockAdvance: (advance) => {
      toolListClockAdvance = advance;
    },
    setToolListResponseClockAdvance: (advance) => {
      toolListResponseClockAdvance = advance;
    },
    notifyToolListChanged: async () => {
      const servers = [...sseTransports.values()].map(({ server }) => server);
      if (servers.length === 0) throw new Error('no persistent MCP server is connected');
      await Promise.all(servers.map((server) => server.sendToolListChanged()));
    },
    close: async () => {
      await Promise.all(
        [...sseTransports.values()].map(async ({ transport, server }) => {
          await transport.close().catch(() => {});
          await server.close().catch(() => {});
        }),
      );
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  remoteFixtures.push(fixture);
  return fixture;
}

function createProtocolServer(options: {
  advertiseTools: boolean;
  advertiseToolListChanges?: boolean;
  toolListMode: () => ToolListMode;
  beforeToolList: () => Promise<void>;
  afterToolList: () => void;
  notifyBeforeEveryToolListResponse: () => boolean;
  notifyOnEveryToolList: () => boolean;
}): McpServer {
  const server = new McpServer(
    { name: 'maka-remote-fixture', version: '1.0.0' },
    {
      capabilities: options.advertiseTools
        ? { tools: options.advertiseToolListChanges === false ? {} : { listChanged: true } }
        : {},
    },
  );
  server.setRequestHandler('tools/list', async () => {
    const mode = options.toolListMode();
    await options.beforeToolList();
    const result = {
      tools:
        mode === 'duplicate'
          ? [remoteToolDefinition('echo'), remoteToolDefinition('echo')]
          : mode === 'replacement'
            ? [remoteToolDefinition('replacement')]
            : mode === 'reordered'
              ? [reorderedRemoteEchoDefinition(), remoteToolDefinition('invalid-output')]
              : mode === 'output-schema-change'
                ? [
                    remoteToolDefinition('echo', {
                      type: 'object',
                      properties: { version: { type: 'number' } },
                      required: ['version'],
                    }),
                    remoteToolDefinition('invalid-output'),
                  ]
                : mode === 'oversized'
                  ? [
                      {
                        ...remoteToolDefinition('echo'),
                        description: 'x'.repeat(1_048_577),
                      },
                    ]
                  : mode === 'invalid-output-schema'
                    ? [
                        {
                          name: 'invalid-schema',
                          inputSchema: { type: 'object' as const },
                          outputSchema: { type: 'string' as const, pattern: '[' },
                        },
                      ]
                    : [remoteToolDefinition('echo'), remoteToolDefinition('invalid-output')],
    };
    options.afterToolList();
    if (options.notifyBeforeEveryToolListResponse()) {
      await server.sendToolListChanged();
    }
    if (options.notifyOnEveryToolList()) {
      setTimeout(() => {
        void server.sendToolListChanged().catch(() => {});
      }, 5);
    }
    return result;
  });
  server.setRequestHandler('tools/call', async ({ params }) => {
    const args = params.arguments ?? {};
    if (params.name === 'invalid-output') {
      if (args.mode === 'missing') {
        return { content: [{ type: 'text', text: 'missing structured output' }] };
      }
      if (args.mode === 'is-error') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'deliberate output failure' }],
        };
      }
      if (args.mode === 'oversized-error') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'x'.repeat(9_000) }],
        };
      }
      if (args.mode === 'too-many-error-blocks') {
        return {
          isError: true,
          content: Array.from({ length: 101 }, () => ({ type: 'text' as const, text: 'x' })),
        };
      }
      return {
        content: [{ type: 'text', text: 'invalid' }],
        structuredContent: { wrong: true },
      };
    }
    return {
      content: [{ type: 'text', text: String(args.value ?? '') }],
      ...(params.name === 'echo' && options.toolListMode() === 'output-schema-change'
        ? { structuredContent: { version: 2 } }
        : Object.hasOwn(args, 'structuredContent')
          ? { structuredContent: args.structuredContent }
          : {}),
    };
  });
  return server;
}

interface InternalToolListGate {
  markStarted(): void;
  waitForRelease: Promise<void>;
}

function remoteToolDefinition(
  name: string,
  outputSchema?: {
    type: 'object';
    properties: Record<string, { type: string }>;
    required: string[];
  },
) {
  return {
    name,
    description: name === 'echo' ? 'Echo text' : 'Return invalid structured output',
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string' } },
    },
    ...(outputSchema
      ? { outputSchema }
      : name === 'invalid-output'
        ? {
            outputSchema: {
              type: 'object' as const,
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          }
        : {}),
  };
}

function reorderedRemoteEchoDefinition() {
  return {
    inputSchema: {
      properties: { value: { type: 'string' } },
      type: 'object' as const,
    },
    description: 'Echo text',
    name: 'echo',
  };
}

function handleCapabilityOmittingLegacyRequest(
  res: ServerResponse,
  body: unknown,
  toolCallResult?: unknown,
): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.writeHead(400).end('invalid JSON-RPC request');
    return;
  }
  const id = 'id' in body ? body.id : undefined;
  const method = 'method' in body && typeof body.method === 'string' ? body.method : undefined;
  if (method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }
  const result =
    method === 'initialize'
      ? {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'capability-omitting-fixture', version: '1.0.0' },
        }
      : method === 'tools/list'
        ? {
            tools: [remoteToolDefinition('echo'), remoteToolDefinition('invalid-output')],
          }
        : method === 'tools/call' && toolCallResult !== undefined
          ? toolCallResult
          : undefined;
  if (result === undefined) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method not found' },
      }),
    );
    return;
  }
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function assertLegacyHandshake(fixture: RemoteFixture): void {
  const methods = fixture.requests.flatMap((request) => request.protocolMethods);
  assert.equal(methods[0], 'initialize');
  assert.equal(methods.includes('server/discover'), false);
}

function countProtocolMethod(fixture: RemoteFixture, method: string): number {
  return fixture.requests
    .flatMap((request) => request.protocolMethods)
    .filter((candidate) => candidate === method).length;
}

function isSafeMcpOperationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.length <= 2_000 &&
    /MCP server/u.test(error.message) &&
    !/sk-live|secret-token|forged/u.test(error.message) &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message)
  );
}

function readProtocolMethods(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
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
