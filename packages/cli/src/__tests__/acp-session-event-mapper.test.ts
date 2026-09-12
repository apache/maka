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
import type { SessionEvent } from '@maka/core/events';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import { AcpSessionEventMapper } from '../acp/session-event-mapper.js';

describe('ACP Session event mapper', () => {
  test('streams text and thinking while deduplicating matching completion events', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);

    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'hel' }));
    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'lo' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hello' }));
    await mapper.accept(event({ type: 'thinking_delta', messageId: 'thought', text: 'hmm' }));
    await mapper.accept(event({ type: 'thinking_complete', messageId: 'thought', text: 'hmm' }));

    assert.deepEqual(
      notifications.map(({ update }) => update),
      [
        chunk('agent_message_chunk', 'answer', 'hel'),
        chunk('agent_message_chunk', 'answer', 'lo'),
        chunk('agent_thought_chunk', 'thought', 'hmm'),
      ],
    );
  });

  test('rejects non-prefix revisions instead of reporting a second message or success', async () => {
    for (const kind of ['text', 'thinking'] as const) {
      for (const text of ['new', '']) {
        const notifications: SessionNotification[] = [];
        const mapper = eventMapper(notifications);
        await mapper.accept(event({ type: `${kind}_delta`, messageId: 'answer', text: 'old' }));
        await assert.rejects(
          mapper.accept(event({ type: `${kind}_complete`, messageId: 'answer', text })),
          { data: { source: 'adapter', code: 'unsupported_stream_revision' } },
        );
        await assert.rejects(mapper.accept(event({ type: 'complete', stopReason: 'end_turn' })));
        assert.deepEqual(
          notifications.map(({ update }) => update),
          [chunk(kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', 'answer', 'old')],
        );
      }
    }
  });

  test('serializes canonical transcript replacement with live notifications', async () => {
    const notifications: SessionNotification[] = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const mapper = new AcpSessionEventMapper({
      sessionId: 'session-1',
      notify: async (notification) => {
        calls += 1;
        if (calls === 1) await firstPending;
        notifications.push(notification);
      },
    });

    const live = mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'old' }));
    const replacement = mapper.replaceTranscript('turn-1', [
      {
        type: 'assistant',
        id: 'answer',
        turnId: 'turn-1',
        ts: 2,
        text: 'older',
        modelId: 'model',
      },
    ]);
    releaseFirst();
    await Promise.all([live, replacement]);

    assert.equal(notifications.length, 2);
    const update = notifications[1]?.update;
    assert.equal(update?.sessionUpdate, 'agent_message_chunk');
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    assert.equal(update.content.type === 'text' && update.content.text, 'er');
    assert.equal(update.messageId, 'answer');
  });

  test('rejects a canonical message that clears already delivered thinking', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(event({ type: 'thinking_delta', messageId: 'answer', text: 'old' }));
    await assert.rejects(
      mapper.replaceTranscript('turn-1', [
        {
          type: 'assistant',
          id: 'answer',
          turnId: 'turn-1',
          ts: 2,
          text: 'answer',
          modelId: 'model',
        },
      ]),
      { data: { source: 'adapter', code: 'unsupported_stream_revision' } },
    );
    await assert.rejects(mapper.accept(event({ type: 'complete', stopReason: 'end_turn' })));
    assert.equal(notifications.length, 1);
  });

  test('leaves terminal classification to the Runtime Host Session channel', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(event({ type: 'error', recoverable: true, message: 'retry' }));
    await mapper.accept(event({ type: 'error', recoverable: false, message: 'failed' }));
    await mapper.accept(event({ type: 'complete', stopReason: 'end_turn' }));
    await mapper.accept(event({ type: 'abort', reason: 'crash' }));
    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'projected' }));

    assert.deepEqual(
      notifications.map(({ update }) => update),
      [chunk('agent_message_chunk', 'answer', 'projected')],
    );
  });

  test('flush waits for every already accepted notification', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered = false;
    const mapper = new AcpSessionEventMapper({
      sessionId: 'session-1',
      notify: async () => {
        await pending;
        delivered = true;
      },
    });

    const accepting = mapper.accept(
      event({ type: 'text_delta', messageId: 'answer', text: 'pending' }),
    );
    let flushed = false;
    const flushing = mapper.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.equal(delivered, true);
    assert.equal(flushed, true);
    await accepting;
  });

  test('replaces cumulative tool content, deduplicates output sequences and preserves stream/redaction', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(toolOutput('tool', 2, 'second', 'stderr', true));
    await mapper.accept(toolOutput('tool', 1, 'first'));
    await mapper.accept(toolOutput('tool', 2, 'second', 'stderr', true));
    await mapper.accept(
      event({
        type: 'tool_start',
        toolUseId: 'tool',
        toolName: 'Bash',
        args: undefined,
        argsPreview: { command: 'pwd' },
        activityKind: 'command',
      }),
    );
    const calls = notifications.filter(({ update }) => update.sessionUpdate === 'tool_call');
    assert.equal(calls.length, 1);
    assert.equal(notifications.length, 3);
    const update = toolUpdate(notifications.at(-1)!);
    assert.equal(update.kind, 'execute');
    assert.equal('rawInput' in update, false);
    assert.match(toolText(notifications.at(-1)!), /Input preview \(not full input\)/);
    assert.ok(
      toolText(notifications.at(-1)!).indexOf('first') <
        toolText(notifications.at(-1)!).indexOf('second'),
    );
    assert.match(toolText(notifications.at(-1)!), /\[stderr\] \[redacted\] second/);
  });

  test('an omitted result preserves live content until authoritative transcript replacement', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(toolOutput('tool', 1, 'transient output'));
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        contentOmitted: true,
        isError: false,
        durationMs: 42,
        content: { kind: 'text', text: '' },
      }),
    );
    const omitted = toolUpdate(notifications.at(-1)!);
    assert.equal(omitted.status, 'completed');
    assert.equal('content' in omitted, false);
    assert.equal('rawOutput' in omitted, false);
    await mapper.acceptTranscriptMessages('turn-1', [
      {
        type: 'tool_result',
        id: 'result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool',
        isError: false,
        durationMs: 42,
        content: { kind: 'text', text: 'authoritative result' },
      },
    ]);
    assert.equal(toolText(notifications.at(-1)!), 'authoritative result');
    assert.deepEqual(toolUpdate(notifications.at(-1)!).rawOutput, {
      kind: 'text',
      text: 'authoritative result',
    });
    const count = notifications.length;
    await mapper.accept(toolOutput('tool', 3, 'late output'));
    await mapper.accept(
      event({
        type: 'tool_result_preview',
        toolUseId: 'tool',
        isError: false,
        content: {
          kind: 'subagent',
          childSessionId: 'child',
          agentName: 'Worker',
          turnId: 'child-turn',
          status: 'running',
          permissionMode: 'ask',
        },
      }),
    );
    await mapper.finishTools('turn-1');
    assert.equal(notifications.length, count);
  });

  test('result before start creates one terminal card and late start only fills identity', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        isError: true,
        content: { kind: 'text', text: 'failed' },
        durationMs: 13,
      }),
    );
    await mapper.accept(
      event({
        type: 'tool_start',
        toolUseId: 'tool',
        toolName: 'Read',
        args: { path: '/workspace/readme' },
        activityKind: 'read',
      }),
    );
    assert.equal(
      notifications.filter(({ update }) => update.sessionUpdate === 'tool_call').length,
      1,
    );
    const update = toolUpdate(notifications.at(-1)!);
    assert.equal(update.title, 'Read');
    assert.equal(update.status, 'failed');
    assert.equal('content' in update, false);
    assert.equal((update._meta?.maka as { durationMs: number } | undefined)?.durationMs, 13);
  });

  test('progress and preview replace a snapshot containing earlier output without ending a tool', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(toolOutput('tool', 1, 'working'));
    await mapper.accept(event({ type: 'tool_progress', toolUseId: 'tool', chunk: 'steps:1/3' }));
    await mapper.accept(
      event({
        type: 'tool_result_preview',
        toolUseId: 'tool',
        isError: false,
        content: {
          kind: 'subagent',
          childSessionId: 'child',
          agentName: 'Worker',
          turnId: 'child-turn',
          status: 'running',
          permissionMode: 'ask',
        },
      }),
    );
    assert.match(toolText(notifications.at(-1)!), /working/);
    assert.match(toolText(notifications.at(-1)!), /Progress: steps:1\/3/);
    assert.match(toolText(notifications.at(-1)!), /Preview:.*Worker/);
    assert.equal(toolUpdate(notifications.at(-1)!).status, 'in_progress');
    await mapper.finishTools('turn-1', 'failed');
    assert.equal(toolUpdate(notifications.at(-1)!).status, 'failed');
    assert.match(toolText(notifications.at(-1)!), /without a result/);
  });

  test('does not label projected stored inputs as complete raw input', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    for (const toolName of ['WriteStdin', 'todo_write']) {
      await mapper.acceptTranscriptMessages('turn-1', [
        {
          type: 'tool_call',
          id: toolName,
          turnId: 'turn-1',
          ts: 1,
          toolName,
          args: { inputPreview: { text: 'safe', bytes: 4, truncated: false } },
        },
      ]);
      assert.equal('rawInput' in toolUpdate(notifications.at(-1)!), false);
    }
  });

  test('bounds live output, terminal content and raw output, including multibyte truncation', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(toolOutput('tool', 1, '😀'.repeat(40_000)));
    assert.match(toolText(notifications.at(-1)!), /truncated/);
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        isError: false,
        content: { kind: 'text', text: '😀'.repeat(40_000) },
      }),
    );
    const update = toolUpdate(notifications.at(-1)!);
    assert.ok(toolText(notifications.at(-1)!).length <= 64 * 1024);
    assert.equal('rawOutput' in update, false);
    assert.match(toolText(notifications.at(-1)!), /Result truncated/);
    assert.equal(
      Buffer.from(toolText(notifications.at(-1)!)).toString('utf8'),
      toolText(notifications.at(-1)!),
    );
  });

  test('enforces the aggregate live-tool budget with a sticky projection failure', async () => {
    const mapper = eventMapper([]);
    for (let i = 0; i < 16; i += 1)
      await mapper.accept(toolOutput(`tool-${i}`, 1, 'x'.repeat(64 * 1024)));
    await assert.rejects(mapper.accept(toolOutput('tool-17', 1, 'x')), {
      data: { source: 'adapter', code: 'tool_presentation_capacity' },
    });
    await assert.rejects(mapper.flush(), {
      data: { source: 'adapter', code: 'tool_presentation_capacity' },
    });
  });

  test('requires the authoritative result promised by an omitted terminal event', async () => {
    const mapper = eventMapper([]);
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        isError: false,
        contentOmitted: true,
        content: { kind: 'text', text: '' },
      }),
    );
    await assert.rejects(mapper.finishTools('turn-1'), {
      data: { source: 'adapter', code: 'tool_result_missing' },
    });
  });

  test('a completed turn also rejects a started tool whose result event was entirely missing', async () => {
    const mapper = eventMapper([]);
    await mapper.accept(
      event({ type: 'tool_start', toolUseId: 'tool', toolName: 'Read', args: undefined }),
    );
    await assert.rejects(mapper.finishTools('turn-1', 'completed'), {
      data: { source: 'adapter', code: 'tool_result_missing' },
    });
  });

  test('notification failure remains visible through flush and suppresses later delivery', async () => {
    let notifications = 0;
    const failure = new Error('transport failed');
    const mapper = new AcpSessionEventMapper({
      sessionId: 'session-1',
      notify: async () => {
        notifications += 1;
        throw failure;
      },
    });
    await assert.rejects(
      mapper.accept(toolOutput('tool', 1, 'first')),
      (error) => error === failure,
    );
    await assert.rejects(mapper.flush(), (error) => error === failure);
    await assert.rejects(
      mapper.accept(toolOutput('tool', 2, 'second')),
      (error) => error === failure,
    );
    assert.equal(notifications, 1);
  });

  test('keeps only bounded terminal identities and rejects the next distinct tool', async () => {
    const mapper = new AcpSessionEventMapper({ sessionId: 'session-1', notify: async () => {} });
    for (let index = 0; index < 4096; index += 1) {
      await mapper.accept(
        event({
          type: 'tool_result',
          toolUseId: `tool-${index}`,
          isError: false,
          content: { kind: 'text', text: 'done' },
        }),
      );
    }
    await assert.rejects(
      mapper.accept(
        event({
          type: 'tool_result',
          toolUseId: 'overflow',
          isError: false,
          content: { kind: 'text', text: 'done' },
        }),
      ),
      { data: { source: 'adapter', code: 'tool_presentation_capacity' } },
    );
  });

  test('repeated authoritative results and stale omitted events do not repeat terminal content', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    const result = event({
      type: 'tool_result',
      toolUseId: 'tool',
      isError: false,
      content: { kind: 'text', text: 'done' },
    });
    await mapper.accept(result);
    await mapper.accept(result);
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        isError: false,
        contentOmitted: true,
        content: { kind: 'text', text: '' },
      }),
    );
    assert.equal(notifications.length, 1);
  });

  test('interaction updates preserve Host closure reasons without reopening terminal tools', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'interaction',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run',
      revision: 1,
      status: 'pending',
      outcome: null,
      request: { kind: 'question', toolUseId: 'tool', questions: [] },
    };
    await mapper.pendingInteraction(pending);
    assert.equal(toolUpdate(notifications.at(-1)!).status, 'pending');
    await mapper.resolvedInteraction(
      {
        ...pending,
        revision: 2,
        status: 'closed',
        outcome: { kind: 'closure', reason: 'provider_disconnected', committedAt: 2 },
      },
      pending,
    );
    assert.equal(
      (
        toolUpdate(notifications.at(-1)!)._meta?.maka as
          | { interaction: { reason: string } }
          | undefined
      )?.interaction.reason,
      'provider_disconnected',
    );
    await mapper.accept(
      event({
        type: 'tool_result',
        toolUseId: 'tool',
        isError: true,
        content: { kind: 'text', text: 'closed' },
      }),
    );
    const count = notifications.length;
    await mapper.pendingInteraction(pending);
    assert.equal(notifications.length, count);
    assert.equal(toolUpdate(notifications.at(-1)!).status, 'failed');
  });
});

function toolOutput(
  toolUseId: string,
  seq: number,
  chunk: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  redacted = false,
): SessionEvent {
  return event({
    type: 'tool_output_delta',
    sessionId: 'session-1',
    toolUseId,
    toolCallId: toolUseId,
    seq,
    chunk,
    stream,
    redacted,
    createdAt: 1,
  });
}

function toolUpdate(notification: SessionNotification) {
  const update = notification.update;
  assert.ok(update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update');
  return update;
}

function toolText(notification: SessionNotification): string {
  return (toolUpdate(notification).content ?? [])
    .map((entry) =>
      entry.type === 'content' && entry.content.type === 'text' ? entry.content.text : '',
    )
    .join('\n');
}

function eventMapper(notifications: SessionNotification[]): AcpSessionEventMapper {
  return new AcpSessionEventMapper({
    sessionId: 'session-1',
    notify: async (notification) => void notifications.push(notification),
  });
}

function chunk(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  messageId: string,
  text: string,
) {
  return { sessionUpdate, content: { type: 'text' as const, text }, messageId };
}

function event<T extends Omit<SessionEvent, 'id' | 'turnId' | 'ts'>>(value: T): SessionEvent {
  return { id: 'event', turnId: 'turn-1', ts: 1, ...value } as unknown as SessionEvent;
}
