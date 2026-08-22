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
import test from 'node:test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import {
  createExternalExecutionBoundary,
  createManagedExecutionBoundary,
  type SandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type SessionEvent } from '@maka/core/events';
import { type SessionHeader } from '@maka/core/session';
import type { McpToolBinding } from '@maka/core/mcp';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import type { AiSdkBackendInput } from '../ai-sdk-backend.js';
import { buildMcpTools } from '../mcp-tools.js';
import type { ToolArtifactRecorderInput } from '../tool-artifacts.js';
import type { MakaTool } from '../tool-runtime.js';
import type { RuntimeCommitSink, ToolPreparedCommit } from '../runtime-commit-sink.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

test('adds exec only for the explicit code_mode provider surface', async () => {
  const directSurface: string[][] = [];
  const codeSurface: string[][] = [];

  await drain(
    backend(capturingModel(directSurface)).send({
      turnId: 'turn-direct',
      text: 'inspect',
      context: [],
    }),
  );
  await drain(
    backend(capturingModel(codeSurface)).send({
      turnId: 'turn-code',
      text: 'inspect',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.deepEqual(directSurface[0], ['lookup']);
  assert.deepEqual(codeSurface[0], ['exec', 'lookup']);
});

test('allows a custom exec tool in direct mode', async () => {
  const surface: string[][] = [];
  await drain(
    backend(capturingModel(surface), [], undefined, {
      tools: [
        {
          name: 'exec',
          description: 'caller tool',
          parameters: z.object({}),
          impl: () => null,
        },
      ],
    }).send({ turnId: 'turn-direct-exec', text: 'inspect', context: [], toolMode: 'direct' }),
  );

  assert.deepEqual(surface[0], ['exec']);
});

test('rejects an invalid runtime tool mode instead of enabling Code Mode', async () => {
  await assert.rejects(
    drain(
      backend(capturingModel([])).send({
        turnId: 'turn-invalid-mode',
        text: 'inspect',
        context: [],
        toolMode: 'legacy_mode' as never,
      }),
    ),
    /invalid tool mode/i,
  );
});

test('keeps the default and explicit direct provider surfaces byte-identical', async () => {
  const captured: string[] = [];
  const model = () =>
    new MockLanguageModelV4({
      doStream: async ({ tools }) => {
        captured.push(JSON.stringify(tools ?? []));
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: ZERO_USAGE,
            },
          ]),
        };
      },
    });

  await drain(backend(model()).send({ turnId: 'turn-default', text: 'inspect', context: [] }));
  await drain(
    backend(model()).send({
      turnId: 'turn-direct',
      text: 'inspect',
      context: [],
      toolMode: 'direct',
    }),
  );

  assert.equal(captured[0], captured[1]);
});

test('denies a nested MCP call before invoking its provider', async () => {
  const boundary = createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0);
  let pendingRequest: SandboxBoundaryRequest | undefined;
  let providerCalls = 0;
  const tools = buildMcpTools({
    toolSnapshot: () => ({
      revision: 1,
      tools: [
        {
          descriptor: {
            serverId: 'catalog',
            name: 'lookup',
            inputSchema: { type: 'object' },
          },
          binding: 'catalog-lookup' as McpToolBinding,
        },
      ],
    }),
    callTool: async () => {
      providerCalls += 1;
      return { content: [] };
    },
  });

  const instance = backend(
    execThenStopModel('return await tools.mcp__catalog__lookup({ id: "mcp-1" })'),
    [],
    undefined,
    {
      tools,
      readExecutionBoundary: async () => boundary,
      createSandboxBoundaryRequest: async (input) => {
        pendingRequest = {
          ...input,
          status: 'pending',
          baseRevision: 0,
          createdAt: 1,
        };
        return pendingRequest;
      },
      settleSandboxBoundaryRequest: async () => {
        assert.ok(pendingRequest);
        return {
          request: { ...pendingRequest, status: 'denied', settledAt: 2 },
          boundary,
          changed: false,
        };
      },
    },
  );
  const iterator = instance
    .send({
      turnId: 'turn-code',
      text: 'look it up through MCP',
      context: [],
      toolMode: 'code_mode',
    })
    [Symbol.asyncIterator]();
  let request: Extract<SessionEvent, { type: 'sandbox_boundary_request' }> | undefined;
  while (!request) {
    const item = await iterator.next();
    assert.equal(item.done, false, 'nested MCP call completed without requesting network access');
    if (item.value.type === 'sandbox_boundary_request') request = item.value;
  }
  await instance.respondToSandboxBoundary({ requestId: request.requestId, decision: 'deny' });
  for (;;) {
    const item = await iterator.next();
    if (item.done) break;
  }

  assert.equal(providerCalls, 0);
});

test('bounds cells outstanding on one backend, across the host drain', async () => {
  // The guarantee under test is the wiring, not the primitive: the permit is
  // taken before the cell and released only once `executeCodeCell` settles,
  // which is after its host operations have drained. Replacing the admission
  // with a no-op must fail this test.
  let firstToolStarted!: () => void;
  let releaseFirstTool!: () => void;
  const firstToolRunning = new Promise<void>((resolve) => {
    firstToolStarted = resolve;
  });
  const firstToolCanFinish = new Promise<void>((resolve) => {
    releaseFirstTool = resolve;
  });
  let toolCalls = 0;

  const instance = backend(
    execEveryTurnModel('return await tools.lookup({ id: "nested" })'),
    [],
    undefined,
    {
      tools: [
        {
          name: 'lookup',
          description: 'Look up a node',
          parameters: z.object({ id: z.string() }),
          impl: async (input: { id: string }) => {
            toolCalls += 1;
            if (toolCalls === 1) {
              firstToolStarted();
              await firstToolCanFinish;
            }
            return input;
          },
        },
      ],
    },
  );

  const cell = (turnId: string) =>
    collect(instance.send({ turnId, text: 'look it up', context: [], toolMode: 'code_mode' }));

  const first = cell('turn-1');
  await firstToolRunning;

  const second = cell('turn-2');
  const third = cell('turn-3');

  // The third cell finds a cell active and one already queued, so it is turned
  // away without ever reaching the sandbox.
  const thirdEvents = await third;
  const turnedAway = thirdEvents.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-3',
  );
  assert.ok(turnedAway, 'the third cell should settle its exec call');
  assert.match(JSON.stringify(turnedAway.content), /limit_exceeded/);

  // The second cell is queued behind the first, which is still holding a host
  // operation, so it has not started one of its own.
  assert.equal(toolCalls, 1, 'a queued cell must not start host work');

  releaseFirstTool();
  await Promise.all([first, second]);
  assert.equal(toolCalls, 2, 'the queued cell runs once the first releases');
});

test('routes a nested cell call back through ToolRuntime', async () => {
  const implementationCalls: unknown[] = [];
  const events = await collect(
    backend(execThenStopModel(), implementationCalls).send({
      turnId: 'turn-code',
      text: 'look it up',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.deepEqual(implementationCalls, [{ id: 'nested' }]);
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: 'tool_start' }> =>
          event.type === 'tool_start',
      )
      .map((event) => event.toolName),
    ['exec', 'lookup'],
  );
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.ok(execResult);
  assert.match(JSON.stringify(execResult.content), /"ok":true/);
});

test('does not materialize hidden nested image results', async () => {
  let attachmentReads = 0;
  const imageTool: MakaTool = {
    name: 'read_image',
    description: 'Read an image',
    parameters: z.object({}),
    impl: () => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath: 'image.png' },
    }),
  };
  const events = await collect(
    backend(execThenStopModel('return await tools.read_image({})'), [], undefined, {
      tools: [imageTool],
      supportsVision: true,
      readAttachmentBytes: async () => {
        attachmentReads += 1;
        return { ok: true, bytes: new Uint8Array([1]) };
      },
    }).send({
      turnId: 'turn-code',
      text: 'read it',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(attachmentReads, 0);
  assert.ok(events.some((event) => event.type === 'tool_result' && event.toolUseId === 'exec-1'));
});

test('links nested activity to the durable outer exec operation', async () => {
  const prepared: ToolPreparedCommit[] = [];
  let seq = 0;
  const sink: RuntimeCommitSink = {
    commitToolPrepared: async (input) => {
      prepared.push(input);
      return { created: true, runtimeEventSeq: ++seq };
    },
    commitToolOutcome: async () => ({ created: true, runtimeEventSeq: ++seq }),
  };
  const events = await collect(
    backend(execThenStopModel(), [], sink).send({
      invocationId: 'inv-1',
      runId: 'run-1',
      turnId: 'turn-code',
      text: 'look it up',
      context: [],
      toolMode: 'code_mode',
    }),
  );
  const starts = events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool_start' }> => event.type === 'tool_start',
  );
  const outer = starts.find((event) => event.toolName === 'exec');
  const nested = starts.find((event) => event.toolName === 'lookup');
  const nestedDurable = prepared.find((commit) => commit.toolName === 'lookup')?.runtimeEvent;

  assert.ok(outer?.operationId);
  assert.equal(nested?.parentOperationId, outer.operationId);
  assert.equal(nestedDurable?.refs?.parentOperationId, outer.operationId);
  assert.equal(nestedDurable?.refs?.parentToolCallId, 'exec-1');
  assert.equal(nestedDurable?.modelVisibility, 'hidden');
});

test('propagates nested durable commit failures out of the outer exec', async () => {
  const outcomes: number[] = [];
  const sink: RuntimeCommitSink = {
    commitToolPrepared: async (input) => {
      if (input.toolName === 'lookup') throw new Error('nested T1 unavailable');
      return { created: true, runtimeEventSeq: 1 };
    },
    commitToolOutcome: async () => {
      outcomes.push(1);
      return { created: true, runtimeEventSeq: 2 };
    },
  };

  const events = await collect(
    backend(execThenStopModel(), [], sink).send({
      invocationId: 'inv-1',
      runId: 'run-1',
      turnId: 'turn-code',
      text: 'look it up',
      context: [],
      toolMode: 'code_mode',
    }),
  );
  assert.equal(
    events.some((event) => event.type === 'error' && event.recoverable === false),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_result' && event.toolUseId === 'exec-1'),
    false,
  );
  assert.deepEqual(outcomes, []);
});

test('keeps direct-only tools out of the cell snapshot', async () => {
  let implementationCalls = 0;
  const tools: MakaTool[] = [
    {
      name: 'secret_control',
      description: 'Direct control tool',
      parameters: z.object({}),
      nesting: 'direct_only',
      impl: () => {
        implementationCalls += 1;
        return { exposed: true };
      },
    },
  ];
  const events = await collect(
    backend(execThenStopModel('return await tools.secret_control({})'), [], undefined, {
      tools,
    }).send({
      turnId: 'turn-code',
      text: 'try direct control',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(implementationCalls, 0);
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.match(JSON.stringify(execResult?.content), /unknown_tool/);
});

test('keeps provider-native tools out of the cell snapshot', async () => {
  let implementationCalls = 0;
  const tools: MakaTool[] = [
    {
      name: 'native_search',
      description: 'Search through the model provider',
      parameters: z.object({}),
      providerTool: { kind: 'openai-web-search' },
      impl: () => {
        implementationCalls += 1;
        return { exposed: true };
      },
    },
  ];
  const events = await collect(
    backend(execThenStopModel('return await tools.native_search({})'), [], undefined, {
      tools,
    }).send({
      turnId: 'turn-code',
      text: 'try native search',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(implementationCalls, 0);
  assert.equal(
    events.some((event) => event.type === 'tool_start' && event.toolName === 'native_search'),
    false,
  );
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.match(JSON.stringify(execResult?.content), /unknown_tool/);
});

test('validates nested arguments before ToolRuntime implementation dispatch', async () => {
  let implementationCalls = 0;
  const tools: MakaTool[] = [
    {
      name: 'typed_lookup',
      description: 'Look up a typed node',
      parameters: z.object({ id: z.string() }),
      impl: () => {
        implementationCalls += 1;
        return { ok: true };
      },
    },
  ];
  const events = await collect(
    backend(execThenStopModel('return await tools.typed_lookup({ id: 42 })'), [], undefined, {
      tools,
    }).send({
      turnId: 'turn-code',
      text: 'use invalid arguments',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(implementationCalls, 0);
  assert.equal(
    events.some((event) => event.type === 'tool_start' && event.toolName === 'typed_lookup'),
    false,
  );
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.match(JSON.stringify(execResult?.content), /invalid arguments/i);
});

test('routes active MCP tools through the nested Runtime path', async () => {
  const calls: Array<{
    serverId: string;
    toolName: string;
    input: unknown;
    signal: AbortSignal | undefined;
  }> = [];
  const tools = buildMcpTools({
    toolSnapshot: () => ({
      revision: 1,
      tools: [
        {
          descriptor: {
            serverId: 'catalog',
            name: 'lookup',
            description: 'Look up a catalog item',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
          binding: 'catalog-lookup' as McpToolBinding,
        },
      ],
    }),
    callTool: async (_binding, input, options) => {
      calls.push({ serverId: 'catalog', toolName: 'lookup', input, signal: options?.signal });
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { id: input.id } };
    },
  });

  const events = await collect(
    backend(
      execThenStopModel('return await tools.mcp__catalog__lookup({ id: "mcp-1" })'),
      [],
      undefined,
      { tools },
    ).send({
      turnId: 'turn-code',
      text: 'look it up through MCP',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0] && { ...calls[0], signal: undefined }, {
    serverId: 'catalog',
    toolName: 'lookup',
    input: { id: 'mcp-1' },
    signal: undefined,
  });
  assert.ok(calls[0]?.signal instanceof AbortSignal);
  assert.ok(
    events.some(
      (event) => event.type === 'tool_start' && event.toolName === 'mcp__catalog__lookup',
    ),
  );
});

test('rejects invalid MCP arguments before nested Runtime dispatch', async () => {
  let implementationCalls = 0;
  const tools = buildMcpTools({
    toolSnapshot: () => ({
      revision: 1,
      tools: [
        {
          descriptor: {
            serverId: 'catalog',
            name: 'lookup',
            description: 'Look up a catalog item',
            inputSchema: {
              $schema: 'https://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          binding: 'catalog-lookup' as McpToolBinding,
        },
      ],
    }),
    callTool: async () => {
      implementationCalls += 1;
      return { content: [{ type: 'text', text: 'unexpected' }] };
    },
  });

  const events = await collect(
    backend(
      execThenStopModel('return await tools.mcp__catalog__lookup({ id: 42 })'),
      [],
      undefined,
      { tools },
    ).send({
      turnId: 'turn-code',
      text: 'use invalid MCP arguments',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(implementationCalls, 0);
  assert.equal(
    events.some(
      (event) => event.type === 'tool_start' && event.toolName === 'mcp__catalog__lookup',
    ),
    false,
  );
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.match(JSON.stringify(execResult?.content), /invalid arguments/i);
});

test('records artifacts produced by a nested tool', async () => {
  const artifacts: ToolArtifactRecorderInput[] = [];
  const tools: MakaTool[] = [
    {
      name: 'Write',
      description: 'Write a file',
      parameters: z.object({ path: z.string(), content: z.string() }),
      impl: (input: { path: string }) => ({ path: input.path, bytes: 2 }),
    },
  ];
  await collect(
    backend(
      execThenStopModel('return await tools.Write({ path: "/tmp/maka/out.txt", content: "ok" })'),
      [],
      undefined,
      {
        tools,
        recordToolArtifacts: (input) => {
          artifacts.push(input);
        },
      },
    ).send({
      turnId: 'turn-code',
      text: 'write it',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.toolName, 'Write');
  assert.equal(artifacts[0]?.candidates[0]?.sourcePath, '/tmp/maka/out.txt');
});

test('parks a nested sandbox request and settles the outer exec after denial', async () => {
  let pendingRequest: SandboxBoundaryRequest | undefined;
  let sideEffects = 0;
  const tools: MakaTool[] = [
    {
      name: 'network_task',
      description: 'Request network authority',
      parameters: z.object({}),
      categoryHint: 'network_send',
      impl: async (_input, context) => {
        assert.ok(context.requestSandboxBoundary);
        const result = await context.requestSandboxBoundary(
          { network: { enabled: true } },
          'Fetch the requested catalog record.',
        );
        if (result.request.status !== 'approved') return result;
        sideEffects += 1;
        return result;
      },
    },
  ];
  const instance = backend(
    execThenStopModel('return await tools.network_task({})'),
    [],
    undefined,
    {
      tools,
      createSandboxBoundaryRequest: async (input) => {
        pendingRequest = {
          ...input,
          status: 'pending',
          baseRevision: 0,
          createdAt: 1,
        };
        return pendingRequest;
      },
      settleSandboxBoundaryRequest: async (input) => {
        assert.ok(pendingRequest);
        return {
          request: {
            ...pendingRequest,
            status: input.decision === 'allow' ? 'approved' : 'denied',
            settledAt: 2,
          },
          boundary: createExternalExecutionBoundary(),
          changed: false,
        };
      },
    },
  );
  const iterator = instance
    .send({
      turnId: 'turn-code',
      text: 'use the network',
      context: [],
      toolMode: 'code_mode',
    })
    [Symbol.asyncIterator]();
  const events: SessionEvent[] = [];
  let request: Extract<SessionEvent, { type: 'sandbox_boundary_request' }> | undefined;
  while (!request) {
    const item = await iterator.next();
    assert.equal(item.done, false);
    events.push(item.value);
    if (item.value.type === 'sandbox_boundary_request') request = item.value;
  }
  await instance.respondToSandboxBoundary({ requestId: request.requestId, decision: 'deny' });
  for (;;) {
    const item = await iterator.next();
    if (item.done) break;
    events.push(item.value);
  }

  assert.ok(
    events.some(
      (event) =>
        event.type === 'sandbox_boundary_decision_ack' &&
        event.requestId === request?.requestId &&
        event.decision === 'deny',
    ),
  );
  assert.ok(events.some((event) => event.type === 'tool_result' && event.toolUseId === 'exec-1'));
  assert.equal(sideEffects, 0);
});

test('aborting a parked nested sandbox request releases the outer exec', async () => {
  let markCreated: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    markCreated = resolve;
  });
  let sideEffects = 0;
  const tools: MakaTool[] = [
    {
      name: 'network_task',
      description: 'Request network authority',
      parameters: z.object({}),
      categoryHint: 'network_send',
      impl: async (_input, context) => {
        assert.ok(context.requestSandboxBoundary);
        const result = await context.requestSandboxBoundary(
          { network: { enabled: true } },
          'Fetch the requested catalog record.',
        );
        if (result.request.status === 'approved') sideEffects += 1;
        return result;
      },
    },
  ];
  const instance = backend(
    execThenStopModel('return await tools.network_task({})'),
    [],
    undefined,
    {
      tools,
      createSandboxBoundaryRequest: async (input) => {
        markCreated?.();
        return { ...input, status: 'pending', baseRevision: 0, createdAt: 1 };
      },
      settleSandboxBoundaryRequest: async (input) => ({
        request: {
          sessionId: 'session-1',
          requestId: input.requestId,
          turnId: 'turn-code',
          expansion: { network: { enabled: true } },
          justification: 'Fetch the requested catalog record.',
          status: 'denied',
          baseRevision: 0,
          createdAt: 1,
          settledAt: 2,
        },
        boundary: createExternalExecutionBoundary(),
        changed: false,
      }),
    },
  );

  const eventsPromise = collect(
    instance.send({
      turnId: 'turn-code',
      text: 'use the network',
      context: [],
      toolMode: 'code_mode',
    }),
  );
  await created;
  await instance.stop('user_stop');
  const events = await Promise.race([
    eventsPromise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('aborted nested boundary did not settle')), 100),
    ),
  ]);

  assert.equal(sideEffects, 0);
  assert.ok(events.some((event) => event.type === 'tool_result' && event.toolUseId === 'exec-1'));
});

test('aborts an owned nested tool when the outer exec is stopped', async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  let releaseTool: (() => void) | undefined;
  const toolRelease = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let nestedAborted = false;
  let nestedSettled = false;
  const tools: MakaTool[] = [
    {
      name: 'slow_task',
      description: 'Wait until stopped',
      parameters: z.object({}),
      impl: async (_input, context) => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          context.abortSignal.addEventListener(
            'abort',
            () => {
              nestedAborted = true;
              markAborted?.();
              resolve();
            },
            { once: true },
          );
        });
        await toolRelease;
        nestedSettled = true;
        throw context.abortSignal.reason;
      },
    },
  ];
  const instance = backend(execThenStopModel('return await tools.slow_task({})'), [], undefined, {
    tools,
  });
  let eventsSettled = false;
  const eventsPromise = collect(
    instance.send({
      turnId: 'turn-code',
      text: 'start it',
      context: [],
      toolMode: 'code_mode',
    }),
  ).then((events) => {
    eventsSettled = true;
    return events;
  });
  await started;
  const stopPromise = instance.stop('user_stop');
  await aborted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeTool = eventsSettled;
  releaseTool?.();
  await stopPromise;
  await eventsPromise;

  assert.equal(nestedAborted, true);
  assert.equal(settledBeforeTool, false);
  assert.equal(nestedSettled, true);
});

test('bounds aggregate nested live output under the outer exec', async () => {
  const emitted = 'x'.repeat(1024 * 1024 + 1);
  const tools: MakaTool[] = [
    {
      name: 'stream_task',
      description: 'Emit output',
      parameters: z.object({}),
      impl: (_input, context) => {
        context.emitOutput('stdout', emitted);
        return { ok: true };
      },
    },
  ];
  const events = await collect(
    backend(execThenStopModel('return await tools.stream_task({})'), [], undefined, { tools }).send(
      {
        turnId: 'turn-code',
        text: 'stream it',
        context: [],
        toolMode: 'code_mode',
      },
    ),
  );
  const outputBytes = events
    .filter(
      (event): event is Extract<SessionEvent, { type: 'tool_output_delta' }> =>
        event.type === 'tool_output_delta',
    )
    .reduce((total, event) => total + Buffer.byteLength(event.chunk), 0);
  const execResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );

  assert.ok(outputBytes <= 1024 * 1024);
  assert.match(JSON.stringify(execResult?.content), /output byte limit/i);
});

test('admits exec exclusively while allowing its nested calls', async () => {
  const implementationCalls: unknown[] = [];
  const events = await collect(
    backend(execAndDirectToolModel(), implementationCalls).send({
      turnId: 'turn-code',
      text: 'run both',
      context: [],
      toolMode: 'code_mode',
    }),
  );

  assert.deepEqual(implementationCalls, [{ id: 'nested' }]);
  const directResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'lookup-direct',
  );
  assert.equal(directResult?.isError, true);
  assert.match(JSON.stringify(directResult?.content), /cannot share an assistant step|exclusive/i);
});

function backend(
  model: MockLanguageModelV4,
  implementationCalls: unknown[] = [],
  runtimeCommitSink?: RuntimeCommitSink,
  overrides: Partial<
    Pick<
      AiSdkBackendInput,
      | 'tools'
      | 'readExecutionBoundary'
      | 'createSandboxBoundaryRequest'
      | 'settleSandboxBoundaryRequest'
      | 'recordToolArtifacts'
      | 'supportsVision'
      | 'readAttachmentBytes'
      | 'maxProviderImageRequestBytes'
    >
  > = {},
) {
  let id = 0;
  const tools: MakaTool[] = [
    {
      name: 'lookup',
      description: 'Look up a node',
      parameters: z.object({ id: z.string() }),
      impl: (input: { id: string }) => {
        implementationCalls.push(input);
        return input;
      },
    },
  ];
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools,
    maxSteps: 1,
    ...(runtimeCommitSink ? { runtimeCommitSink } : {}),
    newId: () => `id-${++id}`,
    now: () => 1,
    ...overrides,
  });
}

function execThenStopModel(
  code = 'return await tools.lookup({ id: "nested" })',
): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      const parts: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'exec-1',
                toolName: 'exec',
                input: JSON.stringify({ code }),
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
}

function execEveryTurnModel(code: string): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: `exec-${call}`,
            toolName: 'exec',
            input: JSON.stringify({ code }),
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

function capturingModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      captured.push((tools ?? []).map((tool) => tool.name).sort());
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
      ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function execAndDirectToolModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'exec-1',
          toolName: 'exec',
          input: JSON.stringify({
            code: 'return await tools.lookup({ id: "nested" })',
          }),
        },
        {
          type: 'tool-call',
          toolCallId: 'lookup-direct',
          toolName: 'lookup',
          input: JSON.stringify({ id: 'direct' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: ZERO_USAGE,
        },
      ]),
    }),
  });
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const item of iterable) void item;
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
