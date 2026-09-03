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
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { McpClientManager } from '@maka/mcp';
import { buildMcpTools } from '@maka/runtime/mcp-tools';
import { decodeClientCapabilityReplaceInput } from '@maka/runtime-host/protocol';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';

const fixturePath = fileURLToPath(new URL('../../../../../packages/mcp/dist/__fixtures__/stdio-server.js', import.meta.url));

test('MCP tools stay bound to the connection generation that advertised them', async () => {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  try {
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixturePath, '--schema-annotations'],
        },
      },
    });
    const tools = buildMcpTools(manager);
    assert.deepEqual(tools.map((tool) => tool.name), [
      'mcp__fixture__annotated',
      'mcp__fixture__echo',
    ]);
    const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
    assert.ok(echo);
    assert.equal(echo.categoryHint, 'network_send');

    const provider = createDesktopNativeCapabilityProvider({
      browserTools: [],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: [] as never,
      releaseComputerUseSession() {},
      additionalGroups: () => [
        {
          offerId: 'desktop_mcp',
          label: 'MCP',
          description: 'MCP tools connected by this Desktop client.',
          tools,
          omitUnsupportedTools: true,
        },
      ],
    });
    assert.doesNotThrow(() =>
      decodeClientCapabilityReplaceInput({
        registrationId: 'registration-1',
        offers: provider.offers(),
      }),
    );
    assert.deepEqual(provider.offers()[0]?.tools[0]?.inputSchema, {
      type: 'object',
      properties: { value: { type: 'string' } },
    });
    assert.deepEqual(provider.offers()[0]?.tools.map((tool) => tool.name), [
      'mcp__fixture__echo',
    ]);
    if (!provider.call) throw new Error('Expected a callable Desktop capability provider');
    assert.throws(
      () => provider.call!(
        {
          kind: 'client.capability.call',
          invocationId: 'incompatible-invocation',
          registrationId: 'registration-1',
          offerId: 'desktop_mcp',
          serverId: 'desktop_mcp',
          toolName: 'mcp__fixture__annotated',
          arguments: {},
          sessionId: 'session',
          turnId: 'turn',
          toolCallId: 'incompatible-capability-call',
          cwd: process.cwd(),
        },
        {
          signal: new AbortController().signal,
          accept: async () => undefined,
        },
      ),
      /not offered/u,
    );
    let admissionEvidence: unknown;
    assert.deepEqual(
      await provider.call(
        {
          kind: 'client.capability.call',
          invocationId: 'invocation-1',
          registrationId: 'registration-1',
          offerId: 'desktop_mcp',
          serverId: 'desktop_mcp',
          toolName: 'mcp__fixture__echo',
          arguments: { value: 'desktop-capability' },
          sessionId: 'session',
          turnId: 'turn',
          toolCallId: 'capability-call',
          cwd: process.cwd(),
        },
        {
          signal: new AbortController().signal,
          accept: async (evidence) => {
            admissionEvidence = evidence;
          },
        },
      ),
      {
        content: [
          { type: 'text', text: 'desktop-capability' },
          { type: 'text', text: '{"structuredContent":{"echoed":"desktop-capability"}}' },
        ],
      },
    );
    // The Host managed admission policy for desktop_mcp requires this contract.
    assert.deepEqual(admissionEvidence, { kind: 'none' });

    const result = await echo.impl({ value: 'runtime-e2e' }, {
      sessionId: 'session', turnId: 'turn', cwd: process.cwd(), toolCallId: 'call',
      abortSignal: new AbortController().signal, emitOutput() {},
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'runtime-e2e' }],
      structuredContent: { echoed: 'runtime-e2e' },
    });

    const firstRevision = manager.toolSnapshot().revision;
    await manager.reconnect('fixture');
    assert.ok(manager.toolSnapshot().revision > firstRevision);
    await assert.rejects(
      async () =>
        echo.impl(
          { value: 'stale-generation' },
          {
            sessionId: 'session',
            turnId: 'turn',
            cwd: process.cwd(),
            toolCallId: 'stale-call',
            abortSignal: new AbortController().signal,
            emitOutput() {},
          },
        ),
      /tool binding is stale/u,
    );

    const replacement = buildMcpTools(manager).find(
      (tool) => tool.name === 'mcp__fixture__echo',
    );
    assert.ok(replacement);
    assert.deepEqual(
      await replacement.impl(
        { value: 'replacement-generation' },
        {
          sessionId: 'session',
          turnId: 'turn',
          cwd: process.cwd(),
          toolCallId: 'replacement-call',
          abortSignal: new AbortController().signal,
          emitOutput() {},
        },
      ),
      {
        content: [{ type: 'text', text: 'replacement-generation' }],
        structuredContent: { echoed: 'replacement-generation' },
      },
    );
  } finally {
    await manager.close();
  }
});
