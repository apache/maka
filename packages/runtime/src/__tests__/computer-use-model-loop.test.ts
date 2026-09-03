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
import { describe, test } from 'node:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
  type CuSemanticAction,
} from '../computer-use-tools.js';
import {
  latestObservationIn,
  stringsIn,
  type ParsedObservation,
} from './observation-text-reader.js';
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
    target: {
      kind: 'running',
      identity: { kind: 'process', appId: 'pid:42' },
      selector: { pid: 42, processGeneration: 'pst:1', windowId: 7 },
    },
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
    async ensureReady() {},
    async resolveTarget() {
      return {
        kind: 'resolved',
        target: {
          kind: 'running',
          identity: { kind: 'process', appId: 'pid:42' },
          selector: { pid: 42, processGeneration: 'pst:1', windowId: 7 },
        },
      };
    },
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
    testProjectionArtifacts: true,
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

function latestObservation(prompt: unknown): ParsedObservation {
  const latest = latestObservationIn(prompt);
  assert.ok(latest, `model prompt did not contain an observation: ${JSON.stringify(prompt)}`);
  return latest;
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
