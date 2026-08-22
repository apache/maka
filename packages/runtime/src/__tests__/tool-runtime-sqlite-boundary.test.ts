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

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGenesisExecutionBoundary } from '@maka/core/sandbox-boundary';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type SessionEvent } from '@maka/core/events';
import { type SessionHeader } from '@maka/core/session';
import type { McpToolBinding } from '@maka/core/mcp';
import { createSqliteRuntimeStore } from '@maka/storage';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { buildMcpTools } from '../mcp-tools.js';
import type { InvocationContext } from '../invocation-context.js';
import { MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN, ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime with real SQLite boundary', () => {
  it('replays raw MCP model arguments without persisting the execution binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-mcp-args-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    const opaqueBinding = 'internal-binding-never-persist' as McpToolBinding;
    try {
      let providerCalls = 0;
      const [tool] = buildMcpTools({
        toolSnapshot: () => ({
          revision: 1,
          tools: [
            {
              descriptor: {
                serverId: 'fixture',
                name: 'echo',
                inputSchema: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                },
              },
              binding: opaqueBinding,
            },
          ],
        }),
        callTool: async (binding, args) => {
          providerCalls += 1;
          assert.equal(binding, opaqueBinding);
          assert.deepEqual(args, { value: 'runtime' });
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      assert.ok(tool);
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });

      await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: { value: 'runtime' },
        abortSignal: new AbortController().signal,
        eventSink: { push: () => {}, pushAndWaitUntilConsumed: async () => {} },
      });

      assert.equal(providerCalls, 1);
      const events = await store.readImmutableRuntimeEvents('session-1', 'run-1');
      const prepared = events.find((event) => event.content?.kind === 'function_call');
      assert.deepEqual(
        prepared?.content?.kind === 'function_call' ? prepared.content.args : undefined,
        { value: 'runtime' },
      );
      const replayCall = buildRuntimeEventModelReplayPlan(events).items.find(
        (item) => item.kind === 'tool_call',
      );
      assert.deepEqual(replayCall?.kind === 'tool_call' ? replayCall.input : undefined, {
        value: 'runtime',
      });
      assert.doesNotMatch(JSON.stringify(events), /internal-binding-never-persist/u);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a boundary-blocked Client Capability without an orphan response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-client-capability-reject-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      let implementationCalls = 0;
      const [clientTool] = buildMcpTools(
        {
          toolSnapshot: () => ({
            revision: 1,
            tools: [
              {
                descriptor: {
                  serverId: 'desktop_computer_use',
                  name: 'maka_computer',
                  description: 'Client-owned Computer Use',
                  inputSchema: {
                    type: 'object',
                    properties: { action: { const: 'list_apps' } },
                    required: ['action'],
                    additionalProperties: false,
                  },
                },
                binding: 'client-capability-binding' as McpToolBinding,
              },
            ],
          }),
          callTool: async () => {
            implementationCalls += 1;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
        { categoryHint: 'client_capability', recoveryMode: 'outcome_unknown' },
      );
      assert.ok(clientTool);
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        readExecutionBoundary: async () => createGenesisExecutionBoundary('ask'),
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });
      const published: SessionEvent[] = [];
      const result = await runtime.settleToolCall({
        tool: clientTool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-computer-use',
        input: { action: 'list_apps' },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => published.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            published.push(event);
          },
        },
      });

      assert.equal(implementationCalls, 0);
      assert.match(JSON.stringify(result.result), /require the Bypass execution boundary/u);
      const toolEvents = published.filter(
        (event) => event.type === 'tool_start' || event.type === 'tool_result',
      );
      assert.equal(toolEvents.length, 2);
      assert.equal(
        toolEvents.some((event) => event.operationId !== undefined),
        false,
      );

      const memory = createSessionEventMapMemory();
      for (const event of toolEvents) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          mapSessionEventToRuntimeEvent(event, invocationContext(), memory),
        );
      }
      const runtimeEvents = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        runtimeEvents.map((event) => event.content?.kind),
        ['function_call', 'function_response'],
      );
      const replayCall = buildRuntimeEventModelReplayPlan(runtimeEvents).items.find(
        (item) => item.kind === 'tool_call',
      );
      assert.deepEqual(replayCall?.kind === 'tool_call' ? replayCall.input : undefined, {
        action: 'list_apps',
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a subagent admission rejection without an orphan response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-subagent-limit-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    const releases: Array<() => void> = [];
    const pending: Promise<unknown>[] = [];
    try {
      let implementationsStarted = 0;
      let resolveAllStarted!: () => void;
      const allStarted = new Promise<void>((resolve) => {
        resolveAllStarted = resolve;
      });
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });
      const tool: MakaTool = {
        name: 'agent_probe',
        description: 'probe',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => {
          implementationsStarted += 1;
          if (implementationsStarted === MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN) resolveAllStarted();
          await new Promise<void>((resolve) => releases.push(resolve));
          return { ok: true };
        },
      };
      const quietSink = {
        push: (_event: SessionEvent) => {},
        pushAndWaitUntilConsumed: async (_event: SessionEvent) => {},
      };
      for (let index = 0; index < MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN; index += 1) {
        pending.push(
          runtime.settleToolCall({
            tool,
            turnId: 'turn-1',
            toolCallId: `provider-call-active-${index}`,
            input: {},
            abortSignal: new AbortController().signal,
            eventSink: quietSink,
          }),
        );
      }
      await withTimeout(allStarted, 'Timed out waiting for subagent slots to fill');

      const published: SessionEvent[] = [];
      const rejected = await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-rejected',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => published.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            published.push(event);
          },
        },
      });

      assert.match(JSON.stringify(rejected.result), /subagents|子代理/u);
      const toolEvents = published.filter(
        (event) => event.type === 'tool_start' || event.type === 'tool_result',
      );
      assert.equal(toolEvents.length, 2);
      assert.equal(
        toolEvents.some((event) => event.operationId !== undefined),
        false,
      );

      const memory = createSessionEventMapMemory();
      for (const event of toolEvents) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          mapSessionEventToRuntimeEvent(event, invocationContext(), memory),
        );
      }
      const rejectedEvents = (await store.readRuntimeEvents('session-1', 'run-1')).filter(
        (event) =>
          event.content?.kind === 'function_call'
            ? event.content.id === 'provider-call-rejected'
            : event.content?.kind === 'function_response' &&
              event.content.id === 'provider-call-rejected',
      );
      assert.deepEqual(
        rejectedEvents.map((event) => event.content?.kind),
        ['function_call', 'function_response'],
      );
    } finally {
      for (const release of releases) release();
      await Promise.allSettled(pending);
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a preflight-rejected sibling beside an exclusive tool without an orphan response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-exclusive-reject-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });
      const published: SessionEvent[] = [];
      const eventSink = {
        push: (event: SessionEvent) => published.push(event),
        pushAndWaitUntilConsumed: async (event: SessionEvent) => {
          published.push(event);
        },
      };
      const exclusive: MakaTool = {
        name: 'exclusive_batch',
        description: 'exclusive',
        parameters: {},
        executionSemantics: 'exclusive_step',
        impl: async () => ({ ok: true }),
      };
      const sibling: MakaTool = {
        name: 'agent_output',
        description: 'sibling',
        parameters: {},
        impl: async () => ({ ok: true }),
      };

      await runtime.settleToolCall({
        tool: exclusive,
        turnId: 'turn-1',
        stepId: 'step-1',
        toolCallId: 'provider-call-exclusive',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink,
      });
      const rejected = await runtime.settleToolCall({
        tool: sibling,
        turnId: 'turn-1',
        stepId: 'step-1',
        toolCallId: 'provider-call-rejected',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink,
      });
      // The refusal says nothing ran before it says why, and it names the tool
      // that held the step — the same wording swarm-orchestration asserts.
      assert.match(
        JSON.stringify(rejected.result),
        /Tool agent_output did not run: exclusive_batch cannot share an assistant step/i,
      );

      const memory = createSessionEventMapMemory();
      for (const event of published) {
        if (event.type !== 'tool_start' && event.type !== 'tool_result') continue;
        const runtimeEvent = mapSessionEventToRuntimeEvent(event, invocationContext(), memory);
        if (runtimeEvent.refs?.operationId !== undefined) continue;
        await store.appendRuntimeEvent('session-1', 'run-1', runtimeEvent);
      }

      const rejectedEvents = (await store.readRuntimeEvents('session-1', 'run-1')).filter(
        (event) =>
          event.content?.kind === 'function_call'
            ? event.content.id === 'provider-call-rejected'
            : event.content?.kind === 'function_response' &&
              event.content.id === 'provider-call-rejected',
      );
      assert.deepEqual(
        rejectedEvents.map((event) => event.content?.kind),
        ['function_call', 'function_response'],
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists one atomic prepared/outcome pair around the real implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      let implementationCalls = 0;
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });
      const tool: MakaTool = {
        name: 'Read',
        description: 'read',
        parameters: {},
        recoveryMode: 'replay_safe',
        impl: async () => {
          implementationCalls += 1;
          return { ok: true, text: 'contents' };
        },
      };

      const published: SessionEvent[] = [];

      await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => published.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            published.push(event);
          },
        },
      });

      assert.equal(implementationCalls, 1);
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.content?.kind),
        ['function_call', undefined, 'function_response'],
      );
      const operationId = events[0]?.refs?.operationId;
      assert.ok(operationId);
      assert.equal((await store.readToolOperation(operationId))?.currentState, 'outcome_committed');
      assert.deepEqual(
        events.map((event) => event.invocationId),
        ['invocation-1', 'invocation-1', 'invocation-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal(operationId)).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);

      const context = invocationContext();
      const memory = createSessionEventMapMemory();
      const durableEvents = published.filter(
        (event) => event.type === 'tool_start' || event.type === 'tool_result',
      );
      assert.equal(durableEvents.length, 2);
      const mappedEvents = durableEvents.map((event) =>
        mapSessionEventToRuntimeEvent(event, context, memory),
      );
      assert.deepEqual(
        mappedEvents,
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' || event.content?.kind === 'function_response',
        ),
      );

      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 3);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the same normalized error event that the Runtime flow later observes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-sqlite-error-'));
    const store = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const runtime = createTestToolRuntime({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: store,
      });
      const published: SessionEvent[] = [];
      const tool: MakaTool = {
        name: 'Read',
        description: 'read',
        parameters: {},
        recoveryMode: 'replay_safe',
        impl: async () => {
          throw new Error('disk read failed');
        },
      };

      await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => published.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            published.push(event);
          },
        },
      });

      const memory = createSessionEventMapMemory();
      const mappedEvents = published
        .filter((item) => item.type === 'tool_start' || item.type === 'tool_result')
        .map((event) => mapSessionEventToRuntimeEvent(event, invocationContext(), memory));
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        mappedEvents,
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' || event.content?.kind === 'function_response',
        ),
      );
      assert.equal(events.length, 3);
      assert.equal(events[2]?.content?.kind, 'function_response');
      assert.equal(
        events[2]?.content?.kind === 'function_response' ? events[2].content.isError : undefined,
        true,
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function header(): SessionHeader {
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

function invocationContext(): InvocationContext {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    source: 'test',
    startedAt: 1,
    newId: nextId(),
    now: () => 1,
    request: {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      text: 'test',
      source: 'test',
    },
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
  let value = 0;
  return () => ++value;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
