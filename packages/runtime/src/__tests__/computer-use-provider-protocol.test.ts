import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';

import type { LlmConnection } from '@maka/core/llm-connections';

import type { SessionEvent } from '@maka/core/events';

import type { SessionHeader, StoredMessage } from '@maka/core/session';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
} from '../computer-use-tools.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureRecord,
} from '../provider-request-telemetry.js';
import { backfillRuntimeEventsFromStoredMessages } from '../runtime-event-backfill.js';
import { createDurableTurnHarness } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';
import { latestObservationIn } from './observation-text-reader.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('Anthropic-compatible Computer Use product loops', () => {
  for (const provider of [
    {
      providerType: 'kimi-coding-plan',
      modelId: 'kimi-for-coding',
      baseSuffix: '/coding',
      expectedPath: '/coding/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: 'enabled',
      expectedWireOutputLimit: 32_768,
      apiProtocol: undefined,
    },
    {
      providerType: 'kimi-coding-plan',
      modelId: 'k3',
      baseSuffix: '/coding',
      expectedPath: '/coding/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: 'adaptive',
      expectedWireOutputLimit: 131_072,
      apiProtocol: undefined,
    },
    {
      providerType: 'minimax-coding-plan',
      modelId: 'MiniMax-M3',
      baseSuffix: '/anthropic',
      expectedPath: '/anthropic/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: undefined,
      expectedWireOutputLimit: 128_000,
      apiProtocol: undefined,
    },
    {
      providerType: 'github-copilot',
      modelId: 'future-claude-model',
      baseSuffix: '/copilot',
      expectedPath: '/copilot/v1/messages',
      auth: 'authorization',
      expectedAuth: 'Bearer test-key',
      expectedThinking: undefined,
      expectedWireOutputLimit: 128_000,
      apiProtocol: 'anthropic-messages',
    },
  ] as const) {
    test(`${provider.providerType}/${provider.modelId} completes a multi-step semantic model loop`, async () => {
      const sessionId = `session-${provider.providerType}`;
      const durable = createDurableTurnHarness({
        sessionId,
        turnId: 'turn-1',
        text: 'Set the fixture field to provider-loop.',
      });
      const requestBodies: Array<Record<string, unknown>> = [];
      const captures: ProviderRequestCaptureRecord[] = [];
      const attempts: ProviderRequestAttemptRecord[] = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, provider.expectedPath);
        assert.equal(request.headers[provider.auth], provider.expectedAuth);
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        assert.equal(body.model, provider.modelId);
        requestBodies.push(body);
        const step = requestBodies.length;
        const toolInput =
          step === 1
            ? { action: 'list_apps' }
            : step === 2
              ? {
                  action: 'observe',
                  app: 'pid:42',
                  window_id: 7,
                  include_screenshot: false,
                }
              : step === 3
                ? semanticInputFromMessages(body.messages)
                : undefined;
        respondAnthropicStream(
          response,
          provider.modelId,
          step,
          toolInput,
          provider.expectedThinking !== undefined,
        );
      });
      const value = { current: '' };
      const [computerTool] = buildComputerUseTools({
        backend: fakeSemanticBackend(value),
      });
      const events: SessionEvent[] = [];
      const toolResults: Array<{ isError: boolean }> = [];
      const providerConnection = connection(
        provider.providerType,
        `${server.url}${provider.baseSuffix}`,
        provider.modelId,
        provider.apiProtocol,
        provider.expectedWireOutputLimit,
      );
      const runtime = createTestAiSdkBackend({
        sessionId,
        header: header(provider.providerType, provider.modelId),
        appendMessage: async () => {},
        connection: providerConnection,
        apiKey: 'test-key',
        modelId: provider.modelId,
        modelFactory: (input) => getAIModel(input),
        providerOptions: buildProviderOptions(providerConnection, provider.modelId),
        tools: [computerTool],
        maxSteps: 6,
        loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
        newId: idGenerator(),
        now: monotonicClock(),
        recordProviderRequestCapture: async (capture) => {
          captures.push(capture);
          return { artifactId: `capture-artifact-${captures.length}` };
        },
        recordProviderRequestAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      for await (const event of runtime.send(durable.sendInput())) {
        durable.record(event);
        events.push(event);
        if (event.type === 'tool_result') {
          toolResults.push({ isError: event.isError });
        }
      }

      assert.equal(
        value.current,
        'provider-loop',
        JSON.stringify({
          requestCount: requestBodies.length,
          eventTypes: events.map((event) => event.type),
          toolResults,
        }),
      );
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(requestBodies.length, 4);
      assert.equal(captures.length, 4);
      assert.equal(attempts.length, 4);
      assert.deepEqual(toolResults, [{ isError: false }, { isError: false }, { isError: false }]);
      assert.deepEqual(
        (requestBodies[0].tools as Array<{ name: string }>).map((tool) => tool.name),
        ['maka_computer'],
      );
      if (provider.expectedThinking) {
        for (const body of requestBodies) {
          assert.equal(
            (body.thinking as { type?: string } | undefined)?.type,
            provider.expectedThinking,
            'Kimi Coding Plan must send its model-specific thinking mode on every turn',
          );
          assert.deepEqual(body.output_config, { effort: 'max' });
        }
        assertAnthropicThinkingReplay(requestBodies[1]?.messages, 1);
        assertAnthropicThinkingReplay(requestBodies[2]?.messages, 2);
        assertAnthropicThinkingReplay(requestBodies[3]?.messages, 3);
      }
      for (const attempt of attempts) {
        assert.equal(attempt.status, 'completed');
        assert.equal(attempt.inputTokens, 15);
        assert.equal(attempt.cacheReadInputTokens, 4);
        assert.equal(attempt.cacheReadInputSource, 'provider');
        assert.equal(attempt.cacheWriteInputTokens, 1);
        assert.equal(attempt.cacheWriteInputSource, 'provider');
        assert.equal(attempt.cacheMissInputTokens, 10);
        assert.equal(attempt.cacheMissInputSource, 'provider');
        assert.equal(attempt.outputTokens, 5);
      }
      for (const body of requestBodies) {
        assert.equal(
          body.max_tokens,
          provider.expectedWireOutputLimit,
          'Anthropic-compatible requests must honor their model wire output limit',
        );
      }
      assert.ok(
        containsToolResult(requestBodies[3]?.messages, 'toolu-3'),
        'final semantic tool result must be reinjected into the closing provider request',
      );
      const finalObservation = latestObservationIn(requestBodies[3]?.messages);
      assert.ok(
        finalObservation?.elements.some((element) => element.value === 'provider-loop'),
        'final provider request must contain the post-action observation',
      );
    });

    test(`${provider.providerType}/${provider.modelId} reinjects a failed semantic action as an error tool result`, async () => {
      const sessionId = `session-${provider.providerType}-failure`;
      const durable = createDurableTurnHarness({
        sessionId,
        turnId: 'turn-failure',
        text: 'Attempt to update the fixture field.',
      });
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, provider.expectedPath);
        assert.equal(request.headers[provider.auth], provider.expectedAuth);
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        assert.equal(body.model, provider.modelId);
        requestBodies.push(body);
        const step = requestBodies.length;
        const toolInput =
          step === 1
            ? {
                action: 'observe',
                app: 'pid:42',
                window_id: 7,
                include_screenshot: false,
              }
            : step === 2
              ? semanticInputFromMessages(body.messages)
              : undefined;
        respondAnthropicStream(response, provider.modelId, step, toolInput);
      });
      const value = { current: 'unchanged' };
      const [computerTool] = buildComputerUseTools({
        backend: failingSemanticBackend(value),
      });
      const events: SessionEvent[] = [];
      const runtime = createTestAiSdkBackend({
        sessionId,
        header: header(provider.providerType, provider.modelId),
        appendMessage: async () => {},
        connection: connection(
          provider.providerType,
          `${server.url}${provider.baseSuffix}`,
          provider.modelId,
          provider.apiProtocol,
          provider.expectedWireOutputLimit,
        ),
        apiKey: 'test-key',
        modelId: provider.modelId,
        modelFactory: (input) => getAIModel(input),
        tools: [computerTool],
        maxSteps: 4,
        loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
        newId: idGenerator(),
        now: monotonicClock(),
      });

      for await (const event of runtime.send(durable.sendInput())) {
        durable.record(event);
        events.push(event);
      }

      const toolResults = events.filter(
        (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
          event.type === 'tool_result',
      );
      assert.equal(requestBodies.length, 3);
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(
        events.some((event) => event.type === 'error'),
        false,
      );
      assert.equal(value.current, 'unchanged');
      assert.deepEqual(
        toolResults.map((event) => ({ toolUseId: event.toolUseId, isError: event.isError })),
        [
          { toolUseId: 'toolu-1', isError: false },
          { toolUseId: 'toolu-2', isError: true },
        ],
      );
      const reinjectedFailure = findToolResult(requestBodies[2]?.messages, 'toolu-2');
      assert.ok(reinjectedFailure, 'failed semantic result must reach the next provider request');
      assert.equal(
        reinjectedFailure.is_error ?? reinjectedFailure.isError,
        true,
        `failed semantic result must use the provider error-tool-result protocol: ${JSON.stringify(reinjectedFailure)}`,
      );
      assert.match(JSON.stringify(reinjectedFailure), /outcome_unknown/);
      assert.match(JSON.stringify(reinjectedFailure), /computer\.set_value failed/);
    });
  }
});

describe('OpenAI-compatible product loops', () => {
  for (const provider of [
    {
      providerType: 'deepseek',
      modelId: 'deepseek-v4-pro',
      responseField: 'reasoning_content',
      requestField: 'reasoning_content',
    },
    {
      providerType: 'ollama-cloud',
      modelId: 'glm-5.2',
      responseField: 'reasoning_content',
      requestField: 'reasoning',
    },
  ] as const) {
    test(`${provider.providerType} replays observed reasoning as its declared request field`, async () => {
      const sessionId = `session-${provider.providerType}-openai-chat`;
      const durable = createDurableTurnHarness({
        sessionId,
        turnId: `turn-${provider.providerType}-openai-chat`,
        text: 'List the available applications.',
      });
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        requestBodies.push(body);
        const step = requestBodies.length;
        respondOpenAiStream(
          response,
          provider.modelId,
          step,
          step === 1 ? { action: 'list_apps' } : undefined,
          provider.responseField,
        );
      });
      const [computerTool] = buildComputerUseTools({
        backend: fakeSemanticBackend({ current: '' }),
      });
      const providerConnection = connection(
        provider.providerType,
        `${server.url}/v1`,
        provider.modelId,
        'openai-chat',
      );
      const runtime = createTestAiSdkBackend({
        sessionId,
        header: header(provider.providerType, provider.modelId),
        appendMessage: async () => {},
        connection: providerConnection,
        apiKey: 'test-key',
        modelId: provider.modelId,
        modelFactory: (input) => getAIModel(input),
        tools: [computerTool],
        maxSteps: 2,
        loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
        newId: idGenerator(),
        now: monotonicClock(),
      });

      for await (const event of runtime.send(durable.sendInput())) durable.record(event);

      assert.equal(requestBodies.length, 2);
      const replayedAssistant = (requestBodies[1]!.messages as unknown[]).find(
        (message) =>
          isRecord(message) &&
          message.role === 'assistant' &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.some((toolCall) => isRecord(toolCall) && toolCall.id === 'call-1'),
      );
      assert.ok(replayedAssistant && isRecord(replayedAssistant));
      assert.equal(replayedAssistant[provider.requestField], 'reasoning-step-1');
      assert.equal(
        replayedAssistant[
          provider.requestField === 'reasoning' ? 'reasoning_content' : 'reasoning'
        ],
        undefined,
      );
    });
  }

  test('reconstructs a recovered reasoning and tool-call step as one assistant message', async () => {
    const sessionId = 'session-kimi-openai-recovered-tool-step';
    const previousTurnId = 'turn-kimi-openai-recovered-tool-step-1';
    const currentTurn = createDurableTurnHarness({
      sessionId,
      turnId: 'turn-kimi-openai-recovered-tool-step-2',
      text: 'Continue after the recovered tool step.',
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/coding/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      respondOpenAiTextStream(response, 'k3', 1, 'reasoning_content', 'next step');
    });
    const providerConnection = connection(
      'kimi-coding-plan',
      `${server.url}/coding`,
      'k3',
      'openai-chat',
      131_072,
    );
    const recovered = backfillRuntimeEventsFromStoredMessages({
      run: {
        runId: 'run-kimi-openai-recovered-tool-step',
        invocationId: 'invocation-kimi-openai-recovered-tool-step',
        sessionId,
        turnId: previousTurnId,
        status: 'completed',
        backendKind: 'ai-sdk',
        llmConnectionSlug: providerConnection.slug,
        modelId: 'k3',
        cwd: '/tmp/maka',
        permissionMode: 'ask',
        createdAt: 1,
        updatedAt: 5,
        completedAt: 5,
      } satisfies AgentRunHeader,
      messages: [
        {
          type: 'user',
          id: 'stored-user-recovered',
          turnId: previousTurnId,
          ts: 1,
          text: 'Inspect the application.',
        },
        {
          type: 'assistant',
          id: 'stored-step-recovered',
          turnId: previousTurnId,
          ts: 2,
          text: 'I will inspect it.',
          modelId: 'k3',
          thinking: {
            text: '',
            providerOptions: { maka: { kimiReasoningField: 'reasoning_content' } },
          },
        },
        {
          type: 'tool_call',
          id: 'call-recovered',
          turnId: previousTurnId,
          ts: 3,
          toolName: 'maka_computer',
          args: { action: 'list_apps' },
          stepId: 'stored-step-recovered',
        },
        {
          type: 'tool_result',
          id: 'result-recovered',
          turnId: previousTurnId,
          ts: 4,
          toolUseId: 'call-recovered',
          isError: false,
          content: { kind: 'text', text: 'Application list' },
        },
      ] satisfies StoredMessage[],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const runtime = createTestAiSdkBackend({
      sessionId,
      header: header('kimi-coding-plan', 'k3'),
      appendMessage: async () => {},
      connection: providerConnection,
      apiKey: 'test-key',
      modelId: 'k3',
      modelFactory: (input) => getAIModel(input),
      providerOptions: buildProviderOptions(providerConnection, 'k3'),
      tools: [],
      maxSteps: 1,
      loadTurnRuntimeEvents: currentTurn.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of runtime.send(
      currentTurn.sendInput({ runtimeContext: recovered.events }),
    )) {
      currentTurn.record(event);
    }

    assert.equal(requestBodies.length, 1);
    const messages = requestBodies[0]!.messages;
    assert.ok(Array.isArray(messages));
    const replayedStep = messages.find(
      (message) =>
        isRecord(message) &&
        message.role === 'assistant' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.some(
          (toolCall) => isRecord(toolCall) && toolCall.id === 'call-recovered',
        ),
    );
    assert.ok(replayedStep && isRecord(replayedStep));
    assert.equal(replayedStep.content, 'I will inspect it.');
    assert.equal(replayedStep.reasoning_content, '');
    const replayedResult = messages.find(
      (message) =>
        isRecord(message) && message.role === 'tool' && message.tool_call_id === 'call-recovered',
    );
    assert.ok(replayedResult, 'the recovered result must follow its reconstructed tool call');
  });

  test('replays explicit empty reasoning after missing-ledger recovery and backend recreation', async () => {
    const sessionId = 'session-kimi-openai-cross-turn';
    const firstTurn = createDurableTurnHarness({
      sessionId,
      turnId: 'turn-kimi-openai-1',
      text: 'First turn.',
    });
    const secondTurn = createDurableTurnHarness({
      sessionId,
      turnId: 'turn-kimi-openai-2',
      text: 'Second turn.',
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    const storedMessages: StoredMessage[] = [
      {
        type: 'user',
        id: 'stored-user-1',
        turnId: firstTurn.anchor.turnId,
        ts: firstTurn.anchor.ts,
        text: 'First turn.',
      },
    ];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/coding/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const step = requestBodies.length;
      respondOpenAiTextStream(response, 'k3', step, 'reasoning', step === 1 ? '' : 'second');
    });
    const providerConnection = connection(
      'kimi-coding-plan',
      `${server.url}/coding`,
      'k3',
      'openai-chat',
      131_072,
    );
    const createRuntime = () =>
      createTestAiSdkBackend({
        sessionId,
        header: header('kimi-coding-plan', 'k3'),
        appendMessage: async (message) => {
          storedMessages.push(structuredClone(message));
        },
        connection: providerConnection,
        apiKey: 'test-key',
        modelId: 'k3',
        modelFactory: (input) => getAIModel(input),
        providerOptions: buildProviderOptions(providerConnection, 'k3'),
        tools: [],
        maxSteps: 1,
        loadTurnRuntimeEvents: async (turnId) =>
          [...firstTurn.ledger, ...secondTurn.ledger].filter((event) => event.turnId === turnId),
        newId: idGenerator(),
        now: monotonicClock(),
      });

    for await (const event of createRuntime().send(firstTurn.sendInput())) firstTurn.record(event);
    assert.ok(
      firstTurn.ledger.some(
        (event) => event.content?.kind === 'thinking' && event.content.text === '',
      ),
      'the first turn must durably preserve the provider-authored empty reasoning field',
    );

    const recovered = backfillRuntimeEventsFromStoredMessages({
      run: {
        runId: firstTurn.anchor.runId,
        invocationId: firstTurn.anchor.invocationId,
        sessionId,
        turnId: firstTurn.anchor.turnId,
        status: 'completed',
        backendKind: 'ai-sdk',
        llmConnectionSlug: providerConnection.slug,
        modelId: 'k3',
        cwd: '/tmp/maka',
        permissionMode: 'ask',
        createdAt: firstTurn.anchor.ts,
        updatedAt: firstTurn.anchor.ts + 1,
        completedAt: firstTurn.anchor.ts + 1,
      } satisfies AgentRunHeader,
      messages: storedMessages,
      newId: idGenerator(),
      now: monotonicClock(),
    });
    assert.ok(
      recovered.events.some(
        (event) =>
          event.content?.kind === 'thinking' &&
          event.content.text === '' &&
          isRecord(event.content.providerOptions),
      ),
      'missing-ledger recovery must preserve explicit empty reasoning and its provider dialect',
    );

    for await (const event of createRuntime().send(
      secondTurn.sendInput({ runtimeContext: recovered.events }),
    )) {
      secondTurn.record(event);
    }

    assert.equal(requestBodies.length, 2);
    const replayedAssistant = (requestBodies[1]!.messages as unknown[]).find(
      (message) =>
        isRecord(message) &&
        message.role === 'assistant' &&
        (typeof message.reasoning === 'string' || typeof message.reasoning_content === 'string'),
    );
    assert.ok(replayedAssistant && isRecord(replayedAssistant));
    assert.equal(replayedAssistant.reasoning, '', JSON.stringify(requestBodies[1]!.messages));
    assert.equal(replayedAssistant.reasoning_content, undefined);
  });

  test('preserves reasoning, tool pairing, and normalized request telemetry across steps', async () => {
    const sessionId = 'session-kimi-openai';
    const durable = createDurableTurnHarness({
      sessionId,
      turnId: 'turn-kimi-openai',
      text: 'Set the fixture field to provider-loop.',
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    const captures: ProviderRequestCaptureRecord[] = [];
    const attempts: ProviderRequestAttemptRecord[] = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/coding/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer test-key');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const step = requestBodies.length;
      const toolInput =
        step === 1
          ? { action: 'list_apps' }
          : step === 2
            ? {
                action: 'observe',
                app: 'pid:42',
                window_id: 7,
                include_screenshot: false,
              }
            : step === 3
              ? semanticInputFromMessages(body.messages)
              : undefined;
      respondOpenAiStream(response, 'k3', step, toolInput);
    });
    const value = { current: '' };
    const [computerTool] = buildComputerUseTools({
      backend: fakeSemanticBackend(value),
    });
    const providerConnection = connection(
      'kimi-coding-plan',
      `${server.url}/coding`,
      'k3',
      'openai-chat',
      131_072,
    );
    const events: SessionEvent[] = [];
    const runtime = createTestAiSdkBackend({
      sessionId,
      header: header('kimi-coding-plan', 'k3'),
      appendMessage: async () => {},
      connection: providerConnection,
      apiKey: 'test-key',
      modelId: 'k3',
      modelFactory: (input) => getAIModel(input),
      providerOptions: buildProviderOptions(providerConnection, 'k3'),
      tools: [computerTool],
      maxSteps: 4,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
      recordProviderRequestCapture: async (capture) => {
        captures.push(capture);
        return { artifactId: `capture-artifact-${captures.length}` };
      },
      recordProviderRequestAttempt: (attempt) => {
        attempts.push(attempt);
      },
    });

    for await (const event of runtime.send(durable.sendInput())) {
      durable.record(event);
      events.push(event);
    }

    assert.equal(
      value.current,
      'provider-loop',
      JSON.stringify({
        requestBodies,
        eventTypes: events.map((event) => event.type),
        attempts: attempts.map((attempt) => ({
          step: attempt.step,
          status: attempt.status,
          finishReason: attempt.finishReason,
        })),
      }),
    );
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(requestBodies.length, 4);
    assert.equal(captures.length, 4);
    assert.equal(attempts.length, 4);
    for (const capture of captures) {
      assert.doesNotMatch(
        capture.serializedRequest,
        /MAKA_(?:KIMI|OPENAI_CHAT)_EMPTY_REASONING/,
        'provider request evidence must not persist the SDK-only empty-reasoning marker',
      );
    }
    for (const body of requestBodies) {
      assert.equal(body.reasoning_effort, 'max');
      assert.equal(body.max_tokens, 131_072);
      assert.deepEqual(body.stream_options, { include_usage: true });
    }
    assert.deepEqual(
      (requestBodies[0]!.tools as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name,
      ),
      ['maka_computer'],
    );
    assertOpenAiReasoningAndToolPair(requestBodies[1]?.messages, 1);
    assertOpenAiReasoningAndToolPair(requestBodies[2]?.messages, 2);
    assertOpenAiReasoningAndToolPair(requestBodies[3]?.messages, 3);
    assert.deepEqual(
      attempts.map((attempt) => ({
        step: attempt.step,
        status: attempt.status,
        input: attempt.inputTokens,
        cacheRead: attempt.cacheReadInputTokens,
        cacheMiss: attempt.cacheMissInputTokens,
        output: attempt.outputTokens,
        reasoning: attempt.reasoningTokens,
      })),
      [
        {
          step: 0,
          status: 'completed',
          input: 20,
          cacheRead: 4,
          cacheMiss: 16,
          output: 7,
          reasoning: 3,
        },
        {
          step: 1,
          status: 'completed',
          input: 21,
          cacheRead: 5,
          cacheMiss: 16,
          output: 8,
          reasoning: 4,
        },
        {
          step: 2,
          status: 'completed',
          input: 22,
          cacheRead: 6,
          cacheMiss: 16,
          output: 9,
          reasoning: 5,
        },
        {
          step: 3,
          status: 'completed',
          input: 23,
          cacheRead: 7,
          cacheMiss: 16,
          output: 10,
          reasoning: 6,
        },
      ],
    );
  });
});

function fakeSemanticBackend(value: { current: string }): CuDispatchBackend {
  const observation = (): CuObservation => ({
    observationId: 'backend-observation',
    appId: 'pid:42',
    pid: 42,
    windowId: 7,
    contentFingerprint: 'fixture',
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
  });
  return {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
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
      return observation();
    },
    async runSemantic(action) {
      assert.equal(action.type, 'set_value');
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
    async run(action) {
      return {
        outcome: {
          ok: false,
          error: 'unsupported_action',
          message: `${action.type} disabled`,
        },
      };
    },
  };
}

function failingSemanticBackend(value: { current: string }): CuDispatchBackend {
  const backend = fakeSemanticBackend(value);
  return {
    ...backend,
    async runSemantic(action) {
      assert.equal(action.type, 'set_value');
      return {
        outcome: {
          ok: false,
          error: 'outcome_unknown',
          message: 'fixture refused the semantic mutation',
        },
      };
    },
  };
}

function semanticInputFromMessages(messages: unknown) {
  const observation = latestObservationIn(messages);
  assert.ok(observation, 'provider request must include the observation tool result');
  const field = observation.elements.find((element) => element.label === 'CUA Lab Set Value Field');
  assert.ok(field);
  return {
    action: 'set_value',
    observation_id: observation.observation_id,
    element_id: field.element_id,
    value: 'provider-loop',
  };
}

function containsToolResult(value: unknown, toolUseId: string): boolean {
  return Boolean(findToolResult(value, toolUseId));
}

function findToolResult(value: unknown, toolUseId: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findToolResult(entry, toolUseId);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'tool_result' &&
    (record.tool_use_id === toolUseId || record.toolUseId === toolUseId)
  ) {
    return record;
  }
  for (const entry of Object.values(record)) {
    const result = findToolResult(entry, toolUseId);
    if (result) return result;
  }
  return undefined;
}

function assertOpenAiReasoningAndToolPair(messages: unknown, step: number): void {
  assert.ok(Array.isArray(messages));
  const assistantIndex = messages.findIndex(
    (message) =>
      isRecord(message) &&
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((toolCall) => isRecord(toolCall) && toolCall.id === `call-${step}`),
  );
  const assistant = messages[assistantIndex];
  assert.ok(assistant && isRecord(assistant));
  assert.equal(assistant.reasoning, step === 1 ? '' : `reasoning-step-${step}`);
  assert.equal(assistant.reasoning_content, undefined);
  const toolResultIndex = messages.findIndex(
    (message) =>
      isRecord(message) && message.role === 'tool' && message.tool_call_id === `call-${step}`,
  );
  const toolResult = messages[toolResultIndex];
  assert.ok(toolResult, `tool result for call-${step} must pair with its assistant tool call`);
  assert.ok(
    assistantIndex < toolResultIndex,
    `assistant call-${step} must precede its paired tool result`,
  );
}

function assertAnthropicThinkingReplay(messages: unknown, step: number): void {
  const blocks = collectRecords(messages);
  assert.ok(
    blocks.some(
      (block) =>
        block.type === 'thinking' &&
        block.thinking === `reasoning-step-${step}` &&
        block.signature === `signature-step-${step}`,
    ),
    `Anthropic request must replay signed reasoning from step ${step}`,
  );
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectRecords);
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap(collectRecords)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function respondAnthropicStream(
  response: ServerResponse,
  model: string,
  step: number,
  toolInput: Record<string, unknown> | undefined,
  withThinking = false,
) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg-${step}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 1,
        output_tokens: 0,
      },
    },
  });
  let contentIndex = 0;
  if (withThinking) {
    send('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: contentIndex,
      delta: { type: 'thinking_delta', thinking: `reasoning-step-${step}` },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: contentIndex,
      delta: { type: 'signature_delta', signature: `signature-step-${step}` },
    });
    send('content_block_stop', { type: 'content_block_stop', index: contentIndex });
    contentIndex += 1;
  }
  if (toolInput) {
    send('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: `toolu-${step}`,
        name: 'maka_computer',
        input: toolInput,
      },
    });
    send('content_block_stop', { type: 'content_block_stop', index: contentIndex });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  } else {
    send('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: { type: 'text', text: 'done' },
    });
    send('content_block_stop', { type: 'content_block_stop', index: contentIndex });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  }
  send('message_stop', { type: 'message_stop' });
  response.end();
}

function respondOpenAiStream(
  response: ServerResponse,
  model: string,
  step: number,
  toolInput: Record<string, unknown> | undefined,
  reasoningField: 'reasoning' | 'reasoning_content' = 'reasoning',
) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const choice = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: `chatcmpl-${step}`,
    object: 'chat.completion.chunk',
    created: step,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  send(
    choice({
      role: 'assistant',
      [reasoningField]:
        step === 1 && reasoningField === 'reasoning' ? '' : `reasoning-step-${step}`,
    }),
  );
  if (toolInput) {
    send(
      choice({
        tool_calls: [
          {
            index: 0,
            id: `call-${step}`,
            type: 'function',
            function: {
              name: 'maka_computer',
              arguments: JSON.stringify(toolInput),
            },
          },
        ],
      }),
    );
    send(choice({}, 'tool_calls'));
  } else {
    send(choice({ content: 'done' }));
    send(choice({}, 'stop'));
  }
  send({
    id: `chatcmpl-${step}`,
    object: 'chat.completion.chunk',
    created: step,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
        usage: {
          prompt_tokens: 19 + step,
          completion_tokens: 6 + step,
          total_tokens: 25 + step * 2,
          cached_tokens: 3 + step,
          completion_tokens_details: { reasoning_tokens: 2 + step },
        },
      },
    ],
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function respondOpenAiTextStream(
  response: ServerResponse,
  model: string,
  step: number,
  reasoningField: 'reasoning' | 'reasoning_content',
  reasoning: string,
) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (data: unknown) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const choice = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: `chatcmpl-text-${step}`,
    object: 'chat.completion.chunk',
    created: step,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  send(choice({ role: 'assistant', [reasoningField]: reasoning }));
  send(choice({ content: `turn-${step}-done` }));
  send(choice({}, 'stop'));
  send({
    id: `chatcmpl-text-${step}`,
    object: 'chat.completion.chunk',
    created: step,
    model,
    choices: [],
    usage: {
      prompt_tokens: 10 + step,
      completion_tokens: 2,
      total_tokens: 12 + step,
    },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function header(providerType: LlmConnection['providerType'], model: string): SessionHeader {
  return {
    id: `session-${providerType}`,
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: providerType,
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: providerType,
    connectionLocked: true,
    model,
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(
  providerType: LlmConnection['providerType'],
  baseUrl: string,
  model: string,
  apiProtocol?: 'anthropic-messages' | 'openai-chat',
  maxOutputTokens?: number,
): LlmConnection {
  return {
    slug: providerType,
    name: providerType,
    providerType,
    baseUrl,
    defaultModel: model,
    ...(apiProtocol ? { models: [{ id: model, apiProtocol, maxOutputTokens }] } : {}),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

let id = 0;
function idGenerator() {
  return () => `id-${++id}`;
}

function monotonicClock() {
  let value = 1_000;
  return () => ++value;
}

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const control = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(control);
  return control;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
