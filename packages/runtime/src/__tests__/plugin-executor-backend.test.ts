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
import type { HostedFormSettlement } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { PluginExecutorBackend } from '../plugin-executor-backend.js';
import { Context } from '../plugin-kernel.js';
import { PluginExecutorService, type PluginExecutorResult } from '../plugin-executor-service.js';

for (const result of [
  { status: 'completed', text: 'done' },
  { status: 'cancelled', providerStopReason: 'cancelled' },
  { status: 'failed', message: 'Agent refused the request' },
] satisfies PluginExecutorResult[]) {
  for (const detached of [false, true]) {
    test(`Plugin acknowledgement for ${result.status} requires terminal consumption (detached: ${detached})`, async () => {
      const root = new Context();
      const service = new PluginExecutorService(root);
      const acknowledgements: string[] = [];
      const abandonments: string[] = [];
      root
        .extend({
          maka: { rootId: 'profile', packageId: 'fixture', entryId: 'provider', generation: 1 },
        })
        .executors.register({
          id: 'remote',
          execute: async () => result,
          acknowledgeExecution: async (conversationKey, turnId) => {
            acknowledgements.push(`${conversationKey}/${turnId}`);
          },
          abandonExecution: async (conversationKey, turnId) => {
            abandonments.push(`${conversationKey}/${turnId}`);
          },
        });
      const backend = new PluginExecutorBackend({
        sessionId: 'session-a',
        cwd: '/workspace',
        binding: service.bind('session-a', 'remote'),
      });
      try {
        const iterator = backend.send({ turnId: 'turn-a', text: 'task' })[Symbol.asyncIterator]();
        assert.equal(
          (await iterator.next()).value?.type,
          result.status === 'completed'
            ? 'text_complete'
            : result.status === 'cancelled'
              ? 'abort'
              : 'error',
        );
        assert.deepEqual(acknowledgements, []);
        assert.equal((await iterator.next()).value?.type, 'complete');
        assert.deepEqual(
          acknowledgements,
          [],
          'terminal delivery is not itself an acknowledgement',
        );
        if (detached) {
          await iterator.return?.();
          assert.deepEqual(
            acknowledgements,
            [],
            'an unconsumed terminal event cannot be acknowledged',
          );
          assert.deepEqual(abandonments, ['session-a/turn-a']);
        } else {
          assert.equal((await iterator.next()).done, true);
          assert.deepEqual(acknowledgements, ['session-a/turn-a']);
          assert.deepEqual(abandonments, []);
        }
      } finally {
        await backend.dispose();
        await root.fiber.dispose();
      }
    });
  }
}

test('failed Plugin acknowledgement abandons the settled external execution', async () => {
  const { root, binding } = fixture(async () => ({ status: 'completed', text: 'done' }));
  const abandoned: string[] = [];
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding: {
      ...binding,
      acknowledgeExecution: async () => {
        throw new Error('checkpoint unavailable');
      },
      abandonExecution: async (conversationKey, turnId) => {
        abandoned.push(`${conversationKey}/${turnId}`);
      },
    },
  });
  try {
    await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
    assert.deepEqual(abandoned, ['session-a/turn-a']);
  } finally {
    await backend.dispose();
    await root.fiber.dispose();
  }
});

test('a settled Plugin result that the Runtime rejects is abandoned once', async () => {
  const { root, backend, acknowledged, abandoned } = recordingFixture(async () => ({
    status: 'completed',
    text: 'x'.repeat(256 * 1024 + 1),
  }));
  try {
    const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
    assert.match(events[0]?.type === 'error' ? events[0].message : '', /completion text exceeds/u);
    assert.deepEqual(acknowledged, []);
    assert.deepEqual(abandoned, ['session-a/turn-a']);
  } finally {
    await backend.dispose();
    await root.fiber.dispose();
  }
});

test('a Plugin execution that fails before settling is neither acknowledged nor abandoned', async () => {
  const { root, backend, acknowledged, abandoned } = recordingFixture(async () => {
    throw new Error('transient transport failure');
  });
  try {
    const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
    assert.match(events[0]?.type === 'error' ? events[0].message : '', /transient transport/u);
    assert.deepEqual(acknowledged, []);
    assert.deepEqual(abandoned, []);
  } finally {
    await backend.dispose();
    await root.fiber.dispose();
  }
});

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

test('oversized executor completion fails without emitting a large text_complete event', async () => {
  const { root, binding } = fixture(async (_request, context) => {
    context.emit({ type: 'output_delta', text: 'streamed' });
    return { status: 'completed', text: 'x'.repeat(256 * 1024 + 1) };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
  });

  const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_delta', 'text_complete', 'error', 'complete'],
  );
  assert.equal(events[1]?.type === 'text_complete' ? events[1].text : undefined, 'streamed');
  assert.equal(events[1]?.type === 'text_complete' ? events[1].interrupted : undefined, true);
  assert.match(events[2]?.type === 'error' ? events[2].message : '', /completion text exceeds/u);
  assert.equal(events[3]?.type === 'complete' ? events[3].stopReason : undefined, 'error');
  await root.fiber.dispose();
});

for (const outcome of ['cancelled', 'failed', 'transport-error', 'oversized-completion'] as const) {
  test(`interrupted executor text stays bounded after ${outcome}`, async () => {
    const chunk = 'x'.repeat(16 * 1024);
    const { root, binding } = fixture(async (_request, context) => {
      for (let index = 0; index < 17; index++) context.emit({ type: 'output_delta', text: chunk });
      context.emit({ type: 'output_delta', text: 'late update' });
      if (outcome === 'transport-error') throw new Error('transport ended');
      if (outcome === 'oversized-completion')
        return { status: 'completed', text: chunk.repeat(17) };
      return outcome === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'failed', message: 'provider failed' };
    });
    const backend = new PluginExecutorBackend({
      sessionId: 'session-a',
      cwd: '/workspace',
      binding,
    });
    try {
      const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
      const answers = events.filter((event) => event.type === 'text_complete');
      assert.equal(answers.length, 1);
      const answer = answers[0]!;
      assert.equal(Buffer.byteLength(answer.text), 256 * 1024);
      assert.equal(answer.interrupted, true);
      const marker = '\n[Response truncated]';
      assert.equal(answer.text, 'x'.repeat(256 * 1024 - Buffer.byteLength(marker)) + marker);
      assert.equal(events.filter((event) => event.type === 'text_delta').length, 18);
      const terminal = events.find((event) => event.type === 'complete');
      assert.equal(terminal?.stopReason, outcome === 'cancelled' ? 'user_stop' : 'error');
    } finally {
      await backend.dispose();
      await root.fiber.dispose();
    }
  });
}

for (const scenario of [
  {
    name: 'one oversized Unicode delta',
    chunks: ['中🙂'.repeat(100_000)],
    expected: '中🙂'.repeat(Math.floor((256 * 1024 - 21) / 7)) + '\n[Response truncated]',
  },
  {
    name: 'a surrogate pair split across deltas at the exact limit',
    chunks: ['x'.repeat(256 * 1024 - 4), '\ud83d', '\ude42'],
    expected: 'x'.repeat(256 * 1024 - 4) + '🙂',
  },
  {
    name: 'a Unicode boundary before the truncation marker',
    chunks: ['x'.repeat(256 * 1024 - 25), '\ud83d', '\ude42', 'z'.repeat(26)],
    expected: 'x'.repeat(256 * 1024 - 25) + '🙂\n[Response truncated]',
  },
]) {
  test(`interrupted executor text preserves ${scenario.name}`, async () => {
    const { root, backend } = recordingFixture(async (_request, context) => {
      for (const text of scenario.chunks) context.emit({ type: 'output_delta', text });
      return { status: 'cancelled' };
    });
    try {
      const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
      const answers = events.filter((event) => event.type === 'text_complete');
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.text, scenario.expected);
      assert.ok(Buffer.byteLength(answers[0]!.text) <= 256 * 1024);
      assert.equal(Buffer.from(answers[0]!.text, 'utf8').toString('utf8'), answers[0]?.text);
    } finally {
      await backend.dispose();
      await root.fiber.dispose();
    }
  });
}

test('a bounded interrupted buffer does not replace a successful provider answer', async () => {
  const { root, backend, acknowledged } = recordingFixture(async (_request, context) => {
    context.emit({ type: 'output_delta', text: 'x'.repeat(256 * 1024 + 1) });
    return { status: 'completed', text: 'authoritative answer' };
  });
  try {
    const events = await collect(backend.send({ turnId: 'turn-a', text: 'task' }));
    const answers = events.filter((event) => event.type === 'text_complete');
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.text, 'authoritative answer');
    assert.equal(answers[0]?.interrupted, undefined);
    assert.deepEqual(acknowledged, ['session-a/turn-a']);
  } finally {
    await backend.dispose();
    await root.fiber.dispose();
  }
});

test('executor backend turns stop into abort and terminal events', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { root, binding } = fixture(async (_request, context) => {
    started();
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
    return { status: 'cancelled', providerStopReason: 'end_turn' };
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
  assert.equal(
    events[1]?.type === 'complete' ? events[1].providerStopReason : undefined,
    'end_turn',
  );
  await root.fiber.dispose();
});

test('executor stop releases its drain wait when the consumer detaches', {
  timeout: 5_000,
}, async () => {
  const { root, backend, acknowledged, abandoned } = recordingFixture(async (_request, context) => {
    context.emit({ type: 'output_delta', text: 'before stop' });
    await new Promise<void>((resolve) =>
      context.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    context.emit({ type: 'output_delta', text: 'after stop' });
    return { status: 'cancelled' };
  });
  const iterator = backend.send({ turnId: 'turn-a', text: 'task' })[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value?.type, 'text_delta');
    const stopping = backend.stop('user_stop');
    await iterator.return?.();
    await stopping;
    assert.deepEqual(acknowledged, []);
    assert.deepEqual(abandoned, ['session-a/turn-a']);
  } finally {
    await iterator.return?.();
    await backend.dispose();
    await root.fiber.dispose();
  }
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
      context.emit({ type: 'tool_output_delta', toolCallId: 'external-1', text: 'working' });
      context.emit({ type: 'tool_progress', toolCallId: 'external-1', text: 'steps:1/2' });
      context.emit({
        type: 'tool_result',
        toolCallId: 'external-1',
        content: { kind: 'file_diff', paths: ['README.md'], diff: '--- a/README.md' },
      });
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
      'tool_output_delta',
      'tool_progress',
      'tool_result',
      'thinking_complete',
      'text_complete',
      'complete',
    ],
  );
  assert.equal(events[1]?.type === 'tool_start' ? events[1].providerExecuted : undefined, true);
  assert.deepEqual(
    events[2]?.type === 'tool_output_delta'
      ? {
          sessionId: events[2].sessionId,
          toolCallId: events[2].toolCallId,
          toolUseId: events[2].toolUseId,
          seq: events[2].seq,
          stream: events[2].stream,
          chunk: events[2].chunk,
          redacted: events[2].redacted,
        }
      : undefined,
    {
      sessionId: 'session-a',
      toolCallId: events[1]?.type === 'tool_start' ? events[1].toolUseId : undefined,
      toolUseId: events[1]?.type === 'tool_start' ? events[1].toolUseId : undefined,
      seq: 1,
      stream: 'stdout',
      chunk: 'working',
      redacted: false,
    },
  );
  assert.deepEqual(events[4]?.type === 'tool_result' ? events[4].content : undefined, {
    kind: 'file_diff',
    paths: ['README.md'],
    diff: '--- a/README.md',
  });
  const stepId = events[0]?.type === 'thinking_delta' ? events[0].messageId : undefined;
  assert.equal(events[1]?.type === 'tool_start' ? events[1].stepId : undefined, stepId);
  assert.equal(events[5]?.type === 'thinking_complete' ? events[5].messageId : undefined, stepId);
  assert.equal(events[6]?.type === 'text_complete' ? events[6].messageId : undefined, stepId);
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

test('executor permission requests use the hosted form authority', async () => {
  const { root, binding } = fixture(async (_request, context) => {
    const result = await context.requestPermission({
      toolCallId: 'external-1',
      title: 'Allow Antigravity to edit?',
      options: [
        { optionId: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', name: 'Reject once' },
      ],
    });
    assert.deepEqual(result, { outcome: 'selected', optionId: 'allow_once' });
    return { status: 'completed', text: 'approved' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
    newId: ids(),
    now: () => 42,
  });
  let settlement: HostedFormSettlement | undefined;
  const events: SessionEvent[] = [];
  for await (const event of backend.send({
    turnId: 'turn-a',
    text: 'task',
    hostedInteraction: {
      sessionId: 'session-a',
      turnId: 'turn-a',
      runId: 'run-a',
      admitUserQuestionRequest: async () => undefined,
      admitSandboxBoundaryRequest: async () => undefined,
      admitFormRequest: async (input) => {
        settlement = input.settlement;
      },
      withdrawFormRequest: async () => undefined,
    },
  })) {
    events.push(event);
    if (event.type === 'form_request') {
      assert.equal(event.requester.name, 'remote');
      assert.equal(event.fields[0]?.kind, 'single_select');
      await settlement?.applyAnswer({ action: 'accept', values: { optionId: 'allow_once' } });
    }
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['form_request', 'text_complete', 'complete'],
  );
  await root.fiber.dispose();
});

test('executor questions round-trip original choices through hosted forms', async () => {
  const { root, binding } = fixture(async (_request, context) => {
    const result = await context.requestPermission({
      kind: 'question',
      toolCallId: 'external-1',
      title: 'Choose alpha or beta?',
      options: [
        { optionId: 'opaque:beta/2', name: 'Beta' },
        { optionId: 'reject_once', name: 'Reject once' },
      ],
    });
    assert.deepEqual(result, { outcome: 'selected', optionId: 'opaque:beta/2' });
    return { status: 'completed', text: 'approved' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding,
    newId: ids(),
    now: () => 42,
  });
  let settlement: HostedFormSettlement | undefined;
  const events: SessionEvent[] = [];
  for await (const event of backend.send({
    turnId: 'turn-a',
    text: 'task',
    hostedInteraction: {
      sessionId: 'session-a',
      turnId: 'turn-a',
      runId: 'run-a',
      admitUserQuestionRequest: async () => undefined,
      admitSandboxBoundaryRequest: async () => undefined,
      admitFormRequest: async (input) => {
        settlement = input.settlement;
      },
      withdrawFormRequest: async () => undefined,
    },
  })) {
    events.push(event);
    if (event.type === 'form_request') {
      assert.equal(event.requester.name, 'remote');
      assert.equal(event.fields[0]?.kind, 'single_select');
      assert.equal(event.fields[0]?.label, 'Question');
      await settlement?.applyAnswer({ action: 'accept', values: { optionId: 'opaque:beta/2' } });
    }
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['form_request', 'text_complete', 'complete'],
  );
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

function recordingFixture(execute: Parameters<PluginExecutorService['register']>[0]['execute']): {
  root: Context;
  backend: PluginExecutorBackend;
  acknowledged: string[];
  abandoned: string[];
} {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const acknowledged: string[] = [];
  const abandoned: string[] = [];
  root
    .extend({
      maka: { rootId: 'profile', packageId: 'fixture', entryId: 'provider', generation: 1 },
    })
    .executors.register({
      id: 'remote',
      execute,
      acknowledgeExecution: async (conversationKey, turnId) => {
        acknowledged.push(`${conversationKey}/${turnId}`);
      },
      abandonExecution: async (conversationKey, turnId) => {
        abandoned.push(`${conversationKey}/${turnId}`);
      },
    });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    binding: service.bind('session-a', 'remote'),
  });
  return { root, backend, acknowledged, abandoned };
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
