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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { McpToolBinding } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import { createMcpCapabilityProvider as createPureMcpCapabilityProvider } from '../mcp-capability-provider.js';
import {
  createMcpCapabilityProvider,
  formatRuntimeHostCapabilityProviderReadyMessage,
} from '../runtime-host-capability-provider-command.js';

test('TUI MCP control keeps its capability provider on the pure import boundary', async () => {
  const [tuiSource, providerSource] = await Promise.all([
    readFile(new URL('../tui-mcp-control.js', import.meta.url), 'utf8'),
    readFile(new URL('../mcp-capability-provider.js', import.meta.url), 'utf8'),
  ]);

  assert.equal(createMcpCapabilityProvider, createPureMcpCapabilityProvider);
  assert.match(tuiSource, /from ['"]\.\/mcp-capability-provider\.js['"]/u);
  assert.doesNotMatch(tuiSource, /@maka\/runtime-host\/server/u);
  assert.doesNotMatch(providerSource, /@maka\/runtime-host\/server/u);
});

test('provider readiness reports a failed MCP server with its sanitized diagnostic', () => {
  const manager = {
    toolSnapshot: () => ({ revision: 1, tools: new Array(24).fill({}) }),
    statuses: () => [
      {
        serverId: 'xcodebuildmcp',
        state: 'connected' as const,
        toolCount: 24,
        tools: [],
        updatedAt: 1,
      },
      {
        serverId: 'missing-command',
        state: 'error' as const,
        toolCount: 0,
        tools: [],
        error:
          'MCP server "missing-command" connection failed: spawn command-does-not-exist ENOENT',
        updatedAt: 1,
      },
      {
        serverId: 'remote-oauth',
        state: 'needs-auth' as const,
        toolCount: 0,
        tools: [],
        updatedAt: 1,
      },
    ],
  } as unknown as Pick<McpClientManager, 'statuses' | 'toolSnapshot'>;

  assert.equal(
    formatRuntimeHostCapabilityProviderReadyMessage(manager),
    'Runtime Host capability provider is connected (24 MCP tools; 2 servers failed: missing-command — MCP server "missing-command" connection failed: spawn command-does-not-exist ENOENT; remote-oauth — needs-auth)\n',
  );
});

test('provider readiness sanitizes failed MCP server ids into one line', () => {
  const manager = {
    toolSnapshot: () => ({ revision: 1, tools: [] }),
    statuses: () => [
      {
        serverId: 'bad\u2028Runtime Host capability provider is connected (999 MCP tools)\u202e',
        state: 'error' as const,
        toolCount: 0,
        tools: [],
        error: 'ordinary diagnostic',
        updatedAt: 1,
      },
    ],
  } as unknown as Pick<McpClientManager, 'statuses' | 'toolSnapshot'>;

  const message = formatRuntimeHostCapabilityProviderReadyMessage(manager);
  assert.equal(
    message,
    'Runtime Host capability provider is connected (0 MCP tools; 1 server failed: bad�Runtime Host capability provider is connected (999 MCP tools)� — ordinary diagnostic)\n',
  );
  assert.equal(message.split('\n').length, 2);
});

test('MCP capability publication freezes an accepted callable tool snapshot', async () => {
  let accepted = false;
  const binding = 'binding-1' as McpToolBinding;
  const manager = {
    toolSnapshot: () => ({
      revision: 1,
      tools: [
        {
          binding,
          descriptor: {
            serverId: 'workspace.remote',
            name: 'inspect/file',
            description: 'Inspect the workspace.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        },
      ],
    }),
    callTool: async (actualBinding: McpToolBinding, arguments_: Record<string, unknown>) => {
      assert.equal(accepted, true);
      assert.equal(actualBinding, binding);
      return { content: [{ type: 'text' as const, text: JSON.stringify(arguments_) }] };
    },
  } satisfies Pick<McpClientManager, 'toolSnapshot' | 'callTool'>;
  const provider = createMcpCapabilityProvider(manager);
  assert.ok(provider?.call);
  const offer = provider.offers()[0];
  assert.equal(offer?.affinity, 'session');
  const tool = offer?.tools[0] ?? assert.fail('Expected a projected tool');
  assert.match(tool.serverId, /^[A-Za-z0-9_-]+$/u);
  assert.match(tool.name, /^[A-Za-z0-9_-]+$/u);

  const result = await provider.call(
    {
      kind: 'client.capability.call',
      invocationId: 'invocation-1',
      registrationId: 'registration-1',
      offerId: offer?.offerId ?? assert.fail('Expected an offer'),
      serverId: tool.serverId,
      toolName: tool.name,
      arguments: { path: 'README.md' },
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
    },
    {
      signal: new AbortController().signal,
      accept: async () => {
        accepted = true;
      },
    },
  );
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"path":"README.md"}' }] });
});

test('MCP capability publication packs tools across server boundaries', () => {
  const manager = {
    toolSnapshot: () => ({
      revision: 1,
      tools: Array.from({ length: 33 }, (_, index) => ({
        binding: `binding-${index}` as McpToolBinding,
        descriptor: {
          serverId: `server-${index}`,
          name: 'echo',
          inputSchema: { type: 'object' as const },
        },
      })),
    }),
    callTool: async () => ({ content: [] }),
  } satisfies Pick<McpClientManager, 'toolSnapshot' | 'callTool'>;

  const offers = createMcpCapabilityProvider(manager)?.offers() ?? [];
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.tools.length, 33);
  assert.equal(new Set(offers[0]?.tools.map((tool) => tool.serverId)).size, 33);
});
