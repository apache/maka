import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import type {
  McpBoundTool,
  McpCallResult,
  McpToolBinding,
  McpToolDescriptor,
} from '@maka/core/mcp';
import { buildMcpTools, mcpProxyToolName, type McpToolProvider } from '../mcp-tools.js';
import type { RuntimeCommitSink } from '../runtime-commit-sink.js';
import type { MakaTool } from '../tool-runtime.js';

test('buildMcpTools projects discovery, persisted arguments, abort, and rich model output', async () => {
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
  const persistedArguments = tools[0]?.permissionArgs?.(
    { value: 'x' },
    { sessionId: 's', turnId: 't', toolCallId: 'call' },
  );
  assert.deepEqual(persistedArguments, {
    serverId: 'read server',
    toolName: 'read.item',
    arguments: { value: 'x' },
  });
  assert.doesNotMatch(JSON.stringify(persistedArguments), /internal-read-binding/u);

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

test('MCP execution without a commit sink uses descriptor-only persisted arguments', async () => {
  const internalBinding = binding('internal-runtime-binding');
  let providerCalls = 0;
  const [tool] = buildMcpTools(
    fakeProvider(
      [boundTool(descriptor('fixture', 'echo'), internalBinding)],
      async (toolBinding, args) => {
        providerCalls += 1;
        assert.equal(toolBinding, internalBinding);
        return {
          content: [{ type: 'text', text: String(args.value) }],
        };
      },
    ),
  );
  assert.ok(tool);
  const harness = runtimeHarness();

  const settlement = await harness.execute(tool, { value: 'runtime' });

  assert.equal(providerCalls, 1);
  assert.deepEqual(settlement.result, {
    content: [{ type: 'text', text: 'runtime' }],
  });
  const persistedArguments = {
    serverId: 'fixture',
    toolName: 'echo',
    arguments: { value: 'runtime' },
  };
  assert.deepEqual(
    harness.messages.find((message) => message.type === 'tool_call')?.args,
    persistedArguments,
  );
  assert.deepEqual(
    harness.events.find((event) => event.type === 'tool_start')?.args,
    persistedArguments,
  );
  assert.doesNotMatch(JSON.stringify(harness.messages), /internal-runtime-binding/u);
  assert.doesNotMatch(JSON.stringify(harness.events), /internal-runtime-binding/u);
  const start = harness.events.find((event) => event.type === 'tool_start');
  // The no-sink JSONL path records the ordinary tool-start projection, but
  // cannot claim the durable operation identity minted by a successful T1.
  assert.equal(start && 'operationId' in start, false);
});

test('MCP execution does not reach the provider when the durable T1 commit fails', async () => {
  const internalBinding = binding('blocked-binding');
  let providerCalls = 0;
  let preparedCalls = 0;
  let preparedArguments: unknown;
  const [tool] = buildMcpTools(
    fakeProvider([boundTool(descriptor('fixture', 'echo'), internalBinding)], async () => {
      providerCalls += 1;
      return { content: [{ type: 'text', text: 'unexpected' }] };
    }),
  );
  assert.ok(tool);
  const harness = runtimeHarness({
    commitToolPrepared: async (input) => {
      preparedCalls += 1;
      preparedArguments =
        input.runtimeEvent.content?.kind === 'function_call'
          ? input.runtimeEvent.content.args
          : undefined;
      throw new Error('T1 unavailable');
    },
    commitToolOutcome: async () => {
      throw new Error('must not reach T2');
    },
  });

  await assert.rejects(harness.execute(tool, { value: 'runtime' }), /T1 unavailable/u);

  assert.equal(preparedCalls, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual(preparedArguments, {
    serverId: 'fixture',
    toolName: 'echo',
    arguments: { value: 'runtime' },
  });
  assert.doesNotMatch(JSON.stringify(preparedArguments), /blocked-binding/u);
});

test('MCP execution crosses T1 before the provider and records T2 afterward', async () => {
  const internalBinding = binding('ordered-binding');
  const order: string[] = [];
  const committedArguments: unknown[] = [];
  const [tool] = buildMcpTools(
    fakeProvider(
      [boundTool(descriptor('fixture', 'echo'), internalBinding)],
      async (toolBinding, args) => {
        order.push('provider');
        assert.equal(toolBinding, internalBinding);
        assert.deepEqual(args, { value: 'runtime' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    ),
  );
  assert.ok(tool);
  const harness = runtimeHarness({
    commitToolPrepared: async (input) => {
      order.push('T1');
      committedArguments.push(
        input.runtimeEvent.content?.kind === 'function_call'
          ? input.runtimeEvent.content.args
          : undefined,
      );
      return { created: true, runtimeEventSeq: 1 };
    },
    commitToolOutcome: async (input) => {
      order.push('T2');
      committedArguments.push(input.runtimeEvent.content);
      return { created: true, runtimeEventSeq: 2 };
    },
  });

  const settlement = await harness.execute(tool, { value: 'runtime' });

  assert.deepEqual(order, ['T1', 'provider', 'T2']);
  assert.deepEqual(settlement.result, {
    content: [{ type: 'text', text: 'ok' }],
  });
  assert.doesNotMatch(JSON.stringify(committedArguments), /ordered-binding/u);
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

function binding(value: string): McpToolBinding {
  return value as McpToolBinding;
}

function boundTool(toolDescriptor: McpToolDescriptor, toolBinding: McpToolBinding): McpBoundTool {
  return { descriptor: toolDescriptor, binding: toolBinding };
}

function fakeProvider(tools: McpBoundTool[], call: McpToolProvider['callTool']): McpToolProvider {
  return { boundTools: () => tools, callTool: call };
}

function runtimeHarness(runtimeCommitSink?: RuntimeCommitSink) {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: sessionHeader(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: nextNow(),
    getPermissionPauseTarget: () => null,
    ...(runtimeCommitSink
      ? {
          runId: 'run-1',
          invocationId: 'invocation-1',
          runtimeCommitSink,
        }
      : {}),
  });
  return {
    messages,
    events,
    execute: (tool: MakaTool, input: unknown) =>
      runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input,
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => events.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      }),
  };
}

function sessionHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function nextNow(): () => number {
  let value = 1_000;
  return () => ++value;
}
