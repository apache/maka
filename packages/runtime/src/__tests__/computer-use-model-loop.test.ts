import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type {
  LlmConnection,
  SessionEvent,
  SessionHeader,
  StoredMessage,
  ToolInvocationRecord,
} from '@maka/core';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
  type CuSemanticAction,
} from '../computer-use-tools.js';
import { createDurableTurnHarness, drainWithDurableTurn } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe('AiSdkBackend Computer Use model loop', () => {
  test('the safe function-tool contract is identical across target provider connections', async () => {
    for (const providerType of [
      'openai',
      'anthropic',
      'claude-subscription',
      'kimi-coding-plan',
      'MiniMax',
      'MiniMax-cn',
    ] as const) {
      const value = { current: '' };
      const computerBackend = fakeComputerBackend(value, []);
      const [computerTool] = buildComputerUseTools({ backend: computerBackend });
      let declaredTools: unknown;
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          declaredTools = options.tools;
          return {
            stream: simulateReadableStream({
              chunks: textCompletion('ready'),
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      });
      const runtime = createRuntime({
        model,
        computerTool,
        messages: [],
        telemetry: [],
        connection: connection(providerType),
      });

      await collect(
        runtime.send({
          turnId: 'turn-1',
          text: 'Inspect the desktop safely.',
          context: [],
        }),
      );

      const serialized = JSON.stringify(declaredTools);
      assert.match(serialized, /maka_computer/);
      assert.match(serialized, /Prefer click_element or set_value/);
      assert.match(
        serialized,
        /Coordinate click, pointer move, scroll, drag, press_key, type.*disabled by default/,
      );
    }
  });

  test('a model discovers, observes, mutates semantically, reads the fresh frame, and completes', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'Set the fixture field to model-written.',
    });
    const value = { current: '' };
    const backendCalls: string[] = [];
    const computerBackend = fakeComputerBackend(value, backendCalls);
    const [computerTool] = buildComputerUseTools({ backend: computerBackend });
    const modelPrompts: unknown[] = [];
    const modelTools: unknown[] = [];
    let modelStep = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelPrompts.push(options.prompt);
        modelTools.push(options.tools);
        modelStep += 1;
        const chunks =
          modelStep === 1
            ? toolCall('list-apps', { action: 'list_apps' })
            : modelStep === 2
              ? toolCall('observe', {
                  action: 'observe',
                  app: 'pid:42',
                  window_id: 7,
                  include_screenshot: true,
                })
              : modelStep === 3
                ? (() => {
                    const observation = latestObservation(options.prompt);
                    const field = observation.elements.find(
                      (element) => element.label === 'CUA Lab Set Value Field',
                    );
                    assert.ok(field, 'model must receive the observed field');
                    return toolCall('set-value', {
                      action: 'set_value',
                      observation_id: observation.observation_id,
                      element_id: field.element_id,
                      value: 'model-written',
                    });
                  })()
                : (() => {
                    const observation = latestObservation(options.prompt);
                    const field = observation.elements.find(
                      (element) => element.label === 'CUA Lab Set Value Field',
                    );
                    assert.equal(field?.value, 'model-written');
                    return textCompletion('done');
                  })();
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const messages: StoredMessage[] = [];
    const telemetry: ToolInvocationRecord[] = [];
    const runtime = createRuntime({
      model,
      computerTool,
      messages,
      telemetry,
      durable,
    });

    const events = await drainWithDurableTurn(runtime.send(durable.sendInput()), durable);

    assert.equal(
      modelStep,
      4,
      JSON.stringify({
        eventTypes: events.map((event) => event.type),
        error: events.find((event) => event.type === 'error'),
        ledger: durable.ledger,
      }),
    );
    assert.deepEqual(backendCalls, ['list_apps', 'observe', 'set_value']);
    assert.equal(value.current, 'model-written');
    assert.equal(events.at(-1)?.type, 'complete');
    const textComplete = [...events].reverse().find((event) => event.type === 'text_complete');
    assert.equal(textComplete?.type === 'text_complete' ? textComplete.text : undefined, 'done');
    assert.deepEqual(
      messages.filter((message) => message.type === 'tool_call').map((message) => message.toolName),
      ['maka_computer', 'maka_computer', 'maka_computer'],
    );
    assert.equal(telemetry.length, 3);
    assert.equal(
      telemetry.every((record) => record.toolName === 'maka_computer'),
      true,
    );
    assert.match(JSON.stringify(modelPrompts[2]), /CUA Lab Set Value Field/);
    assert.match(JSON.stringify(modelPrompts[3]), /model-written/);
    assert.match(
      JSON.stringify(modelTools[0]),
      /Coordinate click, pointer move, scroll, drag, press_key, type.*disabled by default/,
    );
    assert.match(JSON.stringify(modelTools[0]), /Prefer click_element or set_value/);
    assert.equal(
      (modelTools[0] as Array<{ name?: string }>).some((tool) => tool.name === 'maka_computer'),
      true,
    );
  });

  test('a coordinate attempt fails closed and the model can recover through a fresh semantic plan', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'Update the fixture safely.',
    });
    const value = { current: '' };
    const backendCalls: string[] = [];
    const computerBackend = fakeComputerBackend(value, backendCalls);
    const [computerTool] = buildComputerUseTools({ backend: computerBackend });
    let modelStep = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelStep += 1;
        const chunks =
          modelStep === 1
            ? toolCall('observe-1', {
                action: 'observe',
                app: 'pid:42',
                window_id: 7,
                include_screenshot: true,
              })
            : modelStep === 2
              ? (() => {
                  const observation = latestObservation(options.prompt);
                  return toolCall('blocked-click', {
                    action: 'left_click',
                    observation_id: observation.observation_id,
                    coordinate: [20, 20],
                  });
                })()
              : modelStep === 3
                ? (() => {
                    assert.match(stringsIn(options.prompt).join('\n'), /unsupported_action/);
                    return toolCall('observe-2', {
                      action: 'observe',
                      app: 'pid:42',
                      window_id: 7,
                      include_screenshot: true,
                    });
                  })()
                : modelStep === 4
                  ? (() => {
                      const observation = latestObservation(options.prompt);
                      const field = observation.elements.find(
                        (element) => element.label === 'CUA Lab Set Value Field',
                      );
                      assert.ok(field);
                      return toolCall('safe-set', {
                        action: 'set_value',
                        observation_id: observation.observation_id,
                        element_id: field.element_id,
                        value: 'recovered',
                      });
                    })()
                  : textCompletion('recovered safely');
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const runtime = createRuntime({
      model,
      computerTool,
      messages: [],
      telemetry: [],
      durable,
    });

    const events = await drainWithDurableTurn(runtime.send(durable.sendInput()), durable);

    assert.equal(
      modelStep,
      5,
      JSON.stringify({
        eventTypes: events.map((event) => event.type),
        error: events.find((event) => event.type === 'error'),
        ledger: durable.ledger,
      }),
    );
    assert.equal(value.current, 'recovered');
    assert.deepEqual(backendCalls, ['observe', 'left_click', 'observe', 'set_value']);
    assert.equal(events.at(-1)?.type, 'complete');
  });
});

function fakeComputerBackend(value: { current: string }, calls: string[]): CuDispatchBackend {
  const observation = (): CuObservation => ({
    observationId: `backend-${calls.length}`,
    appId: 'pid:42',
    pid: 42,
    windowId: 7,
    windowTitle: 'Codex CUA Lab',
    contentFingerprint: 'fixture-structure',
    elements: [
      {
        elementId: 'field-1',
        role: 'AXTextField',
        label: 'CUA Lab Set Value Field',
        value: value.current,
        identity: {
          role: 'AXTextField',
          label: 'CUA Lab Set Value Field',
          value: value.current,
        },
      },
    ],
    screenshot: {
      base64: 'AA==',
      mimeType: 'image/png',
      widthPx: 800,
      heightPx: 600,
    },
  });
  return {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
      calls.push('list_apps');
      return [
        {
          appId: 'pid:42',
          pid: 42,
          name: 'Codex CUA Lab',
          windowCount: 1,
          windows: [{ windowId: 7, title: 'Codex CUA Lab' }],
        },
      ];
    },
    async observeApp() {
      calls.push('observe');
      return observation();
    },
    async runSemantic(action: CuSemanticAction) {
      assert.equal(action.type, 'set_value');
      calls.push(action.type);
      if (action.type === 'set_value') value.current = action.value;
      return {
        outcome: {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        },
        observation: observation(),
      };
    },
    async captureObservation() {
      calls.push('capture_observation');
      return observation();
    },
    async run(action) {
      calls.push(action.type);
      return {
        outcome: {
          ok: false,
          error: 'unsupported_action',
          message: `background '${action.type}' is disabled because the compatibility event backend can interfere with physical user input`,
        },
      };
    },
  };
}

function createRuntime(input: {
  model: MockLanguageModelV4;
  computerTool: ReturnType<typeof buildComputerUseTools>[number];
  messages: StoredMessage[];
  telemetry: ToolInvocationRecord[];
  connection?: LlmConnection;
  durable?: ReturnType<typeof createDurableTurnHarness>;
}): AiSdkBackend {
  const selectedConnection = input.connection ?? connection('openai');
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async (message) => {
      input.messages.push(message);
    },
    connection: selectedConnection,
    apiKey: 'test-key',
    modelId: 'mock-computer-model',
    modelFactory: () => input.model,
    tools: [input.computerTool],
    ...(input.durable ? { loadTurnRuntimeEvents: input.durable.loadTurnRuntimeEvents } : {}),
    newId: idGenerator(),
    now: monotonicClock(),
    recordToolInvocation: (record) => {
      input.telemetry.push(record);
    },
  });
}

function toolCall(id: string, args: Record<string, unknown>): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: 'maka_computer',
      input: JSON.stringify(args),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: ZERO_USAGE,
    },
  ];
}

function textCompletion(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'final-text' },
    { type: 'text-delta', id: 'final-text', delta: text },
    { type: 'text-end', id: 'final-text' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: ZERO_USAGE,
    },
  ];
}

function latestObservation(prompt: unknown): {
  observation_id: string;
  elements: Array<{
    element_id: string;
    label?: string;
    value?: string;
  }>;
} {
  const candidates = stringsIn(prompt).flatMap((text) => {
    const marker = text.lastIndexOf('Fresh observation:\n');
    const json =
      marker >= 0
        ? text.slice(marker + 'Fresh observation:\n'.length)
        : text.trim().startsWith('{')
          ? text.trim()
          : '';
    if (!json) return [];
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      return typeof value.observation_id === 'string' && Array.isArray(value.elements)
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  const latest = candidates.at(-1);
  assert.ok(latest, `model prompt did not contain an observation: ${JSON.stringify(prompt)}`);
  return latest as {
    observation_id: string;
    elements: Array<{ element_id: string; label?: string; value?: string }>;
  };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Computer model loop',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'mock-computer-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug: `${providerType}-main`,
    name: providerType,
    providerType,
    defaultModel: 'mock-computer-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}
