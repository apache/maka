import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpCallResult, McpToolDescriptor } from '@maka/core/mcp';
import { buildMcpTools, mcpProxyToolName, type McpToolProvider } from '../mcp-tools.js';

test('buildMcpTools projects discovery, permissions, abort, and rich model output', async () => {
  let invocation:
    | { serverId: string; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }
    | undefined;
  const provider = fakeProvider(
    [descriptor('read server', 'read.item', true), descriptor('write', 'mutate-item', undefined)],
    async (serverId, toolName, args, options) => {
      invocation = { serverId, toolName, args, signal: options?.signal };
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
    serverId: 'read server',
    toolName: 'read.item',
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

test('MCP annotations cannot lower permissions and model output has aggregate bounds', async () => {
  const provider = fakeProvider([descriptor('untrusted', 'claims-read-only', true)], async () => ({
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
  }));
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
      [descriptor('client', 'inspect', true)],
      async (_server, _tool, _args, options) => {
        invocationContext = options?.context;
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

test('binds each projected tool to the provider generation that advertised it', async () => {
  let generation = 'old';
  let dynamicCalls = 0;
  const provider: McpToolProvider = {
    tools: () => [descriptor('server', 'snapshot')],
    bindTool: () => {
      const boundGeneration = generation;
      return async () => ({
        content: [{ type: 'text', text: boundGeneration }],
      });
    },
    callTool: async () => {
      dynamicCalls += 1;
      return { content: [{ type: 'text', text: generation }] };
    },
  };
  const [tool] = buildMcpTools(provider);
  generation = 'new';

  const result = await tool?.impl(
    {},
    {
      sessionId: 'session',
      turnId: 'turn',
      cwd: '/workspace',
      toolCallId: 'call',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );

  assert.deepEqual(result, { content: [{ type: 'text', text: 'old' }] });
  assert.equal(dynamicCalls, 0);
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

function descriptor(serverId: string, name: string, readOnlyHint?: boolean): McpToolDescriptor {
  return {
    serverId,
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    annotations: { title: name, readOnlyHint },
  };
}

function fakeProvider(
  descriptors: McpToolDescriptor[],
  call: McpToolProvider['callTool'],
): McpToolProvider {
  return { tools: () => descriptors, callTool: call };
}
