import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';
import { createSqliteRuntimeStore } from '@maka/storage';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime with real SQLite boundary', () => {
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
        name: 'agent_swarm',
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
      assert.match(JSON.stringify(rejected.result), /exclusive tool agent_swarm/i);

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
