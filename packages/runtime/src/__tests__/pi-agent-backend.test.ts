import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BackendKind, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { createSessionStore } from '@maka/storage';

import {
  PiAgentBackend,
  normalizePiAgentFrame,
  type PiAgentFrame,
  type PiAgentTransport,
} from '../pi-agent-backend.js';

describe('PiAgentBackend skeleton', () => {
  test('normalizes fake transport text and tool frames to Maka events and storage records', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        { type: 'text_delta', text: 'hello ' },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: { path: 'README.md' } },
        { type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'stdout', chunk: 'reading\n' },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'file body' } },
        { type: 'text_delta', text: 'world' },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_000),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'text_delta',
        'tool_start',
        'tool_output_delta',
        'tool_result',
        'text_complete',
        'text_delta',
        'text_complete',
        'complete',
      ],
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'assistant').map((message) => message.text),
      ['hello ', 'world'],
    );
    assert.equal(
      messages.some((message) => message.type === 'tool_call' && message.toolName === 'Read'),
      true,
    );
    assert.equal(
      messages.some((message) => message.type === 'tool_result' && message.toolUseId === 'tool-1'),
      true,
    );
  });

  test('includes the truncation marker within the Core tool output limit', async () => {
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async () => undefined,
      transport: frames([
        {
          type: 'tool_output_delta',
          toolUseId: 'tool-1',
          stream: 'stdout',
          chunk: '界'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS + 1),
        },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_600),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));
    const outputs = events.filter(
      (event): event is Extract<SessionEvent, { type: 'tool_output_delta' }> =>
        event.type === 'tool_output_delta',
    );
    assert.equal(outputs.length, 1);
    const output = outputs[0];
    assert.ok(output);
    assert.ok(output.chunk.length <= TOOL_OUTPUT_DELTA_MAX_CHARS);
    assert.match(output.chunk, /\n\[内容已截断\]$/);
    assert.match(output.id, /^id-\d+$/);
    assert.equal(output.seq, 1);
  });

  test('normalizes noncanonical tool payloads before strict storage recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-pi-canonical-'));
    try {
      const store = createSessionStore(root);
      const session = await store.create({
        cwd: root,
        backend: 'pi-agent',
        llmConnectionSlug: 'pi-agent',
        model: 'pi-test',
        permissionMode: 'execute',
      });
      const backend = new PiAgentBackend({
        sessionId: session.id,
        header: session,
        appendMessage: (message) => store.appendMessage(session.id, message),
        transport: frames([
          { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read' },
          { type: 'tool_result', toolUseId: 'tool-1' },
          {
            type: 'tool_start',
            toolUseId: 'tool-2',
            toolName: 'Weather',
            args: { city: 'Singapore' },
          },
          {
            type: 'tool_result',
            toolUseId: 'tool-2',
            content: { kind: 'weather', temperature: 20 },
          },
          { type: 'complete' },
        ]),
        newId: nextId('id'),
        now: nextNow(2_250),
      });

      await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));

      const messages = await store.readMessagesForRecovery(session.id);
      const toolCalls = messages.filter((message) => message.type === 'tool_call');
      const toolResults = messages.filter((message) => message.type === 'tool_result');
      assert.equal(toolCalls[0]?.args, null);
      assert.deepEqual(toolResults[0]?.content, { kind: 'json', value: null });
      assert.deepEqual(toolResults[1]?.content, {
        kind: 'json',
        value: { kind: 'weather', temperature: 20 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists Pi text-tool-text as two stable assistant steps', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        { type: 'text_delta', text: 'before tool' },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: { path: 'README.md' } },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'file body' } },
        { type: 'text_delta', text: 'after tool' },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_500),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));
    const assistants = messages.filter((message) => message.type === 'assistant');
    const toolCall = messages.find((message) => message.type === 'tool_call');
    const toolStart = events.find((event) => event.type === 'tool_start');

    assert.deepEqual(
      assistants.map((message) => message.text),
      ['before tool', 'after tool'],
    );
    assert.deepEqual(
      messages.map((message) => message.type),
      ['assistant', 'tool_call', 'tool_result', 'assistant'],
    );
    assert.equal(toolCall?.type === 'tool_call' ? toolCall.stepId : undefined, assistants[0]?.id);
    assert.equal(
      toolStart?.type === 'tool_start' ? toolStart.stepId : undefined,
      assistants[0]?.id,
    );
  });

  test('keeps sequential Pi tools in one step when no model text separates them', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: { path: 'a' } },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'a' } },
        { type: 'tool_start', toolUseId: 'tool-2', toolName: 'Read', args: { path: 'b' } },
        { type: 'tool_result', toolUseId: 'tool-2', content: { kind: 'text', text: 'b' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_700),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));
    const stepIds = events
      .filter((event) => event.type === 'tool_start')
      .map((event) => event.stepId);

    assert.equal(stepIds.length, 2);
    assert.equal(stepIds[1], stepIds[0]);
  });

  test('rotates the local step id when Pi repeats a provider message id after tools', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        { type: 'text_delta', messageId: 'provider-message-1', text: 'before' },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: {} },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'ok' } },
        { type: 'text_delta', messageId: 'provider-message-1', text: 'af' },
        { type: 'text_delta', messageId: 'provider-message-1', text: 'ter' },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_900),
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));
    const assistants = messages.filter((message) => message.type === 'assistant');

    assert.deepEqual(
      assistants.map((message) => message.text),
      ['before', 'after'],
    );
    assert.notEqual(assistants[1]?.id, assistants[0]?.id);
  });

  test('normalizes token usage frames to Maka events and storage records', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        {
          type: 'token_usage',
          input: 10,
          output: 4,
          cacheHitInput: 2,
          cacheWriteInput: 3,
          total: 17,
          costUsd: 0.0012,
        },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_600),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );

    assert.equal(usage?.input, 10);
    assert.equal(usage?.output, 4);
    assert.equal(usage?.cacheHitInput, 2);
    assert.equal(usage?.cacheRead, 2);
    assert.equal(usage?.cacheWriteInput, 3);
    assert.equal(usage?.cacheCreation, 3);
    assert.equal(usage?.total, 17);
    assert.equal(usage?.costUsd, 0.0012);
    assert.equal(
      messages.some((message) => message.type === 'token_usage' && message.costUsd === 0.0012),
      true,
    );
  });

  test('projects raw Computer Use tool_start args before persistence or emission', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'bypass' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        {
          type: 'tool_start',
          toolUseId: 'tool-1',
          toolName: 'maka_computer',
          args: {
            action: 'type',
            app: 'Example',
            window_id: 42,
            observation_id: 'frame-1',
            text: 'secret text',
            coordinate: [123, 456],
          },
        },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_450),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({
      turnId: 'turn-1',
      text: 'type',
      context: [],
    })) {
      events.push(event);
    }
    const start = events.find((event) => event.type === 'tool_start');
    // This is the record the model reads back as its own call, so it is written
    // in the tool's argument names: `window_id`, not the approval projection's
    // `windowId`, and without the two fields the host adds for a permission
    // decision. Every argument the call carried keeps its key — a call shown
    // with no `text` is a shape the model will send again — and every value
    // that came off the screen or out of a person is reduced to what it was.
    // The coordinate is neither: the model chose it, so it comes back whole.
    const expected = {
      action: 'type',
      app: 'Example',
      window_id: 42,
      observation_id: 'frame-1',
      text: '<text>',
      coordinate: [123, 456],
    };
    assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, expected);
    const toolCall = messages.find((message) => message.type === 'tool_call');
    assert.deepEqual(toolCall?.type === 'tool_call' ? toolCall.args : undefined, expected);
    // The typed text is what a person asked to be written; it stays out. The
    // coordinate is the model's own argument and is not checked here.
    assert.doesNotMatch(JSON.stringify(events), /secret text/);
    assert.doesNotMatch(JSON.stringify(messages), /secret text/);
  });

  test('persists partial Pi text before aborting an active stream', async () => {
    const messages: StoredMessage[] = [];
    let releaseTransport!: () => void;
    const transportReleased = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: {
        async *send() {
          yield { type: 'text_delta', text: 'partial answer' };
          await transportReleased;
          yield { type: 'complete' };
        },
        stop: async () => {
          releaseTransport();
        },
      },
      newId: nextId('id'),
      now: nextNow(8_000),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'answer', context: [] })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'text_delta');

    await backend.stop('user_stop');
    const terminalEvents = [(await iterator.next()).value, (await iterator.next()).value].filter(
      Boolean,
    ) as SessionEvent[];

    assert.deepEqual(
      terminalEvents.map((event) => event.type),
      ['abort', 'complete'],
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'assistant').map((message) => message.text),
      ['partial answer'],
    );
  });

  test('persists partial Pi text before a reported terminal error', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: frames([
        { type: 'text_delta', text: 'partial answer' },
        { type: 'error', message: 'provider failed' },
      ]),
      newId: nextId('id'),
      now: nextNow(10_000),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'answer', context: [] }));

    assert.deepEqual(
      events.map((event) => event.type),
      ['text_delta', 'error', 'complete'],
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'assistant').map((message) => message.text),
      ['partial answer'],
    );
  });

  test('persists partial Pi text before a transport failure', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      transport: {
        async *send() {
          yield { type: 'text_delta', text: 'partial answer' };
          throw new Error('transport failed');
        },
      },
      newId: nextId('id'),
      now: nextNow(12_000),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'answer', context: [] }));

    assert.deepEqual(
      events.map((event) => event.type),
      ['text_delta', 'error', 'complete'],
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'assistant').map((message) => message.text),
      ['partial answer'],
    );
  });

  test('frame guard ignores unknown ACP frames before they reach renderer event code', () => {
    assert.equal(normalizePiAgentFrame({ type: 'session/update', raw: true }), null);
    assert.deepEqual(
      normalizePiAgentFrame({
        type: 'tool_output_delta',
        toolUseId: 'tool-1',
        stream: 'nonsense',
        chunk: 'ok',
      }),
      { type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'stdout', chunk: 'ok' },
    );
  });
});

function frames(items: PiAgentFrame[]): PiAgentTransport {
  return {
    async *send() {
      for (const item of items) yield item;
    },
  };
}

async function drain(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Pi test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'pi-agent' as BackendKind,
    llmConnectionSlug: 'pi-agent',
    connectionLocked: true,
    model: 'pi-test',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

function nextId(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function nextNow(start: number): () => number {
  let now = start;
  return () => now++;
}
