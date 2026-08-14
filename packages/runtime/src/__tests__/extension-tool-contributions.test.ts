import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

import { ExtensionLifecycleKernel } from '../extension-lifecycle-kernel.js';
import {
  ExtensionToolContributionError,
  ExtensionToolContributionRegistry,
  defineTrustedToolExtensionRevision,
} from '../extension-tool-contributions.js';
import type { MakaTool } from '../tool-runtime.js';
import { LOAD_TOOLS_NAME } from '../tool-availability.js';
import { createDurableTurnHarness, drainWithDurableTurn } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

describe('Extension Tool contributions', () => {
  test('lifecycle activation, update, stop, restart, and removal own registry entries', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionToolContributionRegistry();
    const v1 = tool('Weather', () => ({ revision: 1 }));
    const v2 = tool('Weather', () => ({ revision: 2 }));

    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'weather',
        revision: '1',
        tools: [v1],
      }),
    );
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'weather',
        revision: '2',
        tools: [v2],
      }),
    );

    assert.deepEqual(registry.inspect('session-a'), []);
    await kernel.activate({
      bindingId: 'weather-binding',
      scopeId: 'session-a',
      extensionId: 'weather',
      revision: '1',
    });
    assert.deepEqual(registry.inspect('session-a'), [
      {
        scopeId: 'session-a',
        bindingId: 'weather-binding',
        extensionId: 'weather',
        revision: '1',
        toolName: 'Weather',
      },
    ]);
    assert.equal(registry.compose('session-a', [tool('Read')])[1]?.impl, v1.impl);

    await kernel.update('weather-binding', '2');
    assert.equal(registry.inspect('session-a')[0]?.revision, '2');
    assert.equal(registry.compose('session-a', [tool('Read')])[1]?.impl, v2.impl);

    await kernel.stop('weather-binding');
    assert.deepEqual(registry.inspect('session-a'), []);
    assert.deepEqual(
      registry.compose('session-a', [tool('Read')]).map(({ name }) => name),
      ['Read'],
    );

    await kernel.start('weather-binding');
    assert.equal(registry.inspect('session-a')[0]?.revision, '2');
    await kernel.removeBinding('weather-binding');
    assert.deepEqual(registry.inspect('session-a'), []);
    await kernel.uninstall('weather', '1');
    await kernel.uninstall('weather', '2');
    assert.deepEqual(kernel.installedRevisions(), []);
  });

  test('rejects extension-extension, Core, reserved, and provider-native conflicts', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionToolContributionRegistry({
      protectedToolNames: () => ['Read'],
    });
    for (const extensionId of ['first', 'second']) {
      await kernel.install(
        defineTrustedToolExtensionRevision({
          registry,
          extensionId,
          revision: '1',
          tools: [tool(extensionId === 'first' ? 'Weather' : 'weather')],
        }),
      );
    }
    await kernel.activate({
      bindingId: 'first-binding',
      scopeId: 'session-a',
      extensionId: 'first',
      revision: '1',
    });
    await assert.rejects(
      kernel.activate({
        bindingId: 'second-binding',
        scopeId: 'session-a',
        extensionId: 'second',
        revision: '1',
      }),
      /activation failed/,
    );
    assert.deepEqual(
      registry.inspect('session-a').map(({ extensionId }) => extensionId),
      ['first'],
    );
    assert.throws(
      () => registry.compose('session-a', [tool('WEATHER')]),
      (error: unknown) =>
        error instanceof ExtensionToolContributionError && error.code === 'tool_name_conflict',
    );
    assert.deepEqual(
      registry
        .compose('session-b', [
          {
            ...tool('NativeCore'),
            providerTool: { kind: 'openai-web-search' },
          },
        ])
        .map(({ name }) => name),
      ['NativeCore'],
    );
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'core-conflict',
        revision: '1',
        tools: [tool('read')],
      }),
    );
    await assert.rejects(
      kernel.activate({
        bindingId: 'core-conflict-binding',
        scopeId: 'session-a',
        extensionId: 'core-conflict',
        revision: '1',
      }),
      /activation failed/,
    );
    assert.throws(
      () =>
        defineTrustedToolExtensionRevision({
          registry,
          extensionId: 'reserved',
          revision: '1',
          tools: [tool('exec')],
        }),
      (error: unknown) =>
        error instanceof ExtensionToolContributionError && error.code === 'reserved_tool_name',
    );
    assert.throws(
      () =>
        defineTrustedToolExtensionRevision({
          registry,
          extensionId: 'native',
          revision: '1',
          tools: [
            {
              ...tool('Native'),
              providerTool: { kind: 'openai-web-search' },
            },
          ],
        }),
      /cannot claim a provider-native Runtime protocol/,
    );
  });

  test('failed multi-Tool candidate restores the complete current registry surface', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionToolContributionRegistry();
    const weatherV1 = tool('Weather', () => ({ revision: 1 }));
    const weatherV2 = tool('Weather', () => ({ revision: 2 }));
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'weather',
        revision: '1',
        tools: [weatherV1],
      }),
    );
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'weather',
        revision: '2',
        tools: [weatherV2, tool('Calendar')],
      }),
    );
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'calendar',
        revision: '1',
        tools: [tool('Calendar')],
      }),
    );
    await kernel.activate({
      bindingId: 'weather-binding',
      scopeId: 'session-a',
      extensionId: 'weather',
      revision: '1',
    });
    await kernel.activate({
      bindingId: 'calendar-binding',
      scopeId: 'session-a',
      extensionId: 'calendar',
      revision: '1',
    });

    await assert.rejects(kernel.update('weather-binding', '2'), /activation failed/);
    assert.equal(kernel.inspect('weather-binding').current?.revision, '1');
    assert.deepEqual(
      registry.inspect('session-a').map(({ extensionId, revision, toolName }) => ({
        extensionId,
        revision,
        toolName,
      })),
      [
        { extensionId: 'calendar', revision: '1', toolName: 'Calendar' },
        { extensionId: 'weather', revision: '1', toolName: 'Weather' },
      ],
    );
    assert.equal(
      registry.compose('session-a', []).find(({ name }) => name === 'Weather')?.impl,
      weatherV1.impl,
    );
  });

  test('one live Backend observes activation, executes through ToolRuntime, upgrades, and retracts', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const coreTools = [tool('Read')];
    const registry = new ExtensionToolContributionRegistry({
      protectedToolNames: () => coreTools.map(({ name }) => name),
    });
    const executions: Array<{ revision: number; turnId: string; city: string }> = [];
    const extensionTool = (revision: number): MakaTool<{ city: string }> =>
      tool(
        'Weather',
        ({ city }, context) => {
          executions.push({ revision, turnId: context.turnId, city });
          return { revision, city };
        },
        z.object({ city: z.string() }),
      );

    for (const revision of [1, 2]) {
      await kernel.install(
        defineTrustedToolExtensionRevision({
          registry,
          extensionId: 'weather',
          revision: String(revision),
          tools: [extensionTool(revision)],
        }),
      );
    }

    const model = dynamicToolModel();
    let nextId = 0;
    const appended: unknown[] = [];
    const traces: unknown[] = [];
    const durableTurns = new Map<string, ReturnType<typeof createDurableTurnHarness>>();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-a',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model.model,
      tools: coreTools,
      resolveTools: () => registry.compose('session-a', coreTools),
      loadTurnRuntimeEvents: async (turnId) =>
        durableTurns.get(turnId)?.loadTurnRuntimeEvents(turnId) ?? [],
      recordRunTrace: (event) => traces.push(event),
      newId: () => `id-${++nextId}`,
      now: () => nextId,
    });

    model.setMode('observe');
    await sendDurable(backend, durableTurns, 'turn-core', 'core only');
    assert.deepEqual(model.requests.at(-1), ['Read']);

    await kernel.activate({
      bindingId: 'weather-binding',
      scopeId: 'session-a',
      extensionId: 'weather',
      revision: '1',
    });
    model.setMode('call');
    const v1Events = await sendDurable(backend, durableTurns, 'turn-v1', 'weather');
    assert.ok(model.requests.at(-1)?.includes('Weather'));
    assert.deepEqual(
      executions,
      [{ revision: 1, turnId: 'turn-v1', city: 'Shanghai' }],
      JSON.stringify({ v1Events, appended, traces }),
    );

    await kernel.update('weather-binding', '2');
    model.setMode('call');
    await sendDurable(backend, durableTurns, 'turn-v2', 'weather again');
    assert.deepEqual(executions.at(-1), {
      revision: 2,
      turnId: 'turn-v2',
      city: 'Shanghai',
    });

    await kernel.stop('weather-binding');
    model.setMode('observe');
    await sendDurable(backend, durableTurns, 'turn-stopped', 'after stop');
    assert.deepEqual(model.requests.at(-1), ['Read']);
  });

  test('Extension Tools remain subject to Tool availability gating', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const coreTools = [tool('Read')];
    const registry = new ExtensionToolContributionRegistry({
      protectedToolNames: () => coreTools.map(({ name }) => name),
    });
    const executions: string[] = [];
    await kernel.install(
      defineTrustedToolExtensionRevision({
        registry,
        extensionId: 'weather',
        revision: '1',
        tools: [
          tool(
            'Weather',
            ({ city }: { city: string }) => {
              executions.push(city);
              return { city };
            },
            z.object({ city: z.string() }),
          ),
        ],
      }),
    );
    await kernel.activate({
      bindingId: 'weather-binding',
      scopeId: 'session-a',
      extensionId: 'weather',
      revision: '1',
    });
    const model = deferredExtensionToolModel();
    const durableTurns = new Map<string, ReturnType<typeof createDurableTurnHarness>>();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-a',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model.model,
      tools: coreTools,
      resolveTools: () => registry.compose('session-a', coreTools),
      toolAvailability: {
        economy: true,
        groups: [{ id: 'extension', toolNames: ['Weather'] }],
      },
      loadTurnRuntimeEvents: async (turnId) =>
        durableTurns.get(turnId)?.loadTurnRuntimeEvents(turnId) ?? [],
    });

    await sendDurable(backend, durableTurns, 'turn-gated', 'load and call weather');
    assert.ok(!model.requests[0]?.includes('Weather'));
    assert.ok(model.requests[0]?.includes(LOAD_TOOLS_NAME));
    assert.ok(model.requests[1]?.includes('Weather'));
    assert.deepEqual(executions, ['Shanghai']);
  });
});

function dynamicToolModel(): {
  readonly model: MockLanguageModelV4;
  readonly requests: string[][];
  setMode(mode: 'observe' | 'call'): void;
} {
  const requests: string[][] = [];
  let mode: 'observe' | 'call' = 'observe';
  let pendingCall = false;
  const model = new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      requests.push((tools ?? []).map(({ name }) => name).filter((name) => name !== 'invalid'));
      const call = mode === 'call' && pendingCall;
      if (call) pendingCall = false;
      const parts: LanguageModelV4StreamPart[] = call
        ? [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `weather-${requests.length}`,
              toolName: 'Weather',
              input: JSON.stringify({ city: 'Shanghai' }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: ZERO_USAGE,
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  return {
    model,
    requests,
    setMode(next) {
      mode = next;
      pendingCall = next === 'call';
    },
  };
}

function deferredExtensionToolModel(): {
  readonly model: MockLanguageModelV4;
  readonly requests: string[][];
} {
  const requests: string[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      requests.push((tools ?? []).map(({ name }) => name));
      const step = requests.length;
      const parts: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'load-extension',
                toolName: LOAD_TOOLS_NAME,
                input: JSON.stringify({ group: 'extension' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: ZERO_USAGE,
              },
            ]
          : step === 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-weather',
                  toolName: 'Weather',
                  input: JSON.stringify({ city: 'Shanghai' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: ZERO_USAGE,
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: ZERO_USAGE,
                },
              ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  return { model, requests };
}

function tool<P = Record<string, never>>(
  name: string,
  impl: MakaTool<P>['impl'] = (() => ({ ok: true })) as MakaTool<P>['impl'],
  parameters: unknown = z.object({}),
): MakaTool<P> {
  return {
    name,
    description: `${name} test tool`,
    parameters,
    impl,
  };
}

async function sendDurable(
  backend: ReturnType<typeof createTestAiSdkBackend>,
  durableTurns: Map<string, ReturnType<typeof createDurableTurnHarness>>,
  turnId: string,
  text: string,
): Promise<unknown[]> {
  const durable = createDurableTurnHarness({
    sessionId: 'session-a',
    turnId,
    text,
    runId: `run-${turnId}`,
  });
  durableTurns.set(turnId, durable);
  return drainWithDurableTurn(backend.send(durable.sendInput({ runId: `run-${turnId}` })), durable);
}

function header(): SessionHeader {
  return {
    id: 'session-a',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Extension Tool test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'mock-model-id',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
