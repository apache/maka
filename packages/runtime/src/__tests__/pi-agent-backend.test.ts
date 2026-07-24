import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BackendKind, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { createSessionStore } from '@maka/storage';

import { PermissionEngine } from '../permission-engine.js';
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
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_000) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(2_500) }),
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
        permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_250) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_500) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_700) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_900) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(2_500) }),
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

  test('parks ACP permission requests until respondToPermission resolves them', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(3_000) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: { command: 'rm -rf tmp' },
          categoryHint: 'shell_unsafe',
        },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'executed' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_000),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'delete temp files', context: [] })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');
    const requestId = first.value?.type === 'permission_request' ? first.value.requestId : '';

    const secondPromise = iterator.next();
    const race = await Promise.race([
      secondPromise.then(() => 'advanced'),
      sleep(10).then(() => 'parked'),
    ]);
    assert.equal(race, 'parked');
    assert.equal(
      messages.some((message) => message.type === 'tool_result'),
      false,
    );

    await backend.respondToPermission({ requestId, decision: 'deny' });
    const second = await secondPromise;
    assert.equal(second.value?.type, 'permission_decision_ack');
    const third = await iterator.next();
    assert.equal(third.value?.type, 'tool_result');
    assert.equal(third.value?.type === 'tool_result' ? third.value.isError : false, true);
  });

  test('isolates canonical Pi args from transport, storage, permission, and event owners', async () => {
    const initialArgs = {
      command: 'printf password=super-secret',
      options: { columns: 120 },
    };
    const projectedArgs = {
      command: 'printf password=[redacted]',
      options: { columns: 120 },
    };
    const permissionArgs = structuredClone(initialArgs);
    const toolStartArgs = structuredClone(initialArgs);
    let storedArgs: unknown;
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => {
        if (message.type !== 'tool_call') return;
        storedArgs = structuredClone(message.args);
        mutatePiArgs(message.args, 'storage');
      },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(4_100) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: permissionArgs,
          categoryHint: 'shell_unsafe',
        },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Bash', args: toolStartArgs },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'executed' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_200),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'run command', context: [] })
      [Symbol.asyncIterator]();
    const permission = await iterator.next();
    assert.equal(permission.value?.type, 'permission_request');
    if (permission.value?.type !== 'permission_request') return;
    assert.deepEqual(permission.value.args, initialArgs);
    mutatePiArgs(permissionArgs, 'transport');

    await backend.respondToPermission({ requestId: permission.value.requestId, decision: 'allow' });
    assert.equal((await iterator.next()).value?.type, 'permission_decision_ack');
    const toolStart = await iterator.next();
    assert.equal(toolStart.value?.type, 'tool_start');
    assert.deepEqual(
      toolStart.value?.type === 'tool_start' ? toolStart.value.args : undefined,
      projectedArgs,
    );
    if (toolStart.value?.type === 'tool_start') mutatePiArgs(toolStart.value.args, 'event');

    while (!(await iterator.next()).done) {
      // Drain the turn so the backend releases its permission state.
    }

    assert.deepEqual(storedArgs, projectedArgs);
    assert.equal(permissionArgs.command, 'transport');
    assert.deepEqual(toolStartArgs, initialArgs);
  });

  test('snapshots a Pi tool-start frame before awaiting assistant persistence', async () => {
    const approvedArgs = { command: 'printf approved' };
    const driftingArgs = { command: 'rm -rf workspace' };
    let signalAssistantAppend!: () => void;
    const assistantAppendStarted = new Promise<void>((resolve) => {
      signalAssistantAppend = resolve;
    });
    let releaseAssistantAppend!: () => void;
    const assistantAppendReleased = new Promise<void>((resolve) => {
      releaseAssistantAppend = resolve;
    });
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => {
        if (message.type !== 'assistant') return;
        signalAssistantAppend();
        await assistantAppendReleased;
      },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(4_250) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: approvedArgs,
          categoryHint: 'shell_unsafe',
        },
        { type: 'text_delta', text: 'running now' },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Bash', args: driftingArgs },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_275),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'run command', context: [] })
      [Symbol.asyncIterator]();
    const permission = await iterator.next();
    assert.equal(permission.value?.type, 'permission_request');
    if (permission.value?.type !== 'permission_request') return;
    await backend.respondToPermission({ requestId: permission.value.requestId, decision: 'allow' });
    assert.equal((await iterator.next()).value?.type, 'permission_decision_ack');
    assert.equal((await iterator.next()).value?.type, 'text_delta');

    const terminal = iterator.next();
    await assistantAppendStarted;
    driftingArgs.command = approvedArgs.command;
    releaseAssistantAppend();

    const error = await terminal;
    assert.equal(error.value?.type, 'error');
    assert.equal(
      error.value?.type === 'error' ? error.value.reason : undefined,
      'pi_agent_transport_error',
    );
    assert.equal((await iterator.next()).value?.type, 'complete');
  });

  test('fails closed when a later Pi frame changes the canonical invocation', async (t) => {
    const cases = [
      {
        name: 'tool name',
        first: {
          toolName: 'Bash',
          args: { command: 'printf approved' },
          categoryHint: 'shell_unsafe' as const,
        },
        later: { toolName: 'Write', args: { command: 'printf approved' } },
        expectedStoredArgs: { command: 'printf approved' },
      },
      {
        name: 'arguments',
        first: {
          toolName: 'Bash',
          args: { command: 'printf approved' },
          categoryHint: 'shell_unsafe' as const,
        },
        later: { toolName: 'Bash', args: { command: 'printf changed' } },
        expectedStoredArgs: { command: 'printf approved' },
      },
      {
        name: 'private Computer Use arguments with the same approval summary',
        first: {
          toolName: 'maka_computer',
          args: {
            action: 'type',
            app: 'Example',
            observation_id: 'frame-1',
            text: 'first secret',
            coordinate: [10, 20],
          },
          categoryHint: 'computer_use' as const,
        },
        later: {
          toolName: 'maka_computer',
          args: {
            action: 'type',
            app: 'Example',
            observation_id: 'frame-1',
            text: 'second secret',
            coordinate: [30, 40],
          },
        },
        expectedStoredArgs: {
          action: 'type',
          approvalClass: 'keyboard_mutation',
          rememberForTurnAllowed: true,
          app: 'Example',
          observationId: 'frame-1',
        },
      },
    ];

    for (const drift of cases) {
      await t.test(drift.name, async () => {
        const messages: StoredMessage[] = [];
        const backend = new PiAgentBackend({
          sessionId: 'session-1',
          header: header({ permissionMode: 'ask' }),
          appendMessage: async (message) => {
            messages.push(message);
          },
          permissionEngine: new PermissionEngine({
            newId: nextId('permission'),
            now: nextNow(4_300),
          }),
          transport: frames([
            {
              type: 'permission_request',
              toolUseId: 'tool-1',
              toolName: drift.first.toolName,
              args: drift.first.args,
              categoryHint: drift.first.categoryHint,
            },
            {
              type: 'tool_start',
              toolUseId: 'tool-1',
              toolName: drift.later.toolName,
              args: drift.later.args,
            },
            {
              type: 'tool_result',
              toolUseId: 'tool-1',
              content: { kind: 'text', text: 'executed' },
            },
            { type: 'complete' },
          ]),
          newId: nextId('id'),
          now: nextNow(4_400),
        });

        const iterator = backend
          .send({ turnId: 'turn-1', text: 'run command', context: [] })
          [Symbol.asyncIterator]();
        const permission = await iterator.next();
        assert.equal(permission.value?.type, 'permission_request');
        if (permission.value?.type !== 'permission_request') return;
        await backend.respondToPermission({
          requestId: permission.value.requestId,
          decision: 'allow',
        });

        const remaining: SessionEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          remaining.push(next.value);
        }

        assert.deepEqual(
          remaining.map((event) => event.type),
          ['permission_decision_ack', 'error', 'complete'],
        );
        assert.equal(
          remaining.some((event) => event.type === 'tool_start' || event.type === 'tool_result'),
          false,
        );
        const storedCall = messages.find((message) => message.type === 'tool_call');
        assert.deepEqual(
          storedCall?.type === 'tool_call' ? storedCall.args : undefined,
          drift.expectedStoredArgs,
        );
        if (drift.first.categoryHint === 'computer_use') {
          assert.doesNotMatch(JSON.stringify(messages), /first secret|10|20/);
        }
      });
    }
  });

  test('fails closed on Pi frame drift after permission suppression', async (t) => {
    const cases = [
      {
        name: 'policy block',
        permissionMode: 'explore' as const,
        expectedTypes: ['tool_result', 'error', 'complete'],
      },
      {
        name: 'user denial',
        permissionMode: 'ask' as const,
        expectedTypes: [
          'permission_request',
          'permission_decision_ack',
          'tool_result',
          'error',
          'complete',
        ],
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const backend = new PiAgentBackend({
          sessionId: 'session-1',
          header: header({ permissionMode: scenario.permissionMode }),
          appendMessage: async () => {},
          permissionEngine: new PermissionEngine({
            newId: nextId('permission'),
            now: nextNow(4_500),
          }),
          transport: frames([
            {
              type: 'permission_request',
              toolUseId: 'tool-1',
              toolName: 'Bash',
              args: { command: 'printf approved' },
              categoryHint: 'shell_unsafe',
            },
            {
              type: 'tool_start',
              toolUseId: 'tool-1',
              toolName: 'Bash',
              args: { command: 'printf changed' },
            },
            { type: 'complete' },
          ]),
          newId: nextId('id'),
          now: nextNow(4_600),
        });

        const iterator = backend
          .send({ turnId: 'turn-1', text: 'run command', context: [] })
          [Symbol.asyncIterator]();
        const events: SessionEvent[] = [];
        const first = await iterator.next();
        if (!first.done) events.push(first.value);
        if (first.value?.type === 'permission_request') {
          await backend.respondToPermission({ requestId: first.value.requestId, decision: 'deny' });
        }
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        assert.deepEqual(
          events.map((event) => event.type),
          scenario.expectedTypes,
        );
        assert.equal(
          events.some((event) => event.type === 'tool_start'),
          false,
        );
        const error = events.find((event) => event.type === 'error');
        assert.equal(
          error?.type === 'error' ? error.reason : undefined,
          'pi_agent_transport_error',
        );
      });
    }
  });

  test('preserves the computer_use category and redacts Computer Use permission args', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(4_200) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'maka_computer',
          args: {
            action: 'type',
            app: 'Example',
            observation_id: 'frame-1',
            text: 'secret text',
            coordinate: [123, 456],
          },
          categoryHint: 'computer_use',
        },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_300),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'type', context: [] })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');
    if (first.value?.type !== 'permission_request') return;
    assert.equal(first.value.category, 'computer_use');
    assert.equal(first.value.reason, 'computer_use');
    assert.deepEqual(first.value.args, {
      action: 'type',
      approvalClass: 'keyboard_mutation',
      rememberForTurnAllowed: true,
      app: 'Example',
      observationId: 'frame-1',
    });
    const toolCall = messages.find((message) => message.type === 'tool_call');
    assert.deepEqual(toolCall?.type === 'tool_call' ? toolCall.args : undefined, first.value.args);
    assert.doesNotMatch(JSON.stringify(messages), /secret text|123|456/);
  });

  test('projects raw Computer Use tool_start args before persistence or emission', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'bypass' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      permissionEngine: new PermissionEngine({
        newId: nextId('permission'),
        now: nextNow(4_400),
      }),
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
    const expected = {
      action: 'type',
      approvalClass: 'keyboard_mutation',
      rememberForTurnAllowed: true,
      app: 'Example',
      windowId: 42,
      observationId: 'frame-1',
    };
    assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, expected);
    const toolCall = messages.find((message) => message.type === 'tool_call');
    assert.deepEqual(toolCall?.type === 'tool_call' ? toolCall.args : undefined, expected);
    assert.doesNotMatch(JSON.stringify(events), /secret text|123|456/);
    assert.doesNotMatch(JSON.stringify(messages), /secret text|123|456/);
  });

  test('suppresses later child output for a denied permission request', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => {
        messages.push(message);
      },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(4_500) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: { command: 'rm -rf tmp' },
          categoryHint: 'shell_unsafe',
        },
        {
          type: 'tool_start',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: { command: 'rm -rf tmp' },
        },
        {
          type: 'tool_output_delta',
          toolUseId: 'tool-1',
          stream: 'stdout',
          chunk: 'deleted tmp\n',
        },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'executed' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_600),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'delete temp files', context: [] })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');
    const requestId = first.value?.type === 'permission_request' ? first.value.requestId : '';

    const secondPromise = iterator.next();
    await backend.respondToPermission({ requestId, decision: 'deny' });
    const events = [
      (await secondPromise).value,
      (await iterator.next()).value,
      (await iterator.next()).value,
    ].filter(Boolean) as SessionEvent[];

    assert.deepEqual(
      events.map((event) => event.type),
      ['permission_decision_ack', 'tool_result', 'complete'],
    );
    const toolResults = messages.filter((message) => message.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.type === 'tool_result' ? toolResults[0].isError : false, true);
    assert.equal(JSON.stringify(toolResults).includes('executed'), false);
  });

  test('stop aborts a parked permission request and disposes the transport', async () => {
    let stopReason: string | null = null;
    let disposed = false;
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async () => {},
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(5_000) }),
      transport: {
        ...frames([
          {
            type: 'permission_request',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            args: { command: 'rm -rf tmp' },
            categoryHint: 'shell_unsafe',
          },
        ]),
        stop: async (reason) => {
          stopReason = reason;
        },
        dispose: async () => {
          disposed = true;
        },
      },
      newId: nextId('id'),
      now: nextNow(6_000),
    });

    const iterator = backend
      .send({ turnId: 'turn-1', text: 'delete temp files', context: [] })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');

    await backend.stop('user_stop');
    const second = await iterator.next();
    assert.equal(second.value?.type, 'tool_result');
    assert.equal(second.value?.type === 'tool_result' ? second.value.isError : false, true);
    assert.equal(stopReason, 'user_stop');

    await backend.dispose();
    assert.equal(disposed, true);
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
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(7_000) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(9_000) }),
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
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(11_000) }),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutatePiArgs(value: unknown, owner: string): void {
  const mutable = value as { command: string; options: { columns: number } };
  mutable.command = owner;
  mutable.options.columns = owner.length;
}
