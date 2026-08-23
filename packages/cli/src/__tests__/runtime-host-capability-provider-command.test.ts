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
import { test } from 'node:test';
import type { McpToolBinding } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import { createMcpCapabilityProvider } from '../runtime-host-capability-provider-command.js';

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
