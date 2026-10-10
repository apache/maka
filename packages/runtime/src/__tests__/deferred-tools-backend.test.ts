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
import type { SessionHeader } from '@maka/core/session';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  REQUEST_SANDBOX_BOUNDARY_TOOL_NAME,
  buildRequestSandboxBoundaryTool,
} from '../sandbox-boundary-tool.js';
import { TOOL_SEARCH_NAME, type ToolAvailabilityConfig } from '../tool-availability.js';
import type { RunTraceEvent } from '../run-trace.js';
import type { MakaTool } from '../tool-runtime.js';
import { createDurableTurnHarness, drainWithDurableTurn } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const availability: ToolAvailabilityConfig = {
  groups: [
    { id: 'browser', toolNames: ['browser_click'] },
    { id: 'docs', toolNames: ['docs_read'] },
  ],
};

function boundTools(calls: string[]): MakaTool[] {
  return [
    {
      name: 'Read',
      description: 'Read a local file',
      parameters: z.object({ path: z.string().optional() }),
      impl: () => ({ ok: true }),
    },
    {
      name: 'browser_click',
      description: 'Click an element in the browser',
      parameters: z.object({}),
      impl: () => {
        calls.push('browser_click');
        return { ok: true };
      },
    },
    {
      name: 'docs_read',
      description: 'Read a document',
      parameters: z.object({}),
      impl: () => {
        calls.push('docs_read');
        return { ok: true };
      },
    },
  ];
}

function backend(input: {
  model: MockLanguageModelV4;
  calls: string[];
  durable?: ReturnType<typeof createDurableTurnHarness>;
  traces?: RunTraceEvent[];
  toolAvailability?: ToolAvailabilityConfig;
  fullSurface?: boolean;
  resolveTools?: () => readonly MakaTool[];
  extraTools?: readonly MakaTool[];
  loadTurnRuntimeEvents?: ReturnType<typeof createDurableTurnHarness>['loadTurnRuntimeEvents'];
}): AiSdkBackend {
  let id = 0;
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => input.model,
    tools: [...boundTools(input.calls), ...(input.extraTools ?? [])],
    ...(input.resolveTools ? { resolveTools: input.resolveTools } : {}),
    ...(input.fullSurface ? {} : { toolAvailability: input.toolAvailability ?? availability }),
    ...(input.loadTurnRuntimeEvents
      ? { loadTurnRuntimeEvents: input.loadTurnRuntimeEvents }
      : input.durable
        ? { loadTurnRuntimeEvents: input.durable.loadTurnRuntimeEvents }
        : {}),
    ...(input.traces ? { recordRunTrace: (event) => input.traces!.push(event) } : {}),
    newId: () => `id-${++id}`,
    now: () => 1,
  });
}

describe('AiSdkBackend tool_search activation', () => {
  test('step 0 advertises tool_search but withholds deferred schemas', async () => {
    const captured: string[][] = [];
    await drain(
      backend({ model: capturingModel(captured), calls: [] }).send({
        turnId: 'turn-1',
        text: 'hi',
        context: [],
      }),
    );
    assert.ok(captured[0]?.includes('Read'));
    assert.ok(captured[0]?.includes(TOOL_SEARCH_NAME));
    assert.ok(!captured[0]?.includes('browser_click'));
    assert.ok(!captured[0]?.includes('docs_read'));
  });

  test('search result becomes visible on the next step and can then execute', async () => {
    const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'click it' });
    const captured: string[][] = [];
    const calls: string[] = [];
    const traces: RunTraceEvent[] = [];
    await drainWithDurableTurn(
      backend({
        model: searchThenUseModel(captured),
        calls,
        durable,
        traces,
      }).send(durable.sendInput()),
      durable,
    );

    assert.ok(!captured[0]?.includes('browser_click'));
    assert.ok(captured[1]?.includes('browser_click'));
    assert.deepEqual(calls, ['browser_click']);
    const searched = traces.find((event) => event.type === 'tool_searched');
    assert.equal(searched?.data?.query, 'browser click');
    assert.deepEqual(searched?.data?.activated, ['browser_click']);
  });

  test('equivalent Tool wrappers rebuilt between steps retain search activation', async () => {
    const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'click it' });
    const captured: string[][] = [];
    const calls: string[] = [];
    let resolutions = 0;
    await drainWithDurableTurn(
      backend({
        model: searchThenUseModel(captured),
        calls,
        durable,
        resolveTools: () => {
          resolutions += 1;
          return boundTools(calls);
        },
      }).send(durable.sendInput()),
      durable,
    );

    assert.ok(resolutions >= 2);
    assert.ok(!captured[0]?.includes('browser_click'));
    assert.ok(captured[1]?.includes('browser_click'));
    assert.deepEqual(calls, ['browser_click']);
  });

  test('parallel search and hidden-tool use still rejects the same-step call', async () => {
    const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'search and click' });
    const captured: string[][] = [];
    const calls: string[] = [];
    await drainWithDurableTurn(
      backend({ model: parallelSearchAndUseModel(captured), calls, durable }).send(
        durable.sendInput(),
      ),
      durable,
    );
    assert.ok(!captured[0]?.includes('browser_click'));
    assert.deepEqual(calls, []);
  });

  test('parallel searches union their matches for the following step', async () => {
    const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'search both' });
    const captured: string[][] = [];
    await drainWithDurableTurn(
      backend({ model: parallelSearchModel(captured), calls: [], durable }).send(
        durable.sendInput(),
      ),
      durable,
    );
    assert.ok(captured[1]?.includes('browser_click'));
    assert.ok(captured[1]?.includes('docs_read'));
  });

  test('search activation remains visible on a later Turn of the same backend', async () => {
    const captured: string[][] = [];
    const first = createDurableTurnHarness({ turnId: 'turn-1', text: 'search the click tool' });
    const second = createDurableTurnHarness({ turnId: 'turn-2', text: 'continue' });
    const instance = backend({
      model: searchThenStopModel(captured),
      calls: [],
      loadTurnRuntimeEvents: async (turnId) =>
        turnId === 'turn-1'
          ? first.loadTurnRuntimeEvents(turnId)
          : second.loadTurnRuntimeEvents(turnId),
    });
    await drainWithDurableTurn(instance.send(first.sendInput()), first);

    assert.ok(!captured[0]?.includes('browser_click'));
    assert.ok(captured[1]?.includes('browser_click'));

    await drainWithDurableTurn(instance.send(second.sendInput()), second);
    assert.ok(captured[2]?.includes('browser_click'));
    assert.ok(captured[2]?.includes(TOOL_SEARCH_NAME));
  });

  test('a rebuilt backend starts with an empty activation map', async () => {
    const captured: string[][] = [];
    const first = createDurableTurnHarness({ turnId: 'turn-1', text: 'search the click tool' });
    await drainWithDurableTurn(
      backend({
        model: searchThenStopModel(captured),
        calls: [],
        durable: first,
      }).send(first.sendInput()),
      first,
    );
    assert.ok(captured[1]?.includes('browser_click'));

    const later: string[][] = [];
    await drain(
      backend({ model: capturingModel(later), calls: [] }).send({
        turnId: 'turn-2',
        text: 'fresh backend',
        context: [],
      }),
    );
    assert.ok(!later[0]?.includes('browser_click'));
    assert.ok(later[0]?.includes(TOOL_SEARCH_NAME));
  });

  test('historical load_tools events never seed a new turn', async () => {
    const captured: string[][] = [];
    await drain(
      backend({ model: capturingModel(captured), calls: [] }).send({
        turnId: 'turn-2',
        text: 'new turn',
        context: [],
        runtimeContext: [
          {
            id: 'legacy-load',
            invocationId: 'inv-1',
            runId: 'run-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            ts: 1,
            role: 'model',
            author: 'agent',
            partial: false,
            content: {
              kind: 'function_call',
              id: 'legacy-call',
              name: 'load_tools',
              args: { group: 'browser' },
            },
          },
        ],
      }),
    );
    assert.ok(!captured[0]?.includes('browser_click'));
  });

  test('omitting search availability keeps the complete bound surface direct', async () => {
    const captured: string[][] = [];
    await drain(
      backend({ model: capturingModel(captured), calls: [], fullSurface: true }).send({
        turnId: 'turn-1',
        text: 'hi',
        context: [],
      }),
    );
    assert.ok(captured[0]?.includes('browser_click'));
    assert.ok(captured[0]?.includes('docs_read'));
    assert.ok(!captured[0]?.includes(TOOL_SEARCH_NAME));
  });

  test('a bound request_sandbox_boundary stays visible without tool_search', async () => {
    const captured: string[][] = [];
    const instance = backend({
      model: capturingModel(captured),
      calls: [],
      extraTools: [buildRequestSandboxBoundaryTool()],
    });
    await drain(
      instance.send({
        turnId: 'turn-1',
        text: 'hi',
        context: [],
      }),
    );
    assert.ok(captured[0]?.includes(REQUEST_SANDBOX_BOUNDARY_TOOL_NAME));
    assert.ok(captured[0]?.includes(TOOL_SEARCH_NAME));
    assert.ok(!captured[0]?.includes('browser_click'));

    await drain(
      instance.send({
        turnId: 'turn-2',
        text: 'continue',
        context: [],
      }),
    );
    assert.ok(captured[1]?.includes(REQUEST_SANDBOX_BOUNDARY_TOOL_NAME));
  });
});

function capturingModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name));
      return { stream: convertArrayToReadableStream(doneChunks()) };
    },
  });
}

function searchThenStopModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name));
      if (captured.length === 1) {
        return { stream: convertArrayToReadableStream(searchChunks('search-1', 'browser click')) };
      }
      return { stream: convertArrayToReadableStream(doneChunks()) };
    },
  });
}

function searchThenUseModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name));
      const step = captured.length;
      if (step === 1)
        return { stream: convertArrayToReadableStream(searchChunks('search-1', 'browser click')) };
      if (step === 2)
        return {
          stream: convertArrayToReadableStream(
            toolCallChunks('click-1', 'browser_click', {}, 'tool-calls'),
          ),
        };
      return { stream: convertArrayToReadableStream(doneChunks()) };
    },
  });
}

function parallelSearchAndUseModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name));
      if (captured.length > 1) return { stream: convertArrayToReadableStream(doneChunks()) };
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: TOOL_SEARCH_NAME,
            input: JSON.stringify({ query: 'browser click' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'click-1',
            toolName: 'browser_click',
            input: JSON.stringify({}),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: ZERO_USAGE,
          },
        ]),
      };
    },
  });
}

function parallelSearchModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name));
      if (captured.length > 1) return { stream: convertArrayToReadableStream(doneChunks()) };
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          ...toolCallOnly('search-browser', TOOL_SEARCH_NAME, { query: 'browser click' }),
          ...toolCallOnly('search-docs', TOOL_SEARCH_NAME, { query: 'document read' }),
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: ZERO_USAGE,
          },
        ]),
      };
    },
  });
}

function searchChunks(id: string, query: string): LanguageModelV4StreamPart[] {
  return toolCallChunks(id, TOOL_SEARCH_NAME, { query }, 'tool-calls');
}

function toolCallOnly(id: string, name: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input),
    },
  ];
}

function toolCallChunks(
  id: string,
  name: string,
  input: unknown,
  finish: 'tool-calls',
): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...toolCallOnly(id, name, input),
    {
      type: 'finish',
      finishReason: { unified: finish, raw: 'tool_calls' },
      usage: ZERO_USAGE,
    },
  ];
}

function doneChunks(): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
  ];
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) void _;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'c',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
