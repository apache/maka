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
import type { SessionEvent } from '@maka/core/events';
import { PluginExecutorBackend } from '../plugin-executor-backend.js';
import { Context } from '../plugin-kernel.js';
import { PluginExecutorService } from '../plugin-executor-service.js';

test('executor backend converts plugin output and result to ordinary Session events', async () => {
  const { root, binding } = fixture(async (request, context) => {
    assert.equal(request.instructions, 'child instructions');
    assert.equal(request.model, 'gpt-codex');
    assert.equal(request.reasoningEffort, 'high');
    context.emit({ type: 'output_delta', text: 'hel' });
    return { status: 'completed', text: 'hello' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    instructions: 'child instructions',
    model: 'gpt-codex',
    thinkingLevel: 'high',
    binding,
    newId: ids(),
    now: () => 42,
  });

  const events = await collect(backend.send({ turnId: 'turn-a', runId: 'run-a', text: 'task' }));
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_delta', 'text_complete', 'complete'],
  );
  assert.equal(events[0]?.turnId, 'turn-a');
  assert.equal(events[0]?.type === 'text_delta' ? events[0].text : undefined, 'hel');
  assert.equal(events[1]?.type === 'text_complete' ? events[1].text : undefined, 'hello');
  assert.equal(events[2]?.type === 'complete' ? events[2].stopReason : undefined, 'end_turn');
  await root.fiber.dispose();
});

test('executor backend turns stop into abort and terminal events', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { root, binding } = fixture(async (_request, context) => {
    started();
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
    return { status: 'cancelled' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
  });

  const eventsPromise = collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  await ready;
  await backend.stop('user_stop');
  const events = await eventsPromise;
  assert.deepEqual(
    events.map((event) => event.type),
    ['abort', 'complete'],
  );
  assert.equal(events[1]?.type === 'complete' ? events[1].stopReason : undefined, 'user_stop');
  await root.fiber.dispose();
});

test('executor backend projects optional thinking and external tool activity', async () => {
  const { root, binding } = fixture(
    async (_request, context) => {
      context.emit({ type: 'thinking_delta', text: 'considering' });
      context.emit({
        type: 'tool_start',
        toolCallId: 'external-1',
        name: 'search',
        input: { query: 'maka' },
        activityKind: 'search',
      });
      context.emit({ type: 'tool_progress', toolCallId: 'external-1', text: 'working' });
      context.emit({ type: 'tool_result', toolCallId: 'external-1', text: 'found' });
      return { status: 'completed', text: 'done' };
    },
    { thinking: true, toolActivity: true },
  );
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
    newId: ids(),
    now: () => 42,
  });

  const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'thinking_delta',
      'tool_start',
      'tool_progress',
      'tool_result',
      'thinking_complete',
      'text_complete',
      'complete',
    ],
  );
  assert.equal(events[1]?.type === 'tool_start' ? events[1].providerExecuted : undefined, true);
  const stepId = events[0]?.type === 'thinking_delta' ? events[0].messageId : undefined;
  assert.equal(events[1]?.type === 'tool_start' ? events[1].stepId : undefined, stepId);
  assert.equal(events[4]?.type === 'thinking_complete' ? events[4].messageId : undefined, stepId);
  assert.equal(events[5]?.type === 'text_complete' ? events[5].messageId : undefined, stepId);
  await root.fiber.dispose();
});

test('executor retirement remains cancellation and is surfaced as a crash abort', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { root, binding, dispose } = fixture(async (_request, context) => {
    started();
    await new Promise<void>((_resolve, reject) =>
      context.signal.addEventListener('abort', () => reject(context.signal.reason)),
    );
    return { status: 'completed', text: 'unreachable' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
  });

  const eventsPromise = collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  await ready;
  await dispose();
  const events = await eventsPromise;
  assert.equal(events[0]?.type === 'abort' ? events[0].reason : undefined, 'crash');
  assert.equal(events[1]?.type === 'complete' ? events[1].stopReason : undefined, 'user_stop');
  await root.fiber.dispose();
});

test('executor failure closes rich output before publishing its terminal error', async () => {
  const { root, binding } = fixture(
    async (_request, context) => {
      context.emit({ type: 'thinking_delta', text: 'partial thought' });
      context.emit({ type: 'tool_start', toolCallId: 'external-1', name: 'search' });
      throw new Error('provider crashed');
    },
    { thinking: true, toolActivity: true },
  );
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
    newId: ids(),
    now: () => 42,
  });

  const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  assert.deepEqual(
    events.map((event) => event.type),
    ['thinking_delta', 'tool_start', 'thinking_complete', 'tool_result', 'error', 'complete'],
  );
  assert.equal(events[3]?.type === 'tool_result' ? events[3].isError : undefined, true);
  assert.equal(events[4]?.type === 'error' ? events[4].message : undefined, 'provider crashed');
  await root.fiber.dispose();
});

function fixture(
  execute: Parameters<PluginExecutorService['register']>[0]['execute'],
  capabilities?: Parameters<PluginExecutorService['register']>[0]['capabilities'],
): {
  root: Context;
  binding: ReturnType<PluginExecutorService['bind']>;
  dispose: ReturnType<PluginExecutorService['register']>;
} {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const dispose = root
    .extend({
      maka: { rootId: 'profile', packageId: 'fixture', entryId: 'provider', generation: 1 },
    })
    .executors.register({ id: 'remote', execute, ...(capabilities ? { capabilities } : {}) });
  return { root, binding: service.bind('session-a', 'remote'), dispose };
}

function ids(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const result: SessionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
