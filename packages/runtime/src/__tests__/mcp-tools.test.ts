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
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import type {
  McpBoundTool,
  McpCallResult,
  McpToolBinding,
  McpToolDescriptor,
} from '@maka/core/mcp';
import {
  buildMcpTools,
  buildMcpToolsWithIdentities,
  mcpProxyToolName,
  type McpToolProvider,
} from '../mcp-tools.js';
import { selectCollaborationTools } from '../plan-mode.js';

test('buildMcpTools projects discovery, abort, and rich model output', async () => {
  const readBinding = binding('internal-read-binding');
  const writeBinding = binding('internal-write-binding');
  let invocation:
    | {
        binding: McpToolBinding;
        args: Record<string, unknown>;
        signal?: AbortSignal;
      }
    | undefined;
  const provider = fakeProvider(
    [
      boundTool(descriptor('read server', 'read.item', true), readBinding),
      boundTool(descriptor('write', 'mutate-item', undefined), writeBinding),
    ],
    async (toolBinding, args, options) => {
      invocation = { binding: toolBinding, args, signal: options?.signal };
      return {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', data: 'aW1n', mimeType: 'image/png' },
          { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' },
        ],
        structuredContent: { id: 1 },
      };
    },
  );
  const tools = buildMcpTools(provider);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['mcp__read_server__read_item', 'mcp__write__mutate-item'],
  );
  assert.equal(tools[0]?.categoryHint, 'network_send');
  assert.equal(tools[1]?.categoryHint, 'network_send');
  assert.equal(tools[0]?.description, 'read.item description');
  assert.equal(tools[0]?.displayName, 'read.item');
  const controller = new AbortController();
  const result = await tools[0]?.impl(
    { value: 'x' },
    {
      sessionId: 's',
      turnId: 't',
      cwd: '/tmp',
      toolCallId: 'call',
      abortSignal: controller.signal,
      emitOutput() {},
    },
  );
  assert.deepEqual(invocation, {
    binding: readBinding,
    args: { value: 'x' },
    signal: controller.signal,
  });
  const model = await tools[0]?.toModelOutput?.({ toolCallId: 'call', input: {}, output: result });
  assert.equal(model?.type, 'content');
  if (model?.type !== 'content') throw new Error('expected content tool output');
  assert.deepEqual(model?.value.slice(0, 2), [
    { type: 'text', text: 'ok' },
    {
      type: 'file',
      data: { type: 'data', data: 'aW1n' },
      mediaType: 'image/png',
    },
  ]);
  assert.match(model?.value[2]?.type === 'text' ? model.value[2].text : '', /structuredContent/u);
});

test('buildMcpTools carries the Runtime-owned form callback to the provider', async () => {
  const cancellation = new AbortController();
  const provider = fakeProvider(
    [boundTool(descriptor('client', 'deploy'), binding('nested-form-binding'))],
    async (_binding, _args, options) => {
      assert.ok(options.requestInteraction);
      const answer = await options.requestInteraction(
        {
          message: 'Choose a target',
          requester: { name: 'deploy' },
          fields: [
            { kind: 'string', name: 'target', label: 'Target', required: true, maxLength: 256 },
          ],
        },
        { cancellationSignal: cancellation.signal },
      );
      assert.deepEqual(answer, { action: 'accept', values: { target: 'staging' } });
      return { content: [] };
    },
  );
  const [tool] = buildMcpTools(provider);

  await tool?.impl(
    {},
    {
      sessionId: 'session',
      turnId: 'turn',
      cwd: '/workspace',
      toolCallId: 'tool-call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
      requestUserForm: async (form, options) => {
        assert.equal(form.message, 'Choose a target');
        assert.equal(options?.cancellationSignal, cancellation.signal);
        return { action: 'accept', values: { target: 'staging' } };
      },
    },
  );
});

test('prepared MCP execution receives the Runtime-owned form callback after admission', async () => {
  const toolBinding = binding('prepared-form-binding');
  const provider: McpToolProvider = {
    toolSnapshot: () => ({
      revision: 1,
      tools: [boundTool(descriptor('client', 'deploy'), toolBinding)],
    }),
    prepareTool: async () => ({
      execute: async (options) => {
        assert.ok(options?.requestInteraction);
        const answer = await options.requestInteraction({
          message: 'Choose a target',
          requester: { name: 'deploy' },
          fields: [
            { kind: 'string', name: 'target', label: 'Target', required: true, maxLength: 256 },
          ],
        });
        assert.deepEqual(answer, { action: 'accept', values: { target: 'staging' } });
        return { content: [] };
      },
      cancel: () => undefined,
    }),
    callTool: async () => assert.fail('Prepared provider must not use direct callTool'),
  };
  const [tool] = buildMcpTools(provider);
  assert.ok(tool?.prepareExecution);
  const controller = new AbortController();
  const prepared = await tool.prepareExecution(
    {},
    {
      sessionId: 'session',
      turnId: 'turn',
      cwd: '/workspace',
      toolCallId: 'tool-call',
      abortSignal: controller.signal,
    },
  );
  await prepared.execute({
    sessionId: 'session',
    turnId: 'turn',
    cwd: '/workspace',
    toolCallId: 'tool-call',
    abortSignal: controller.signal,
    emitOutput: () => undefined,
    requestUserForm: async () => ({ action: 'accept', values: { target: 'staging' } }),
  });
});

test('Direct-mode MCP calls request managed network expansion before provider dispatch', async () => {
  const sequence: string[] = [];
  const boundary = createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0);
  const [tool] = buildMcpTools(
    fakeProvider(
      [boundTool(descriptor('server', 'mutate'), binding('managed-network-binding'))],
      async () => {
        sequence.push('provider');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    ),
  );

  await tool?.impl(
    {},
    {
      sessionId: 'session',
      turnId: 'turn',
      cwd: '/workspace',
      toolCallId: 'direct-call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
      executionBoundary: boundary,
      requestSandboxBoundary: async (expansion, justification) => {
        sequence.push('boundary');
        assert.deepEqual(expansion, { network: { enabled: true } });
        assert.equal(justification, 'Call MCP tool server/mutate.');
        return {
          request: {
            sessionId: 'session',
            requestId: 'request-1',
            status: 'approved',
            baseRevision: 0,
            expansion,
            justification,
            createdAt: 1,
          },
          boundary,
          changed: true,
        };
      },
    },
  );

  assert.deepEqual(sequence, ['boundary', 'provider']);
});

test('MCP annotations cannot lower permissions and model output has aggregate bounds', async () => {
  const provider = fakeProvider(
    [boundTool(descriptor('untrusted', 'claims-read-only', true), binding('untrusted-binding'))],
    async () => ({
      content: [
        { type: 'text', text: 'a'.repeat(150_000) },
        { type: 'text', text: 'b'.repeat(150_000) },
        ...Array.from({ length: 6 }, (_, index) => ({
          type: 'image' as const,
          data: `aW1n${index}`,
          mimeType: 'image/png',
        })),
        { type: 'unknown', value: { secretBlob: 'x'.repeat(250_000) } },
      ],
      structuredContent: { oversized: 'y'.repeat(250_000) },
    }),
  );
  const [tool] = buildMcpTools(provider);
  assert.equal(tool?.categoryHint, 'network_send');
  const output = await tool?.impl(
    {},
    {
      sessionId: 's',
      turnId: 't',
      cwd: '/tmp',
      toolCallId: 'call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  const model = await tool?.toModelOutput?.({ toolCallId: 'call', input: {}, output });
  assert.equal(model?.type, 'content');
  if (model?.type !== 'content') throw new Error('expected content tool output');
  const text =
    model?.value
      .filter((item) => item.type === 'text')
      .map((item) => (item.type === 'text' ? item.text : ''))
      .join('') ?? '';
  const images = model?.value.filter((item) => item.type === 'file') ?? [];
  assert.ok(text.length <= 200_000);
  assert.equal(images.length, 4);
  assert.doesNotMatch(text, /secretBlob/u);
});

test('MCP text clipping never leaves an unpaired surrogate at the boundary', async () => {
  const provider = fakeProvider(
    [boundTool(descriptor('untrusted', 'claims-read-only', true), binding('surrogate-binding'))],
    async () => ({
      // Every code point is astral, so a clip boundary inside any pair would
      // surface as an unpaired surrogate ahead of the truncation marker.
      content: [{ type: 'text', text: '🦊'.repeat(120_000) }],
    }),
  );
  const [tool] = buildMcpTools(provider);
  const output = await tool?.impl(
    {},
    {
      sessionId: 's',
      turnId: 't',
      cwd: '/tmp',
      toolCallId: 'call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  const model = await tool?.toModelOutput?.({ toolCallId: 'call', input: {}, output });
  assert.equal(model?.type, 'content');
  if (model?.type !== 'content') throw new Error('expected content tool output');
  const text = model.value
    .filter((item) => item.type === 'text')
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('');
  assert.ok(text.length <= 200_000);
  assert.match(text, /…\[truncated by Maka\]/u);
  assert.doesNotMatch(
    text,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
});

test('MCP tools stay network sends and are excluded from Plan mode', () => {
  const tools = buildMcpTools(
    fakeProvider(
      [boundTool(descriptor('untrusted', 'claims-read-only', true), binding('plan-binding'))],
      async () => ({ content: [{ type: 'text', text: 'unused' }] }),
    ),
  );

  assert.equal(tools[0]?.categoryHint, 'network_send');
  assert.deepEqual(
    selectCollaborationTools({ mode: 'plan', tools, hasActiveExecution: false }),
    [],
  );
});

test('a trusted composition can apply the Client Capability permission floor and context', async () => {
  let invocationContext:
    | {
        sessionId: string;
        turnId: string;
        toolCallId: string;
        cwd: string;
      }
    | undefined;
  const [tool] = buildMcpTools(
    fakeProvider(
      [boundTool(descriptor('client', 'inspect', true), binding('client-inspect-binding'))],
      async (_binding, _args, options) => {
        invocationContext = options.context;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    ),
    { categoryHint: 'client_capability', recoveryMode: 'outcome_unknown' },
  );
  assert.equal(tool?.categoryHint, 'client_capability');
  assert.equal(tool?.recoveryMode, 'outcome_unknown');
  await tool?.impl(
    {},
    {
      sessionId: 'session',
      turnId: 'turn',
      cwd: '/workspace',
      toolCallId: 'tool-call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  assert.deepEqual(invocationContext, {
    sessionId: 'session',
    turnId: 'turn',
    cwd: '/workspace',
    toolCallId: 'tool-call',
  });
});

test('a trusted composition can preserve provider-owned activity semantics', () => {
  const [tool] = buildMcpTools(
    fakeProvider(
      [
        boundTool(
          descriptor('desktop_computer_use', 'maka_computer'),
          binding('desktop-computer-binding'),
        ),
      ],
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ),
    { activityKindForDescriptor: () => 'computer' },
  );
  assert.equal(tool?.activityKind, 'computer');
});

test('mcpProxyToolName is stable, provider-safe, and bounded to 64 chars', () => {
  const first = mcpProxyToolName('服 务/'.repeat(20), 'tool.with punctuation '.repeat(20));
  const second = mcpProxyToolName('服 务/'.repeat(20), 'tool.with punctuation '.repeat(20));
  assert.equal(first, second);
  assert.ok(first.length <= 64);
  assert.match(first, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(
    first,
    mcpProxyToolName('服 务/'.repeat(20), 'tool.with punctuation '.repeat(20) + 'different'),
  );
});

test('buildMcpToolsWithIdentities pairs each proxy tool with its source identity', () => {
  const provider = fakeProvider(
    [
      boundTool(descriptor('read server', 'read.item', true), binding('read-binding')),
      boundTool(descriptor('write', 'mutate-item', undefined), binding('write-binding')),
    ],
    async () => ({ content: [] }),
  );
  const identified = buildMcpToolsWithIdentities(provider);
  assert.deepEqual(
    identified.map(({ tool, serverId, toolName }) => [tool.name, serverId, toolName]),
    [
      ['mcp__read_server__read_item', 'read server', 'read.item'],
      ['mcp__write__mutate-item', 'write', 'mutate-item'],
    ],
  );
  assert.deepEqual(
    buildMcpTools(provider).map((tool) => tool.name),
    identified.map(({ tool }) => tool.name),
  );
});

function descriptor(serverId: string, name: string, readOnlyHint?: boolean): McpToolDescriptor {
  return {
    serverId,
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    annotations: { title: name, readOnlyHint },
  };
}

function binding(value: string): McpToolBinding {
  return value as McpToolBinding;
}

function boundTool(toolDescriptor: McpToolDescriptor, toolBinding: McpToolBinding): McpBoundTool {
  return { descriptor: toolDescriptor, binding: toolBinding };
}

function fakeProvider(tools: McpBoundTool[], call: McpToolProvider['callTool']): McpToolProvider {
  return {
    toolSnapshot: () => ({ revision: 1, tools }),
    callTool: call,
  };
}
