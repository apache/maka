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
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { ModelMessage, ModelStreamResult } from '../model-protocol.js';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { APICallError, type LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { AttachmentByteReader } from '@maka/core/attachments';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { StorageRef } from '@maka/core/events';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import { projectRuntimeEventsToStoredMessages } from '../runtime-event-read-model.js';
import { materializeSession } from '../materializer.js';
import type { InvocationContext } from '../invocation-context.js';
import type { AssistantMessage, StoredMessage, ToolResultMessage } from '@maka/core/session';
import { z } from 'zod';
import {
  AiSdkBackend,
  INVALID_TOOL_NAME,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
  normalizeAiSdkUsage,
  repairMakaToolCall,
  type AiSdkBackendInput,
  type RunTraceEvent,
} from '../ai-sdk-backend.js';
import type { DurableSessionEventSink, MakaTool, ToolRuntime } from '../tool-runtime.js';
import { LOAD_TOOLS_NAME } from '../tool-availability.js';
import { buildNativeWebSearchTool } from '../native-web-search-tool.js';
import {
  canonicalizeToolSet,
  computeRequestShapeDiagnostic,
  findFirstChangedCacheableSegment,
} from '../request-shape.js';
import {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildHistoryCompactBlockFromSummary,
  type HistoryCompactBlock,
  type SynthesisCacheBlock,
} from '../context-budget.js';
import {
  buildHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from '../history-compact-checkpoint.js';
import {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from '../history-compact-artifacts.js';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';
import { memoryArtifactStore } from './memory-artifact-store.js';
import { buildRuntimeEventModelReplayPlan, buildSteeringEnvelope } from '../model-history.js';
import type { SemanticCompactBlock } from '../semantic-compact.js';
import { HistoryCompactSummarizerError } from '../history-compact-summarizer.js';
import type { SandboxDiagnosticsSnapshot } from '../sandbox/diagnostics.js';
import { SandboxCommandError } from '../sandbox/errors.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { RunTrace } from '../run-trace.js';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureRecord,
} from '../provider-request-telemetry.js';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
import { createToolResultArchiveCapability } from '../tool-result-archive-capability.js';
import {
  createTestAiSdkBackend,
  testToolResultArchive,
} from './execution-boundary-test-helpers.js';
import type { MemoryExtractionSourceSnapshot } from '../memory-extraction.js';
import type { OpenAiResponsesSemanticBaseline } from '../openai-responses-continuation.js';
import type { OpenAiResponsesTransportState } from '../openai-responses-websocket.js';
import { getAIModel } from '../model-factory.js';

describe('AiSdkBackend ApplyPatch routing', () => {
  test('advertises apply_patch only to supported native OpenAI models', async () => {
    for (const [providerType, modelId, expected] of [
      ['openai', 'gpt-5.4', true],
      ['openai', 'gpt-5', false],
      ['anthropic', connection().defaultModel, false],
    ] as const) {
      const model = completionModel();
      const backend = createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        appendMessage: async () => {},
        connection:
          providerType === 'openai'
            ? { ...connection(), slug: 'openai', providerType }
            : connection(),
        apiKey: 'sk-test',
        modelId,
        modelFactory: () => model,
        tools: [
          nativeApplyPatchTool(),
          testTool('Write', z.object({})),
          testTool('Edit', z.object({})),
        ],
        newId: idGenerator(),
        now: monotonicClock(),
      });

      await drain(backend.send({ turnId: 'turn-1', text: 'edit', context: [] }));
      const names = modelToolNames(model);
      assert.equal(names.includes('apply_patch'), expected);
      assert.equal(names.includes('Write'), !expected);
      assert.equal(names.includes('Edit'), !expected);
    }
  });

  test('keeps Write and Edit when DeepSeek cannot carry custom apply_patch', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        ...connection(),
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => model,
      tools: [
        nativeApplyPatchTool(),
        testTool('Write', z.object({})),
        testTool('Edit', z.object({})),
      ],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'edit', context: [] }));

    const names = modelToolNames(model);
    assert.equal(names.includes('apply_patch'), false);
    assert.equal(names.includes('Write'), true);
    assert.equal(names.includes('Edit'), true);
  });

  test('replays a durable apply_patch failure as native provider JSON', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), slug: 'openai', providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'gpt-5.4',
      modelFactory: () => model,
      tools: [nativeApplyPatchTool()],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-user',
            turnId: 'turn-previous',
            role: 'user',
            author: 'user',
            text: 'patch it',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-previous',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'call-1',
              name: 'apply_patch',
              args: {
                callId: 'call-1',
                operation: { type: 'update_file', path: 'file.txt', diff: '@@' },
              },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-previous',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'call-1',
              name: 'apply_patch',
              result: { status: 'failed', output: 'diff rejected' },
              isError: true,
            },
          }),
        ],
      }),
    );

    const toolResult = (compactPrompt(model) as Array<{ role: string; content: any[] }>)
      .find((message) => message.role === 'tool')
      ?.content.find((part) => part.type === 'tool-result');
    assert.deepEqual(toolResult?.output, {
      type: 'json',
      value: { status: 'failed', output: 'diff rejected' },
    });
  });

  const assertApplyPatchHistoryDowngraded = async (
    targetConnection: LlmConnection,
    modelId: string,
  ) => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: targetConnection,
      apiKey: 'sk-test',
      modelId,
      modelFactory: () => model,
      tools: [nativeApplyPatchTool()],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-user',
            turnId: 'turn-previous',
            role: 'user',
            author: 'user',
            text: 'patch it',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-previous',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'call-1',
              name: 'apply_patch',
              args: [
                '*** Begin Patch',
                '*** Update File: file.txt',
                '@@',
                '-before',
                '+after',
                '*** End Patch',
              ].join('\n'),
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-previous',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'call-1',
              name: 'apply_patch',
              result: { status: 'completed', output: 'Applied 1 file operation.' },
            },
          }),
        ],
      }),
    );

    const replay = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    assert.equal(
      replay.some((message) =>
        message.content.some(
          (part) => part.type === 'tool-call' && part.toolName === 'apply_patch',
        ),
      ),
      false,
    );
    assert.equal(
      replay.some((message) => message.role === 'tool'),
      false,
    );
    assert.match(
      replay
        .flatMap((message) => message.content)
        .find((part) => part.type === 'text' && /ApplyPatch completed/.test(part.text))?.text ?? '',
      /ApplyPatch completed 1 file operation: update_file file\.txt/,
    );
  };

  test('downgrades durable DeepSeek freeform apply_patch history to a fact', async () => {
    await assertApplyPatchHistoryDowngraded(
      {
        ...connection(),
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      'deepseek-v4-flash',
    );
  });

  test('downgrades apply_patch history when a non-Responses target does not advertise it', async () => {
    const targetConnection = connection();
    await assertApplyPatchHistoryDowngraded(targetConnection, targetConnection.defaultModel!);
  });

  test('preserves a multi-file ApplyPatch fact when structured replay cannot represent it', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), slug: 'openai', providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'gpt-5.4',
      modelFactory: () => model,
      tools: [nativeApplyPatchTool()],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const patch = [
      '*** Begin Patch',
      '*** Add File: added.txt',
      '+hello',
      '*** Delete File: removed.txt',
      '*** End Patch',
    ].join('\n');

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-user',
            turnId: 'turn-previous',
            role: 'user',
            author: 'user',
            text: 'patch both files',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-previous',
            role: 'model',
            author: 'agent',
            content: { kind: 'function_call', id: 'call-1', name: 'apply_patch', args: patch },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-previous',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'call-1',
              name: 'apply_patch',
              result: {
                status: 'completed',
                applied: [
                  { type: 'create_file', path: 'added.txt' },
                  { type: 'delete_file', path: 'removed.txt' },
                ],
                output: 'Applied 2 file operations.',
              },
            },
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const replayText = prompt
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .find((part) => part.type === 'text' && part.text.includes('added.txt'));
    assert.equal(
      replayText?.text,
      'ApplyPatch completed 2 file operations: create_file added.txt, delete_file removed.txt.',
    );
    assert.equal(
      prompt.some((message) =>
        message.content.some(
          (part) => part.type === 'tool-call' && part.toolName === 'apply_patch',
        ),
      ),
      false,
    );
  });

  test('preserves every multi-file ApplyPatch fact from one provider step', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), slug: 'openai', providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'gpt-5.4',
      modelFactory: () => model,
      tools: [nativeApplyPatchTool()],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const firstPatch = [
      '*** Begin Patch',
      '*** Add File: first.txt',
      '+first',
      '*** Delete File: old-first.txt',
      '*** End Patch',
    ].join('\n');
    const secondPatch = [
      '*** Begin Patch',
      '*** Add File: second.txt',
      '+second',
      '*** Delete File: old-second.txt',
      '*** End Patch',
    ].join('\n');
    const call = (id: string, args: string) =>
      runtimeEvent({
        id: `rt-${id}`,
        turnId: 'turn-previous',
        role: 'model',
        author: 'agent',
        refs: { stepId: 'patch-step' },
        content: { kind: 'function_call', id, name: 'apply_patch', args },
      });
    const result = (id: string, applied: Array<{ type: string; path: string }>) =>
      runtimeEvent({
        id: `rt-${id}-result`,
        turnId: 'turn-previous',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id,
          name: 'apply_patch',
          result: { status: 'completed', applied, output: 'Applied 2 file operations.' },
        },
      });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-user',
            turnId: 'turn-previous',
            role: 'user',
            author: 'user',
            text: 'patch both pairs',
          }),
          call('call-1', firstPatch),
          call('call-2', secondPatch),
          result('call-1', [
            { type: 'create_file', path: 'first.txt' },
            { type: 'delete_file', path: 'old-first.txt' },
          ]),
          result('call-2', [
            { type: 'create_file', path: 'second.txt' },
            { type: 'delete_file', path: 'old-second.txt' },
          ]),
          runtimeEvent({
            id: 'rt-step-text',
            turnId: 'turn-previous',
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'patch-step' },
            content: { kind: 'text', text: 'Both patches finished.' },
          }),
        ],
      }),
    );

    const replayFacts = (compactPrompt(model) as Array<{ role: string; content: any[] }>)
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text' && part.text.startsWith('ApplyPatch completed'))
      .map((part) => part.text);
    assert.deepEqual(replayFacts, [
      'ApplyPatch completed 2 file operations: create_file first.txt, delete_file old-first.txt.',
      'ApplyPatch completed 2 file operations: create_file second.txt, delete_file old-second.txt.',
    ]);
  });
});

describe('AiSdkBackend Memory Extraction triggers', () => {
  test('dispatches a pre-turn Compaction recipe without projecting history or awaiting it', async () => {
    const model = completionModel();
    const recorded: HistoryCompactCheckpoint[] = [];
    let snapshot: MemoryExtractionSourceSnapshot | undefined;
    let systemPromptResolutions = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      systemPrompt: async () => {
        systemPromptResolutions += 1;
        return 'CURRENT_MEMORY_SYSTEM_PROMPT';
      },
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 1_500,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.01,
          tailEstimatedTokens: 20,
          maxSummaryEstimatedTokens: 500,
        },
      },
      summarizeHistoryCompact: async () => structuredSummary('AUTOMATIC_MEMORY_SUMMARY'),
      recordHistoryCompactCheckpoint: (checkpoint) => {
        recorded.push(checkpoint);
      },
      memoryExtraction: {
        gate: () => new Promise(() => {}),
        automaticGate: () => ({ allowed: true }),
        remember: async () => ({ status: 'unavailable', requestedItems: [] }),
        extract: (value) => {
          snapshot = value;
          return new Promise<void>(() => {});
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const runtimeContext = [
      runtimeTextEvent({
        id: 'memory-compact-old-user',
        turnId: 'memory-compact-turn-1',
        role: 'user',
        author: 'user',
        text: 'The project uses SQLite. '.repeat(40),
      }),
      runtimeTextEvent({
        id: 'memory-compact-old-model',
        turnId: 'memory-compact-turn-2',
        role: 'model',
        author: 'agent',
        text: 'Acknowledged. '.repeat(70),
      }),
      runtimeTextEvent({
        id: 'memory-compact-boundary',
        turnId: 'memory-compact-turn-3',
        role: 'user',
        author: 'user',
        text: 'Keep this retained context.',
      }),
    ];

    await drain(
      backend.send({
        turnId: 'memory-compact-current',
        runId: 'memory-compact-current-run',
        text: 'continue',
        context: [],
        runtimeContext,
      }),
    );

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.memoryExtractionBoundary?.runtimeEventId, 'memory-compact-boundary');
    assert.equal(snapshot?.trigger, 'compaction');
    assert.equal(snapshot?.compactionCheckpointId, recorded[0]?.checkpointId);
    assert.equal(snapshot?.compactionBoundaryEventId, 'memory-compact-boundary');
    assert.equal(snapshot?.sourceSystemPrompt, undefined);
    assert.deepEqual(snapshot?.sourceMessages, []);
    assert.deepEqual(snapshot?.sourceTools, {});
    assert.deepEqual(snapshot?.sourceActiveTools, []);
    assert.equal(snapshot?.sourceProviderOptions, undefined);
    assert.equal(snapshot?.rebuildSourceContextFromCompactionCheckpoint, true);
    assert.equal(systemPromptResolutions, 1);
    assert.match(JSON.stringify(model.doStreamCalls[0]), /CURRENT_MEMORY_SYSTEM_PROMPT/);
    assert.equal(model.doStreamCalls.length, 1, 'the unresolved extraction must not block Agent');
  });

  test('terminates cleanly when the dynamic system prompt rejects before Compaction', async () => {
    const model = completionModel();
    const recorded: HistoryCompactCheckpoint[] = [];
    let dispatches = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      systemPrompt: async () => {
        throw new Error('dynamic system prompt failed');
      },
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 1_500,
        charsPerToken: 1,
        historyCompact: { enabled: true, mode: 'read_write' },
      },
      summarizeHistoryCompact: async () => structuredSummary('must not summarize'),
      recordHistoryCompactCheckpoint: (checkpoint) => {
        recorded.push(checkpoint);
      },
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        automaticGate: () => ({ allowed: true }),
        remember: async () => ({ status: 'unavailable', requestedItems: [] }),
        extract: () => {
          dispatches += 1;
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({
      turnId: 'prompt-failure-turn',
      runId: 'prompt-failure-run',
      text: 'continue',
      context: [],
      runtimeContext: [],
    })) {
      events.push(event);
    }

    assert.equal(model.doStreamCalls.length, 0);
    assert.equal(recorded.length, 0);
    assert.equal(dispatches, 0);
    assert.equal(
      events.some((event) => event.type === 'error'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'complete' && event.stopReason === 'error'),
      true,
    );
  });

  for (const gate of [
    { allowed: false as const, reason: 'disabled' as const },
    { allowed: false as const, reason: 'incognito' as const },
  ]) {
    test(`persists a denied marker and does not dispatch when automatic Compaction is ${gate.reason}`, async () => {
      const recorded: HistoryCompactCheckpoint[] = [];
      let dispatches = 0;
      const backend = createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        appendMessage: async () => {},
        connection: connection(),
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => completionModel(),
        tools: [],
        contextBudget: {
          maxHistoryEstimatedTokens: 1_500,
          charsPerToken: 1,
          historyCompact: {
            enabled: true,
            mode: 'read_write',
            highWaterRatio: 0.01,
            tailEstimatedTokens: 20,
            maxSummaryEstimatedTokens: 500,
          },
        },
        summarizeHistoryCompact: async () => structuredSummary('DENIED_MEMORY_SUMMARY'),
        recordHistoryCompactCheckpoint: (checkpoint) => {
          recorded.push(checkpoint);
        },
        memoryExtraction: {
          gate: async () => gate,
          automaticGate: () => gate,
          remember: async () => ({ status: 'unavailable', requestedItems: [] }),
          extract: () => {
            dispatches += 1;
          },
        },
        newId: idGenerator(),
        now: monotonicClock(),
      });

      await drain(
        backend.send({
          turnId: `denied-${gate.reason}-current`,
          runId: `denied-${gate.reason}-run`,
          text: 'continue',
          context: [],
          runtimeContext: [
            runtimeTextEvent({
              id: `denied-${gate.reason}-old-user`,
              turnId: 'denied-old-1',
              role: 'user',
              author: 'user',
              text: 'Private disabled-period context. '.repeat(50),
            }),
            runtimeTextEvent({
              id: `denied-${gate.reason}-old-model`,
              turnId: 'denied-old-2',
              role: 'model',
              author: 'agent',
              text: 'Acknowledged. '.repeat(70),
            }),
            runtimeTextEvent({
              id: `denied-${gate.reason}-boundary`,
              turnId: 'denied-old-3',
              role: 'user',
              author: 'user',
              text: 'Retained tail.',
            }),
          ],
        }),
      );

      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.memoryExtractionBoundary?.disposition, 'policy_denied');
      assert.equal(dispatches, 0);
    });
  }

  test('keeps a transiently unavailable automatic Compaction checkpoint recoverable', async () => {
    const recorded: HistoryCompactCheckpoint[] = [];
    let dispatches = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 1_500,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.01,
          tailEstimatedTokens: 20,
          maxSummaryEstimatedTokens: 500,
        },
      },
      summarizeHistoryCompact: async () => structuredSummary('UNAVAILABLE_MEMORY_SUMMARY'),
      recordHistoryCompactCheckpoint: (checkpoint) => {
        recorded.push(checkpoint);
      },
      memoryExtraction: {
        gate: async () => ({ allowed: false, reason: 'unavailable' }),
        automaticGate: () => ({ allowed: false, reason: 'unavailable' }),
        remember: async () => ({ status: 'unavailable', requestedItems: [] }),
        extract: () => {
          dispatches += 1;
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'unavailable-current',
        runId: 'unavailable-run',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'unavailable-old-user',
            turnId: 'unavailable-old-1',
            role: 'user',
            author: 'user',
            text: 'Recoverable context. '.repeat(50),
          }),
          runtimeTextEvent({
            id: 'unavailable-old-model',
            turnId: 'unavailable-old-2',
            role: 'model',
            author: 'agent',
            text: 'Acknowledged. '.repeat(70),
          }),
          runtimeTextEvent({
            id: 'unavailable-boundary',
            turnId: 'unavailable-old-3',
            role: 'user',
            author: 'user',
            text: 'Retained tail.',
          }),
        ],
      }),
    );

    assert.equal(recorded[0]?.memoryExtractionBoundary?.disposition, 'eligible');
    assert.equal(dispatches, 0);
  });

  test('exposes explicitly unsupported Memory triggers on the native OpenAI Responses lane', async () => {
    const model = completionModel();
    let memoryCalled = false;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'gpt-5.4',
      modelFactory: () => model,
      tools: [],
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        remember: async () => {
          memoryCalled = true;
          return { status: 'unavailable', requestedItems: [] };
        },
        extract: () => {
          memoryCalled = true;
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'hello', context: [] }));

    assert.equal(
      model.doStreamCalls[0]?.tools?.some(
        (tool) => tool.name === 'memory_remember' || tool.name === 'memory_extract',
      ) ?? false,
      true,
    );
    assert.equal(memoryCalled, false);
  });

  test('runs memory_remember synchronously and returns the persisted requested Item to the next step', async () => {
    let modelCalls = 0;
    let snapshot: MemoryExtractionSourceSnapshot | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: (modelCalls === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'remember-call',
                    toolName: 'memory_remember',
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: emptyUsage(),
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'Remembered.' },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: emptyUsage(),
                  },
                ]) as LanguageModelV4StreamPart[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const durable = durableTurnHarness('turn-memory', 'Remember that I prefer concise Chinese.');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        remember: async (value) => {
          snapshot = value;
          return {
            status: 'remembered',
            requestedItems: [{ itemId: 'memory-1', content: 'User prefers concise Chinese.' }],
          };
        },
        extract: () => {},
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drainDurably(
      backend.send(durable.input({ runId: 'run-1', invocationId: 'invocation-1' })),
      durable,
    );

    assert.equal(snapshot?.trigger, 'remember');
    assert.equal(snapshot?.toolCallId, 'remember-call');
    const sourceUserEvent = durable.ledger.find(
      (event) => event.role === 'user' && event.content?.kind === 'text',
    );
    assert.ok(sourceUserEvent);
    assert.deepEqual(snapshot?.sourceEventMessagePositions?.[sourceUserEvent.id], [0]);
    assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /User prefers concise Chinese/);
  });

  test('keeps the complete frozen provider context while evidence authority remains user-only', async () => {
    let modelCalls = 0;
    let snapshot: MemoryExtractionSourceSnapshot | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          modelCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'read-call',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'volatile.json' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: emptyUsage(),
                },
              ]
            : modelCalls === 2
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'remember-call',
                    toolName: 'memory_remember',
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: emptyUsage(),
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'Remembered.' },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: emptyUsage(),
                  },
                ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const durable = durableTurnHarness('turn-memory-tool', 'Remember only what I explicitly said.');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'read volatile data',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ value: 'TOOL-ONLY-SECRET' }),
        },
      ],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        remember: async (value) => {
          snapshot = value;
          return { status: 'not_applicable', requestedItems: [] };
        },
        extract: () => {},
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drainDurably(
      backend.send(durable.input({ runId: 'run-1', invocationId: 'invocation-1' })),
      durable,
    );

    assert.ok(snapshot);
    const messagesJson = JSON.stringify(snapshot.sourceMessages);
    assert.match(messagesJson, /TOOL-ONLY-SECRET/);
    assert.match(messagesJson, /read-call/);
    assert.match(messagesJson, /volatile\.json/);
    assert.ok(snapshot.sourceMessages.some((message) => message.role === 'assistant'));
    assert.ok(snapshot.sourceMessages.some((message) => message.role === 'tool'));
    const sourceUserEvent = durable.ledger.find(
      (event) => event.role === 'user' && event.content?.kind === 'text',
    );
    assert.ok(sourceUserEvent);
    assert.deepEqual(snapshot.sourceEventMessagePositions?.[sourceUserEvent.id], [0]);
    assert.ok(snapshot.sourceTools.Read, 'Tool schemas remain available for provider-prefix reuse');
  });

  test('dispatches memory_extract only after the terminal Event is durably consumed', async () => {
    let modelCalls = 0;
    let extractionSnapshot: MemoryExtractionSourceSnapshot | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: (modelCalls === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'extract-call',
                    toolName: 'memory_extract',
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: emptyUsage(),
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'Done.' },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: emptyUsage(),
                  },
                ]) as LanguageModelV4StreamPart[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const durable = durableTurnHarness('turn-memory', 'This is durable project context.');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        remember: async () => ({ status: 'unavailable', requestedItems: [] }),
        extract: (snapshot) => {
          extractionSnapshot = snapshot;
        },
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drainDurably(
      backend.send(durable.input({ runId: 'run-1', invocationId: 'invocation-1' })),
      durable,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(modelCalls, 2);
    assert.ok(
      durable.ledger.some(
        (event) =>
          event.content?.kind === 'function_response' &&
          event.content.name === 'memory_extract' &&
          JSON.stringify(event.content.result).includes('accepted'),
      ),
    );
    assert.equal(extractionSnapshot?.trigger, 'extract');
    assert.ok(extractionSnapshot?.terminalEventId);
    assert.ok(durable.ledger.some(({ id }) => id === extractionSnapshot?.terminalEventId));
  });
});
describe('AiSdkBackend model history', () => {
  test('exposes one active sandbox snapshot to the model and durable run trace', async () => {
    const model = completionModel();
    const traces: RunTraceEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      sandboxDiagnosticsSnapshot: sandboxSnapshot(),
      recordRunTrace: (event) => traces.push(event),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({ turnId: 'turn-current', text: 'current user', context: [] }));

    assert.match(JSON.stringify(compactPrompt(model)), /Maka runtime sandbox context/);
    assert.match(JSON.stringify(compactPrompt(model)), /Working directory: \/tmp\/maka/);
    const contextEvent = traces.find((event) => event.type === 'sandbox_context_resolved');
    const traceSnapshot = contextEvent?.data?.snapshot as
      | { profile?: { name?: string } }
      | undefined;
    assert.equal(traceSnapshot?.profile?.name, 'workspace-write');
    assert.equal(JSON.stringify(contextEvent).includes('/tmp/maka'), false);
  });

  test('records structured sandbox failure metadata on tool failure traces', async () => {
    const traces: RunTraceEvent[] = [];
    const messages: ToolResultMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('bypass'),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    turnScope(backend, 'turn-1').runTrace = new RunTrace({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'anthropic-main',
      providerId: 'anthropic',
      modelId: 'mock-model-id',
      newId: idGenerator(),
      now: monotonicClock(),
      record: (event) => traces.push(event),
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'shell',
      parameters: {},
      impl: async () => {
        throw new SandboxCommandError({
          domain: 'command',
          stage: 'transform',
          reason: 'backend_not_available',
          backend: 'macos-seatbelt',
          recoverable: false,
          profileName: 'workspace-write',
          message: 'contains /private/workspace/path',
        });
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', { push: () => {} });

    await execute(
      { command: 'true' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    const failure = traces.find((event) => event.type === 'tool_failed');
    assert.deepEqual(failure?.data?.sandbox, {
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      recoverable: false,
      backend: 'macos-seatbelt',
      profileName: 'workspace-write',
    });
    assert.equal(JSON.stringify(failure).includes('/private/workspace/path'), false);
    assert.equal(
      messages[0]?.content.kind === 'text' ? messages[0].content.sandboxDenial : undefined,
      undefined,
    );
  });

  test('persists a sandbox denial signal for explicit filesystem worker sandbox denials', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('bypass'),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const tool: MakaTool = {
      name: 'Grep',
      description: 'search',
      parameters: {},
      impl: async () => {
        throw new FilesystemWorkerClientError({
          reason: 'sandbox_denied',
          stage: 'operation',
          backend: 'macos-seatbelt',
          recoverable: false,
          message: 'Filesystem access was denied.',
        });
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    await execute(
      { pattern: 'needle', path: '/workspace' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    const expected = { likely: true, backend: 'macos-seatbelt' } as const;
    assert.deepEqual(
      messages[0]?.content.kind === 'text' ? messages[0].content.sandboxDenial : undefined,
      expected,
    );
    const event = events.find(
      (candidate): candidate is Extract<SessionEvent, { type: 'tool_result' }> =>
        candidate.type === 'tool_result',
    );
    assert.deepEqual(
      event?.content.kind === 'text' ? event.content.sandboxDenial : undefined,
      expected,
    );
  });

  test('does not label ordinary filesystem permission errors as sandbox denials', async () => {
    const messages: ToolResultMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('bypass'),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const tool: MakaTool = {
      name: 'Read',
      description: 'read',
      parameters: {},
      impl: async () => {
        throw new FilesystemWorkerClientError({
          reason: 'filesystem_denied',
          stage: 'operation',
          backend: 'macos-seatbelt',
          recoverable: false,
          message: 'Filesystem access was denied.',
        });
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', { push: () => {} });

    await execute(
      { path: '/workspace/private.txt' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    assert.equal(
      messages[0]?.content.kind === 'text' ? messages[0].content.sandboxDenial : undefined,
      undefined,
    );
  });

  test('prefers the connection-advertised Kimi output limit over catalog metadata', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'kimi-coding-plan',
        providerType: 'kimi-coding-plan',
        defaultModel: 'k3',
        models: [{ id: 'k3', maxOutputTokens: 65_536 }],
      },
      apiKey: 'sk-test',
      modelId: 'k3',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
      }),
    );

    assert.equal(model.doStreamCalls[0]?.maxOutputTokens, 65_536);
  });

  test('reserves Kimi fixed thinking inside the provider wire output limit', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'kimi-coding-plan',
        providerType: 'kimi-coding-plan',
        defaultModel: 'kimi-for-coding',
      },
      apiKey: 'sk-test',
      modelId: 'kimi-for-coding',
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 1_024 },
          effort: 'max',
        },
      },
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
      }),
    );

    // Anthropic's adapter adds budgetTokens to maxOutputTokens on the wire.
    assert.equal(model.doStreamCalls[0]?.maxOutputTokens, 32_768 - 1_024);
  });

  test('leaves OpenAI-compatible output limits to their provider adapter', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'mistral',
        providerType: 'mistral',
        defaultModel: 'mistral-large-latest',
      },
      apiKey: 'sk-test',
      modelId: 'mistral-large-latest',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
      }),
    );

    assert.equal(model.doStreamCalls[0]?.maxOutputTokens, undefined);
  });

  test('prefers RuntimeEvent prior messages and appends current user once', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'runtime user',
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'runtime assistant',
          }),
          runtimeTextEvent({
            id: 'rt-current',
            turnId: 'turn-current',
            role: 'user',
            author: 'user',
            text: 'current from runtime',
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'runtime user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'runtime assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('safe-boundary continuation does not append a duplicate current user message', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 1,
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original user' }] },
    ]);
  });

  test('continuation replays the original user after diagnostic terminal errors with no StoredMessage context', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
          runtimeEvent({
            id: 'rt-failed',
            turnId: 'turn-source',
            role: 'system',
            author: 'system',
            status: 'failed',
            content: { kind: 'error', reason: 'runtime_error', message: 'previous attempt failed' },
            actions: { endInvocation: true },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 2,
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original user' }] },
    ]);
  });

  test('continuation fails before the provider when replay materializes no messages', async () => {
    const trace: RunTraceEvent[] = [];
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => trace.push(event),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({
      turnId: 'turn-resume',
      text: '',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-failed',
          turnId: 'turn-source',
          role: 'system',
          author: 'system',
          status: 'failed',
          content: { kind: 'error', reason: 'runtime_error', message: 'previous attempt failed' },
          actions: { endInvocation: true },
        }),
      ],
      continuation: {
        sourceInvocationId: 'invocation-source',
        sourceRunId: 'run-source',
        sourceTurnId: 'turn-source',
        sourceRuntimeEventHighWater: 1,
      },
    })) {
      events.push(event);
    }

    assert.equal(model.doStreamCalls.length, 0);
    assert.deepEqual(
      events.map((event) => event.type),
      ['error', 'complete'],
    );
    const error = events.find(
      (event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error',
    );
    assert.equal(error?.code, 'continuation_replay_empty');
    const failure = trace.find((event) => event.type === 'model_stream_failed');
    assert.equal(failure?.data?.errorClass, 'continuation_replay_empty');
    assert.equal(failure?.data?.priorReplayGate, 'runtime_replay_text_only');
    assert.deepEqual(failure?.data?.priorReplayDiagnosticCodes, [
      'terminal_fact_diagnostic_only',
      'error_content_diagnostic_only',
    ]);
  });

  test('continuation materializes validated RuntimeEvents when provider-native replay is unavailable', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
          runtimeEvent({
            id: 'rt-thinking',
            turnId: 'turn-source',
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text: 'private reasoning', signature: 'sig-1' },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 2,
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original user' }] },
    ]);
  });

  test('continuation never substitutes StoredMessages when RuntimeEvent replay has blocking diagnostics', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [
          {
            type: 'user',
            id: 'projection-u',
            turnId: 'turn-source',
            ts: 1,
            text: 'must not replay projection',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-source',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Bash',
              args: { command: 'printf ok' },
            },
          }),
          runtimeEvent({
            id: 'rt-invalid-result',
            turnId: 'turn-source',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Bash',
              result: {
                kind: 'terminal',
                cwd: '/workspace',
                cmd: 'printf ok',
                status: 'completed',
                exitCode: 0,
                stdout: 'ok',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
                output: {
                  mode: 'pipes',
                  stdout: 'ok',
                  stderr: '',
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  redacted: false,
                },
              },
            },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 3,
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original user' }] },
    ]);
  });

  test('continuation replay may end with an assistant message without an active user head anchor', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-source',
            role: 'model',
            author: 'agent',
            text: 'partial answer',
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 2,
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    ]);
  });

  test('continuation replay may end at a paired tool boundary without an active user head anchor', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'run the check',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-source',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'README.md' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-source',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: { kind: 'text', text: 'contents' },
            },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 3,
        },
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string }>;
    assert.equal(prompt[0]?.role, 'user');
    assert.equal(prompt.at(-1)?.role, 'tool');
  });

  test('uses StoredMessage projection when RuntimeEvent replay is empty', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          {
            id: 'rt-terminal',
            invocationId: 'inv-1',
            runId: 'run-prev',
            sessionId: 'session-1',
            turnId: 'turn-prev',
            ts: 1,
            partial: false,
            role: 'model',
            author: 'agent',
            status: 'completed',
            actions: { endInvocation: true },
          },
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('stored-message fallback skips empty assistant texts', async () => {
    // A thinking/tool-only step projects an assistant row with empty text.
    // The degraded stored-message path must not replay it: an empty text
    // content block is a hard 400 on Anthropic-protocol providers, which
    // permanently blocks every later turn of the session.
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-empty',
            turnId: 'turn-prev',
            ts: 2,
            text: '',
            modelId: 'm',
          },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 3,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('stored-message fallback describes an attachment that is not safely addressable', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          {
            type: 'user',
            id: 'projection-u',
            turnId: 'turn-prev',
            ts: 1,
            text: 'see the attached chart',
            attachments: [
              {
                kind: 'image',
                name: 'chart.png',
                mimeType: 'image/png',
                bytes: 123,
                ref: {
                  kind: 'session_file',
                  sessionId: 'sess-1',
                  relativePath: 'attachments/chart.png',
                },
              },
            ],
          },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          {
            id: 'rt-terminal',
            invocationId: 'inv-1',
            runId: 'run-prev',
            sessionId: 'session-1',
            turnId: 'turn-prev',
            ts: 1,
            partial: false,
            role: 'model',
            author: 'agent',
            status: 'completed',
            actions: { endInvocation: true },
          },
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; text: string }>;
    const text = parts[0]?.text ?? '';
    assert.ok(text.includes('see the attached chart'), `expected user text in: ${text}`);
    assert.ok(
      text.includes(
        '<attachment>\nThe attachment content is unavailable to Read.\nname: "chart.png"\nmime_type: "image/png"\n</attachment>',
      ),
      `expected unavailable attachment context in stored-message fallback, got: ${text}`,
    );
  });

  test('stored-message fallback renders image attachments as image parts when a reader is wired', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
      supportsVision: true,
    } as never);

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          {
            type: 'user',
            id: 'projection-u',
            turnId: 'turn-prev',
            ts: 1,
            text: 'see the attached chart',
            attachments: [
              {
                kind: 'image',
                name: 'chart.png',
                mimeType: 'image/png',
                bytes: 123,
                ref: {
                  kind: 'session_file',
                  sessionId: 'sess-1',
                  relativePath: 'attachments/chart.png',
                },
              },
            ],
          },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          {
            id: 'rt-terminal',
            invocationId: 'inv-1',
            runId: 'run-prev',
            sessionId: 'session-1',
            turnId: 'turn-prev',
            ts: 1,
            partial: false,
            role: 'model',
            author: 'agent',
            status: 'completed',
            actions: { endInvocation: true },
          },
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; mediaType?: string }>;
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.ok(
      imageLike,
      `expected a historical image/png part in stored-message fallback, got: ${JSON.stringify(parts)}`,
    );
  });

  test('current-turn image attachment falls back to text unless vision support is explicit', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
    } as never);

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'describe this chart',
        attachments: [
          {
            kind: 'image',
            name: 'chart.png',
            mimeType: 'image/png',
            bytes: pngBytes.length,
            ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'fake/chart.png' },
          },
        ],
        context: [],
        runtimeContext: [],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const currentUser = prompt[prompt.length - 1];
    const parts = currentUser.content as Array<{ type: string; mediaType?: string; text?: string }>;
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.equal(
      imageLike,
      undefined,
      `expected no image/png part without explicit vision support, got: ${JSON.stringify(parts)}`,
    );
    const text = parts.map((p) => p.text ?? '').join('\n');
    assert.ok(text.includes('describe this chart'), `expected original text in: ${text}`);
    assert.ok(
      text.includes(
        '<attachment>\nThe attachment content is unavailable to Read.\nname: "chart.png"\nmime_type: "image/png"\n</attachment>',
      ),
      `expected unavailable attachment context in: ${text}`,
    );
    assert.ok(
      text.includes('does not support image input'),
      `expected non-vision fallback note in: ${text}`,
    );
  });

  test('reports unavailable attachment reads without consuming image budget', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 15,
      readAttachmentBytes: async (ref: StorageRef) =>
        ref.kind === 'session_file' && ref.relativePath === 'missing'
          ? { ok: false, reason: 'not_found' }
          : { ok: true, bytes: new Uint8Array(10) },
    } as never);
    const attachment = (relativePath: string) => ({
      kind: 'image' as const,
      name: `${relativePath}.png`,
      mimeType: 'image/png',
      bytes: 10,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath },
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'describe these charts',
        attachments: [attachment('missing'), attachment('available')],
        context: [],
        runtimeContext: [],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const parts = prompt.at(-1)?.content as Array<{
      type: string;
      mediaType?: string;
      text?: string;
    }>;
    assert.equal(
      parts.filter((part) => part.type !== 'text' && part.mediaType === 'image/png').length,
      1,
    );
    assert.match(parts.map((part) => part.text ?? '').join('\n'), /missing\.png.*not_found/);
  });

  test('charges attachment image budget from the bytes actually read', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 15,
      readAttachmentBytes: async () => ({ ok: true, bytes: new Uint8Array(10) }),
    } as never);

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'describe this chart',
        attachments: [
          {
            kind: 'image',
            name: 'chart.png',
            mimeType: 'image/png',
            bytes: 20,
            ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'chart' },
          },
        ],
        context: [],
        runtimeContext: [],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const parts = prompt.at(-1)?.content as Array<{ type: string; mediaType?: string }>;
    assert.equal(
      parts.filter((part) => part.type !== 'text' && part.mediaType === 'image/png').length,
      1,
    );
  });

  test('degrades excess current-turn image attachments once the per-request budget is exceeded', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 25,
      readAttachmentBytes: async () => ({ ok: true, bytes: new Uint8Array(10) }),
    } as never);

    const attachment = (relativePath: string) => ({
      kind: 'image' as const,
      name: relativePath,
      mimeType: 'image/png',
      bytes: 10,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath },
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'describe these charts',
        attachments: [attachment('img-1'), attachment('img-2'), attachment('img-3')],
        context: [],
        runtimeContext: [],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const currentUser = prompt[prompt.length - 1];
    const parts = currentUser.content as Array<{ type: string; mediaType?: string; text?: string }>;
    const imageParts = parts.filter((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.equal(imageParts.length, 2, `expected two image parts, got: ${JSON.stringify(parts)}`);
    const text = parts.map((p) => p.text ?? '').join('\n');
    assert.match(
      text,
      /1 image attachment\(s\) omitted.*image budget/,
      `expected budget-omitted notice in: ${text}`,
    );
  });

  test('counts the same attachment ref separately in replay and the current turn', async () => {
    const bytes = new Uint8Array(10);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 15,
      readAttachmentBytes: async () => ({ ok: true, bytes }),
    });
    const attachment = {
      kind: 'image' as const,
      name: 'chart.png',
      mimeType: 'image/png',
      bytes: bytes.length,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath: 'artifact-1' },
    };

    await drain(
      backend.send({
        turnId: 'turn-regenerated',
        text: 'describe this chart',
        attachments: [attachment],
        context: [],
        runtimeContext: [
          runtimeEvent({
            id: 'rt-original',
            turnId: 'turn-original',
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'describe this chart', attachments: [attachment] },
          }),
          runtimeTextEvent({
            id: 'rt-answer',
            turnId: 'turn-original',
            role: 'model',
            author: 'agent',
            text: 'original answer',
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const imageParts = prompt
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part: any) => part.type !== 'text' && part.mediaType === 'image/png');
    assert.equal(
      imageParts.length,
      1,
      `expected the repeated ref to consume budget twice: ${JSON.stringify(prompt)}`,
    );
    const currentUser = prompt[prompt.length - 1];
    const currentText = (currentUser.content as Array<{ text?: string }>)
      .map((part) => part.text ?? '')
      .join('\n');
    assert.match(
      currentText,
      /1 image attachment\(s\) omitted.*image budget/,
      `expected current attachment omission: ${currentText}`,
    );
  });

  test('charges a durable current-turn image once when the first request reloads the ledger', async () => {
    const bytes = new Uint8Array(10);
    const model = completionModel();
    const attachment = {
      kind: 'image' as const,
      name: 'chart.png',
      mimeType: 'image/png',
      bytes: bytes.length,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath: 'chart' },
    };
    const anchor = runtimeEvent({
      id: 'rt-current',
      turnId: 'turn-current',
      role: 'user',
      author: 'user',
      content: {
        kind: 'text',
        text: 'describe this chart',
        attachments: [attachment],
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: async () => [anchor],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 15,
      readAttachmentBytes: async () => ({ ok: true, bytes }),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'describe this chart',
        attachments: [attachment],
        context: [],
        headAnchorRuntimeEvent: anchor,
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const parts = prompt.at(-1)?.content as Array<{ type: string; mediaType?: string }>;
    assert.equal(
      parts.filter((part) => part.type !== 'text' && part.mediaType === 'image/png').length,
      1,
    );
  });

  test('degrades excess replayed image tool results once the per-request budget is exceeded', async () => {
    const bytes = new Uint8Array(10);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 25,
      readAttachmentBytes: async () => ({ ok: true, bytes }),
    });

    const imageResult = (callId: string, relativePath: string) =>
      runtimeEvent({
        id: `rt-result-${callId}`,
        turnId: 'turn-prev',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: callId,
          name: 'Read',
          isError: false,
          result: {
            kind: 'image',
            mimeType: 'image/png',
            ref: { kind: 'session_file', sessionId: 'session-1', relativePath },
          },
        },
      });
    const call = (callId: string, path: string) =>
      runtimeEvent({
        id: `rt-call-${callId}`,
        turnId: 'turn-prev',
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: callId, name: 'Read', args: { path } },
      });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'read them',
          }),
          call('tool-1', 'a.png'),
          imageResult('tool-1', 'artifact-1'),
          call('tool-2', 'b.png'),
          imageResult('tool-2', 'artifact-2'),
          call('tool-3', 'c.png'),
          imageResult('tool-3', 'artifact-3'),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const toolOutputs = prompt
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content as any[])
      .map((entry) => entry?.output)
      .filter((output) => output?.type === 'content');
    const imageData = toolOutputs.filter((output) =>
      output.value.some((part: any) => part.type === 'file' && part.mediaType === 'image/png'),
    );
    const degraded = toolOutputs.filter((output) =>
      output.value.some((part: any) => part.type === 'text' && /image budget/.test(part.text)),
    );
    assert.equal(
      imageData.length,
      2,
      `expected two hydrated image tool results, got: ${JSON.stringify(toolOutputs)}`,
    );
    assert.equal(
      degraded.length,
      1,
      `expected one budget-degraded tool result, got: ${JSON.stringify(toolOutputs)}`,
    );
  });

  test('budgets replayed image tool results by durable occurrence instead of reused tool-call ids', async () => {
    const bytes = new Uint8Array(10);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      maxProviderImageRequestBytes: 15,
      readAttachmentBytes: async () => ({ ok: true, bytes }),
    });
    const call = (eventId: string, turnId: string) =>
      runtimeEvent({
        id: eventId,
        turnId,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'reused-tool-id',
          name: 'Read',
          args: { path: `${turnId}.png` },
        },
      });
    const result = (eventId: string, turnId: string) =>
      runtimeEvent({
        id: eventId,
        turnId,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'reused-tool-id',
          name: 'Read',
          isError: false,
          result: {
            kind: 'image',
            mimeType: 'image/png',
            ref: {
              kind: 'session_file',
              sessionId: 'session-1',
              relativePath: `${turnId}.png`,
            },
          },
        },
      });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'user-a',
            turnId: 'turn-a',
            role: 'user',
            author: 'user',
            text: 'read a',
          }),
          call('call-a', 'turn-a'),
          result('result-a', 'turn-a'),
          runtimeTextEvent({
            id: 'user-b',
            turnId: 'turn-b',
            role: 'user',
            author: 'user',
            text: 'read b',
          }),
          call('call-b', 'turn-b'),
          result('result-b', 'turn-b'),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const outputs = prompt
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((entry) => entry?.output)
      .filter((output) => output?.type === 'content');
    assert.equal(
      outputs.filter((output) =>
        output.value.some((part: any) => part.type === 'file' && part.mediaType === 'image/png'),
      ).length,
      1,
    );
    assert.equal(
      outputs.filter((output) =>
        output.value.some((part: any) => part.type === 'text' && /image budget/.test(part.text)),
      ).length,
      1,
    );
  });

  test('RuntimeEvent replay renders historical image attachments as image parts', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
      supportsVision: true,
    } as never);

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'follow-up question',
        context: [],
        runtimeContext: [
          runtimeEvent({
            id: 'rt-img',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            content: {
              kind: 'text',
              text: 'look at this chart',
              attachments: [
                {
                  kind: 'image',
                  name: 'pic.png',
                  mimeType: 'image/png',
                  bytes: 11,
                  ref: {
                    kind: 'session_file',
                    sessionId: 'session-1',
                    relativePath: 'fake/pic.png',
                  },
                },
              ],
            },
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'noted',
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const historicalUser = prompt[0];
    const parts = historicalUser.content as Array<{ type: string; mediaType?: string }>;
    const imageLike = parts.find((p) => p.type !== 'text' && p.mediaType === 'image/png');
    assert.ok(
      imageLike,
      `expected a historical image/png part in replay, got: ${JSON.stringify(parts)}`,
    );
  });

  test('preserves RuntimeEvent tool calls and results as structured AI SDK parts', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'projection user',
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'projection assistant',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: 'contents',
              isError: false,
            },
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'Read',
            input: { path: 'package.json' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'Read',
            output: { type: 'text', value: 'contents' },
            providerOptions: undefined,
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('replays provider-executed CC web search with encrypted result content intact', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [buildNativeWebSearchTool({ adapter: 'anthropic-messages' })],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u-search',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'search',
          }),
          runtimeEvent({
            id: 'rt-search-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'search-1',
              name: 'WebSearch',
              args: { query: 'latest Maka' },
              providerExecuted: true,
            },
          }),
          runtimeEvent({
            id: 'rt-search-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'search-1',
              name: 'WebSearch',
              result: [
                {
                  type: 'web_search_result',
                  url: 'https://maka.example/',
                  title: 'Maka',
                  pageAge: '2026-08-04',
                  encryptedContent: 'encrypted-result',
                },
              ],
              providerExecuted: true,
            },
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const assistant = prompt.find((message) => message.role === 'assistant');
    const call = assistant?.content.find((part) => part.type === 'tool-call');
    const result = assistant?.content.find((part) => part.type === 'tool-result');
    assert.equal(call?.providerExecuted, true, JSON.stringify(prompt));
    assert.deepEqual(call?.input, { query: 'latest Maka' });
    assert.match(JSON.stringify(result?.output), /encrypted-result/);
    assert.equal(
      prompt.some((message) => message.role === 'tool'),
      false,
      JSON.stringify(prompt),
    );
  });

  test('replays provider-executed web search before its grounded assistant text', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [buildNativeWebSearchTool({ adapter: 'openai-responses' })],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u-search',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'search',
          }),
          runtimeEvent({
            id: 'rt-search-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { stepId: 'provider-step' },
            content: {
              kind: 'function_call',
              id: 'search-1',
              name: 'WebSearch',
              args: { query: 'latest Maka' },
              providerExecuted: true,
            },
          }),
          runtimeEvent({
            id: 'rt-search-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'search-1',
              name: 'WebSearch',
              result: { type: 'web_search_result', query: 'latest Maka' },
              providerOutput: { type: 'web_search_result', id: 'ws_123' },
              providerExecuted: true,
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-search-text',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'provider-step' },
            content: { kind: 'text', text: 'Maka shipped the feature.' },
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const assistant = prompt.find(
      (message) =>
        message.role === 'assistant' && message.content.some((part) => part.type === 'tool-call'),
    );
    assert.deepEqual(
      assistant?.content.map((part) => part.type),
      ['tool-call', 'tool-result', 'text'],
    );
    assert.match(JSON.stringify(assistant), /ws_123/);
    assert.match(JSON.stringify(assistant), /Maka shipped the feature/);
  });

  test('falls back to grounded text when Open Responses cannot replay a hosted tool pair', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u-search',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'search',
          }),
          runtimeEvent({
            id: 'rt-search-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { stepId: 'provider-step' },
            content: {
              kind: 'function_call',
              id: 'search-1',
              name: 'WebSearch',
              args: { query: 'latest Maka' },
              providerExecuted: true,
            },
          }),
          runtimeEvent({
            id: 'rt-search-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'search-1',
              name: 'WebSearch',
              result: { type: 'web_search_result', query: 'latest Maka' },
              providerExecuted: true,
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-search-text',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'provider-step' },
            content: { kind: 'text', text: 'Maka shipped the feature.' },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-prev',
          sourceRuntimeEventHighWater: 4,
        },
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    assert.match(JSON.stringify(prompt), /Maka shipped the feature/);
    assert.equal(JSON.stringify(prompt).includes('tool-call'), false);
    assert.equal(JSON.stringify(prompt).includes('tool-result'), false);
  });

  test('keeps unrelated client tool history when degrading a hosted tool pair', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: '[redacted]',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u-mixed',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'read then search',
          }),
          runtimeEvent({
            id: 'rt-read-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { stepId: 'client-step' },
            content: {
              kind: 'function_call',
              id: 'read-1',
              name: 'Read',
              args: { path: '/tmp/sentinel.ts' },
            },
          }),
          runtimeEvent({
            id: 'rt-read-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'read-1',
              name: 'Read',
              result: [{ type: 'text', text: 'CLIENT_READ_SENTINEL_CONTENT' }],
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-search-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { stepId: 'provider-step' },
            content: {
              kind: 'function_call',
              id: 'search-1',
              name: 'WebSearch',
              args: { query: 'latest Maka' },
              providerExecuted: true,
            },
          }),
          runtimeEvent({
            id: 'rt-search-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'search-1',
              name: 'WebSearch',
              result: { type: 'web_search_result', query: 'latest Maka' },
              providerExecuted: true,
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-mixed-text',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'provider-step' },
            content: { kind: 'text', text: 'Maka shipped the feature.' },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-prev',
          sourceRuntimeEventHighWater: 6,
        },
      }),
    );

    const wire = JSON.stringify(compactPrompt(model));
    // The unsupported provider-executed pair degrades away…
    assert.equal(wire.includes('latest Maka'), false, wire);
    // …but the unrelated client Read call and its result survive (#2972).
    assert.match(wire, /CLIENT_READ_SENTINEL_CONTENT/);
    assert.match(wire, /"toolName":"Read"|\\"toolName\\":\\"Read\\"/);
    assert.match(wire, /Maka shipped the feature/);
  });

  test('replays an image tool result as provider image data', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      supportsVision: true,
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'read it',
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'chart.png' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              isError: false,
              result: {
                kind: 'image',
                mimeType: 'image/png',
                ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
              },
            },
          }),
        ],
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const result = prompt.find((message) => message.role === 'tool')?.content[0]?.output;
    assert.equal(result.type, 'content');
    assert.ok(
      result.value.some((part: any) => part.type === 'file' && part.mediaType === 'image/png'),
    );
  });

  test('sends a live image tool result to the next provider step', async () => {
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    );
    let calls = 0;
    const anchor = runtimeTextEvent({
      id: 'runtime-user',
      turnId: 'turn-1',
      role: 'user',
      author: 'user',
      text: 'read chart.png',
    });
    const ledger: RuntimeEvent[] = [anchor];
    const mappingMemory = createSessionEventMapMemory();
    const mappingContext: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'read chart.png',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks: (calls === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'tool-1',
                    toolName: 'Read',
                    input: JSON.stringify({ path: 'chart.png' }),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: emptyUsage(),
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: emptyUsage(),
                  },
                ]) as LanguageModelV4StreamPart[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'read',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({
            kind: 'image',
            mimeType: 'image/png',
            ref: {
              kind: 'session_file' as const,
              sessionId: 'session-1',
              relativePath: 'artifact-1',
            },
          }),
        },
      ],
      supportsVision: true,
      readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes }),
      loadTurnRuntimeEvents: async () => ledger,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({
      turnId: 'turn-1',
      text: 'read chart.png',
      context: [],
      headAnchorRuntimeEvent: anchor,
    })) {
      const mapped = mapSessionEventToRuntimeEvent(event, mappingContext, mappingMemory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    }

    const nextPrompt = model.doStreamCalls[1]?.prompt as Array<{ role: string; content: any[] }>;
    const result = nextPrompt.find((message) => message.role === 'tool')?.content[0]?.output;
    assert.ok(
      result.value.some((part: any) => part.type === 'file' && part.mediaType === 'image/png'),
    );
  });

  test('reloads durable multi-tool settlement before terminal continuation', async () => {
    const anchor = runtimeTextEvent({
      id: 'runtime-user',
      turnId: 'turn-1',
      role: 'user',
      author: 'user',
      text: 'run both tools',
    });
    const ledger: RuntimeEvent[] = [anchor];
    const mappingMemory = createSessionEventMapMemory();
    const mappingContext: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'run both tools',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    const executions: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 2) {
          assert.equal(
            ledger.filter((event) => event.content?.kind === 'function_response').length,
            2,
          );
        }
        const chunks: LanguageModelV4StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'reasoning-1' },
                { type: 'reasoning-delta', id: 'reasoning-1', delta: 'inspect first' },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-1',
                  delta: '',
                  providerMetadata: { anthropic: { signature: 'sig-step-1' } },
                },
                { type: 'reasoning-end', id: 'reasoning-1' },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Running tools.' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'tool-call',
                  toolCallId: 'call-success',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'ok.md' }),
                  providerMetadata: {
                    google: { thoughtSignature: 'thought-signature-step-1' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'call-failure',
                  toolName: 'Fail',
                  input: JSON.stringify({ path: 'bad.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: emptyUsage(),
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-2' },
                { type: 'text-delta', id: 'text-2', delta: 'Done.' },
                { type: 'text-end', id: 'text-2' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: emptyUsage(),
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'read',
          parameters: z.object({ path: z.string() }),
          impl: async ({ path }: { path: string }) => {
            executions.push(`Read:${path}`);
            return { body: 'ok' };
          },
        },
        {
          name: 'Fail',
          description: 'fail',
          parameters: z.object({ path: z.string() }),
          impl: async ({ path }: { path: string }) => {
            executions.push(`Fail:${path}`);
            throw new Error('tool failed');
          },
        },
      ],
      loadTurnRuntimeEvents: async () => ledger,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const emitted: SessionEvent[] = [];
    for await (const event of backend.send({
      turnId: 'turn-1',
      text: 'run both tools',
      context: [],
      headAnchorRuntimeEvent: anchor,
    })) {
      emitted.push(event);
      const mapped = mapSessionEventToRuntimeEvent(event, mappingContext, mappingMemory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    }

    assert.equal(calls, 2);
    assert.deepEqual(executions, ['Read:ok.md', 'Fail:bad.md']);
    const nextPrompt = model.doStreamCalls[1]?.prompt as unknown as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const assistantStep = nextPrompt.find(
      (message) =>
        message.role === 'assistant' && message.content.some((part) => part.type === 'tool-call'),
    );
    assert.deepEqual(
      assistantStep?.content.map((part) => part.type),
      ['reasoning', 'text', 'tool-call', 'tool-call'],
    );
    assert.match(JSON.stringify(assistantStep), /sig-step-1/);
    assert.deepEqual(assistantStep?.content[2]?.providerOptions, {
      google: { thoughtSignature: 'thought-signature-step-1' },
    });
    assert.match(JSON.stringify(assistantStep), /Running tools\./);
    assert.deepEqual(
      nextPrompt
        .filter((message) => message.role === 'tool')
        .flatMap((message) => message.content.map((part) => part.toolCallId)),
      ['call-success', 'call-failure'],
    );
    const toolResults = JSON.stringify(nextPrompt.filter((message) => message.role === 'tool'));
    assert.match(toolResults, /"ok"/);
    assert.match(toolResults, /tool failed/i);
    assert.deepEqual(
      ledger
        .filter((event) => event.content?.kind === 'function_response')
        .map((event) => {
          assert.equal(event.content?.kind, 'function_response');
          return {
            id: event.content.id,
            isError: event.content.isError === true,
          };
        }),
      [
        { id: 'call-success', isError: false },
        { id: 'call-failure', isError: true },
      ],
    );
    assert.ok(
      emitted.some((event) => event.type === 'text_complete' && event.text === 'Done.'),
      'the terminal provider step emits its final assistant text',
    );
    assert.ok(
      ledger.some(
        (event) =>
          event.partial !== true &&
          event.role === 'model' &&
          event.content?.kind === 'text' &&
          event.content.text === 'Done.',
      ),
      'the terminal assistant text becomes a durable RuntimeEvent fact',
    );
    const complete = emitted.find(
      (event): event is Extract<SessionEvent, { type: 'complete' }> => event.type === 'complete',
    );
    assert.equal(complete?.stopReason, 'end_turn');
  });

  test('does not read image bytes for a non-vision model', async () => {
    let reads = 0;
    const model = completionModel();
    const backend = imageReplayBackend(model, {
      supportsVision: false,
      readAttachmentBytes: async () => {
        reads += 1;
        return { ok: true, bytes: new Uint8Array([1]) };
      },
    });

    await drain(backend.send(imageReplayInput()));

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const output = prompt.find((message) => message.role === 'tool')?.content[0]?.output;
    assert.equal(reads, 0);
    assert.match(output.value[0].text, /does not support image input/);
  });

  test('explains when a replayed image artifact is missing', async () => {
    const model = completionModel();
    const backend = imageReplayBackend(model, {
      supportsVision: true,
      readAttachmentBytes: async () => ({ ok: false, reason: 'not_found' }),
    });

    await drain(backend.send(imageReplayInput()));

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const output = prompt.find((message) => message.role === 'tool')?.content[0]?.output;
    assert.match(output.value[0].text, /not_found/);
  });

  test('explains when replayed image storage throws', async () => {
    const model = completionModel();
    const backend = imageReplayBackend(model, {
      supportsVision: true,
      readAttachmentBytes: async () => {
        throw new Error('private disk detail');
      },
    });

    await drain(backend.send(imageReplayInput()));

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const output = prompt.find((message) => message.role === 'tool')?.content[0]?.output;
    assert.match(output.value[0].text, /read_failed/);
    assert.doesNotMatch(JSON.stringify(prompt), /private disk detail/);
  });

  test('replays interleaved parallel RuntimeEvent tool calls as one provider tool-call block', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'inspect files',
          }),
          runtimeEvent({
            id: 'rt-call-0',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-0',
              name: 'Read',
              args: { path: 'main.cpp' },
            },
          }),
          runtimeEvent({
            id: 'rt-call-1',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'user.cpp' },
            },
          }),
          runtimeEvent({
            id: 'rt-result-0',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-0',
              name: 'Read',
              result: 'main',
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-call-2',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'function_call', id: 'tool-2', name: 'Glob', args: { pattern: '*' } },
          }),
          runtimeEvent({
            id: 'rt-result-1',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: 'user',
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-result-2',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-2',
              name: 'Glob',
              result: ['main.cpp', 'user.cpp'],
              isError: false,
            },
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'inspect files' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-0',
            toolName: 'Read',
            input: { path: 'main.cpp' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'Read',
            input: { path: 'user.cpp' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
          {
            type: 'tool-call',
            toolCallId: 'tool-2',
            toolName: 'Glob',
            input: { pattern: '*' },
            providerExecuted: undefined,
            providerOptions: undefined,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-0',
            toolName: 'Read',
            output: { type: 'text', value: 'main' },
            providerOptions: undefined,
          },
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'Read',
            output: { type: 'text', value: 'user' },
            providerOptions: undefined,
          },
          {
            type: 'tool-result',
            toolCallId: 'tool-2',
            toolName: 'Glob',
            output: { type: 'json', value: ['main.cpp', 'user.cpp'] },
            providerOptions: undefined,
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('replays durable Bash results without duplicating commands in provider output', async () => {
    const model = completionModel();
    const durableResults = [
      {
        kind: 'terminal' as const,
        cwd: '/workspace',
        cmd: 'printf completed-marker',
        status: 'completed' as const,
        exitCode: 0,
        output: {
          mode: 'pipes' as const,
          stdout: 'completed',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace',
        cmd: 'printf failed-marker',
        status: 'failed' as const,
        exitCode: 2,
        output: {
          mode: 'pipes' as const,
          stdout: '',
          stderr: 'failed',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
        sandboxDenial: {
          likely: true as const,
          backend: 'macos-seatbelt' as const,
          recovery: 'require_escalated' as const,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace',
        cmd: 'printf timeout-marker',
        status: 'timed_out' as const,
        exitCode: 124,
        output: {
          mode: 'pipes' as const,
          stdout: 'partial timeout',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace',
        cmd: 'printf cancelled-marker',
        status: 'cancelled' as const,
        exitCode: 130,
        output: {
          mode: 'pipes' as const,
          stdout: '',
          stderr: 'cancelled',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace',
        cmd: 'printf truncated-marker',
        status: 'completed' as const,
        exitCode: 0,
        output: {
          mode: 'pipes' as const,
          stdout: 'tail',
          stderr: 'error tail',
          stdoutTruncated: true,
          stderrTruncated: true,
          redacted: true,
        },
      },
    ];
    const runtimeContext: RuntimeEvent[] = [
      runtimeTextEvent({
        id: 'rt-u',
        turnId: 'turn-prev',
        role: 'user',
        author: 'user',
        text: 'run all commands',
      }),
      ...durableResults.map((result, index) =>
        runtimeEvent({
          id: `rt-call-${index}`,
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: `tool-${index}`,
            name: 'Bash',
            args: { command: result.cmd },
          },
        }),
      ),
      ...durableResults.map((result, index) =>
        runtimeEvent({
          id: `rt-result-${index}`,
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: `tool-${index}`,
            name: 'Bash',
            result,
            isError: result.status !== 'completed',
          },
        }),
      ),
    ];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(model) as Array<{ role: string; content: any[] }>;
    const serializedPrompt = JSON.stringify(prompt);
    const toolResults = prompt.find((message) => message.role === 'tool')?.content ?? [];
    assert.equal(toolResults.length, durableResults.length);
    for (const [index, durable] of durableResults.entries()) {
      assert.equal(
        serializedPrompt.split(durable.cmd).length - 1,
        1,
        `command ${index} should remain only in its paired Bash call`,
      );
      const output = toolResults[index]?.output;
      assert.equal(output?.type, durable.status === 'completed' ? 'json' : 'error-json');
      assert.equal(Object.hasOwn(output?.value ?? {}, 'cmd'), false);
      const { cmd: _cmd, ...expected } = durable;
      assert.deepEqual(output?.value, expected);
      assert.equal(durableResults[index]?.cmd, durable.cmd);
    }
  });

  test('archives stale RuntimeEvent tool results before replay placeholder rewrite', async () => {
    const model = completionModel();
    const archiveRequests: Array<{
      runtimeEventId: string;
      serializedResult: string;
      bodySha256: string;
    }> = [];
    const oldResult = { body: 'x'.repeat(500) };
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archiveRequests.push({
            runtimeEventId: event.runtimeEventId,
            serializedResult: event.serializedResult,
            bodySha256: event.bodySha256,
          });
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
      }),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
        runtimeContext: [
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: oldResult,
              isError: false,
            },
          }),
        ],
      }),
    );

    assert.equal(archiveRequests.length, 1);
    assert.equal(archiveRequests[0]?.runtimeEventId, 'rt-result');
    assert.equal(archiveRequests[0]?.serializedResult, JSON.stringify(oldResult));
    assert.match(archiveRequests[0]?.bodySha256 ?? '', /^[a-f0-9]{64}$/);

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /"kind":"maka\.archived_tool_result"/);
    assert.match(prompt, /"artifactId":"artifact-rt-result"/);
    assert.match(prompt, /"runtimeEventId":"rt-result"/);
    assert.equal(prompt.includes(oldResult.body), false);
  });

  test('preserves existing archive refs while adding newly archived refs', async () => {
    const model = completionModel();
    const existingResult = { body: 'EXISTING_ARCHIVE_REF_PAYLOAD'.repeat(20) };
    const newResult = { body: 'NEW_ARCHIVE_REF_PAYLOAD'.repeat(20) };
    const existingSerialized = JSON.stringify(existingResult);
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'existing-archive-ref-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
          archiveRefs: [
            {
              runtimeEventId: 'rt-result',
              toolCallId: 'tool-1',
              toolName: 'Read',
              artifactId: 'artifact-existing-rt-result',
              bodySha256: sha256(existingSerialized),
              originalEstimatedTokens: existingSerialized.length,
              originalBytes: utf8Bytes(existingSerialized),
              rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
              reason: 'stale_tool_result_pruned_before_compact',
            },
          ],
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) =>
          event.runtimeEventId === 'rt-new-result'
            ? { artifactId: 'artifact-new-rt-result' }
            : undefined,
      }),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
        runtimeContext: [
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: existingResult,
              isError: false,
            },
          }),
          runtimeEvent({
            id: 'rt-new-call',
            turnId: 'turn-new',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-2',
              name: 'Read',
              args: { path: 'new.txt' },
            },
          }),
          runtimeEvent({
            id: 'rt-new-result',
            turnId: 'turn-new',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-2',
              name: 'Read',
              result: newResult,
              isError: false,
            },
          }),
        ],
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /"artifactId":"artifact-existing-rt-result"/);
    assert.match(prompt, /"artifactId":"artifact-new-rt-result"/);
    assert.equal(prompt.includes(existingResult.body), false);
    assert.equal(prompt.includes(newResult.body), false);
  });

  test('history search does not re-add stale full tool results after archive pruning', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const oldResult = { body: 'SECRET_PAYLOAD_SHOULD_NOT_RETURN'.repeat(20) };
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-search-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => ({ artifactId: `artifact-${event.runtimeEventId}` }),
      }),
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Find SECRET_PAYLOAD_SHOULD_NOT_RETURN',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-old',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-1',
            name: 'Read',
            args: { path: 'secret.txt' },
          },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-old',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-1',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
        runtimeEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'newer retained context' },
        }),
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(compactPrompt(model));
    assert.equal(prompt.includes(oldResult.body), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.archivePlaceholders, 1);
    assert.equal(usage?.contextBudget?.historySearchMatches, 0);
  });

  test('hydrates archived RuntimeEvent tool results for model replay when retrieval is enabled', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    let archivedBody = '';
    const oldResult = { body: 'retrieved 中文 archived payload 🙂'.repeat(3) };
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'archive-retrieval-test',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          maxResults: 1,
          maxEstimatedTokens: 1024,
          maxBytes: 1024,
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archivedBody = event.serializedResult;
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
        readToolResultArchive: async (event) => {
          if (event.originalBytes !== utf8Bytes(archivedBody)) {
            return { ok: false, reason: 'size_mismatch' };
          }
          return {
            ok: true,
            serializedResult: event.bodySha256 === sha256(archivedBody) ? archivedBody : 'tampered',
          };
        },
      }),
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-1',
            name: 'Read',
            args: { path: 'package.json' },
          },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-1',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /retrieved 中文 archived payload/);
    assert.equal(prompt.includes('maka.archived_tool_result'), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(usage?.contextBudget?.archiveRetrievalFailures, 0);
  });

  test('gates archive hydration to RuntimeEvent turns selected by history search', async () => {
    const selectedResult = { body: 'PHASE7_SELECTED_SENTINEL'.repeat(20) };
    const unselectedResult = { body: 'PHASE7_UNSELECTED_SENTINEL'.repeat(20) };
    const result = await runArchiveGatedReplay({
      query: 'Find needle-a and recover its archived result',
      selectedResult,
      unselectedResult,
      selectedPath: 'needle-a.txt',
      unselectedPath: 'needle-b.txt',
    });

    assert.deepEqual(result.readRuntimeEventIds, ['rt-result-a']);
    assert.match(result.prompt, /PHASE7_SELECTED_SENTINEL/);
    assert.equal(result.prompt.includes('PHASE7_UNSELECTED_SENTINEL'), false);
    assert.equal(result.usage?.contextBudget?.archiveRetrievalMode, 'history_search_gated');
    assert.equal(result.usage?.contextBudget?.archiveRetrievalEligibleTurns, 1);
    assert.equal(result.usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(result.usage?.contextBudget?.historySearchMatches, 1);
  });

  test('gates archive hydration using searchable original tool result content', async () => {
    const selectedResult = { body: 'zzztokenbodyonly777'.repeat(20) };
    const unselectedResult = { body: 'other_payload'.repeat(20) };
    const result = await runArchiveGatedReplay({
      query: 'zzztokenbodyonly777',
      selectedResult,
      unselectedResult,
      selectedPath: 'selected.txt',
      unselectedPath: 'unselected.txt',
      selectedAfterUnselected: true,
    });

    assert.deepEqual(result.readRuntimeEventIds, ['rt-result-a']);
    assert.match(result.prompt, /zzztokenbodyonly777/);
    assert.equal(result.prompt.includes('other_payload'), false);
    assert.equal(result.usage?.contextBudget?.archiveRetrievalMode, 'history_search_gated');
    assert.equal(result.usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(result.usage?.contextBudget?.historySearchMatches, 1);
  });

  test('uses selected synthesis block instead of hydrating covered archived payload', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const writeInputs: Array<{ turnId: string; query: string }> = [];
    const oldResult = { body: 'RAW_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          blocks: [block],
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archivedBodies.set(event.runtimeEventId, event.serializedResult);
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
        readToolResultArchive: async (event) => {
          readRuntimeEventIds.push(event.runtimeEventId);
          const body = archivedBodies.get(event.runtimeEventId);
          return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
        },
      }),
      writeSynthesisCache: async (event) => {
        writeInputs.push({ turnId: event.turnId, query: event.source.query });
        return { blocks: [] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-alpha',
            name: 'Read',
            args: { path: 'key-alpha.txt' },
          },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-alpha',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(readRuntimeEventIds, []);
    assert.deepEqual(writeInputs, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /maka_synthesis_cache_block/);
    assert.match(prompt, /SYNTHESIS_SENTINEL_KEY_ALPHA/);
    assert.equal(prompt.includes('RAW_SYNTHESIS_ARCHIVE_PAYLOAD'), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheBlockIds, ['synth-key-alpha']);
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, undefined);
  });

  test('A/B: synthesis cache cuts replay tokens vs hydrating the archived payload', async () => {
    // Deterministic economic-mechanism benchmark for #578. The same replay is
    // projected twice against a fake model: the baseline re-hydrates the full
    // archived tool result; the arm injects the compact synthesis block instead.
    // The prompt the model actually receives is ground truth, so its size delta
    // is the synthesis cache's replay-token saving — no live model or network,
    // so the number is reproducible in CI. (Live Terminal-Bench runs can't drive
    // this: their single-long-turn shape never archives-then-retrieves a turn, so
    // the write path stays source_missing — see docs/archive/economic-mechanisms-benchmark.md.)
    const CHARS_PER_TOKEN = 1; // 1:1 so prompt chars are directly the token estimate
    const archivedResult = { body: 'RAW_SYNTHESIS_ARCHIVE_PAYLOAD '.repeat(80).trim() };
    const serialized = JSON.stringify(archivedResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    async function projectReplayPromptChars(useSynthesisCache: boolean): Promise<string> {
      const model = completionModel();
      const archivedBodies = new Map<string, string>();
      const backend = createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        appendMessage: async () => {},
        connection: connection(),
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => model,
        tools: [],
        newId: idGenerator(),
        now: monotonicClock(),
        contextBudget: {
          name: 'synthesis-cache-benchmark',
          maxHistoryTurns: 1,
          minRecentTurns: 0,
          staleToolResultPrune: {
            enabled: true,
            maxResultEstimatedTokens: 1,
            minRecentTurnsFull: 0,
          },
          archiveRetrieval: {
            enabled: true,
            mode: 'history_search_gated',
            maxResults: 1,
            maxEstimatedTokens: 8192,
            maxBytes: 8192,
          },
          historySearch: { enabled: true, maxResults: 1, around: 1, maxEstimatedTokens: 8192 },
          ...(useSynthesisCache
            ? { synthesisCache: { enabled: true, mode: 'read_write', blocks: [block] } }
            : {}),
          charsPerToken: CHARS_PER_TOKEN,
        },
        toolResultArchive: testToolResultArchive({
          archiveToolResult: async (event) => {
            archivedBodies.set(event.runtimeEventId, event.serializedResult);
            return { artifactId: `artifact-${event.runtimeEventId}` };
          },
          readToolResultArchive: async (event) => {
            const body = archivedBodies.get(event.runtimeEventId);
            return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
          },
        }),
        writeSynthesisCache: async () => ({ blocks: [] }),
      });
      for await (const _event of backend.send({
        turnId: 'turn-current',
        text: 'Recover key-alpha',
        context: [],
        runtimeContext: [
          runtimeEvent({
            id: 'rt-call-alpha',
            turnId: 'turn-alpha',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-alpha',
              name: 'Read',
              args: { path: 'key-alpha.txt' },
            },
          }),
          runtimeEvent({
            id: 'rt-result-alpha',
            turnId: 'turn-alpha',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-alpha',
              name: 'Read',
              result: archivedResult,
              isError: false,
            },
          }),
          runtimeTextEvent({
            id: 'rt-new',
            turnId: 'turn-new',
            role: 'user',
            author: 'user',
            text: 'newer retained context',
          }),
        ],
      })) {
        // drain the stream so the request is issued to the mock model
      }
      return JSON.stringify(compactPrompt(model));
    }

    const baseline = await projectReplayPromptChars(false);
    const arm = await projectReplayPromptChars(true);
    const baselineTokens = Math.ceil(baseline.length / CHARS_PER_TOKEN);
    const armTokens = Math.ceil(arm.length / CHARS_PER_TOKEN);

    // Ground-truth: baseline hydrates the raw payload; the arm swaps in the block.
    assert.ok(
      baseline.includes('RAW_SYNTHESIS_ARCHIVE_PAYLOAD'),
      'baseline should hydrate the archived payload',
    );
    assert.ok(arm.includes('maka_synthesis_cache_block'), 'arm should inject the synthesis block');
    assert.equal(
      arm.includes('RAW_SYNTHESIS_ARCHIVE_PAYLOAD'),
      false,
      'arm must not hydrate the raw payload',
    );
    assert.ok(armTokens < baselineTokens, 'synthesis cache must reduce replay tokens');
  });

  test('loads synthesis blocks before archive retrieval', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const oldResult = { body: 'RAW_LOADED_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    let loadCalls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-load-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          maxBlocks: 1,
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archivedBodies.set(event.runtimeEventId, event.serializedResult);
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
        readToolResultArchive: async (event) => {
          readRuntimeEventIds.push(event.runtimeEventId);
          const body = archivedBodies.get(event.runtimeEventId);
          return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
        },
      }),
      loadSynthesisCache: async () => {
        loadCalls += 1;
        return { blocks: [block] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-alpha',
            name: 'Read',
            args: { path: 'key-alpha.txt' },
          },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-alpha',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.equal(loadCalls, 1);
    assert.deepEqual(readRuntimeEventIds, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /maka_synthesis_cache_block/);
    assert.equal(prompt.includes('RAW_LOADED_SYNTHESIS_ARCHIVE_PAYLOAD'), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksLoaded, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 1);
  });

  test('writes synthesis cache after successful gated archive retrieval without injecting it into the same request', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const writeInputs: Array<{ sourceRefCount: number; hydratedHasRaw: boolean }> = [];
    const oldResult = { body: 'RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20), key: 'key-alpha' };
    const serialized = JSON.stringify(oldResult);
    const writtenBlock = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-write-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          maxBlocks: 1,
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archivedBodies.set(event.runtimeEventId, event.serializedResult);
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
        readToolResultArchive: async (event) => {
          const body = archivedBodies.get(event.runtimeEventId);
          return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
        },
      }),
      writeSynthesisCache: async (input) => {
        writeInputs.push({
          sourceRefCount: input.source.retrievedArchiveRefs.length,
          hydratedHasRaw: JSON.stringify(input.source.hydratedRuntimeEvents).includes(
            'RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD',
          ),
        });
        return { blocks: [writtenBlock] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Recover key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-alpha',
            name: 'Read',
            args: { path: 'key-alpha.txt' },
          },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-alpha',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(writeInputs, [{ sourceRefCount: 1, hydratedHasRaw: true }]);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /RAW_WRITE_SYNTHESIS_ARCHIVE_PAYLOAD/);
    assert.equal(prompt.includes('SYNTHESIS_SENTINEL_KEY_ALPHA'), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.synthesisCacheWritesAttempted, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksWritten, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheWrittenBlockIds, ['synth-key-alpha']);
  });

  test('falls back to gated archive retrieval when synthesis request asks for evidence', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const archivedBodies = new Map<string, string>();
    const readRuntimeEventIds: string[] = [];
    const writeInputs: Array<{ turnId: string; query: string }> = [];
    const oldResult = { body: 'RAW_SYNTHESIS_ARCHIVE_PAYLOAD'.repeat(20) };
    const serialized = JSON.stringify(oldResult);
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'rt-result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-rt-result-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'synthesis-cache-raw-test',
        maxHistoryTurns: 1,
        minRecentTurns: 0,
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 1,
          minRecentTurnsFull: 0,
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'history_search_gated',
          maxResults: 1,
          maxEstimatedTokens: 4096,
          maxBytes: 4096,
        },
        historySearch: {
          enabled: true,
          maxResults: 1,
          around: 1,
          maxEstimatedTokens: 4096,
        },
        synthesisCache: {
          enabled: true,
          mode: 'read_write',
          blocks: [block],
        },
        charsPerToken: 1,
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async (event) => {
          archivedBodies.set(event.runtimeEventId, event.serializedResult);
          return { artifactId: `artifact-${event.runtimeEventId}` };
        },
        readToolResultArchive: async (event) => {
          readRuntimeEventIds.push(event.runtimeEventId);
          const body = archivedBodies.get(event.runtimeEventId);
          return body ? { ok: true, serializedResult: body } : { ok: false, reason: 'not_found' };
        },
      }),
      writeSynthesisCache: async (event) => {
        writeInputs.push({ turnId: event.turnId, query: event.source.query });
        return { blocks: [] };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'Show raw evidence for key-alpha',
      context: [],
      runtimeContext: [
        runtimeEvent({
          id: 'rt-call-alpha',
          turnId: 'turn-alpha',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-alpha',
            name: 'Read',
            args: { path: 'key-alpha.txt' },
          },
        }),
        runtimeEvent({
          id: 'rt-result-alpha',
          turnId: 'turn-alpha',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-alpha',
            name: 'Read',
            result: oldResult,
            isError: false,
          },
        }),
        runtimeTextEvent({
          id: 'rt-new',
          turnId: 'turn-new',
          role: 'user',
          author: 'user',
          text: 'newer retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(readRuntimeEventIds, ['rt-result-alpha']);
    assert.deepEqual(writeInputs, []);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /RAW_SYNTHESIS_ARCHIVE_PAYLOAD/);
    assert.equal(prompt.includes('maka_synthesis_cache_block'), false);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.synthesisCacheBlocksSelected, 0);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
    assert.equal(usage?.contextBudget?.retrievedArchiveToolResults, 1);
    assert.equal(usage?.contextBudget?.synthesisCacheWriteSkipped, 1);
    assert.deepEqual(usage?.contextBudget?.synthesisCacheWriteSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
  });

  test('manual compactHistory writes shared history compact artifacts and returns diagnostics', async () => {
    const writeInputs: Array<{ turnId: string; foldedIds: string[] }> = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual beta compact source '.repeat(12),
      }),
    ];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push({
          turnId: input.turnId,
          foldedIds: input.source.foldedRuntimeEvents.map((event) => event.id),
        });
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    const recentEvent = runtimeTextEvent({
      id: 'manual-compact-recent',
      turnId: 'turn-recent',
      role: 'user',
      author: 'user',
      text: 'manual recent retained context',
    });
    const runtimeContext = [...oldEvents, recentEvent];
    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext,
    });

    assert.deepEqual(writeInputs, [
      {
        turnId: 'turn-compact',
        foldedIds: ['manual-compact-old-1', 'manual-compact-old-2'],
      },
    ]);
    assert.equal(result.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(result.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.boundaryKind, 'historyCompact');

    await backend.compactHistory({
      turnId: 'turn-overflow-recovery',
      runId: 'run-1',
      runtimeContext,
      minRecentTurns: 0,
    });
    assert.deepEqual(writeInputs[1], {
      turnId: 'turn-overflow-recovery',
      foldedIds: ['manual-compact-old-1', 'manual-compact-old-2', 'manual-compact-recent'],
    });
  });

  test('manual compactHistory still folds small histories with the default automatic compact policy', async () => {
    const writeInputs: string[][] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: buildDefaultContextBudgetPolicy(connection(), {
        name: 'cli-default-history-budget',
        modelId: 'claude-sonnet-4-5-20250929',
      }),
      writeHistoryCompact: async (input) => {
        writeInputs.push(input.source.foldedRuntimeEvents.map((event) => event.id));
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'DEFAULT_POLICY_MANUAL_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'default-policy-manual-old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'default policy manual old alpha '.repeat(10),
        }),
        runtimeTextEvent({
          id: 'default-policy-manual-old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'default policy manual old beta '.repeat(10),
        }),
        runtimeTextEvent({
          id: 'default-policy-manual-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'default policy manual recent retained context',
        }),
      ],
    });

    assert.deepEqual(writeInputs, [['default-policy-manual-old-1', 'default-policy-manual-old-2']]);
    assert.equal(result.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
  });

  test('manual compactHistory writes a V2 checkpoint without the legacy artifact writer', async () => {
    const recorded: HistoryCompactCheckpoint[] = [];
    let memoryDispatches = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      summarizeHistoryCompact: async () => structuredSummary('MANUAL_V2_HISTORY_COMPACT_SENTINEL'),
      recordHistoryCompactCheckpoint: (checkpoint) => {
        recorded.push(checkpoint);
      },
      memoryExtraction: {
        gate: async () => ({ allowed: true }),
        remember: async () => ({ status: 'unavailable', requestedItems: [] }),
        extract: () => {
          memoryDispatches += 1;
        },
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'manual-v2-old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'manual v2 old alpha '.repeat(100),
        }),
        runtimeTextEvent({
          id: 'manual-v2-old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'manual v2 old beta '.repeat(100),
        }),
        runtimeTextEvent({
          id: 'manual-v2-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'manual v2 recent retained context',
        }),
      ],
    });

    assert.equal(recorded.length, 1);
    assert.equal(
      recorded[0]?.version === 2 ? recorded[0].summary : undefined,
      structuredSummary('MANUAL_V2_HISTORY_COMPACT_SENTINEL'),
    );
    assert.deepEqual(recorded[0]?.coverage.eventCount, 2);
    assert.equal(recorded[0]?.memoryExtractionBoundary, undefined);
    assert.equal(memoryDispatches, 0);
    assert.equal(result.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
  });

  test('manual compactHistory rolls forward from the previous V2 checkpoint', async () => {
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-v2-roll-old-1',
        turnId: 'manual-v2-roll-turn-1',
        role: 'user',
        author: 'user',
        text: 'manual v2 roll old alpha '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-v2-roll-old-2',
        turnId: 'manual-v2-roll-turn-2',
        role: 'model',
        author: 'agent',
        text: 'manual v2 roll old beta '.repeat(12),
      }),
    ];
    const previous = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: oldEvents.slice(0, 1),
      summary: 'MANUAL_V2_PREVIOUS_SUMMARY',
      summaryFormat: 'legacy_freeform',
      charsPerToken: 1,
    });
    const summaryInputs: Array<{ previous?: string; newlyFoldedIds: string[] }> = [];
    const recorded: HistoryCompactCheckpoint[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-roll-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      loadHistoryCompactCheckpoint: () => previous,
      summarizeHistoryCompact: async (input) => {
        summaryInputs.push({
          previous:
            input.previousCheckpoint?.version === 2 ? input.previousCheckpoint.summary : undefined,
          newlyFoldedIds: (input.newlyFoldedRuntimeEvents ?? []).map((event) => event.id),
        });
        return structuredSummary('MANUAL_V2_ROLLED_SUMMARY');
      },
      recordHistoryCompactCheckpoint: (checkpoint) => {
        recorded.push(checkpoint);
      },
    });

    await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'manual-v2-roll-recent',
          turnId: 'manual-v2-roll-recent-turn',
          role: 'user',
          author: 'user',
          text: 'manual v2 roll retained context',
        }),
      ],
    });

    assert.deepEqual(summaryInputs, [
      {
        previous: 'MANUAL_V2_PREVIOUS_SUMMARY',
        newlyFoldedIds: ['manual-v2-roll-old-2'],
      },
    ]);
    assert.equal(recorded[0]?.previousCheckpointId, previous.checkpointId);
    assert.equal(recorded[0]?.coverage.eventCount, 2);
  });

  test('manual compactHistory reuses a checkpoint that already covers the full fold', async () => {
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-v2-reuse-old-1',
        turnId: 'manual-v2-reuse-turn-1',
        role: 'user',
        author: 'user',
        text: 'manual v2 reuse old alpha '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-v2-reuse-old-2',
        turnId: 'manual-v2-reuse-turn-2',
        role: 'model',
        author: 'agent',
        text: 'manual v2 reuse old beta '.repeat(12),
      }),
    ];
    const previous = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: oldEvents,
      summary: 'MANUAL_V2_REUSED_SUMMARY',
      summaryFormat: 'legacy_freeform',
      charsPerToken: 1,
    });
    let summarizeCalls = 0;
    let recordCalls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-reuse-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      loadHistoryCompactCheckpoint: () => previous,
      summarizeHistoryCompact: async () => {
        summarizeCalls += 1;
        return structuredSummary('must not resummarize an already covered fold');
      },
      recordHistoryCompactCheckpoint: () => {
        recordCalls += 1;
        throw new Error('equal coverage must not reach the recorder');
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'manual-v2-reuse-recent',
          turnId: 'manual-v2-reuse-recent-turn',
          role: 'user',
          author: 'user',
          text: 'manual v2 reuse retained context',
        }),
      ],
    });

    assert.equal(summarizeCalls, 0);
    assert.equal(recordCalls, 0);
    assert.equal(result.contextBudget?.historyCompactWriteFailures ?? 0, 0);
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'unchanged');
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.reason, 'already_compacted');
  });

  test('manual compactHistory rewrites a fully covered checkpoint that exceeds current limits', async () => {
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-v2-refit-old-1',
        turnId: 'manual-v2-refit-turn-1',
        role: 'user',
        author: 'user',
        text: 'manual v2 refit old alpha '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-v2-refit-old-2',
        turnId: 'manual-v2-refit-turn-2',
        role: 'model',
        author: 'agent',
        text: 'manual v2 refit old beta '.repeat(12),
      }),
    ];
    const previous = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: oldEvents,
      summary: 'OVERSIZED_PREVIOUS_SUMMARY '.repeat(100),
      summaryFormat: 'legacy_freeform',
      charsPerToken: 1,
    });

    for (const limits of [
      { maxHistoryEstimatedTokens: 10_000, maxBlockEstimatedTokens: 500 },
      { maxHistoryEstimatedTokens: 1_400, maxBlockEstimatedTokens: 10_000 },
    ]) {
      let summarizeCalls = 0;
      const recorded: HistoryCompactCheckpoint[] = [];
      const backend = createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        appendMessage: async () => {},
        connection: connection(),
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => completionModel(),
        tools: [],
        newId: idGenerator(),
        now: monotonicClock(),
        contextBudget: {
          name: 'manual-v2-refit-test',
          maxHistoryEstimatedTokens: limits.maxHistoryEstimatedTokens,
          minRecentTurns: 1,
          charsPerToken: 1,
          historyCompact: {
            enabled: true,
            maxBlockEstimatedTokens: limits.maxBlockEstimatedTokens,
          },
        },
        loadHistoryCompactCheckpoint: () => previous,
        summarizeHistoryCompact: async () => {
          summarizeCalls += 1;
          return structuredSummary('REFITTED_SUMMARY');
        },
        recordHistoryCompactCheckpoint: (checkpoint) => {
          recorded.push(checkpoint);
        },
      });

      const result = await backend.compactHistory({
        turnId: 'turn-compact',
        runId: 'run-1',
        runtimeContext: [
          ...oldEvents,
          runtimeTextEvent({
            id: 'manual-v2-refit-recent',
            turnId: 'manual-v2-refit-recent-turn',
            role: 'user',
            author: 'user',
            text: 'manual v2 refit retained context',
          }),
        ],
      });

      assert.equal(summarizeCalls, 1);
      assert.equal(recorded.length, 1);
      assert.equal(result.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    }
  });

  test('manual compactHistory does not record a rebuilt checkpoint whose envelope exceeds current limits', async () => {
    let recordCalls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-envelope-budget-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: { enabled: true, maxBlockEstimatedTokens: 100, maxEstimatedTokens: 10_000 },
      },
      summarizeHistoryCompact: async () => structuredSummary('TINY_SUMMARY'),
      recordHistoryCompactCheckpoint: () => {
        recordCalls += 1;
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'manual-v2-envelope-old-1',
          turnId: 'manual-v2-envelope-turn-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'manual-v2-envelope-old-2',
          turnId: 'manual-v2-envelope-turn-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'manual-v2-envelope-recent',
          turnId: 'manual-v2-envelope-recent-turn',
          role: 'user',
          author: 'user',
          text: 'recent tail',
        }),
      ],
    });

    assert.equal(recordCalls, 0);
    assert.equal(result.contextBudget?.historyCompactWriteFailures, 1);
  });

  test('manual compactHistory rejects a complete summary that makes the full replay larger', async () => {
    let recordCalls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-larger-replacement-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: { enabled: true },
      },
      summarizeHistoryCompact: async () => structuredSummary('LARGER_SUMMARY '.repeat(100)),
      recordHistoryCompactCheckpoint: () => {
        recordCalls += 1;
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'manual-v2-larger-old-1',
          turnId: 'manual-v2-larger-turn-1',
          role: 'user',
          author: 'user',
          text: 'old alpha',
        }),
        runtimeTextEvent({
          id: 'manual-v2-larger-old-2',
          turnId: 'manual-v2-larger-turn-2',
          role: 'model',
          author: 'agent',
          text: 'old beta',
        }),
        runtimeTextEvent({
          id: 'manual-v2-larger-recent',
          turnId: 'manual-v2-larger-recent-turn',
          role: 'user',
          author: 'user',
          text: 'recent tail',
        }),
      ],
    });

    assert.equal(recordCalls, 0);
    assert.equal(result.contextBudget?.historyCompactWriteFailures, 1);
    assert.equal(
      result.contextBudget?.compactionDecisions?.[0]?.failOpenReason,
      'replacement_not_smaller',
    );
  });

  test('manual compactHistory reports output-length exhaustion instead of empty_summary', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-output-length-test',
        maxHistoryEstimatedTokens: 10_000,
        charsPerToken: 1,
        historyCompact: { enabled: true },
      },
      summarizeHistoryCompact: async () => {
        throw new HistoryCompactSummarizerError('output_length');
      },
      recordHistoryCompactCheckpoint: () => {
        throw new Error('must not persist');
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'output-length-old',
          turnId: 'old',
          role: 'user',
          author: 'user',
          text: 'old '.repeat(100),
        }),
        runtimeTextEvent({
          id: 'output-length-recent',
          turnId: 'recent',
          role: 'user',
          author: 'user',
          text: 'recent',
        }),
      ],
    });

    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.failOpenReason, 'output_length');
    assert.deepEqual(result.contextBudget?.historyCompactWriteSkippedReasonCounts, {
      output_length: 1,
    });
  });

  test('the checkpoint write gate rejects a malformed summary from any producer', async () => {
    // #3029: the summarizer validates its own completions, but the WRITE gate
    // must enforce the invariant even for a producer that skipped that path —
    // a malformed summary never replaces folded history.
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-v2-write-gate-test',
        maxHistoryEstimatedTokens: 10_000,
        charsPerToken: 1,
        historyCompact: { enabled: true },
      },
      // Returns (not throws) a section-less fragment, bypassing the
      // summarizer's own generate-time validation.
      summarizeHistoryCompact: async () => '这次会话主要讨论了以下内容，然后：',
      recordHistoryCompactCheckpoint: () => {
        throw new Error('must not persist');
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'write-gate-old',
          turnId: 'old',
          role: 'user',
          author: 'user',
          text: 'old '.repeat(100),
        }),
        runtimeTextEvent({
          id: 'write-gate-recent',
          turnId: 'recent',
          role: 'user',
          author: 'user',
          text: 'recent',
        }),
      ],
    });

    assert.equal(
      result.contextBudget?.compactionDecisions?.[0]?.failOpenReason,
      'malformed_summary_missing_section',
    );
    assert.deepEqual(result.contextBudget?.historyCompactWriteSkippedReasonCounts, {
      malformed_summary_missing_section: 1,
    });
  });

  test('manual compactHistory writes the current fold instead of reusing a loaded prefix block', async () => {
    const covered = [
      runtimeTextEvent({
        id: 'manual-prefix-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual prefix alpha '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-prefix-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual prefix beta '.repeat(12),
      }),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: covered,
      summary: 'OLD_MANUAL_HISTORY_COMPACT_SENTINEL',
      highWaterName: 'loaded-manual-compact',
      highWaterSeq: 1,
      charsPerToken: 1,
    });
    let loadCalls = 0;
    const writeInputs: string[][] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      loadHistoryCompact: async () => {
        loadCalls += 1;
        return { blocks: [loadedBlock] };
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push(input.source.foldedRuntimeEvents.map((event) => event.id));
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'NEW_MANUAL_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        ...covered,
        runtimeTextEvent({
          id: 'manual-prefix-former-tail',
          turnId: 'turn-former-tail',
          role: 'user',
          author: 'user',
          text: 'manual former retained tail now foldable '.repeat(8),
        }),
        runtimeTextEvent({
          id: 'manual-prefix-recent',
          turnId: 'turn-recent',
          role: 'model',
          author: 'agent',
          text: 'manual recent retained context',
        }),
      ],
    });

    assert.equal(loadCalls, 0);
    assert.deepEqual(writeInputs, [
      ['manual-prefix-old-1', 'manual-prefix-old-2', 'manual-prefix-former-tail'],
    ]);
  });

  test('manual compactHistory is a no-op when context budget is disabled', async () => {
    let writes = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      writeHistoryCompact: async () => {
        writes += 1;
        return { blocks: [] };
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
      ],
    });

    assert.deepEqual(result, {});
    assert.equal(writes, 0);
  });

  test('manual compactHistory is a no-op when no durable writer is configured', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
      ],
    });

    assert.deepEqual(result, {});
  });

  test('manual compactHistory does not report replaced when durable write fails', async () => {
    const oldEvents = [
      runtimeTextEvent({
        id: 'manual-compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'manual alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'manual beta compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'manual-compact-recent',
        turnId: 'turn-recent',
        role: 'user',
        author: 'user',
        text: 'manual recent retained context',
      }),
    ];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async () => {
        throw new Error('artifact write failed');
      },
    });

    const result = await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: oldEvents,
    });

    assert.equal(result.contextBudget?.historyCompactWriteFailures, 1);
    assert.equal(result.contextBudget?.historyCompactBlockIds, undefined);
    assert.equal(result.contextBudget?.historyCompactBlocksSelected, undefined);
    assert.equal(result.contextBudget?.historyCompactedEvents, undefined);
    assert.equal(result.contextBudget?.highWaterReason, undefined);
    assert.deepEqual(
      result.contextBudget?.compactionDecisions?.map((decision) => decision.decision),
      ['failedOpen'],
    );
    assert.equal(result.contextBudget?.compactionDecisions?.[0]?.failOpenReason, 'write_failed');
  });

  test('stopping manual compactHistory does not poison the next backend turn', async () => {
    const writeGate = makeGate();
    let writeStarted: (() => void) | undefined;
    let writeAbortSignal: AbortSignal | undefined;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeAbortSignal = input.abortSignal;
        writeStarted?.();
        await writeGate.promise;
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    const compactPromise = backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'recent',
        }),
      ],
    });
    await writeStartedPromise;
    assert.equal(writeAbortSignal?.aborted, false);
    await backend.stop('user_stop');
    assert.equal(writeAbortSignal?.aborted, true);
    writeGate.release();
    await compactPromise;

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
      events.push(event);
    }

    assert.equal(
      events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'),
      true,
    );
  });

  test('stopped manual compactHistory stays suppressed when the next send starts before the writer returns', async () => {
    const writeGate = makeGate();
    let writeStarted: (() => void) | undefined;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => {
        writeStarted?.();
        await writeGate.promise;
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    const compactPromise = backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'recent',
        }),
      ],
    });
    await writeStartedPromise;
    await backend.stop('user_stop');

    const sendEventsPromise = (async () => {
      const events: SessionEvent[] = [];
      for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
        events.push(event);
      }
      return events;
    })();
    writeGate.release();

    const [compactResult, events] = await Promise.all([compactPromise, sendEventsPromise]);
    assert.equal(compactResult.contextBudget, undefined);
    assert.equal(
      events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'),
      true,
    );
  });

  test('stopping after manual compactHistory returns does not poison the next backend turn', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => textCompletionModel('NEXT_OK'),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'manual-compact-test',
        maxHistoryEstimatedTokens: 10_000,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
      writeHistoryCompact: async (input) => ({
        blocks: [
          buildHistoryCompactBlockFromSummary({
            sessionId: input.sessionId,
            foldedRuntimeEvents: input.source.foldedRuntimeEvents,
            summary: 'MANUAL_HISTORY_COMPACT_SENTINEL',
            highWaterName: input.source.draftBlock.highWaterName,
            highWaterSeq: input.source.draftBlock.highWaterSeq,
            charsPerToken: input.limits.charsPerToken,
          }),
        ],
      }),
    });

    await backend.compactHistory({
      turnId: 'turn-compact',
      runId: 'run-1',
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-1',
          turnId: 'turn-old-1',
          role: 'user',
          author: 'user',
          text: 'old alpha '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'old-2',
          turnId: 'turn-old-2',
          role: 'model',
          author: 'agent',
          text: 'old beta '.repeat(20),
        }),
        runtimeTextEvent({
          id: 'recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'recent',
        }),
      ],
    });
    await backend.stop('user_stop');

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-next', text: 'next', context: [] })) {
      events.push(event);
    }

    assert.equal(
      events.some((event) => event.type === 'text_delta' && event.text === 'NEXT_OK'),
      true,
    );
  });

  test('aborting the model stream mid-flight routes to the abort path instead of false success', async () => {
    const gate = makeGate();
    let streamReachedGate = false;
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'PARTIAL' });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
            streamReachedGate = true;
            // Hold the stream open so stop() can flip this.aborted before the
            // finish chunk arrives. The mock ignores the abort signal on
            // purpose, simulating a provider that keeps yielding after abort.
            await gate.promise;
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      },
    });
    const appended: string[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message: StoredMessage) => {
        appended.push(message.type);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];
    const sendPromise = (async () => {
      for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
        events.push(event);
      }
    })();
    await waitFor(() => streamReachedGate);
    await backend.stop('user_stop');
    gate.release();
    await sendPromise;

    // No partial assistant turn or usage should be persisted after a stop.
    assert.equal(appended.includes('assistant'), false);
    assert.equal(appended.includes('token_usage'), false);
    // The turn must close as a user_stop, not a false end_turn success.
    assert.equal(
      events.some((event) => event.type === 'abort' && event.reason === 'user_stop'),
      true,
    );
    const completes = events.filter((event) => event.type === 'complete');
    assert.equal(completes.length > 0, true);
    assert.equal(
      completes.every((event) => (event as { stopReason?: string }).stopReason === 'user_stop'),
      true,
    );
  });

  test('after-step stop preserves the current provider step usage and prevents another step', async () => {
    const loop = countingToolLoopModel();
    const durable = durableTurnHarness('turn-1', 'hi');
    let backend!: AiSdkBackend;
    let stopRequested = false;
    const stoppingTool: MakaTool = {
      name: 'Read',
      description: 'Read description',
      parameters: z.object({ path: z.string() }),
      impl: async () => {
        stopRequested = true;
        await (
          backend.stop as unknown as (reason: 'user_stop', mode: 'after_step') => Promise<void>
        )('user_stop', 'after_step');
        return { ok: true };
      },
    };
    backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [stoppingTool],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];

    for await (const event of backend.send(durable.input())) {
      durable.record(event);
      events.push(event);
    }

    assert.equal(stopRequested, true);
    assert.equal(loop.callCount(), 1);
    assert.equal(
      events.some((event) => event.type === 'abort'),
      false,
    );
    const usage = events.find((event) => event.type === 'token_usage');
    assert.equal(usage?.type === 'token_usage' ? usage.total : undefined, 2);
  });

  test('aborting during post-stream persistence wins over step-limit completion', async () => {
    const loop = countingToolLoopModel();
    const gate = makeGate();
    let usagePersistenceStarted = false;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type !== 'token_usage') return;
        usagePersistenceStarted = true;
        await gate.promise;
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      maxSteps: 1,
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];
    const sendPromise = (async () => {
      for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
        events.push(event);
      }
    })();

    await waitFor(() => usagePersistenceStarted);
    await backend.stop('user_stop');
    gate.release();
    await sendPromise;

    assert.equal(
      events.some((event) => event.type === 'abort' && event.reason === 'user_stop'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'complete' && event.stopReason === 'step_limit'),
      false,
    );
  });

  test('provider error mid-step persists partial text and its safe provider summary', async () => {
    // The user already saw the streamed text, so it belongs in the ledger even
    // when the provider fails. The gate makes consumption-before-error deterministic.
    const gate = makeGate();
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial answer' });
            await gate.promise;
            controller.error({
              error: { code: 'provider_error', message: 'provider exploded mid-step' },
              request_id: 'req-mid-step',
            });
          },
        }),
      },
    });
    const assistants: AssistantMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'assistant') assistants.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'text_delta' && event.text === 'partial answer') gate.release();
    }

    // The streamed partial persists as this step's AssistantMessage.
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]!.text, 'partial answer');
    // And the turn still closes as an error, not a false success.
    const failure = events.find((event) => event.type === 'error');
    assert.equal(
      failure?.message,
      'provider exploded mid-step (code=provider_error, requestId=req-mid-step)',
    );
    const completes = events.filter((event) => event.type === 'complete');
    assert.equal(completes.length > 0, true);
    assert.equal(
      completes.every((event) => (event as { stopReason?: string }).stopReason === 'error'),
      true,
    );
  });

  test('writes host history compact block and replays the host summary in the same request', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const storedMessages: StoredMessage[] = [];
    const writeInputs: Array<{ draftSummary: string; foldedIds: string[] }> = [];
    const oldEvents = [
      runtimeTextEvent({
        id: 'compact-old-1',
        turnId: 'turn-old-1',
        role: 'user',
        author: 'user',
        text: 'alpha compact source '.repeat(12),
      }),
      runtimeTextEvent({
        id: 'compact-old-2',
        turnId: 'turn-old-2',
        role: 'model',
        author: 'agent',
        text: 'beta compact source '.repeat(12),
      }),
    ];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        storedMessages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        name: 'history-compact-write-test',
        maxHistoryEstimatedTokens: 1500,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.01,
          tailEstimatedTokens: 44,
          minRecentTurns: 1,
          maxSummaryEstimatedTokens: 120,
        },
      },
      writeHistoryCompact: async (input) => {
        writeInputs.push({
          draftSummary: input.source.draftBlock.summary,
          foldedIds: input.source.foldedRuntimeEvents.map((event) => event.id),
        });
        return {
          blocks: [
            buildHistoryCompactBlockFromSummary({
              sessionId: input.sessionId,
              foldedRuntimeEvents: input.source.foldedRuntimeEvents,
              summary: 'HOST_HISTORY_COMPACT_SENTINEL',
              highWaterName: input.source.draftBlock.highWaterName,
              highWaterSeq: input.source.draftBlock.highWaterSeq,
              charsPerToken: input.limits.charsPerToken,
            }),
          ],
        };
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'continue after compact',
      context: [],
      runtimeContext: [
        ...oldEvents,
        runtimeTextEvent({
          id: 'compact-recent',
          turnId: 'turn-recent',
          role: 'user',
          author: 'user',
          text: 'recent retained context',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(
      writeInputs.map((input) => input.foldedIds),
      [['compact-old-1', 'compact-old-2']],
    );
    assert.match(writeInputs[0]?.draftSummary ?? '', /Compacted 2 older turns/);
    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /HOST_HISTORY_COMPACT_SENTINEL/);
    assert.equal(prompt.includes('alpha compact source'), false);
    assert.match(prompt, /recent retained context/);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usage?.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(usage?.contextBudget?.historyCompactBlocksWritten, 1);
    assert.equal(usage?.contextBudget?.highWaterReason, 'history_compact');
    assert.deepEqual(
      usage?.contextBudget?.compactionDecisions?.[0]?.boundaryIds,
      usage?.contextBudget?.historyCompactWrittenBlockIds,
    );
    assert.equal(usage?.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    assert.equal(usage?.contextBudget?.compactionDecisions?.[0]?.boundaryKind, 'historyCompact');
    assert.equal(
      storedMessages.some(
        (message) => message.type === 'system_note' && message.kind === 'context_compacted',
      ),
      true,
    );
  });

  test('V2 blank summary fails open to the retained tail and emits one visible notice', async () => {
    const model = completionModel();
    const storedMessages: StoredMessage[] = [];
    let recordCalls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        storedMessages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      contextBudget: {
        maxHistoryEstimatedTokens: 1_500,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'read_write',
          highWaterRatio: 0.01,
          tailEstimatedTokens: 20,
          maxSummaryEstimatedTokens: 500,
        },
      },
      summarizeHistoryCompact: async () => '   ',
      recordHistoryCompactCheckpoint: () => {
        recordCalls += 1;
      },
    });
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'blank-old-1',
            turnId: 'blank-turn-1',
            role: 'user',
            author: 'user',
            text: 'blank old source one '.repeat(30),
          }),
          runtimeTextEvent({
            id: 'blank-old-2',
            turnId: 'blank-turn-2',
            role: 'model',
            author: 'agent',
            text: 'blank old source two '.repeat(50),
          }),
          runtimeTextEvent({
            id: 'blank-recent',
            turnId: 'blank-recent-turn',
            role: 'user',
            author: 'user',
            text: 'BLANK_RETAINED_TAIL',
          }),
        ],
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.equal(prompt.includes('blank old source one'), false);
    assert.equal(prompt.includes('blank old source two'), false);
    assert.match(prompt, /BLANK_RETAINED_TAIL/);
    assert.equal(recordCalls, 0);
    assert.equal(
      storedMessages.filter(
        (message) =>
          message.type === 'system_note' && message.kind === 'context_compaction_failed_open',
      ).length,
      1,
    );
  });

  test('replays a matching Codex V3 checkpoint as native provider state', async () => {
    const model = completionModel();
    const codexConnection = {
      ...connection(),
      slug: 'codex-subscription',
      providerType: 'openai-codex' as const,
    };
    const covered = [
      runtimeTextEvent({
        id: 'codex-covered-1',
        turnId: 'codex-old-1',
        role: 'user',
        author: 'user',
        text: 'CODEX_RAW_OLD_ONE '.repeat(100),
      }),
      runtimeTextEvent({
        id: 'codex-covered-2',
        turnId: 'codex-old-2',
        role: 'model',
        author: 'agent',
        text: 'CODEX_RAW_OLD_TWO '.repeat(100),
      }),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: covered,
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: codexConnection.slug,
        modelId: 'mock-model-id',
        itemId: 'cmp_replay',
        encryptedContent: 'CODEX_ENCRYPTED_REPLAY_STATE',
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: codexConnection,
      apiKey: 'codex-token',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 100_000,
        historyCompact: { enabled: true, mode: 'lookup' },
      },
      loadHistoryCompactCheckpoint: () => checkpoint,
    });

    await drain(
      backend.send({
        turnId: 'codex-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          ...covered,
          runtimeTextEvent({
            id: 'codex-tail',
            turnId: 'codex-tail-turn',
            role: 'user',
            author: 'user',
            text: 'CODEX_RAW_TAIL',
          }),
        ],
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /CODEX_ENCRYPTED_REPLAY_STATE/);
    assert.match(prompt, /cmp_replay/);
    assert.match(prompt, /CODEX_RAW_TAIL/);
    assert.doesNotMatch(prompt, /Provider-native OpenAI Codex compaction checkpoint/);
    assert.doesNotMatch(prompt, /CODEX_RAW_OLD_(ONE|TWO)/);
  });

  test('replays a matching Codex V3 checkpoint when it covers the entire prior history', async () => {
    const model = completionModel();
    const codexConnection = {
      ...connection(),
      slug: 'codex-subscription',
      providerType: 'openai-codex' as const,
    };
    const covered = [
      runtimeTextEvent({
        id: 'codex-full-covered',
        turnId: 'codex-full-old',
        role: 'user',
        author: 'user',
        text: 'CODEX_FULL_RAW_OLD '.repeat(100),
      }),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: covered,
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: codexConnection.slug,
        modelId: 'mock-model-id',
        itemId: 'cmp_full_replay',
        encryptedContent: 'CODEX_FULL_ENCRYPTED_STATE',
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: codexConnection,
      apiKey: 'codex-token',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 100_000,
        minRecentTurns: 0,
        historyCompact: { enabled: true, mode: 'lookup', minRecentTurns: 0 },
      },
      loadHistoryCompactCheckpoint: () => checkpoint,
    });

    await drain(
      backend.send({
        turnId: 'codex-full-current',
        text: 'continue after full coverage',
        context: [],
        runtimeContext: covered,
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /CODEX_FULL_ENCRYPTED_STATE/);
    assert.match(prompt, /cmp_full_replay/);
    assert.match(prompt, /continue after full coverage/);
    assert.doesNotMatch(prompt, /CODEX_FULL_RAW_OLD/);
  });

  test('keeps a Codex V3 checkpoint when a signed-thinking tail requires text-only replay', async () => {
    const model = completionModel();
    const codexConnection = {
      ...connection(),
      slug: 'codex-subscription',
      providerType: 'openai-codex' as const,
    };
    const covered = [
      runtimeTextEvent({
        id: 'codex-switch-covered-user',
        turnId: 'codex-switch-old-user',
        role: 'user',
        author: 'user',
        text: 'CODEX_SWITCH_RAW_COVERED_USER '.repeat(100),
      }),
      runtimeTextEvent({
        id: 'codex-switch-covered-model',
        turnId: 'codex-switch-old-model',
        role: 'model',
        author: 'agent',
        text: 'CODEX_SWITCH_RAW_COVERED_MODEL '.repeat(100),
      }),
    ];
    const tail = [
      runtimeTextEvent({
        id: 'anthropic-tail-user',
        turnId: 'anthropic-tail',
        role: 'user',
        author: 'user',
        text: 'ANTHROPIC_VISIBLE_TAIL_USER',
      }),
      runtimeEvent({
        id: 'anthropic-tail-thinking',
        turnId: 'anthropic-tail',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: 'ANTHROPIC_PRIVATE_SIGNED_THINKING',
          signature: 'anthropic-signature',
        },
      }),
      runtimeTextEvent({
        id: 'anthropic-tail-model',
        turnId: 'anthropic-tail',
        role: 'model',
        author: 'agent',
        text: 'ANTHROPIC_VISIBLE_TAIL_MODEL',
      }),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: covered,
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: codexConnection.slug,
        modelId: 'mock-model-id',
        itemId: 'cmp_model_switch',
        encryptedContent: 'CODEX_MODEL_SWITCH_ENCRYPTED_STATE',
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: codexConnection,
      apiKey: 'codex-token',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 100_000,
        historyCompact: { enabled: true, mode: 'lookup' },
      },
      loadHistoryCompactCheckpoint: () => checkpoint,
    });

    await drain(
      backend.send({
        turnId: 'codex-switch-current',
        text: 'continue after switching back to Codex',
        context: [
          {
            type: 'user',
            id: 'codex-switch-covered-user',
            turnId: 'codex-switch-old-user',
            ts: 1,
            text: 'CODEX_SWITCH_RAW_COVERED_USER '.repeat(100),
          },
          {
            type: 'assistant',
            id: 'codex-switch-covered-model',
            turnId: 'codex-switch-old-model',
            ts: 2,
            text: 'CODEX_SWITCH_RAW_COVERED_MODEL '.repeat(100),
            modelId: 'mock-model-id',
          },
          {
            type: 'user',
            id: 'anthropic-tail-user',
            turnId: 'anthropic-tail',
            ts: 3,
            text: 'ANTHROPIC_VISIBLE_TAIL_USER',
          },
          {
            type: 'assistant',
            id: 'anthropic-tail-model',
            turnId: 'anthropic-tail',
            ts: 4,
            text: 'ANTHROPIC_VISIBLE_TAIL_MODEL',
            modelId: 'claude-sonnet',
            thinking: {
              text: 'ANTHROPIC_PRIVATE_SIGNED_THINKING',
              signature: 'anthropic-signature',
            },
          },
        ],
        runtimeContext: [...covered, ...tail],
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /CODEX_MODEL_SWITCH_ENCRYPTED_STATE|cmp_model_switch/);
    assert.match(prompt, /ANTHROPIC_VISIBLE_TAIL_(USER|MODEL)/);
    assert.doesNotMatch(prompt, /CODEX_SWITCH_RAW_COVERED_(USER|MODEL)/);
    assert.doesNotMatch(prompt, /ANTHROPIC_PRIVATE_SIGNED_THINKING/);
  });

  test('ignores a Codex V3 checkpoint bound to a different model and replays raw history', async () => {
    const model = completionModel();
    const codexConnection = {
      ...connection(),
      slug: 'codex-subscription',
      providerType: 'openai-codex' as const,
    };
    const covered = [
      runtimeTextEvent({
        id: 'codex-mismatch-covered',
        turnId: 'codex-mismatch-old',
        role: 'user',
        author: 'user',
        text: 'CODEX_MISMATCH_RAW_HISTORY',
      }),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: covered,
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: codexConnection.slug,
        modelId: 'different-model',
        itemId: 'cmp_wrong_model',
        encryptedContent: 'CODEX_WRONG_MODEL_STATE',
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: codexConnection,
      apiKey: 'codex-token',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      contextBudget: {
        maxHistoryEstimatedTokens: 100_000,
        historyCompact: { enabled: true, mode: 'lookup' },
      },
      loadHistoryCompactCheckpoint: () => checkpoint,
    });

    await drain(
      backend.send({
        turnId: 'codex-current',
        text: 'continue',
        context: [],
        runtimeContext: covered,
      }),
    );

    const prompt = JSON.stringify(compactPrompt(model));
    assert.match(prompt, /CODEX_MISMATCH_RAW_HISTORY/);
    assert.doesNotMatch(prompt, /CODEX_WRONG_MODEL_STATE|cmp_wrong_model/);
  });

  test('keeps RuntimeEvent replay when a tool result is unmatched (orphan dropped, rest replayed)', async () => {
    // `unmatched_tool_result` is a non-blocking diagnostic: the materializer
    // drops the orphan itself (a standalone tool message is an Anthropic 400),
    // so the ledger stays on RuntimeEvent replay instead of falling back to
    // StoredMessage projection.
    const model = completionModel();
    let imageReads = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      supportsVision: true,
      readAttachmentBytes: async () => {
        imageReads += 1;
        return { ok: true, bytes: new Uint8Array([1]) };
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'runtime user',
          }),
          runtimeEvent({
            id: 'rt-unmatched-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'missing-call',
              name: 'Read',
              isError: false,
              result: {
                kind: 'image',
                mimeType: 'image/png',
                ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'orphan' },
              },
            },
          }),
        ],
      }),
    );

    // RuntimeEvent replay (not the StoredMessage projection), orphan gone.
    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'runtime user' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
    assert.equal(imageReads, 0);
  });

  test('keeps RuntimeEvent replay when a system error fact is diagnostic-only', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'runtime user',
          }),
          runtimeEvent({
            id: 'rt-error',
            turnId: 'turn-prev',
            role: 'system',
            author: 'system',
            content: {
              kind: 'error',
              reason: 'tool_failed',
              message: 'Tool failed',
            },
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'runtime user' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('uses StoredMessage projection instead of leaking unsupported thinking text', async () => {
    const model = completionModel();
    const openAiConnection = { ...connection(), providerType: 'openai' as const };
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: openAiConnection,
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'projection user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'projection assistant',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'projection user',
          }),
          runtimeEvent({
            id: 'rt-thinking',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text: 'private chain of thought', signature: 'sig-1' },
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'projection assistant',
          }),
        ],
      }),
    );

    const promptJson = JSON.stringify(compactPrompt(model));
    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'projection user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'projection assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
    assert.equal(promptJson.includes('private chain of thought'), false);
  });

  test('skips unsupported unsigned thinking without dropping native tool replay', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'read the file',
          }),
          runtimeEvent({
            id: 'rt-thinking',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text: 'private unsigned thought' },
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: 'file contents',
              isError: false,
            },
          }),
        ],
      }),
    );

    const promptJson = JSON.stringify(compactPrompt(model));
    assert.match(promptJson, /"toolCallId":"tool-1"/);
    assert.match(promptJson, /file contents/);
    assert.equal(promptJson.includes('private unsigned thought'), false);
  });

  test('skips unmarked unsigned thinking when replaying Kimi OpenAI tool history', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        ...connection(),
        slug: 'kimi-main',
        providerType: 'kimi-coding-plan',
        defaultModel: 'k3',
        models: [{ id: 'k3', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'sk-test',
      modelId: 'k3',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'read the file',
          }),
          runtimeEvent({
            id: 'rt-thinking',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text: 'private thinking from another provider' },
          }),
          runtimeEvent({
            id: 'rt-call',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
          }),
          runtimeEvent({
            id: 'rt-result',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: 'file contents',
              isError: false,
            },
          }),
        ],
      }),
    );

    const promptJson = JSON.stringify(compactPrompt(model));
    assert.equal(promptJson.includes('private thinking from another provider'), false);
    assert.match(promptJson, /"toolCallId":"tool-1"/);
    assert.match(promptJson, /file contents/);
  });

  test('rejects signed thinking from provider-native replay when the target cannot replay it', async () => {
    const trace: RunTraceEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('provider failed');
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: { ...connection(), providerType: 'openai' },
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => trace.push(event),
    });

    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'current user',
        context: [
          { type: 'user', id: 'projection-u', turnId: 'turn-prev', ts: 1, text: 'prior user' },
          {
            type: 'assistant',
            id: 'projection-a',
            turnId: 'turn-prev',
            ts: 2,
            text: 'prior answer',
            modelId: 'm',
          },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'prior user',
          }),
          runtimeEvent({
            id: 'rt-thinking',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text: 'signed thought', signature: 'sig-1' },
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'prior answer',
          }),
        ],
      }),
    );

    const failure = trace.find((event) => event.type === 'model_stream_failed');
    assert.equal(failure?.data?.priorReplayGate, 'runtime_replay_unsupported_semantics');
  });
});

describe('AiSdkBackend error surfaces', () => {
  test('generalizes model setup errors before emitting renderer events', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-live-secret-token-value',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => {
        throw new Error('401 Authorization: Bearer sk-live-secret-token-value');
      },
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const error = events.find(
      (event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error',
    );
    assert.equal(error?.message, 'Authentication failed');
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
  });

  test('stops after a T1 rejection only after sibling tool calls settle', async () => {
    const durable = durableTurnHarness('turn-1', 'read notes');
    const messages: StoredMessage[] = [];
    const events: SessionEvent[] = [];
    const executions: string[] = [];
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-2',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'sibling.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 0, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'recovered' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          ...testTool('Read', z.object({ path: z.string() })),
          impl: async ({ path }: { path: string }) => {
            executions.push(path);
            return { body: path };
          },
        },
      ],
      runtimeCommitSink: {
        commitToolPrepared: async ({ providerToolCallId }) => {
          if (providerToolCallId === 'tool-1') throw new Error('T1 unavailable');
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
      },
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(
      durable.input({
        runId: 'run-1',
        invocationId: 'invocation-1',
      }),
    )) {
      durable.record(event);
      events.push(event);
    }

    assert.equal(streamCalls, 1);
    assert.deepEqual(executions, ['sibling.md']);
    assert.equal(messages.filter((message) => message.type === 'tool_result').length, 1);
    assert.equal(events.filter((event) => event.type === 'tool_result').length, 1);
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
    assert.equal(events.find((event) => event.type === 'error')?.message, 'Operation failed');
  });

  test('redacts and caps synthetic tool error text before storage and model return', () => {
    const raw = `provider exploded: Authorization: Bearer sk-live-secret-token-value ${'x'.repeat(5000)}`;
    const text = formatSyntheticToolErrorText(new Error(raw));

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.ok(text.includes('[redacted]'));
    assert.equal(text.length, TOOL_ERROR_RESULT_MAX_CHARS);
    assert.equal(text.endsWith('…'), true);
  });

  test('writeSyntheticToolResult never persists raw secret-shaped errors', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    await turnScope(backend, 'turn-1').toolRuntime.writeSyntheticToolResult(
      'tool-1',
      'turn-1',
      'failed with api_key=sk-live-secret-token-value',
      {
        push: (event) => {
          events.push(event);
        },
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    );

    assert.equal(JSON.stringify(messages).includes('sk-live-secret-token-value'), false);
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
    assert.deepEqual(
      messages[0]?.content,
      events.find((event) => event.type === 'tool_result')?.content,
    );
  });

  test('failed Bash results preserve terminal stdout and stderr as an error card', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'shell',
      parameters: {},
      impl: async () => {
        throw Object.assign(new Error('Command failed with exit code 2'), {
          code: 2,
          stdout: 'stdout before failure\nAuthorization: Bearer sk-live-secret-token-value',
          stderr: 'stderr before failure',
        });
      },
    };

    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    const result = await execute(
      { command: 'printf out; printf err >&2; exit 2' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    // In-turn result now folds in a redacted, bounded tail of stderr/stdout so
    // the model can see *why* the command failed (the full structured content
    // still goes to session history, asserted below).
    assert.deepEqual(result, {
      error: [
        '命令退出码 2',
        '--- stderr ---\nstderr before failure',
        '--- stdout ---\nstdout before failure\nAuthorization: Bearer [redacted]',
      ].join('\n\n'),
    });
    assert.equal(messages[0]?.isError, true);
    assert.deepEqual(
      messages[0]?.content,
      events.find((event) => event.type === 'tool_result')?.content,
    );
    assert.deepEqual(messages[0]?.content, {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'printf out; printf err >&2; exit 2',
      status: 'failed',
      exitCode: 2,
      output: {
        mode: 'pipes',
        stdout: 'stdout before failure\nAuthorization: Bearer [redacted]',
        stderr: 'stderr before failure',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: true,
      },
    });
  });
});

describe('AiSdkBackend usage telemetry', () => {
  test('records provider-reported usage for a content-filter terminal', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'content-filter', raw: 'content_filter' },
              usage: {
                inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const appended: StoredMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(events.find((event) => event.type === 'token_usage')?.total, 10);
    assert.equal(appended.find((message) => message.type === 'token_usage')?.total, 10);
  });

  test('lets an unconfigured turn continue past the former 50-step default', async () => {
    const loop = countingToolLoopModel(51);
    const durable = durableTurnHarness('turn-1', 'hi');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(loop.callCount(), 52);
    assert.equal(events.at(-1)?.type, 'complete');
  });

  test('retries an output-free truncated provider stream once and recovers', async () => {
    const durable = durableTurnHarness('turn-truncated-retry', 'analyse the image');
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'other', raw: undefined },
                  usage: emptyUsage(),
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Recovered' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: emptyUsage(),
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
      providerRetrySleep: async () => {},
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(calls, 2);
    assert.deepEqual(
      events
        .filter((event) => event.type === 'provider_retry')
        .map(({ phase, attempt, maxAttempts, reason }) => ({
          phase,
          attempt,
          maxAttempts,
          reason,
        })),
      [
        { phase: 'scheduled', attempt: 2, maxAttempts: 2, reason: 'provider_unavailable' },
        { phase: 'started', attempt: 2, maxAttempts: 2, reason: 'provider_unavailable' },
      ],
    );
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
  });

  test('classifies an exhausted output-free truncated stream as provider unavailable', async () => {
    const durable = durableTurnHarness('turn-truncated-exhausted', 'analyse the image');
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: { unified: 'other', raw: undefined },
                usage: emptyUsage(),
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
      providerRetrySleep: async () => {},
    });

    const events = await drainDurably(backend.send(durable.input()), durable);
    const error = events.find(
      (event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error',
    );

    assert.equal(calls, 2);
    assert.equal(error?.reason, 'provider_unavailable');
    assert.equal(error?.message, 'Provider stream ended without finishing (other)');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('does not retry a truncated provider stream after partial output', async () => {
    // The upstream cut the SSE connection mid-answer: chunks arrived, no
    // `finish` frame did. The stream then ends without yielding an error and
    // without throwing, so every guard that watches for a thrown failure sees
    // nothing. Reporting `end_turn` here tells the caller the model said its
    // piece when the connection simply died — a benchmark cell recorded
    // `status: completed` on exactly this shape while the agent was still
    // mid-task.
    const durable = durableTurnHarness('turn-truncated', 'analyse the image');
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'Let me look at the top region' },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
      providerRetrySleep: async () => {},
    });

    const events = await drainDurably(backend.send(durable.input()), durable);
    const complete = events.find(
      (event): event is Extract<SessionEvent, { type: 'complete' }> => event.type === 'complete',
    );

    // Not merely "some other stop reason": `max_tokens` would also satisfy that
    // and still record the turn as completed downstream, which is the bug.
    assert.equal(
      complete?.stopReason,
      'error',
      'a stream that never delivered a finish frame did not end the turn',
    );
    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    // And it must say so. A failed terminal whose only trace is the stop reason
    // leaves the session's lastError empty and the request ledger reading
    // `success` — the same silence that let the benchmark cell pass unnoticed.
    assert.ok(
      events.some((event) => event.type === 'error'),
      'a failed terminal must be accompanied by an error event',
    );
    const error = events.find(
      (event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error',
    );
    assert.equal(error?.reason, 'provider_unavailable');
  });

  test('rejects continuation-capable tools before side effects without a durable reader', async () => {
    const loop = countingToolLoopModel(1);
    let executions = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [
        {
          ...testTool('Read', z.object({ path: z.string() })),
          impl: async () => {
            executions += 1;
            return { ok: true };
          },
        },
      ],
      maxSteps: 2,
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(loop.callCount(), 1);
    assert.equal(executions, 0);
    assert.ok(events.some((event) => event.type === 'error'));
  });

  test('checks that the durable ledger is readable before tool side effects', async () => {
    const loop = countingToolLoopModel(1);
    const durable = durableTurnHarness('turn-1', 'hi');
    let reads = 0;
    let executions = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [
        {
          ...testTool('Read', z.object({ path: z.string() })),
          impl: async () => {
            executions += 1;
            return { ok: true };
          },
        },
      ],
      maxSteps: 2,
      loadTurnRuntimeEvents: async (turnId) => {
        reads += 1;
        if (reads === 2) throw new Error('runtime ledger unavailable');
        return await durable.loadTurnRuntimeEvents(turnId);
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(loop.callCount(), 1);
    assert.equal(executions, 0);
    assert.ok(events.some((event) => event.type === 'error'));
  });

  test('lets a trusted turn override the configured step limit', async () => {
    const loop = countingToolLoopModel();
    const durable = durableTurnHarness('turn-1', 'hi');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => loop.model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      maxSteps: 3,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drainDurably(backend.send({ ...durable.input(), maxSteps: 1 }), durable);

    assert.equal(loop.callCount(), 1);
  });

  test('reserves the final child-agent step for a tool-free evidence summary', async () => {
    const durable = durableTurnHarness('turn-1', 'audit the repository');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-final' },
                {
                  type: 'text-delta',
                  id: 'text-final',
                  delta: 'Verified evidence summary with explicit gaps.',
                },
                { type: 'text-end', id: 'text-final' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: { ...header(), collaborationMode: 'agent' },
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      maxSteps: 2,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(streamCalls, 2);
    assert.equal(model.doStreamCalls[1]?.tools?.length ?? 0, 0);
    assert.deepEqual(model.doStreamCalls[1]?.toolChoice, { type: 'none' });
    assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /final budgeted step/i);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'text_delta' &&
          event.text === 'Verified evidence summary with explicit gaps.',
      ),
    );
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(
      (events.at(-1) as Extract<SessionEvent, { type: 'complete' }>).stopReason,
      'end_turn',
    );
  });

  test('ends the tool loop cooperatively when the graph supervisor yields', async () => {
    const durable = durableTurnHarness('turn-graph-yield', 'coordinate the graph');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'yield-1',
                toolName: 'yield_agent_graph',
                input: JSON.stringify({ reason: 'Waiting for committed child results.' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          ...testTool('yield_agent_graph', z.object({ reason: z.string() })),
          impl: async ({ reason }) => ({
            kind: 'agent_graph_yielded' as const,
            pendingWorkCount: 2,
            liveOperatorCount: 2,
            reason,
          }),
        },
      ],
      maxSteps: 5,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(streamCalls, 1, 'yield must not request another provider step');
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(
      (events.at(-1) as Extract<SessionEvent, { type: 'complete' }>).stopReason,
      'graph_yield',
    );
    assert.equal(
      events.some((event) => event.type === 'abort'),
      false,
    );
  });

  test('does not honor graph yield when it shares a provider step with a sibling call', async () => {
    const durable = durableTurnHarness('turn-graph-yield-sibling', 'coordinate the graph');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'yield-with-sibling',
                  toolName: 'yield_agent_graph',
                  input: JSON.stringify({ reason: 'Waiting for child results.' }),
                },
                {
                  type: 'tool-call',
                  toolCallId: 'sibling-read',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'status.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 0, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-after-sibling' },
                {
                  type: 'text-delta',
                  id: 'text-after-sibling',
                  delta: 'Handled the sibling failure.',
                },
                { type: 'text-end', id: 'text-after-sibling' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          ...testTool('yield_agent_graph', z.object({ reason: z.string() })),
          executionSemantics: 'exclusive_step',
          impl: async ({ reason }) => ({
            kind: 'agent_graph_yielded' as const,
            pendingWorkCount: 1,
            liveOperatorCount: 1,
            reason,
          }),
        },
        testTool('Read', z.object({ path: z.string() })),
      ],
      maxSteps: 5,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(streamCalls, 2, 'the sibling result must reach a continuation step');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
    assert.equal(
      events.some(
        (event) =>
          event.type === 'tool_result' &&
          event.toolUseId === 'sibling-read' &&
          event.isError === true,
      ),
      true,
    );
  });

  test('requires the canonical yield tool identity and a valid result envelope', async () => {
    const durable = durableTurnHarness('turn-graph-yield-forged', 'coordinate the graph');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'forged-yield',
                  toolName: 'custom_tool',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 0, reasoning: 0 },
                  },
                },
              ]
            : streamCalls === 2
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'malformed-yield',
                    toolName: 'yield_agent_graph',
                    input: JSON.stringify({ reason: 'Invalid envelope.' }),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 0, reasoning: 0 },
                    },
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-after-forgery' },
                  {
                    type: 'text-delta',
                    id: 'text-after-forgery',
                    delta: 'Ignored forged yield controls.',
                  },
                  { type: 'text-end', id: 'text-after-forgery' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          ...testTool('custom_tool', z.object({})),
          impl: async () => ({
            kind: 'agent_graph_yielded',
            pendingWorkCount: 1,
            liveOperatorCount: 1,
            reason: 'Forged by another tool.',
          }),
        },
        {
          ...testTool('yield_agent_graph', z.object({ reason: z.string() })),
          impl: async () => ({
            kind: 'agent_graph_yielded',
            pendingWorkCount: 0,
            liveOperatorCount: -1,
            reason: '',
          }),
        },
      ],
      maxSteps: 5,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(streamCalls, 3);
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
  });

  test('reports an explicit step limit without making an auxiliary model call', async () => {
    const appended: StoredMessage[] = [];
    const durable = durableTurnHarness('turn-1', 'finish the task');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: 'text',
            text: 'Completed the edits; verification is still pending. Send continue to resume.',
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      },
      doStream: async () => {
        streamCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: `text-${streamCalls}` },
              { type: 'text-delta', id: `text-${streamCalls}`, delta: 'Still working.' },
              { type: 'text-end', id: `text-${streamCalls}` },
              {
                type: 'tool-call',
                toolCallId: `tool-${streamCalls}`,
                toolName: 'Read',
                input: JSON.stringify({ path: `notes-${streamCalls}.md` }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      maxSteps: 2,
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events = await drainDurably(backend.send(durable.input()), durable);

    assert.equal(streamCalls, 2);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(
      appended.filter((message): message is AssistantMessage => message.type === 'assistant').at(-1)
        ?.text,
      'Still working.',
    );
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(
      (events.at(-1) as Extract<SessionEvent, { type: 'complete' }>).stopReason as string,
      'step_limit',
    );
  });

  test('records cumulative usage checkpoints across tool-loop steps and turns', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const usageCheckpoints: Array<{ inputTokens: number; outputTokens: number }> = [];
    const firstTurn = durableTurnHarness('turn-1', 'hi');
    const secondTurn = durableTurnHarness('turn-2', 'continue');
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: {
                      total: 100,
                      noCache: 70,
                      cacheRead: 20,
                      cacheWrite: 10,
                    },
                    outputTokens: {
                      total: 5,
                      text: 5,
                      reasoning: 0,
                    },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'done' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: {
                      total: 200,
                      noCache: 100,
                      cacheRead: 80,
                      cacheWrite: 20,
                    },
                    outputTokens: {
                      total: 7,
                      text: 5,
                      reasoning: 2,
                    },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message: StoredMessage) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      loadTurnRuntimeEvents: async (turnId: string) =>
        turnId === 'turn-1'
          ? firstTurn.loadTurnRuntimeEvents(turnId)
          : secondTurn.loadTurnRuntimeEvents(turnId),
      newId: idGenerator(),
      now: monotonicClock(),
      recordUsageCheckpoint: async (usage: { inputTokens: number; outputTokens: number }) => {
        usageCheckpoints.push(usage);
      },
    } as never);

    for await (const event of backend.send(firstTurn.input())) {
      firstTurn.record(event);
      events.push(event);
    }
    await drainDurably(backend.send(secondTurn.input()), secondTurn);

    const usageMessage = messages.find(
      (message) => (message as { type?: string }).type === 'token_usage',
    ) as
      | {
          input?: number;
          output?: number;
          cacheHitInput?: number;
          cacheMissInput?: number;
          cacheMissInputSource?: string;
          cacheWriteInput?: number;
          cacheRead?: number;
          cacheCreation?: number;
          reasoning?: number;
          total?: number;
          rawFinishReason?: string;
        }
      | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | Extract<SessionEvent, { type: 'token_usage' }>
      | undefined;

    assert.equal(streamCalls, 3);
    assert.equal(usageMessage?.input, 300);
    assert.equal(usageMessage?.output, 12);
    assert.equal(usageMessage?.cacheHitInput, 100);
    assert.equal(usageMessage?.cacheMissInput, 170);
    assert.equal(usageMessage?.cacheMissInputSource, 'explicit');
    assert.equal(usageMessage?.cacheWriteInput, 30);
    assert.equal(usageMessage?.cacheRead, 100);
    assert.equal(usageMessage?.cacheCreation, 30);
    assert.equal(usageMessage?.reasoning, 2);
    assert.equal(usageMessage?.total, 312);
    assert.equal(usageMessage?.rawFinishReason, 'stop');
    assert.equal(usageEvent?.input, 300);
    assert.deepEqual(
      usageCheckpoints.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })),
      [
        { inputTokens: 100, outputTokens: 5 },
        { inputTokens: 300, outputTokens: 12 },
        { inputTokens: 500, outputTokens: 19 },
      ],
    );
  });

  test('does not record fabricated zero telemetry when provider usage is unavailable', async () => {
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: undefined,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              } as never,
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    // No usable sample means no usage record at all — a zero would be
    // indistinguishable from a call that genuinely consumed nothing (#972).
    assert.deepEqual(
      events.filter((event) => event.type === 'token_usage'),
      [],
    );
  });

  test('keeps checkpoint cost unknown when model pricing is unavailable', async () => {
    const usageCheckpoints: Array<{ costUsd?: number }> = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'unpriced-model',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      lookupPricing: () => null,
      recordUsageCheckpoint: async (usage: { costUsd?: number }) => {
        usageCheckpoints.push(usage);
      },
    } as never);

    await drain(backend.send({ turnId: 'turn-1', text: 'hi', context: [] }));

    assert.equal(usageCheckpoints.length, 1);
    assert.equal(usageCheckpoints[0]?.costUsd, undefined);
  });

  test('a pruned tool result is readable again through the tool its placeholder names', async () => {
    // The whole loop through real dispatch (#2026): the budget prunes an
    // oversized result, the runtime mints a placeholder naming `ArchiveRead`,
    // the model calls it with the ref that placeholder carried, and the body
    // lands back in the conversation. Advertising the decoder is only half the
    // invariant; the other half is that calling it works from inside the turn.
    const durable = durableTurnHarness('turn-1', 'read the big file');
    const largeBody = 'ARCHIVED_BODY_SENTINEL'.repeat(200);
    const store = new Map<string, string>();
    const prompts: unknown[] = [];
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        streamCalls += 1;
        prompts.push(prompt);
        const call = (toolCallId: string, toolName: string, input: unknown) =>
          [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ] as LanguageModelV4StreamPart[];
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? call('tool-1', 'Read', { path: 'big.md' })
            : // The newest completed step is never pruned, so a second call is
              // what makes the Read result stale enough to be archived.
              streamCalls === 2
              ? call('tool-2', 'Bash', { cmd: 'continue' })
              : streamCalls === 3
                ? call('tool-3', 'ArchiveRead', {
                    // Read the ref out of the placeholder the runtime just
                    // handed us, exactly as a model would.
                    ref: /maka:\/\/archive\/[^"\\]+/.exec(JSON.stringify(prompt))?.[0] ?? 'missing',
                    operation: 'read',
                  })
                : [
                    { type: 'stream-start', warnings: [] },
                    {
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: 'stop' },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                      },
                    },
                  ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'Read description',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ body: largeBody }),
        },
        {
          name: 'Bash',
          description: 'Bash description',
          parameters: z.object({ cmd: z.string() }),
          impl: async () => ({ body: 'small' }),
        },
      ],
      contextBudget: {
        activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      },
      // A real store, so the decoder has to reach what the writer actually wrote.
      toolResultArchive: createToolResultArchiveCapability({
        archiveToolResult: async (event) => {
          const artifactId = `artifact-${store.size + 1}`;
          store.set(artifactId, event.serializedResult);
          return { artifactId };
        },
        readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
        readArchivedToolResultResource: async (event) => {
          const serializedResult = store.get(event.artifactId);
          return serializedResult === undefined
            ? { ok: false, reason: 'not_found' }
            : { ok: true, serializedResult };
        },
      }),
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(durable.input())) durable.record(event);

    assert.match(
      store.get('artifact-1') ?? '',
      /ARCHIVED_BODY_SENTINEL/,
      'the oversized Read result must have been archived',
    );
    const thirdPrompt = JSON.stringify(prompts[2]);
    assert.doesNotMatch(thirdPrompt, /ARCHIVED_BODY_SENTINEL/);
    assert.match(thirdPrompt, /maka:\/\/archive\//);
    assert.match(
      JSON.stringify(prompts[3]),
      /ARCHIVED_BODY_SENTINEL/,
      'the ArchiveRead result must carry the archived body back into the conversation',
    );
  });

  test('records active tool-result prune diagnostics in usage telemetry', async () => {
    const durable = durableTurnHarness('turn-1', 'hi');
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const largeBody = 'SECRET_PAYLOAD_SHOULD_BE_ARCHIVED'.repeat(200);
    let streamCalls = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        streamCalls += 1;
        prompts.push(prompt);
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : streamCalls === 2
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'tool-2',
                    toolName: 'Bash',
                    input: JSON.stringify({ cmd: 'continue' }),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'Read description',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ body: largeBody }),
        },
        {
          name: 'Bash',
          description: 'Bash description',
          parameters: z.object({ cmd: z.string() }),
          impl: async () => ({ body: 'NEWEST_RESULT_STAYS_VISIBLE' }),
        },
      ],
      contextBudget: {
        activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async () => ({ artifactId: 'artifact-tool-1' }),
      }),
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(durable.input())) {
      durable.record(event);
      events.push(event);
    }

    const usageMessage = messages.find(
      (message) => (message as { type?: string }).type === 'token_usage',
    ) as { contextBudget?: Record<string, unknown> } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & {
          contextBudget?: Record<string, unknown>;
        })
      | undefined;
    assert.equal(streamCalls, 3);
    const secondPrompt = JSON.stringify(prompts[1]);
    assert.match(secondPrompt, /SECRET_PAYLOAD_SHOULD_BE_ARCHIVED/);
    assert.doesNotMatch(secondPrompt, /maka\.active_archived_tool_result/);
    const thirdPrompt = JSON.stringify(prompts[2]);
    assert.doesNotMatch(thirdPrompt, /SECRET_PAYLOAD_SHOULD_BE_ARCHIVED/);
    assert.match(thirdPrompt, /artifact-tool-1/);
    assert.match(thirdPrompt, /NEWEST_RESULT_STAYS_VISIBLE/);
    for (const contextBudget of [usageMessage?.contextBudget, usageEvent?.contextBudget]) {
      assert.equal(contextBudget?.activePrunedToolResults, 1);
      assert.equal(contextBudget?.activeArchiveFailures, undefined);
      assert.ok(((contextBudget?.activeEstimatedTokensSaved as number | undefined) ?? 0) > 0);
    }
  });

  test('projects superseded current-turn observations before the next provider step', async () => {
    const durable = durableTurnHarness('turn-1', 'hi');
    const messages: unknown[] = [];
    const prompts: unknown[] = [];
    const oldBody = 'OLD_READ_RESULT'.repeat(200);
    const newBody = 'NEW_READ_RESULT'.repeat(200);
    let streamCalls = 0;
    let readCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        streamCalls += 1;
        prompts.push(prompt);
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls <= 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: `read-${streamCalls}`,
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'Read description',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ body: readCalls++ === 0 ? oldBody : newBody }),
        },
      ],
      contextBudget: {
        charsPerToken: 1,
        activeToolResultPrune: {
          enabled: true,
          maxCurrentResultEstimatedTokens: 10_000,
          minSupersededResultEstimatedTokens: 1,
        },
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async () => ({ artifactId: 'artifact-read-1' }),
      }),
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(durable.input())) durable.record(event);

    assert.equal(streamCalls, 3);
    assert.match(JSON.stringify(prompts[1]), /OLD_READ_RESULT/);
    const thirdPrompt = JSON.stringify(prompts[2]);
    assert.doesNotMatch(thirdPrompt, /OLD_READ_RESULT/);
    assert.match(thirdPrompt, /NEW_READ_RESULT/);
    assert.match(thirdPrompt, /newer_read_covers_range/);
    const usageMessage = messages.find(
      (message) => (message as { type?: string }).type === 'token_usage',
    ) as { contextBudget?: Record<string, unknown> } | undefined;
    assert.equal(usageMessage?.contextBudget?.activeSupersededToolResults, 1);
    assert.equal(usageMessage?.contextBudget?.activeDuplicateToolResults, undefined);
  });

  test('semantic compact projects a recorded block through the real backend request pipeline', async () => {
    const durable = durableTurnHarness('turn-1', 'inspect the repository');
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const recordedBlocks: SemanticCompactBlock[] = [];
    const largeBody = 'SEMANTIC_RAW_TOOL_OUTPUT'.repeat(200);
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              established_findings: ['The repository inspection completed.'],
              decisions: [],
              failed_paths: [],
              partial_work_product: ['The earlier Read result was inspected.'],
              action_in_progress: 'Continue from the preserved latest tool episode.',
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        warnings: [],
      },
      doStream: async () => {
        streamCalls += 1;
        const toolCall = (toolCallId: string, toolName: string, input: unknown) =>
          [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ] as LanguageModelV4StreamPart[];
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? toolCall('tool-read', 'Read', { path: 'notes.md' })
            : streamCalls === 2
              ? toolCall('tool-bash', 'Bash', { cmd: 'continue' })
              : [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  },
                ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'Read description',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ body: largeBody }),
        },
        {
          name: 'Bash',
          description: 'Bash description',
          parameters: z.object({ cmd: z.string() }),
          impl: async () => ({ body: 'latest tool episode' }),
        },
      ],
      contextBudget: {
        charsPerToken: 1,
        activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
        semanticCompact: {
          enabled: true,
          mode: 'replace',
          minStepNumber: 1,
          highWaterRatio: 0.1,
          maxActiveEstimatedTokens: 1,
          minSafePrefixEstimatedTokens: 1,
          maxAcceptedProjectionEstimatedTokens: 2048,
          minSavingsTokens: 1,
          minSavingsRatio: 0,
        },
      },
      toolResultArchive: testToolResultArchive({
        archiveToolResult: async () => ({ artifactId: 'artifact-tool-read' }),
      }),
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      recordSemanticCompactBlock: (block) => {
        recordedBlocks.push(block);
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(durable.input())) {
      durable.record(event);
      events.push(event);
    }
    await Promise.resolve();

    assert.equal(streamCalls, 3);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(recordedBlocks.length, 1);
    assert.equal(recordedBlocks[0]?.kind, 'maka.semantic_compact_block');
    assert.equal(recordedBlocks[0]?.projection?.format, 'structured');
    const projectedPrompt = JSON.stringify(model.doStreamCalls[2]?.prompt ?? []);
    assert.match(projectedPrompt, /maka_semantic_compact_block/);
    assert.match(projectedPrompt, /Continue from the preserved latest tool episode/);
    assert.doesNotMatch(projectedPrompt, /SEMANTIC_RAW_TOOL_OUTPUT/);
    assert.match(projectedPrompt, /latest tool episode/);

    const usageMessage = messages.find(
      (message) => (message as { type?: string }).type === 'token_usage',
    ) as { contextBudget?: Record<string, unknown> } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & {
          contextBudget?: Record<string, unknown>;
        })
      | undefined;
    for (const contextBudget of [usageMessage?.contextBudget, usageEvent?.contextBudget]) {
      const decisions = contextBudget?.compactionDecisions as
        | Array<Record<string, unknown>>
        | undefined;
      assert.equal(
        decisions?.some(
          (decision) =>
            decision.boundaryKind === 'semanticCompact' && decision.decision === 'replaced',
        ),
        true,
      );
      assert.equal(typeof contextBudget?.highWaterRequestShapeHashBefore, 'string');
      assert.equal(typeof contextBudget?.highWaterRequestShapeHashAfter, 'string');
    }
  });

  test('normalizes cache and reasoning tokens to messages, events, and telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const runTraceEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
    let pricingLookupCalls = 0;
    const pricing = {
      modelKey: 'anthropic:mock-model-id',
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
      cacheReadUsdPer1M: 0.3,
      cacheWriteUsdPer1M: 3.75,
    };
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 5,
            cacheRead: 3,
            cacheWrite: 2,
          },
          outputTokens: {
            total: 7,
            text: 5,
            reasoning: 2,
          },
        },
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system prompt',
      lookupPricing: (modelKey) => {
        pricingLookupCalls += 1;
        return modelKey === pricing.modelKey ? pricing : null;
      },
      recordRunTrace: (event) => {
        runTraceEvents.push(event);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageMessage = messages.find(
      (message) => (message as { type?: string }).type === 'token_usage',
    ) as
      | {
          input?: number;
          output?: number;
          cacheHitInput?: number;
          cacheMissInput?: number;
          cacheMissInputSource?: string;
          cacheWriteInput?: number;
          cacheRead?: number;
          cacheCreation?: number;
          reasoning?: number;
          total?: number;
          rawFinishReason?: string;
          costUsd?: number;
          systemPromptHash?: string;
          prefixHash?: string;
          prefixChangeReason?: string;
          requestShapeHash?: string;
          requestShapeChangeReason?: string;
        }
      | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | (Extract<SessionEvent, { type: 'token_usage' }> & { systemPromptHash?: string })
      | undefined;
    const expectedCostUsd = (5 * 3 + 3 * 0.3 + 2 * 3.75 + 7 * 15) / 1_000_000;
    const startTrace = runTraceEvents.find((event) => event.type === 'model_stream_started');

    assert.equal((usageMessage as { type?: string } | undefined)?.type, 'token_usage');
    assert.equal((usageMessage as { turnId?: string } | undefined)?.turnId, 'turn-1');
    assert.equal(usageMessage?.input, 10);
    assert.equal(usageMessage?.output, 7);
    assert.equal(usageMessage?.cacheHitInput, 3);
    assert.equal(usageMessage?.cacheMissInput, 5);
    assert.equal(usageMessage?.cacheMissInputSource, 'explicit');
    assert.equal(usageMessage?.cacheWriteInput, 2);
    assert.equal(usageMessage?.cacheRead, 3);
    assert.equal(usageMessage?.cacheCreation, 2);
    assert.equal(usageMessage?.reasoning, 2);
    assert.equal(usageMessage?.total, 17);
    assert.equal(usageMessage?.rawFinishReason, 'stop');
    assert.equal(usageMessage?.systemPromptHash, usageEvent?.systemPromptHash);
    assert.ok(usageMessage?.systemPromptHash);
    assert.equal(usageMessage?.costUsd, expectedCostUsd);
    assert.equal(usageMessage?.prefixChangeReason, 'first_turn');
    assert.equal(usageMessage?.requestShapeChangeReason, 'first_turn');
    assert.ok(usageMessage?.prefixHash);
    assert.ok(usageMessage?.requestShapeHash);
    assert.equal(usageEvent?.input, 10);
    assert.equal(usageEvent?.output, 7);
    assert.equal(usageEvent?.cacheHitInput, 3);
    assert.equal(usageEvent?.cacheMissInput, 5);
    assert.equal(usageEvent?.cacheMissInputSource, 'explicit');
    assert.equal(usageEvent?.cacheWriteInput, 2);
    assert.equal(usageEvent?.cacheRead, 3);
    assert.equal(usageEvent?.cacheCreation, 2);
    assert.equal(usageEvent?.reasoning, 2);
    assert.equal(usageEvent?.total, 17);
    assert.equal(usageEvent?.rawFinishReason, 'stop');
    assert.equal(usageEvent?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(usageEvent?.costUsd, expectedCostUsd);
    assert.equal(usageEvent?.prefixChangeReason, 'first_turn');
    assert.equal(usageEvent?.requestShapeChangeReason, 'first_turn');
    assert.ok(usageEvent?.prefixHash);
    assert.ok(usageEvent?.requestShapeHash);
    assert.equal(startTrace?.data?.prefixChangeReason, 'first_turn');
    assert.equal(startTrace?.data?.requestShapeChangeReason, 'first_turn');
    assert.ok(startTrace?.data?.prefixHash);
    assert.ok(startTrace?.data?.requestShapeHash);
    assert.equal(startTrace?.data?.systemPromptHash, usageMessage?.systemPromptHash);
    assert.equal(pricingLookupCalls, 1);
  });
});

describe('AiSdkBackend request-shape diagnostics', () => {
  test('classifies targeted request-shape changes', () => {
    const tools = canonicalizeToolSet(
      [testTool('Read', z.object({ path: z.string() }))],
      testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })),
    );
    const baseInput = {
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { temperature: 0 },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [{ role: 'user' as const, content: 'hello' }],
    };
    const base = computeRequestShapeDiagnostic(baseInput, undefined);

    assert.equal(
      computeRequestShapeDiagnostic(
        {
          ...baseInput,
          systemPrompt: 'changed system',
        },
        base,
      ).prefixChangeReason,
      'system_prompt_changed',
    );
    assert.equal(
      computeRequestShapeDiagnostic(
        {
          ...baseInput,
          providerTools: canonicalizeToolSet(
            [testTool('Read', z.object({ path: z.string(), offset: z.number().optional() }))],
            testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })),
          ).providerTools,
        },
        base,
      ).prefixChangeReason,
      'tool_schema_changed',
    );
    assert.equal(
      computeRequestShapeDiagnostic(
        {
          ...baseInput,
          providerOptions: { temperature: 1 },
        },
        base,
      ).prefixChangeReason,
      'provider_options_changed',
    );
    assert.equal(
      computeRequestShapeDiagnostic(
        {
          ...baseInput,
          modelId: 'other-model',
        },
        base,
      ).prefixChangeReason,
      'model_or_provider_changed',
    );
    const historyChanged = computeRequestShapeDiagnostic(
      {
        ...baseInput,
        priorMessages: [{ role: 'assistant' as const, content: 'hello' }],
      },
      base,
    );
    assert.equal(historyChanged.prefixChangeReason, 'stable');
    assert.equal(historyChanged.prefixHash, base.prefixHash);
    assert.equal(historyChanged.requestShapeChangeReason, 'history_projection_changed');
    assert.notEqual(historyChanged.requestShapeHash, base.requestShapeHash);
  });

  test('tool-result output hydration changes request shape without changing durable prefix', () => {
    const tools = canonicalizeToolSet(
      [testTool('Read', z.object({ path: z.string() }))],
      testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() })),
    );
    const toolCallMessage: ModelMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { path: 'archive.txt' },
        },
      ],
    };
    const placeholderToolResult: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'Read',
          output: { type: 'text', value: '[archived placeholder]' },
        },
      ],
    };
    const hydratedToolResult: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'Read',
          output: { type: 'text', value: 'hydrated archive payload '.repeat(20) },
        },
      ],
    };
    const baseInput = {
      connection: connection(),
      modelId: 'mock-model-id',
      systemPrompt: 'durable system',
      providerOptions: { temperature: 0 },
      providerTools: tools.providerTools,
      activeTools: tools.activeTools,
      priorMessages: [toolCallMessage, placeholderToolResult],
    };
    const placeholder = computeRequestShapeDiagnostic(baseInput, undefined);
    const hydrated = computeRequestShapeDiagnostic(
      {
        ...baseInput,
        priorMessages: [toolCallMessage, hydratedToolResult],
      },
      placeholder,
    );

    assert.equal(hydrated.prefixChangeReason, 'stable');
    assert.equal(hydrated.prefixHash, placeholder.prefixHash);
    assert.equal(hydrated.requestShapeChangeReason, 'history_projection_changed');
    assert.notEqual(hydrated.requestShapeHash, placeholder.requestShapeHash);
  });

  test('tool canonicalization is independent of registration order and places invalid last', () => {
    const invalid = testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() }));
    const first = canonicalizeToolSet(
      [
        testTool('Write', z.object({ path: z.string(), content: z.string() })),
        testTool('Read', z.object({ path: z.string() })),
      ],
      invalid,
    );
    const second = canonicalizeToolSet(
      [
        testTool('Read', z.object({ path: z.string() })),
        testTool('Write', z.object({ content: z.string(), path: z.string() })),
      ],
      invalid,
    );

    assert.deepEqual(first.activeTools, ['Read', 'Write']);
    assert.deepEqual(
      first.providerTools.map((tool) => tool.name),
      ['Read', 'Write', INVALID_TOOL_NAME],
    );
    assert.deepEqual(
      second.providerTools.map((tool) => tool.name),
      ['Read', 'Write', INVALID_TOOL_NAME],
    );
    assert.equal(
      computeRequestShapeDiagnostic(
        {
          connection: connection(),
          modelId: 'mock-model-id',
          providerTools: first.providerTools,
          activeTools: first.activeTools,
          priorMessages: [],
        },
        undefined,
      ).componentHashes.toolSchemaHash,
      computeRequestShapeDiagnostic(
        {
          connection: connection(),
          modelId: 'mock-model-id',
          providerTools: second.providerTools,
          activeTools: second.activeTools,
          priorMessages: [],
        },
        undefined,
      ).componentHashes.toolSchemaHash,
    );
  });

  test('classifies strict enabled-group expansion as tool_source_enabled', () => {
    const invalid = testTool(INVALID_TOOL_NAME, z.object({ tool: z.string().optional() }));
    const initialTools = canonicalizeToolSet(
      [
        testTool('Read', z.object({ path: z.string() })),
        testTool(LOAD_TOOLS_NAME, z.object({ group: z.string() })),
      ],
      invalid,
    );
    const expandedTools = canonicalizeToolSet(
      [
        testTool('Read', z.object({ path: z.string() })),
        testTool('WebFetch', z.object({ url: z.string() })),
        testTool(LOAD_TOOLS_NAME, z.object({ group: z.string() })),
      ],
      invalid,
    );
    const groupCatalog = { web: ['WebFetch'] };
    const first = computeRequestShapeDiagnostic(
      {
        connection: connection(),
        modelId: 'mock-model-id',
        providerTools: initialTools.providerTools,
        activeTools: initialTools.activeTools,
        priorMessages: [],
        toolAvailability: {
          mode: 'economy',
          enabledSourceIds: [],
          availableSourceIds: ['web'],
          connectorToolName: LOAD_TOOLS_NAME,
          visibleToolNamesBySource: groupCatalog,
        },
      },
      undefined,
    );
    const second = computeRequestShapeDiagnostic(
      {
        connection: connection(),
        modelId: 'mock-model-id',
        providerTools: expandedTools.providerTools,
        activeTools: expandedTools.activeTools,
        priorMessages: [],
        toolAvailability: {
          mode: 'economy',
          enabledSourceIds: ['web'],
          availableSourceIds: [],
          connectorToolName: LOAD_TOOLS_NAME,
          visibleToolNamesBySource: groupCatalog,
        },
      },
      first,
    );

    assert.equal(second.prefixChangeReason, 'tool_schema_changed');
    assert.equal(second.requestShapeChangeReason, 'tool_schema_changed');
    assert.equal(second.toolSchemaChangeReason, 'tool_source_enabled');
    assert.notEqual(second.prefixHash, first.prefixHash);
  });

  test('backend full mode keeps the complete tool surface and omits the connector', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      // No toolAvailability ⇒ full surface: every tool visible, no connector.
      tools: [
        testTool('Read', z.object({ path: z.string() })),
        testTool('WebFetch', z.object({ url: z.string() })),
      ],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(modelToolNames(model), sortedModelToolNames(['Read', 'WebFetch']));
    assert.equal(modelToolNames(model).includes(LOAD_TOOLS_NAME), false);
    // toolCount tracks the model-visible (active) tools — the two real tools.
    // The invalid fallback lives in providerTools but is never advertised, so
    // it is not counted (toolCount is the wire-visible subset).
    const usageEvent = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(toolSchemaPromptSegment(usageEvent)?.toolCount, 2);
  });

  test('volatile turn-tail facts do not churn the durable prefix hash', async () => {
    const events: SessionEvent[] = [];
    const models: MockLanguageModelV4[] = [];
    let date = '2026-05-29';
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => {
        const model = completionModel();
        models.push(model);
        return model;
      },
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system prompt',
      turnTailPrompt: () => `Maka session environment:\n<env>\n  Today's date: ${date}\n</env>`,
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }
    date = '2026-05-30';
    for await (const event of backend.send({ turnId: 'turn-2', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageEvents = events.filter(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.equal(usageEvents[0]?.prefixChangeReason, 'first_turn');
    assert.equal(usageEvents[1]?.prefixChangeReason, 'stable');
    assert.equal(usageEvents[1]?.prefixHash, usageEvents[0]?.prefixHash);
    assert.equal(usageEvents[0]?.requestShapeChangeReason, 'first_turn');
    assert.equal(usageEvents[1]?.requestShapeChangeReason, 'stable');
    assert.equal(usageEvents[1]?.requestShapeHash, usageEvents[0]?.requestShapeHash);
    assert.match(JSON.stringify(compactPrompt(models[0]!)), /2026-05-29/);
    assert.match(JSON.stringify(compactPrompt(models[1]!)), /2026-05-30/);
    assert.equal(JSON.stringify(modelCallSettings(models[0]!)).includes('2026-05-29'), false);
    assert.equal(JSON.stringify(modelCallSettings(models[1]!)).includes('2026-05-30'), false);
  });
});

describe('AiSdkBackend context budget and prompt attribution', () => {
  test('replay hands the model a bounded summary for an Edit file_diff result, not the diff', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join(
      '\n',
    );
    const events = [
      runtimeEvent({
        id: 'edit-call',
        turnId: 't1',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-edit',
          name: 'Edit',
          args: { path: 'a.ts' },
        },
      }),
      runtimeEvent({
        id: 'edit-result',
        turnId: 't1',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-edit',
          name: 'Edit',
          result: { kind: 'file_diff', paths: ['a.ts'], diff },
        },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);
    const result = plan.items.find(
      (item) => item.kind === 'tool_result' && item.toolCallId === 'tool-edit',
    );

    assert.equal(result?.kind === 'tool_result' ? result.output : undefined, 'Edited a.ts (+1 -1)');
    // The durable event itself keeps the full diff — only the model-facing
    // projection is bounded.
    const durable = events[1].content;
    assert.equal(
      durable?.kind === 'function_response' ? (durable.result as { kind: string }).kind : undefined,
      'file_diff',
    );
  });

  test('usage events include prompt segments and context budget diagnostics', async () => {
    const model = completionModel();
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      newId: idGenerator(),
      now: monotonicClock(),
      systemPrompt: 'durable system',
      turnTailPrompt: 'volatile tail',
      contextBudget: {
        name: 'test-budget',
        maxHistoryEstimatedTokens: 40,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
    });

    for await (const event of backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [],
      runtimeContext: [
        runtimeTextEvent({
          id: 'old-u',
          turnId: 'old',
          role: 'user',
          author: 'user',
          text: 'old user text',
        }),
        runtimeTextEvent({
          id: 'old-a',
          turnId: 'old',
          role: 'model',
          author: 'agent',
          text: 'old assistant text',
        }),
        runtimeTextEvent({
          id: 'new-u',
          turnId: 'new',
          role: 'user',
          author: 'user',
          text: 'new user text',
        }),
        runtimeTextEvent({
          id: 'new-a',
          turnId: 'new',
          role: 'model',
          author: 'agent',
          text: 'new assistant text',
        }),
      ],
    })) {
      events.push(event);
    }

    assert.deepEqual(compactPrompt(model), [
      { role: 'system', content: 'durable system' },
      { role: 'user', content: [{ type: 'text', text: 'new user text' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'new assistant text' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user\n\nvolatile tail' }] },
    ]);
    const usage = events.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.ok(usage);
    assert.equal(usage.contextBudget?.policyName, 'test-budget');
    assert.equal(usage.contextBudget?.droppedTurns, 1);
    assert.equal(
      usage.promptSegments?.some((segment) => segment.kind === 'prior_history'),
      true,
    );
    assert.equal(
      usage.promptSegments?.some((segment) => segment.kind === 'tool_schema'),
      true,
    );
    assert.equal(
      usage.promptSegments?.some((segment) => segment.kind === 'turn_tail'),
      true,
    );
  });
});

describe('AiSdkBackend RunTrace', () => {
  for (const protocol of ['openai-compatible', 'anthropic-compatible'] as const) {
    test(`records ${protocol} multi-step requests and reconciles complete attempt usage`, async () => {
      const captures: ProviderRequestCaptureRecord[] = [];
      const attempts: ProviderRequestAttemptRecord[] = [];
      const durable = durableTurnHarness('turn-1', 'hi');
      let calls = 0;
      const usageFor = (step: number) => {
        if (protocol === 'openai-compatible') {
          const input = step === 0 ? 10 : 20;
          const cached = step === 0 ? 4 : 5;
          const output = step === 0 ? 2 : 3;
          return {
            inputTokens: {
              total: input,
              noCache: input - cached,
              cacheRead: cached,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: output,
              text: output - (step === 0 ? 0 : 1),
              reasoning: step === 0 ? 0 : 1,
            },
            raw: {
              prompt_tokens: input,
              completion_tokens: output,
              prompt_tokens_details: { cached_tokens: cached },
              completion_tokens_details: { reasoning_tokens: step === 0 ? 0 : 1 },
            },
          };
        }
        const noCache = step === 0 ? 6 : 12;
        const cacheRead = step === 0 ? 3 : 6;
        const cacheWrite = step === 0 ? 1 : 2;
        const output = step === 0 ? 2 : 3;
        return {
          inputTokens: {
            total: noCache + cacheRead + cacheWrite,
            noCache,
            cacheRead,
            cacheWrite,
          },
          outputTokens: { total: output, text: undefined, reasoning: undefined },
          raw: {
            input_tokens: noCache,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
          },
        };
      };
      const model = new MockLanguageModelV4({
        doStream: async () => {
          const step = calls++;
          const chunks: LanguageModelV4StreamPart[] =
            step === 0
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'read-1',
                    toolName: 'Read',
                    input: JSON.stringify({ path: 'notes.md' }),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: usageFor(step),
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'done' },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: usageFor(step),
                  },
                ];
          return {
            stream: simulateReadableStream({
              chunks,
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      });
      const backend = createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        appendMessage: async () => {},
        connection: connection(),
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => model,
        tools: [testTool('Read', z.object({ path: z.string() }))],
        loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
        newId: idGenerator(),
        now: monotonicClock(),
        recordProviderRequestCapture: async (capture) => {
          captures.push(capture);
          return { artifactId: `artifact-${captures.length}` };
        },
        recordProviderRequestAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      const events = await drainDurably(backend.send(durable.input()), durable);

      assert.equal(captures.length, 2);
      assert.deepEqual(
        attempts.map(({ step, attempt, status }) => ({ step, attempt, status })),
        [
          { step: 0, attempt: 1, status: 'completed' },
          { step: 1, attempt: 1, status: 'completed' },
        ],
      );
      assert.equal(findFirstChangedCacheableSegment(captures[1]!, captures[0]!)?.kind, 'message');
      const aggregate = events.find(
        (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
          event.type === 'token_usage',
      );
      assert.ok(aggregate);
      const sum = (field: keyof ProviderRequestAttemptRecord) =>
        attempts.reduce(
          (total, attempt) => total + ((attempt[field] as number | undefined) ?? 0),
          0,
        );
      assert.equal(sum('inputTokens'), aggregate.input);
      assert.equal(sum('outputTokens'), aggregate.output);
      assert.equal(sum('cacheReadInputTokens'), aggregate.cacheHitInput);
      assert.equal(sum('cacheMissInputTokens'), aggregate.cacheMissInput);
      assert.equal(sum('cacheWriteInputTokens'), aggregate.cacheWriteInput);
    });
  }

  test('captures the prepared request before the provider call and records its physical attempt', async () => {
    const captures: ProviderRequestCaptureRecord[] = [];
    const attempts: ProviderRequestAttemptRecord[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        assert.equal(captures.length, 1, 'capture must be durable before provider dispatch');
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: undefined },
                  outputTokens: { total: 2, text: 2, reasoning: 0 },
                  raw: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                    prompt_tokens_details: { cached_tokens: 0 },
                  },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        ...connection(),
        models: [{ id: 'mock-model-id', contextWindow: 200_000 }],
      },
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordProviderRequestCapture: async (capture) => {
        captures.push(capture);
        return { artifactId: `artifact-${captures.length}` };
      },
      recordProviderRequestAttempt: async (attempt) => {
        attempts.push(attempt);
      },
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(captures.length, 1);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.step, 0);
    assert.equal(attempts[0]?.attempt, 1);
    assert.equal(attempts[0]?.status, 'completed');
    assert.equal(attempts[0]?.contextWindow, 200_000);
    assert.equal(attempts[0]?.captureId, captures[0]?.captureId);
    assert.equal(attempts[0]?.cacheMissInputSource, 'derived');
    assert.equal(
      events.find((event) => event.type === 'token_usage')?.providerRequestTraceId,
      captures[0]?.traceId,
    );
  });

  test('does not call the provider when prepared-request persistence fails', async () => {
    const model = completionModel();
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordProviderRequestCapture: async () => {
        throw new Error('capture unavailable');
      },
      recordProviderRequestAttempt: () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.equal(model.doStreamCalls.length, 0);
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('disables hidden AI SDK retries and traces the one explicit Runtime retry', async () => {
    const captures: ProviderRequestCaptureRecord[] = [];
    const attempts: ProviderRequestAttemptRecord[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          throw new APICallError({
            message: 'retry me',
            url: 'https://provider.invalid/v1/messages',
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { 'retry-after-ms': '1' },
          });
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: undefined },
                  outputTokens: { total: 2, text: 2, reasoning: 0 },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordProviderRequestCapture: async (capture) => {
        captures.push(capture);
        return { artifactId: 'artifact-1' };
      },
      recordProviderRequestAttempt: (attempt) => {
        attempts.push(attempt);
      },
      providerRetrySleep: async () => {},
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'hi', context: [] }));

    assert.equal(calls, 2);
    assert.equal(captures.length, 1);
    assert.deepEqual(
      attempts.map(({ attempt, status }) => ({ attempt, status })),
      [
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'completed' },
      ],
    );
  });

  test('retries one idle watchdog timeout after preserving partial thinking', async () => {
    const timers = manualWatchdogTimer();
    const assistants: AssistantMessage[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        if (calls === 1) {
          return {
            stream: hangingProviderStream(
              [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'reasoning-1' },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-1',
                  delta: 'partial thought',
                },
              ],
              options.abortSignal,
              'close',
            ),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'recovered' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: emptyUsage(),
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'assistant') assistants.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'thinking_delta' && event.text === 'partial thought') timers.fire();
    }

    assert.equal(calls, 2);
    assert.deepEqual(
      events
        .filter((event) => event.type === 'provider_retry')
        .map(({ phase, attempt, maxAttempts, reason }) => ({
          phase,
          attempt,
          maxAttempts,
          reason,
        })),
      [
        { phase: 'scheduled', attempt: 2, maxAttempts: 2, reason: 'timeout' },
        { phase: 'started', attempt: 2, maxAttempts: 2, reason: 'timeout' },
      ],
    );
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0]?.thinking?.text, 'partial thought');
    assert.equal(assistants[0]?.text, '');
    assert.equal(assistants[1]?.text, 'recovered');
    assert.notEqual(assistants[0]?.id, assistants[1]?.id);
  });

  test('retries DeepSeek OpenAI Chat reasoning marked only for field replay', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        if (calls === 1) {
          return {
            stream: hangingProviderStream(
              [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'reasoning-1' },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-1',
                  delta: 'ordinary DeepSeek reasoning',
                },
              ],
              options.abortSignal,
            ),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'recovered' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: emptyUsage(),
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        ...connection(),
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-pro', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-pro',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'thinking_delta' && event.text === 'ordinary DeepSeek reasoning') {
        timers.fire();
      }
    }

    assert.equal(calls, 2);
    assert.equal(
      events.some((event) => event.type === 'provider_retry' && event.phase === 'started'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
  });

  test('does not report a consumed idle timeout for a later assistant append failure', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: 'reasoning-1' },
              {
                type: 'reasoning-delta',
                id: 'reasoning-1',
                delta: 'partial thought',
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {
        throw new Error('assistant append failed');
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'thinking_delta' && event.text === 'partial thought') timers.fire();
    }

    assert.equal(calls, 1);
    const error = events.find((event) => event.type === 'error');
    assert.equal(error?.type, 'error');
    assert.notEqual(error?.type === 'error' ? error.reason : undefined, 'timeout');
    assert.equal(error?.type === 'error' ? error.message : undefined, 'Operation failed');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('links a recovered tool call to the retry assistant step', async () => {
    const timers = manualWatchdogTimer();
    const durable = durableTurnHarness('turn-1', 'read notes');
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        if (calls === 1) {
          return {
            stream: hangingProviderStream(
              [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'reasoning-timeout' },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-timeout',
                  delta: 'timed-out thought',
                },
              ],
              options.abortSignal,
            ),
          };
        }
        const chunks: LanguageModelV4StreamPart[] =
          calls === 2
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'reasoning-retry' },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-retry',
                  delta: 'recovered thought',
                },
                {
                  type: 'reasoning-delta',
                  id: 'reasoning-retry',
                  delta: '',
                  providerMetadata: { anthropic: { signature: 'sig-retry' } },
                },
                { type: 'reasoning-end', id: 'reasoning-retry' },
                {
                  type: 'tool-call',
                  toolCallId: 'read-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'notes.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: emptyUsage(),
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-final' },
                { type: 'text-delta', id: 'text-final', delta: 'done' },
                { type: 'text-end', id: 'text-final' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: emptyUsage(),
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send(durable.input())) {
      durable.record(event);
      events.push(event);
      if (event.type === 'thinking_delta' && event.text === 'timed-out thought') timers.fire();
    }

    const timeoutThinking = events.find(
      (event) => event.type === 'thinking_complete' && event.text === 'timed-out thought',
    );
    const recoveredThinking = events.find(
      (event) => event.type === 'thinking_complete' && event.text === 'recovered thought',
    );
    const toolStart = events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.toolUseId === 'read-1',
    );

    assert.equal(calls, 3);
    assert.equal(timeoutThinking?.type, 'thinking_complete');
    assert.equal(recoveredThinking?.type, 'thinking_complete');
    assert.equal(toolStart?.stepId, recoveredThinking?.messageId);
    assert.notEqual(toolStart?.stepId, timeoutThinking?.messageId);
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
  });

  test('stops after one recovered idle watchdog timeout in the same provider step', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: `reasoning-${calls}` },
              {
                type: 'reasoning-delta',
                id: `reasoning-${calls}`,
                delta: `partial thought ${calls}`,
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'thinking_delta' && event.text.startsWith('partial thought')) {
        timers.fire();
      }
    }

    assert.equal(calls, 2);
    assert.equal(
      events.filter((event) => event.type === 'provider_retry' && event.phase === 'scheduled')
        .length,
      1,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('does not retry an idle watchdog timeout after partial answer text', async () => {
    const timers = manualWatchdogTimer();
    const traces: RunTraceEvent[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'partial answer' },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
      recordRunTrace: (event) => traces.push(event),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'text_delta' && event.text === 'partial answer') timers.fire();
    }

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
    const failureTrace = traces.find((event) => event.type === 'model_stream_failed');
    assert.equal(failureTrace?.data?.rawErrorName, 'Error');
    assert.match(String(failureTrace?.data?.redactedErrorMessage), /stream idle timeout/);
    assert.equal(typeof failureTrace?.data?.redactedErrorStackSha256, 'string');
  });

  test('does not retry an idle watchdog timeout after provider continuation metadata', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: 'reasoning-1' },
              {
                type: 'reasoning-delta',
                id: 'reasoning-1',
                delta: 'completed provider reasoning',
              },
              {
                type: 'reasoning-end',
                id: 'reasoning-1',
                providerMetadata: {
                  openai: {
                    itemId: 'reasoning-item-1',
                    reasoningEncryptedContent: 'encrypted-reasoning',
                  },
                },
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    const eventsPromise = collectEvents(
      backend.send({ turnId: 'turn-1', text: 'hi', context: [] }),
      events,
    );
    await waitFor(() => timers.armCount() >= 5);
    timers.fire();
    await eventsPromise;

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('does not retry after provider-executed tool input starts', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-input-start',
                id: 'provider-tool-1',
                toolName: 'web_search',
                providerExecuted: true,
              },
              {
                type: 'tool-input-delta',
                id: 'provider-tool-1',
                delta: '{"query":"release notes"}',
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    const eventsPromise = collectEvents(
      backend.send({ turnId: 'turn-1', text: 'hi', context: [] }),
      events,
    );
    await waitFor(() => timers.armCount() >= 4);
    timers.fire();
    await eventsPromise;

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('does not retry an idle watchdog timeout after text continuation metadata', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              {
                type: 'text-end',
                id: 'text-1',
                providerMetadata: { openai: { itemId: 'message-item-1' } },
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });

    const events: SessionEvent[] = [];
    const eventsPromise = collectEvents(
      backend.send({ turnId: 'turn-1', text: 'hi', context: [] }),
      events,
    );
    await waitFor(() => timers.armCount() >= 4);
    timers.fire();
    await eventsPromise;

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('does not retry an idle watchdog timeout after a terminal finish boundary', async () => {
    const timers = manualWatchdogTimer();
    const finishConsumed = makeGate();
    let calls = 0;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async () => {},
    });
    type FakeStreamInput = {
      abortSignal: AbortSignal;
      onStreamActivity: () => void;
    };
    (
      backend as unknown as {
        modelAdapter: { startStream: (input: FakeStreamInput) => Promise<ModelStreamResult> };
      }
    ).modelAdapter.startStream = async (input: FakeStreamInput) => {
      calls += 1;
      return {
        events: (async function* () {
          input.onStreamActivity();
          yield { kind: 'finish' as const, finishReason: 'stop' };
          finishConsumed.release();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(input.abortSignal.reason ?? new Error('aborted'));
            if (input.abortSignal.aborted) abort();
            else input.abortSignal.addEventListener('abort', abort, { once: true });
          });
        })(),
        outcome: Promise.resolve({
          kind: 'completed',
          finishReason: 'stop',
          request: { messages: [] },
          continuation: 'none',
        }),
      };
    };

    const events: SessionEvent[] = [];
    const eventsPromise = collectEvents(
      backend.send({ turnId: 'turn-1', text: 'hi', context: [] }),
      events,
    );
    await finishConsumed.promise;
    timers.fire();
    await eventsPromise;

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'error')?.reason, 'timeout');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
  });

  test('Stop aborts the turn while an idle-timeout retry is waiting', async () => {
    const timers = manualWatchdogTimer();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        return {
          stream: hangingProviderStream(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: 'reasoning-1' },
              {
                type: 'reasoning-delta',
                id: 'reasoning-1',
                delta: 'partial thought',
              },
            ],
            options.abortSignal,
          ),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      streamWatchdogTimer: timers.clock,
      providerRetrySleep: async (_delayMs, signal) =>
        await new Promise<void>((_resolve, reject) => {
          const abort = () =>
            reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
      if (event.type === 'thinking_delta' && event.text === 'partial thought') timers.fire();
      if (event.type === 'provider_retry' && event.phase === 'scheduled') {
        await backend.stop('user_stop');
      }
    }

    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === 'provider_retry' && event.phase === 'started'),
      false,
    );
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'user_stop');
  });

  test('records the continuation replay gate and blocking diagnostics on stream failure', async () => {
    const trace: RunTraceEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('provider failed');
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => trace.push(event),
    });

    await drain(
      backend.send({
        turnId: 'turn-resume',
        text: '',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-source',
            role: 'user',
            author: 'user',
            text: 'original user',
          }),
          runtimeEvent({
            id: 'rt-invalid-role',
            turnId: 'turn-source',
            role: 'tool',
            author: 'tool',
            content: { kind: 'text', text: 'invalid text lane' },
          }),
        ],
        continuation: {
          sourceInvocationId: 'invocation-source',
          sourceRunId: 'run-source',
          sourceTurnId: 'turn-source',
          sourceRuntimeEventHighWater: 2,
        },
      }),
    );

    const failure = trace.find((event) => event.type === 'model_stream_failed');
    assert.equal(failure?.data?.priorReplayGate, 'runtime_replay_text_only');
    assert.deepEqual(failure?.data?.priorReplayDiagnosticCodes, ['unsupported_role']);
  });

  test('records turn, model, usage, and completion trace events without changing SessionEvents', async () => {
    const trace: RunTraceEvent[] = [];
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 4,
                  noCache: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 2,
                  text: 1,
                  reasoning: 1,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => {
        trace.push(event);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      trace.map((event) => event.type),
      [
        'turn_started',
        'model_resolved',
        'model_stream_started',
        'model_stream_completed',
        'send_diagnostics_recorded',
      ],
    );
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['turn', 'model', 'model', 'model', 'model'],
    );
    assert.equal(trace[0]?.sessionId, 'session-1');
    assert.equal(trace[0]?.turnId, 'turn-1');
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });

  test('trace recorder failures are best-effort and do not change model execution', async () => {
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 1,
                  text: 1,
                  reasoning: 0,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: () => {
        throw new Error('trace sink unavailable');
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });

  test('records abort trace when stop is requested', async () => {
    const trace: RunTraceEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    turnScope(backend, 'turn-1').runTrace = {
      abortRequested: (reason: string) => {
        trace.push({
          id: 'trace-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: 1,
          phase: 'abort',
          type: 'abort_requested',
          message: 'Abort requested',
          data: { reason },
        });
      },
    } as unknown as RunTrace;

    await backend.stop('redirect');

    assert.equal(trace.length, 1);
    assert.equal(trace[0]?.type, 'abort_requested');
    assert.equal(trace[0]?.data?.reason, 'redirect');
  });
});

describe('AiSdkBackend tool execution', () => {
  test('WebSearch telemetry never copies the user-derived query', async () => {
    const telemetry: Array<{ argsSummary?: string }> = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('bypass'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({ argsSummary: record.argsSummary });
      },
    });
    const tool: MakaTool = {
      name: 'WebSearch',
      description: 'search web',
      parameters: {},
      impl: async () => ({
        kind: 'web_search',
        provider: 'tavily',
        query: 'PRIVATE_QUERY_SENTINEL',
        rows: [],
      }),
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', { push: () => {} });

    await execute(
      { query: 'PRIVATE_QUERY_SENTINEL', limit: 3 },
      { toolCallId: 'tool-web-search', abortSignal: new AbortController().signal },
    );

    assert.deepEqual(telemetry, [{ argsSummary: '{"limit":3}' }]);
    assert.doesNotMatch(JSON.stringify(telemetry), /PRIVATE_QUERY_SENTINEL/);
  });

  test('tool failure telemetry classifies and redacts generic implementation errors', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; errorClass?: string; bytesOut: number }> = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({
          status: record.status,
          errorClass: record.errorClass,
          bytesOut: record.bytesOut ?? 0,
        });
      },
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      impl: async () => {
        const error = new Error('401 Authorization: Bearer sk-live-secret-token-value');
        Object.assign(error, { code: 401 });
        throw error;
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    const result = await execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const resultText = (result as { error?: string }).error ?? '';
    const serialized = JSON.stringify({ messages, events, result });

    assert.match(resultText, /Authorization: Bearer \[redacted\]/);
    assert.equal(serialized.includes('sk-live-secret-token-value'), false);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'tool_result' && event.toolUseId === 'tool-1' && event.isError === true,
      ),
      true,
    );
    assert.deepEqual(telemetry, [{ status: 'error', errorClass: 'Auth', bytesOut: 0 }]);
  });

  test('flushes output deltas before successful and failed tool results', async () => {
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const successTool: MakaTool = {
      name: 'Streamer',
      description: 'streams output',
      parameters: {},
      impl: async (_args, ctx) => {
        ctx.emitOutput('stdout', 'success chunk');
        return { ok: true };
      },
    };
    const failureTool: MakaTool = {
      name: 'Streamer',
      description: 'streams then fails',
      parameters: {},
      impl: async (_args, ctx) => {
        ctx.emitOutput('stderr', 'failure chunk');
        throw new Error('tool failed');
      },
    };
    const wrap = (tool: MakaTool) =>
      runtimeExecute(backend, tool, 'turn-1', { push: (event) => events.push(event) });

    await wrap(successTool)(
      {},
      {
        toolCallId: 'tool-success',
        abortSignal: new AbortController().signal,
      },
    );
    await wrap(failureTool)(
      {},
      {
        toolCallId: 'tool-failure',
        abortSignal: new AbortController().signal,
      },
    );
    const eventKeys = events.map(
      (event) => `${event.type}:${'toolUseId' in event ? event.toolUseId : ''}`,
    );

    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-success') <
        eventKeys.indexOf('tool_result:tool-success'),
      'successful tool output must flush before its result event',
    );
    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-failure') <
        eventKeys.indexOf('tool_result:tool-failure'),
      'failed tool output must flush before its result event',
    );
  });

  test('pauses stream watchdog while a foreground subagent tool is running', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let pauseCount = 0;
    let resumeCount = 0;
    turnScope(backend, 'turn-1').watchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    let release!: () => void;
    const tool: MakaTool = {
      name: 'agent_spawn',
      description: 'spawn child agent',
      parameters: {},
      categoryHint: 'subagent',
      impl: async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              kind: 'subagent',
              agentName: 'Researcher',
              turnId: 'child-turn',
              status: 'completed',
              permissionMode: 'explore',
              summary: 'done',
              artifactIds: [],
            });
        }),
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', { push: () => {} });

    const pending = execute(
      {},
      {
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 0);
    release();
    await pending;
    assert.equal(resumeCount, 1);
  });

  test('pauses stream watchdog while a regular (non-subagent) tool is running', async () => {
    // A long Bash command (apt-get install, a build) must not trip the model
    // stream idle timeout: the model is between steps while the tool runs.
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let pauseCount = 0;
    let resumeCount = 0;
    turnScope(backend, 'turn-1').watchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    let release!: () => void;
    const tool: MakaTool = {
      name: 'Bash',
      description: 'run a shell command',
      parameters: {},
      impl: async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              kind: 'terminal',
              cwd: '/app',
              cmd: 'sleep 300',
              status: 'completed',
              exitCode: 0,
              output: {
                mode: 'pipes',
                stdout: '',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
                redacted: false,
              },
            });
        }),
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', { push: () => {} });

    const pending = execute(
      {},
      {
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 0);
    release();
    await pending;
    assert.equal(resumeCount, 1);
  });

  test('keeps the stream alive while filtered tool input parts keep arriving', async () => {
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        const chunks: LanguageModelV4StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Preparing the report.' },
          { type: 'text-end', id: 'text-1' },
          { type: 'tool-input-start', id: 'tool-1', toolName: 'Write' },
          { type: 'tool-input-delta', id: 'tool-1', delta: '{"path":' },
          { type: 'tool-input-delta', id: 'tool-1', delta: '"report.md",' },
          { type: 'tool-input-delta', id: 'tool-1', delta: '"content":' },
          { type: 'tool-input-delta', id: 'tool-1', delta: '"complete"}' },
          { type: 'tool-input-end', id: 'tool-1' },
          { type: 'text-start', id: 'text-2' },
          { type: 'text-delta', id: 'text-2', delta: 'Done.' },
          { type: 'text-end', id: 'text-2' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: emptyUsage(),
          },
        ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: 25,
          }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('bypass'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => model,
      tools: [],
      streamConnectTimeoutMs: 1_000,
      streamIdleTimeoutMs: 100,
      newId: idGenerator(),
      now: Date.now,
    });

    const events: SessionEvent[] = [];
    await collectEvents(
      backend.send({ turnId: 'turn-1', text: 'write the report', context: [] }),
      events,
    );

    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events.filter((event) => event.type === 'error')),
    );
    assert.equal(providerCalls, 1);
    const completion = events.find((event) => event.type === 'complete');
    assert.equal(completion?.type === 'complete' ? completion.stopReason : undefined, 'end_turn');
  });

  test('caps concurrent read-only subagent tools in one turn', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let implStarted = 0;
    const release: Array<() => void> = [];
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      categoryHint: 'subagent',
      impl: async () => {
        implStarted += 1;
        return new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        });
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    const pending = Array.from({ length: MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN }, (_, index) =>
      execute(
        { objective: `research ${index}` },
        { toolCallId: `tool-${index}`, abortSignal: new AbortController().signal },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);

    const rejected = await execute(
      { objective: 'overflow' },
      { toolCallId: 'tool-overflow', abortSignal: new AbortController().signal },
    );
    assert.deepEqual(rejected, {
      error: '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。',
    });
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'tool_result' && event.toolUseId === 'tool-overflow' && event.isError,
      ),
      true,
    );
    assert.equal(JSON.stringify(messages).includes('tool-overflow'), true);

    release.forEach((resume) => resume());
    await Promise.all(pending);
  });

  test('maps structured subagent terminal states to persisted tool status', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      categoryHint: 'subagent',
      impl: async (args: unknown) => {
        const input = args as { reason?: string };
        return {
          kind: 'explore_agent',
          ok: false,
          mode: 'read_only',
          objective: 'bad scope',
          roots: [],
          queries: [],
          filesInspected: 0,
          filesSkipped: 0,
          bytesRead: 0,
          progress: [],
          candidateFiles: [],
          matches: [],
          notes: [],
          reason: input.reason === 'aborted' ? 'aborted' : 'invalid_root',
          message: input.reason === 'aborted' ? '只读探索已取消。' : '范围无效。',
        };
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    await execute(
      { objective: 'bad scope' },
      {
        toolCallId: 'tool-failed',
        abortSignal: new AbortController().signal,
      },
    );
    await execute(
      { objective: 'cancelled', reason: 'aborted' },
      {
        toolCallId: 'tool-aborted',
        abortSignal: new AbortController().signal,
      },
    );

    assert.equal(
      (
        messages.find(
          (message) =>
            (message as { type?: string; toolUseId?: string }).type === 'tool_result' &&
            (message as { toolUseId?: string }).toolUseId === 'tool-failed',
        ) as { isError?: boolean } | undefined
      )?.isError,
      true,
    );
    assert.equal(
      (
        events.find(
          (event) => event.type === 'tool_result' && event.toolUseId === 'tool-aborted',
        ) as { isError?: boolean } | undefined
      )?.isError,
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', toolCallId: 'tool-failed' },
      { status: 'aborted', toolCallId: 'tool-aborted' },
    ]);
  });

  test('maps foreground subagent terminal states to persisted tool status', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'agent_spawn',
      description: 'spawn read-only worker',
      parameters: {},
      categoryHint: 'subagent',
      impl: async (args: unknown) => {
        const input = args as { status: 'completed' | 'failed' | 'cancelled' };
        return {
          kind: 'subagent',
          agentName: 'Researcher',
          turnId: `child-${input.status}`,
          status: input.status,
          permissionMode: 'explore',
          summary: input.status,
          artifactIds: [],
        };
      },
    };
    const execute = runtimeExecute(backend, tool, 'turn-1', {
      push: (event) => events.push(event),
    });

    await execute(
      { status: 'failed' },
      {
        toolCallId: 'tool-failed',
        abortSignal: new AbortController().signal,
      },
    );
    await execute(
      { status: 'cancelled' },
      {
        toolCallId: 'tool-cancelled',
        abortSignal: new AbortController().signal,
      },
    );
    await execute(
      { status: 'completed' },
      {
        toolCallId: 'tool-completed',
        abortSignal: new AbortController().signal,
      },
    );

    assert.equal(
      (
        messages.find(
          (message) =>
            (message as { type?: string; toolUseId?: string }).type === 'tool_result' &&
            (message as { toolUseId?: string }).toolUseId === 'tool-failed',
        ) as { isError?: boolean } | undefined
      )?.isError,
      true,
    );
    assert.equal(
      (
        events.find(
          (event) => event.type === 'tool_result' && event.toolUseId === 'tool-cancelled',
        ) as { isError?: boolean } | undefined
      )?.isError,
      true,
    );
    assert.equal(
      (
        events.find(
          (event) => event.type === 'tool_result' && event.toolUseId === 'tool-completed',
        ) as { isError?: boolean } | undefined
      )?.isError,
      false,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', toolCallId: 'tool-failed' },
      { status: 'aborted', toolCallId: 'tool-cancelled' },
      { status: 'success', toolCallId: 'tool-completed' },
    ]);
  });
});

describe('AiSdkBackend tool-call repair', () => {
  test('repairs provider tool-name case drift to the canonical Maka tool name', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'bash',
        input: '{"command":"pwd"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool'),
    });

    assert.equal(repaired?.toolName, 'Bash');
    assert.equal(repaired?.input, '{"command":"pwd"}');
  });

  test('routes unrepairable tool calls into the structured invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'DeleteEverything',
        input: '{"path":"/"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool: Authorization: Bearer sk-live-secret-token-value'),
    });

    assert.equal(repaired?.toolName, INVALID_TOOL_NAME);
    const input = JSON.parse(repaired?.input ?? '{}') as { tool?: string; error?: string };
    assert.equal(input.tool, 'DeleteEverything');
    assert.match(input.error ?? '', /No such tool/);
    assert.equal((input.error ?? '').includes('sk-live-secret-token-value'), false);
  });

  test('does not recursively repair the internal invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: INVALID_TOOL_NAME,
        input: '{}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('Invalid tool failed'),
    });

    assert.equal(repaired, null);
  });
});

describe('AiSdkBackend concurrent turns', () => {
  // #1990: RuntimeKernel reuses one backend per Session and lets one generation
  // hold several concurrent runs. A finishing turn used to clear the backend's
  // shared "current run", so an overlapping turn's next tool call committed
  // against no run at all and the whole turn died with "Operation failed".
  test('a finishing turn does not strip the run identity of an overlapping turn', async () => {
    const first = durableTurnHarness('turn-a', 'first', {
      runId: 'run-a',
      invocationId: 'invocation-a',
    });
    const second = durableTurnHarness('turn-b', 'second', {
      runId: 'run-b',
      invocationId: 'invocation-b',
    });
    const ledgers = new Map([
      ['turn-a', first],
      ['turn-b', second],
    ]);
    const preparedRunIds: Array<string | undefined> = [];
    const executions: string[] = [];
    // The overlapping turn must reach its tool AFTER the other turn is fully
    // torn down: run identity was read at dispatch, so that is the window the
    // crash lived in. Holding the provider stream (not the tool body) is what
    // puts the tool call on the far side of the other turn's cleanup.
    const firstTurnDone = makeGate();
    const overlappingStreamStarted = makeGate();

    let servedToolCall = false;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const servesOverlappingTurn = !servedToolCall && JSON.stringify(prompt).includes('second');
        if (servesOverlappingTurn) {
          servedToolCall = true;
          overlappingStreamStarted.release();
          await firstTurnDone.promise;
        }
        const chunks: LanguageModelV4StreamPart[] = servesOverlappingTurn
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-b',
                toolName: 'Read',
                input: JSON.stringify({ path: 'b.md' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 0, reasoning: 0 },
                },
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });

    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          ...testTool('Read', z.object({ path: z.string() })),
          impl: async ({ path }: { path: string }) => {
            executions.push(path);
            return { body: path };
          },
        },
      ],
      runtimeCommitSink: {
        commitToolPrepared: async ({ runtimeEvent }) => {
          preparedRunIds.push(runtimeEvent.runId);
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
      },
      loadTurnRuntimeEvents: async (turnId: string) =>
        (ledgers.get(turnId) ?? first).loadTurnRuntimeEvents(turnId),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const overlapping = drainDurably(
      backend.send(second.input({ runId: 'run-b', invocationId: 'invocation-b' })),
      second,
    );
    // Let the overlapping turn park mid-stream, run the other turn to completion
    // on the SAME backend, then release the tool call into that aftermath.
    await overlappingStreamStarted.promise;
    await drainDurably(
      backend.send(first.input({ runId: 'run-a', invocationId: 'invocation-a' })),
      first,
    );
    firstTurnDone.release();
    const events = await overlapping;

    assert.deepEqual(executions, ['b.md']);
    assert.deepEqual(preparedRunIds, ['run-b']);
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      'the overlapping turn must not fail when a sibling turn finishes',
    );
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'end_turn');
    // Both turns are done, so neither left a scope behind for a later turn to
    // inherit — the leak that would reintroduce shared per-turn state.
    assert.equal(backendInternals(backend).activeTurns.size, 0);
  });

  // A scope that reaches activeTurns must always leave it. Setup runs before the
  // provider pump exists, and a throw there used to strand the scope forever:
  // nothing overwrites a Set entry, and stop()/dispose() only iterate.
  test('a send that throws during setup leaves no scope registered', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await assert.rejects(
      drain(
        backend.send({
          turnId: 'turn-1',
          text: 'hi',
          context: [],
          // A hosted Interaction Run for a different turn: beginTurn refuses it,
          // and it throws before anything installs the turn's own cleanup.
          hostedInteraction: {
            sessionId: 'session-1',
            turnId: 'a-different-turn',
          } as never,
        }),
      ),
      /mismatched hosted Interaction Run/,
    );

    assert.equal(backendInternals(backend).activeTurns.size, 0);
    // And the backend is still usable: a leaked scope would pin dispose() to the
    // stop path and broadcast endTurn to a dead runtime forever.
    await backend.dispose();
  });

  // A broadcast stop must reach every turn even when one of them cannot close.
  // `endTurn` rejects when a durable sandbox denial cannot be written, and it is
  // also the ONLY thing that rejects a tool parked on askUserQuestion — an abort
  // signal does not wake the registry. So a stop that bails on the first failure
  // parks the sibling forever: that turn's own send() cleanup is itself waiting
  // on the tool the skipped endTurn was supposed to reject.
  test('stop() closes every turn even when one turn fails to close', async () => {
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const aborted: string[] = [];
    const endedTurns: string[] = [];
    for (const turnId of ['turn-a', 'turn-b']) {
      const scope = turnScope(backend, turnId);
      scope.runTrace = {
        emit: () => {},
        abortRequested: () => aborted.push(turnId),
      } as unknown as RunTrace;
    }
    // The first turn cannot complete teardown; the second parks on a question
    // that only its own endTurn can reject.
    const failing = turnScope(backend, 'turn-a');
    const endFailingTurn = failing.toolRuntime.endTurn.bind(failing.toolRuntime);
    failing.toolRuntime.endTurn = async (reason) => {
      endedTurns.push(failing.turnId);
      await endFailingTurn(reason);
      throw new Error('Could not durably deny every sandbox boundary request');
    };
    const parked = turnScope(backend, 'turn-b');
    const endParkedTurn = parked.toolRuntime.endTurn.bind(parked.toolRuntime);
    parked.toolRuntime.endTurn = async (reason) => {
      endedTurns.push(parked.turnId);
      await endParkedTurn(reason);
    };

    const events: SessionEvent[] = [];
    const sink = { push: (event: SessionEvent) => events.push(event) };
    // Each tool gets its OWN turn's abort signal, exactly as send() hands it out,
    // so the broadcast is observed where tools actually receive it.
    const abortObserved: string[] = [];
    const abortCall = runtimeExecute(
      backend,
      {
        ...testTool('WaitForAbort', z.object({})),
        impl: async (_input: unknown, ctx: { abortSignal: AbortSignal }) =>
          new Promise((resolve) => {
            ctx.abortSignal.addEventListener('abort', () => {
              abortObserved.push('turn-a');
              resolve({ stopped: true });
            });
          }),
      } as MakaTool,
      'turn-a',
      sink,
    )({}, { toolCallId: 'tool-a', abortSignal: failing.abortController.signal });
    const questionCall = runtimeExecute(
      backend,
      {
        ...testTool('Ask', z.object({})),
        impl: async (
          _input: unknown,
          ctx: { askUserQuestion: (questions: unknown[]) => Promise<unknown> },
        ) => ctx.askUserQuestion([{ question: 'Continue?', options: ['yes', 'no'] }]),
      } as MakaTool,
      'turn-b',
      sink,
    )({}, { toolCallId: 'tool-b', abortSignal: parked.abortController.signal });
    await waitFor(() => events.some((event) => event.type === 'user_question_request'));

    await assert.rejects(backend.stop('user_stop'), /Could not durably deny/);

    // Every turn is aborted under its own controller, not just the first one:
    // turn-a's tool observes the signal it was actually handed, and turn-b's
    // controller is aborted even though turn-a's teardown failed.
    assert.equal(
      await Promise.race([
        abortCall.then(() => 'aborted'),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 50)),
      ]),
      'aborted',
    );
    assert.deepEqual(abortObserved, ['turn-a']);
    assert.equal(parked.abortController.signal.aborted, true);
    // The failing turn's error still surfaces, and the sibling is closed anyway:
    // its parked question is rejected rather than left waiting forever.
    assert.deepEqual(endedTurns, ['turn-a', 'turn-b']);
    assert.deepEqual(aborted, ['turn-a', 'turn-b']);
    // settleToolCall reports a failed tool rather than rejecting, so what
    // matters is that it settles at all instead of parking forever.
    assert.equal(
      await Promise.race([
        questionCall.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise((resolve) => setTimeout(() => resolve('parked'), 50)),
      ]),
      'settled',
    );
  });
});

describe('AiSdkBackend thinking persistence', () => {
  test('emits a non-partial thinking_complete that survives read-model projection and materialization', async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Let me ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'reason.' },
      // Anthropic delivers the signed signature on a standalone empty delta.
      {
        type: 'reasoning-delta',
        id: 'r1',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-123' } },
      },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Final answer.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 1, reasoning: 1 },
        },
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const thinkingComplete = events.find(
      (event): event is Extract<SessionEvent, { type: 'thinking_complete' }> =>
        event.type === 'thinking_complete',
    );
    assert.ok(thinkingComplete, 'backend must emit a thinking_complete event');
    assert.equal(thinkingComplete.text, 'Let me reason.');
    assert.equal(thinkingComplete.signature, 'sig-123');

    // Thinking must be finalized before the assistant text so the read-model
    // has an assistant row to attach it to (order-independent, but assert the
    // intended emission order for clarity).
    const thinkingIndex = events.findIndex((event) => event.type === 'thinking_complete');
    const textIndex = events.findIndex((event) => event.type === 'text_complete');
    assert.ok(thinkingIndex >= 0 && textIndex >= 0 && thinkingIndex < textIndex);

    // End-to-end: SessionEvent → RuntimeEvent → StoredMessage projection.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-1',
      turnId: 'turn-1',
      now: () => 42,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const runtimeEvents = events.map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory));
    const runHeader: AgentRunHeader = {
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'completed',
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'anthropic-main',
      modelId: 'mock-model-id',
      cwd: '/tmp/maka',
      permissionMode: 'ask',
      createdAt: 1,
      updatedAt: 2,
    };
    const projection = projectRuntimeEventsToStoredMessages(runtimeEvents, {
      runHeaders: [runHeader],
    });
    const assistant = projection.messages.find((message) => message.type === 'assistant');
    assert.ok(assistant && assistant.type === 'assistant');
    assert.equal(assistant.text, 'Final answer.');
    assert.equal(assistant.thinking?.text, 'Let me reason.');
    assert.equal(assistant.thinking?.signature, 'sig-123');

    // materializeSession (session reload) surfaces the reconstructed thinking.
    const viewModel = materializeSession(projection.messages);
    const assistantItem = viewModel.items.find((item) => item.kind === 'assistant');
    assert.ok(assistantItem && assistantItem.kind === 'assistant');
    assert.equal(assistantItem.message.thinking?.text, 'Let me reason.');
    assert.equal(assistantItem.message.thinking?.signature, 'sig-123');
  });

  test('persists reasoning for a thinking-only turn that produces no final text', async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'silent ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thought' },
      { type: 'reasoning-end', id: 'r1' },
      // No text-* parts: the turn ends with reasoning only.
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 0, reasoning: 1 },
        },
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      },
    });
    const appended: unknown[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    // thinking_complete must be emitted even though there is no assistant text.
    const thinkingComplete = events.find(
      (event): event is Extract<SessionEvent, { type: 'thinking_complete' }> =>
        event.type === 'thinking_complete',
    );
    assert.ok(thinkingComplete, 'thinking-only turn must still emit thinking_complete');
    assert.equal(thinkingComplete.text, 'silent thought');
    // An AssistantMessage (empty text + thinking) is persisted for the turn.
    const assistantMessage = appended.find(
      (message): message is { type: string; text: string; thinking?: { text: string } } =>
        (message as { type?: string }).type === 'assistant',
    );
    assert.ok(assistantMessage);
    assert.equal(assistantMessage.text, '');
    assert.equal(assistantMessage.thinking?.text, 'silent thought');

    // Full chain: RuntimeEvent projection + materialize keep the reasoning on an
    // empty-text assistant row without crashing.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-1',
      turnId: 'turn-1',
      now: () => 42,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const runtimeEvents = events.map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory));
    const runHeader: AgentRunHeader = {
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'completed',
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'anthropic-main',
      modelId: 'mock-model-id',
      cwd: '/tmp/maka',
      permissionMode: 'ask',
      createdAt: 1,
      updatedAt: 2,
    };
    const projection = projectRuntimeEventsToStoredMessages(runtimeEvents, {
      runHeaders: [runHeader],
    });
    const assistant = projection.messages.find((message) => message.type === 'assistant');
    assert.ok(assistant && assistant.type === 'assistant');
    assert.equal(assistant.text, '');
    assert.equal(assistant.thinking?.text, 'silent thought');

    const viewModel = materializeSession(projection.messages);
    const assistantItem = viewModel.items.find((item) => item.kind === 'assistant');
    assert.ok(assistantItem && assistantItem.kind === 'assistant');
    assert.equal(assistantItem.message.thinking?.text, 'silent thought');
  });

  test('text-only terminal replay fixture preserves signed thinking and usage exactly', async () => {
    const openCodeClaudeConnection: LlmConnection = {
      slug: 'opencode',
      name: 'OpenCode Zen',
      providerType: 'opencode',
      defaultModel: 'claude-opus-4-8',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    // Turn 1: produce a signed thinking + text turn through the real backend.
    const firstChunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'deep thought' },
      {
        type: 'reasoning-delta',
        id: 'r1',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-replay' } },
      },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'the answer' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 1, reasoning: 1 },
        },
      },
    ];
    const firstModel = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: firstChunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const firstBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: openCodeClaudeConnection,
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-8',
      modelFactory: () => firstModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const firstEvents: SessionEvent[] = [];
    for await (const event of firstBackend.send({ turnId: 'turn-prev', text: 'q', context: [] })) {
      firstEvents.push(event);
    }
    const firstUsage = firstEvents.find(
      (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
        event.type === 'token_usage',
    );
    assert.deepEqual(
      firstUsage && {
        input: firstUsage.input,
        output: firstUsage.output,
        reasoning: firstUsage.reasoning,
        total: firstUsage.total,
      },
      { input: 1, output: 2, reasoning: 1, total: 3 },
    );

    // Translate the emitted SessionEvents into the durable RuntimeEvent ledger.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const runtimeContext = firstEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );

    // Turn 2: replay the prior ledger and capture the outgoing provider request.
    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: openCodeClaudeConnection,
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-8',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    // The reasoning block + text + Anthropic signature must reach the AI SDK
    // request in the same order emitted by the prior turn. This fails if
    // signature forwarding regresses, text disappears, or replay degrades to
    // an unstructured transcript.
    const prompt = compactPrompt(secondModel) as ModelMessage[];
    const replayedAssistant = prompt.find(
      (message) => message.role === 'assistant' && Array.isArray(message.content),
    );
    assert.ok(replayedAssistant && Array.isArray(replayedAssistant.content));
    assert.deepEqual(
      replayedAssistant.content.map((part) => part.type),
      ['reasoning', 'text'],
    );
    const [reasoningPart, textPart] = replayedAssistant.content;
    assert.equal(reasoningPart?.type, 'reasoning');
    assert.equal(reasoningPart.text, 'deep thought');
    assert.match(JSON.stringify(reasoningPart.providerOptions), /sig-replay/);
    assert.equal(textPart?.type, 'text');
    assert.equal(textPart.text, 'the answer');
  });

  test('signed thinking from a per-step tool-calling turn IS replayed, merged with its tool call', async () => {
    // Per-step ledger: the tool_start carries the step id (stepId === the
    // step's message id 'm1'), so the step's signed reasoning + text + tool call
    // regroup into ONE assistant message on replay (reasoning leads, then text,
    // then the tool call, then the tool result) — the Anthropic-valid shape.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const priorEvents: SessionEvent[] = [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-prev',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
        stepId: 'm1',
      },
      {
        type: 'tool_result',
        id: 'e2',
        turnId: 'turn-prev',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file contents' },
      },
      {
        type: 'thinking_complete',
        id: 'e3',
        turnId: 'turn-prev',
        ts: 3,
        messageId: 'm1',
        text: 'reasoning about the tool result',
        signature: 'sig-tool',
      },
      {
        type: 'text_complete',
        id: 'e4',
        turnId: 'turn-prev',
        ts: 4,
        messageId: 'm1',
        text: 'the answer',
      },
    ];
    const runtimeContext = priorEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );

    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = JSON.stringify(compactPrompt(secondModel));
    // Reasoning (with signature), text, and the tool call all reach the request.
    assert.match(prompt, /"type":"reasoning"/);
    assert.match(prompt, /sig-tool/);
    assert.match(prompt, /reasoning about the tool result/);
    assert.match(prompt, /"toolName":"Read"|"toolCallId":"tool-1"/);
    // Reasoning leads the tool call inside the assistant message (Anthropic order).
    assert.ok(prompt.indexOf('reasoning about the tool result') < prompt.indexOf('tool-1'));
  });

  test('omits Responses reasoning without encrypted content from the wire request', async (t) => {
    for (const replayCase of [
      { name: 'missing', openai: { itemId: 'rs_openai' } },
      {
        name: 'null',
        openai: { itemId: 'rs_openai', reasoningEncryptedContent: null },
      },
      {
        name: 'empty string',
        openai: { itemId: 'rs_openai', reasoningEncryptedContent: '' },
      },
    ] as const) {
      await t.test(replayCase.name, async () => {
        const runtimeContext: RuntimeEvent[] = [
          runtimeEvent({
            id: 'e1',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'thinking',
              text: 'display-only reasoning without an encrypted replay payload',
              providerOptions: { openai: replayCase.openai },
            },
            refs: { providerEventId: 'm1' },
          }),
          runtimeEvent({
            id: 'e2',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'answer before the tool call' },
            refs: { providerEventId: 'm1' },
          }),
          runtimeEvent({
            id: 'e3',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'tool-1',
              name: 'Read',
              args: { path: 'package.json' },
            },
            refs: { toolCallId: 'tool-1', stepId: 'm1' },
          }),
          runtimeEvent({
            id: 'e4',
            turnId: 'turn-prev',
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-1',
              name: 'Read',
              result: { kind: 'text', text: 'file contents' },
            },
            refs: { toolCallId: 'tool-1' },
          }),
        ];
        let requestBody: Record<string, unknown> | undefined;
        const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const events = [
            { type: 'response.created', response: { id: 'response-current' } },
            {
              type: 'response.completed',
              response: {
                id: 'response-current',
                object: 'response',
                created_at: 8,
                model: 'gpt-5.5',
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ];
          const body = `${events
            .map((event) => `data: ${JSON.stringify(event)}`)
            .join('\n\n')}\n\ndata: [DONE]\n\n`;
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }) as unknown as typeof globalThis.fetch;
        const secondBackend = createTestAiSdkBackend({
          sessionId: 'session-1',
          header: header(),
          appendMessage: async () => {},
          connection: {
            slug: 'openai',
            providerType: 'openai',
            defaultModel: 'gpt-5.5',
          },
          apiKey: 'openai-test-token',
          modelId: 'gpt-5.5',
          modelFactory: (input) => getAIModel({ ...input, fetch }),
          tools: [],
          newId: idGenerator(),
          now: monotonicClock(),
        });

        await drain(
          secondBackend.send({
            turnId: 'turn-current',
            text: 'follow up',
            context: [],
            runtimeContext,
          }),
        );

        const input = requestBody?.input;
        assert.ok(Array.isArray(input));
        assert.equal(
          input.some((item) => item?.type === 'reasoning'),
          false,
        );
        assert.deepEqual(
          input.slice(0, 3).map((item) => {
            assert.ok(item && typeof item === 'object' && !Array.isArray(item));
            const record = item as Record<string, unknown>;
            const content = Array.isArray(record.content) ? record.content : [];
            const firstContent = content[0];
            return {
              type: record.type ?? (typeof record.role === 'string' ? 'message' : undefined),
              role: record.role,
              text:
                firstContent && typeof firstContent === 'object' && !Array.isArray(firstContent)
                  ? (firstContent as Record<string, unknown>).text
                  : undefined,
              callId: record.call_id,
              name: record.name,
              arguments: record.arguments,
              output: record.output,
            };
          }),
          [
            {
              type: 'message',
              role: 'assistant',
              text: 'answer before the tool call',
              callId: undefined,
              name: undefined,
              arguments: undefined,
              output: undefined,
            },
            {
              type: 'function_call',
              role: undefined,
              text: undefined,
              callId: 'tool-1',
              name: 'Read',
              arguments: '{"path":"package.json"}',
              output: undefined,
            },
            {
              type: 'function_call_output',
              role: undefined,
              text: undefined,
              callId: 'tool-1',
              name: undefined,
              arguments: undefined,
              output: '{"kind":"text","text":"file contents"}',
            },
          ],
        );
      });
    }
  });

  test('OpenAI Responses reasoning from a tool step is replayed with its encrypted content', async () => {
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const priorEvents: SessionEvent[] = [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-prev',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
        stepId: 'm1',
      },
      {
        type: 'tool_result',
        id: 'e2',
        turnId: 'turn-prev',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file contents' },
      },
      {
        type: 'thinking_complete',
        id: 'e3',
        turnId: 'turn-prev',
        ts: 3,
        messageId: 'm1',
        text: 'reasoning about the tool',
        providerOptions: {
          openai: {
            itemId: 'rs_ark',
            reasoningEncryptedContent: 'encrypted-ark-reasoning',
          },
        },
      },
      {
        type: 'thinking_complete',
        id: 'e4',
        turnId: 'turn-prev',
        ts: 4,
        messageId: 'm1',
        text: 'unreplayable OpenAI reasoning',
        providerOptions: { openai: { itemId: 'rs_without_encrypted_content' } },
      },
      {
        type: 'text_complete',
        id: 'e5',
        turnId: 'turn-prev',
        ts: 5,
        messageId: 'm1',
        text: '',
      },
    ];
    const runtimeContext = priorEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );
    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'volcengine-agent-plan',
        providerType: 'volcengine-agent-plan',
        defaultModel: 'ark-code-latest',
      },
      apiKey: 'ark-plan-token',
      modelId: 'ark-code-latest',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(secondModel) as ModelMessage[];
    const assistant = prompt.find(
      (message) => message.role === 'assistant' && Array.isArray(message.content),
    );
    assert.ok(assistant && Array.isArray(assistant.content));
    assert.deepEqual(
      assistant.content.filter((part) => part.type === 'reasoning'),
      [
        {
          type: 'reasoning',
          text: 'reasoning about the tool',
          providerOptions: {
            openai: {
              itemId: 'rs_ark',
              reasoningEncryptedContent: 'encrypted-ark-reasoning',
            },
          },
        },
      ],
    );
    assert.ok(
      assistant.content.some((part) => part.type === 'tool-call' && part.toolCallId === 'tool-1'),
    );
  });

  test('DeepSeek Responses replays plaintext reasoning without an OpenAI item id', async () => {
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const priorEvents: SessionEvent[] = [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-prev',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
        stepId: 'm1',
      },
      {
        type: 'tool_result',
        id: 'e2',
        turnId: 'turn-prev',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file contents' },
      },
      {
        type: 'thinking_complete',
        id: 'e3',
        turnId: 'turn-prev',
        ts: 3,
        messageId: 'm1',
        text: 'reasoning about the tool',
      },
      {
        type: 'thinking_complete',
        id: 'e3-empty',
        turnId: 'turn-prev',
        ts: 3,
        messageId: 'm1',
        text: '',
      },
      {
        type: 'text_complete',
        id: 'e4',
        turnId: 'turn-prev',
        ts: 4,
        messageId: 'm1',
        text: '',
      },
    ];
    const runtimeContext = priorEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );
    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(secondModel) as ModelMessage[];
    const assistant = prompt.find(
      (message) => message.role === 'assistant' && Array.isArray(message.content),
    );
    assert.ok(assistant && Array.isArray(assistant.content));
    const reasoningParts = assistant.content.filter((part) => part.type === 'reasoning');
    assert.equal(reasoningParts.length, 1);
    const reasoning = reasoningParts[0];
    assert.ok(reasoning && reasoning.type === 'reasoning');
    assert.equal(reasoning.text, 'reasoning about the tool');
    assert.ok(
      assistant.content.some((part) => part.type === 'tool-call' && part.toolCallId === 'tool-1'),
    );
  });

  test('passes DeepSeek max reasoning through as the provider-native effort', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const events = [
        { type: 'response.created', response: { id: 'response-current' } },
        {
          type: 'response.completed',
          response: {
            id: 'response-current',
            object: 'response',
            created_at: 8,
            model: 'deepseek-v4-flash',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: { ...header(), thinkingLevel: 'max' },
      appendMessage: async () => {},
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: 'deepseek-test-token',
      modelId: 'deepseek-v4-flash',
      modelFactory: (input) => getAIModel({ ...input, fetch }),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({ turnId: 'turn-current', text: 'think', context: [] }));

    assert.deepEqual(requestBody?.reasoning, { effort: 'max' });
    assert.equal(requestBody?.include, undefined);
  });

  test('preserves every OpenAI Responses reasoning item through stream persistence and replay', async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      {
        type: 'reasoning-delta',
        id: 'r1',
        delta: 'first summary',
        providerMetadata: { openai: { itemId: 'rs_first' } },
      },
      {
        type: 'reasoning-end',
        id: 'r1',
        providerMetadata: {
          openai: {
            itemId: 'rs_first',
            reasoningEncryptedContent: 'encrypted-first',
          },
        },
      },
      { type: 'reasoning-start', id: 'r2' },
      {
        type: 'reasoning-delta',
        id: 'r2',
        delta: 'second summary',
        providerMetadata: { openai: { itemId: 'rs_second' } },
      },
      {
        type: 'reasoning-end',
        id: 'r2',
        providerMetadata: {
          openai: {
            itemId: 'rs_second',
            reasoningEncryptedContent: 'encrypted-second',
          },
        },
      },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Final answer.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 1, reasoning: 2 },
        },
      },
    ];
    const firstModel = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      },
    });
    const planConnection: LlmConnection = {
      slug: 'volcengine-agent-plan',
      name: 'Volcengine Ark Agent Plan (China)',
      providerType: 'volcengine-agent-plan',
      defaultModel: 'ark-code-latest',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const appended: StoredMessage[] = [];
    const firstBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: planConnection,
      apiKey: 'ark-plan-token',
      modelId: 'ark-code-latest',
      modelFactory: () => firstModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const events: SessionEvent[] = [];
    for await (const event of firstBackend.send({
      turnId: 'turn-prev',
      text: 'solve it',
      context: [],
    })) {
      events.push(event);
    }

    const thinkingCompletes = events.filter(
      (event): event is Extract<SessionEvent, { type: 'thinking_complete' }> =>
        event.type === 'thinking_complete',
    );
    assert.deepEqual(
      thinkingCompletes.map((event) => [event.text, event.providerOptions]),
      [
        [
          'first summary',
          {
            openai: {
              itemId: 'rs_first',
              reasoningEncryptedContent: 'encrypted-first',
            },
          },
        ],
        [
          'second summary',
          {
            openai: {
              itemId: 'rs_second',
              reasoningEncryptedContent: 'encrypted-second',
            },
          },
        ],
      ],
    );

    const persistedAssistant = appended.find(
      (message): message is AssistantMessage => message.type === 'assistant',
    );
    assert.ok(persistedAssistant);
    assert.deepEqual(
      (
        persistedAssistant.thinking as
          | {
              parts?: Array<{
                text: string;
                providerOptions?: Record<string, unknown>;
              }>;
            }
          | undefined
      )?.parts,
      thinkingCompletes.map(({ text, providerOptions }) => ({ text, providerOptions })),
    );

    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const runtimeContext = events.map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory));
    const projection = projectRuntimeEventsToStoredMessages(runtimeContext, {
      runHeaders: [
        {
          runId: 'run-prev',
          sessionId: 'session-1',
          turnId: 'turn-prev',
          status: 'completed',
          backendKind: 'ai-sdk',
          llmConnectionSlug: planConnection.slug,
          modelId: 'ark-code-latest',
          cwd: '/tmp/maka',
          permissionMode: 'ask',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    const projectedAssistant = projection.messages.find(
      (message): message is AssistantMessage => message.type === 'assistant',
    );
    assert.ok(projectedAssistant);
    assert.deepEqual(
      projectedAssistant.thinking?.parts,
      thinkingCompletes.map(({ text, providerOptions }) => ({ text, providerOptions })),
    );

    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: planConnection,
      apiKey: 'ark-plan-token',
      modelId: 'ark-code-latest',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(secondModel) as ModelMessage[];
    const assistant = prompt.find(
      (message) => message.role === 'assistant' && Array.isArray(message.content),
    );
    assert.ok(assistant && Array.isArray(assistant.content));
    assert.deepEqual(
      assistant.content.filter((part) => part.type === 'reasoning'),
      [
        {
          type: 'reasoning',
          text: 'first summary',
          providerOptions: {
            openai: {
              itemId: 'rs_first',
              reasoningEncryptedContent: 'encrypted-first',
            },
          },
        },
        {
          type: 'reasoning',
          text: 'second summary',
          providerOptions: {
            openai: {
              itemId: 'rs_second',
              reasoningEncryptedContent: 'encrypted-second',
            },
          },
        },
      ],
    );
  });

  test('thinking-only tool step (no text) replays reasoning + tool call in one assistant message without an empty text block', async () => {
    // Anthropic interleaved thinking's most common step shape: the step reasons,
    // calls a tool, and produces NO closing text — the backend still flushes the
    // step's AssistantMessage (text: '') so the signed block persists, and emits
    // text_complete with empty text. On replay the step must merge into ONE
    // assistant message [reasoning, tool-call] with NO empty text part between
    // them (emitStep skips text.length === 0; an empty text block is provider
    // noise and this locks that skip path).
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const priorEvents: SessionEvent[] = [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-prev',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
        stepId: 'm1',
      },
      {
        type: 'tool_result',
        id: 'e2',
        turnId: 'turn-prev',
        ts: 2,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file contents' },
      },
      {
        type: 'thinking_complete',
        id: 'e3',
        turnId: 'turn-prev',
        ts: 3,
        messageId: 'm1',
        text: 'plan the read',
        signature: 'sig-interleaved',
      },
      { type: 'text_complete', id: 'e4', turnId: 'turn-prev', ts: 4, messageId: 'm1', text: '' },
    ];
    const runtimeContext = priorEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );

    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(secondModel) as Array<{ role: string; content: unknown }>;
    const assistantMessages = prompt.filter((message) => message.role === 'assistant');
    assert.equal(
      assistantMessages.length,
      1,
      'reasoning and tool call must merge into one assistant message',
    );
    const parts = assistantMessages[0]!.content as Array<{ type: string; text?: string }>;
    // Reasoning leads the tool call; no text part at all (not even an empty one).
    assert.deepEqual(
      parts.map((part) => part.type),
      ['reasoning', 'tool-call'],
    );
    assert.equal(parts[0]!.text, 'plan the read');
    const promptJson = JSON.stringify(prompt);
    assert.match(promptJson, /sig-interleaved/);
    assert.match(promptJson, /"toolCallId":"tool-1"/);
  });

  test('an orphan tool_result does not degrade replay: dropped, while paired history replays provider-native', async () => {
    // Codex P2: `unmatched_tool_result` must not be a blocking diagnostic — the
    // materializer intentionally drops the orphan (a standalone tool message is
    // an Anthropic 400), so one orphan must not push the whole ledger back to
    // stored-message projection. Paired call/result and the step's signed
    // reasoning must all still reach the provider request.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const priorEvents: SessionEvent[] = [
      // Orphan: result with no prior tool_start (its call was sliced away).
      {
        type: 'tool_result',
        id: 'e0',
        turnId: 'turn-prev',
        ts: 1,
        toolUseId: 'tool-orphan',
        isError: false,
        content: { kind: 'text', text: 'orphan payload' },
      },
      // Paired per-step tool call + result + signed reasoning + text.
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-prev',
        ts: 2,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
        stepId: 'm1',
      },
      {
        type: 'tool_result',
        id: 'e2',
        turnId: 'turn-prev',
        ts: 3,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'file contents' },
      },
      {
        type: 'thinking_complete',
        id: 'e3',
        turnId: 'turn-prev',
        ts: 4,
        messageId: 'm1',
        text: 'plan the read',
        signature: 'sig-paired',
      },
      {
        type: 'text_complete',
        id: 'e4',
        turnId: 'turn-prev',
        ts: 5,
        messageId: 'm1',
        text: 'the answer',
      },
    ];
    const runtimeContext = priorEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );

    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = compactPrompt(secondModel) as Array<{ role: string; content: unknown }>;
    const promptJson = JSON.stringify(prompt);
    // Provider-native replay happened: reasoning + signature + paired tool pair.
    assert.match(promptJson, /"type":"reasoning"/);
    assert.match(promptJson, /sig-paired/);
    assert.match(promptJson, /"toolCallId":"tool-1"/);
    assert.match(promptJson, /file contents/);
    // The orphan result is dropped — no tool message for it anywhere.
    assert.doesNotMatch(promptJson, /tool-orphan/);
    assert.doesNotMatch(promptJson, /orphan payload/);
  });

  test('signature-only (omitted) thinking is persisted and replays with its signature', async () => {
    // Anthropic omitted/redacted thinking: a signed reasoning block whose text
    // is empty (only a standalone signature-carrier delta, no reasoning-delta
    // with text). The block must still persist + replay so the signature
    // round-trips; gating on thinking text alone would silently drop it.
    const firstChunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      // No text delta — only the signature carrier.
      {
        type: 'reasoning-delta',
        id: 'r1',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-omitted' } },
      },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'omitted-answer' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 1, reasoning: 1 },
        },
      },
    ];
    const firstModel = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: firstChunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const persisted: AssistantMessage[] = [];
    const firstBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (m) => {
        if (m.type === 'assistant') persisted.push(m);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => firstModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    const firstEvents: SessionEvent[] = [];
    for await (const event of firstBackend.send({ turnId: 'turn-prev', text: 'q', context: [] })) {
      firstEvents.push(event);
    }

    // thinking_complete is emitted with empty text but the signature intact.
    const thinkingComplete = firstEvents.find(
      (event): event is Extract<SessionEvent, { type: 'thinking_complete' }> =>
        event.type === 'thinking_complete',
    );
    assert.ok(thinkingComplete, 'signature-only turn must still emit thinking_complete');
    assert.equal(thinkingComplete.text, '');
    assert.equal(thinkingComplete.signature, 'sig-omitted');
    // The persisted AssistantMessage carries the signed (empty-text) thinking.
    assert.equal(persisted.at(-1)?.thinking?.text, '');
    assert.equal(persisted.at(-1)?.thinking?.signature, 'sig-omitted');

    // Replay: pure-reasoning turn → the signed block reaches the next request.
    const ctx = {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-prev',
      turnId: 'turn-prev',
      now: () => 7,
      newId: idGenerator(),
    } as unknown as InvocationContext;
    const memory = createSessionEventMapMemory();
    const runtimeContext = firstEvents.map((event) =>
      mapSessionEventToRuntimeEvent(event, ctx, memory),
    );

    const secondModel = completionModel();
    const secondBackend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => secondModel,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(
      secondBackend.send({
        turnId: 'turn-current',
        text: 'follow up',
        context: [],
        runtimeContext,
      }),
    );

    const prompt = JSON.stringify(compactPrompt(secondModel));
    assert.match(prompt, /"type":"reasoning"/);
    assert.match(prompt, /sig-omitted/);
  });

  test('does not synthesize assistant text when a stream ends without a trailing finish-step', async () => {
    // Drive the backend through a patched one-step adapter whose signed
    // thinking stream ends abruptly without a finish-step / finish event.
    const appended: StoredMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => completionModel(),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    type FakeStreamInput = {
      abortSignal: AbortSignal;
    };
    (
      backend as unknown as {
        modelAdapter: { startStream: (input: FakeStreamInput) => Promise<ModelStreamResult> };
      }
    ).modelAdapter.startStream = async (input: FakeStreamInput) => ({
      // The adapter boundary now exposes Maka-owned `ModelStreamEvent`s, not
      // raw SDK chunks. This fake adapter yields events directly so the test
      // drives the backend through the new contract with no trailing
      // `step-finish` / `finish`.
      events: (async function* () {
        void input.abortSignal;
        yield { kind: 'thinking', text: 'final thoughts' };
        yield { kind: 'thinking-signature', signature: 'sig-last' };
      })(),
      outcome: Promise.resolve({
        kind: 'truncated',
        failure: {
          type: 'model_failure',
          kind: 'provider_unavailable',
          message: 'Provider stream ended without finishing (unknown)',
          retryable: false,
        },
        request: { messages: [] },
        continuation: 'none',
      }),
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const assistants = appended.filter((m): m is AssistantMessage => m.type === 'assistant');
    // Catch-all flush persists the thinking-only step without fabricating text.
    assert.equal(assistants.length, 1);
    const thinkingOnly = assistants.find((m) => m.thinking?.signature === 'sig-last');
    assert.ok(thinkingOnly, 'thinking-only last step must persist');
    assert.equal(thinkingOnly.text, '');
    assert.equal(events.find((event) => event.type === 'complete')?.stopReason, 'error');
    // No duplicate message ids anywhere in the ledger.
    const ids = appended.map((m) => (m as { id: string }).id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ledger ids: ${ids.join(', ')}`);
  });

  test('flushes one AssistantMessage per step, each with its own thinking + signature, and stamps tool_start.stepId', async () => {
    // Two-step tool turn: step 1 reasons + calls a tool; step 2 reasons + answers.
    // Each step must persist its own AssistantMessage with its own signature, and
    // the step-1 tool_start must carry the step-1 assistant id.
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'r1' },
                { type: 'reasoning-delta', id: 'r1', delta: 'think one' },
                {
                  type: 'reasoning-delta',
                  id: 'r1',
                  delta: '',
                  providerMetadata: { anthropic: { signature: 'sig-step-1' } },
                },
                { type: 'reasoning-end', id: 'r1' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'calling the tool' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'a.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'r2' },
                { type: 'reasoning-delta', id: 'r2', delta: 'think two' },
                {
                  type: 'reasoning-delta',
                  id: 'r2',
                  delta: '',
                  providerMetadata: { anthropic: { signature: 'sig-step-2' } },
                },
                { type: 'reasoning-end', id: 'r2' },
                { type: 'text-start', id: 't2' },
                { type: 'text-delta', id: 't2', delta: 'final answer' },
                { type: 'text-end', id: 't2' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });

    const assistants: AssistantMessage[] = [];
    const events: SessionEvent[] = [];
    const durable = durableTurnHarness('turn-1', 'hi');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (m) => {
        if (m.type === 'assistant') assistants.push(m);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send(durable.input())) {
      durable.record(event);
      events.push(event);
    }

    // Two assistant rows with distinct ids and correctly paired signatures.
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0]!.text, 'calling the tool');
    assert.equal(assistants[0]!.thinking?.text, 'think one');
    assert.equal(assistants[0]!.thinking?.signature, 'sig-step-1');
    assert.equal(assistants[1]!.text, 'final answer');
    assert.equal(assistants[1]!.thinking?.text, 'think two');
    assert.equal(assistants[1]!.thinking?.signature, 'sig-step-2');
    assert.notEqual(assistants[0]!.id, assistants[1]!.id);

    // The tool_start of step 1 carries the step-1 assistant id.
    const toolStart = events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start',
    );
    assert.ok(toolStart, 'expected a tool_start event');
    assert.equal(toolStart.stepId, assistants[0]!.id);

    // Each step emits its own thinking_complete/text_complete pointing at its row.
    const textCompletes = events.filter(
      (event): event is Extract<SessionEvent, { type: 'text_complete' }> =>
        event.type === 'text_complete',
    );
    assert.deepEqual(
      textCompletes.map((event) => [event.messageId, event.text]),
      [
        [assistants[0]!.id, 'calling the tool'],
        [assistants[1]!.id, 'final answer'],
      ],
    );
  });

  test('continues a reasoning tool step from Maka durable replay instead of SDK response shape', async () => {
    let baseline: OpenAiResponsesSemanticBaseline | undefined;
    let pending: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'> | undefined;
    const transport = {
      semanticBaseline: () => baseline,
      hasPendingSemantic: () => pending !== undefined,
      recordSemanticRequest: (
        _lane: string,
        value: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'>,
      ) => {
        pending = value;
        baseline = undefined;
      },
      recordSemanticResponse: (_lane: string, responseMessages: readonly ModelMessage[]) => {
        if (!pending) return;
        baseline = { ...pending, responseMessages: structuredClone(responseMessages) };
        pending = undefined;
      },
      clearSemantic: () => {
        baseline = undefined;
        pending = undefined;
      },
      canRecordSemantic: () => true,
      wrapFetch: (fetch: typeof globalThis.fetch) => fetch,
      endLane: () => {},
      close: () => {},
    } as unknown as OpenAiResponsesTransportState;
    let streamCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCalls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          streamCalls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'response-metadata',
                  id: 'resp-1',
                  modelId: 'gpt-5',
                  timestamp: new Date(0),
                },
                { type: 'reasoning-start', id: 'r1' },
                {
                  type: 'reasoning-delta',
                  id: 'r1',
                  delta: 'inspect first',
                  providerMetadata: { openai: { itemId: 'reasoning-1' } },
                },
                {
                  type: 'reasoning-end',
                  id: 'r1',
                  providerMetadata: {
                    openai: {
                      itemId: 'reasoning-1',
                      reasoningEncryptedContent: 'encrypted-reasoning',
                    },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'a.md' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: emptyUsage(),
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'response-metadata',
                  id: 'resp-2',
                  modelId: 'gpt-5',
                  timestamp: new Date(0),
                },
                { type: 'text-start', id: 't2' },
                { type: 'text-delta', id: 't2', delta: 'done' },
                { type: 'text-end', id: 't2' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: emptyUsage(),
                },
              ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const durable = durableTurnHarness('turn-1', 'inspect it');
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: {
        slug: 'openai-main',
        providerType: 'openai',
        defaultModel: 'gpt-5',
      },
      apiKey: 'openai-test-key',
      modelId: 'gpt-5',
      modelFactory: () => model,
      tools: [testTool('Read', z.object({ path: z.string() }))],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      openAiResponsesTransportState: transport,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drainDurably(backend.send(durable.input()), durable);

    assert.equal(model.doStreamCalls.length, 2);
    assert.equal(model.doStreamCalls[1]?.prompt.length, 1);
    assert.equal(model.doStreamCalls[1]?.prompt[0]?.role, 'tool');
    assert.equal(model.doStreamCalls[1]?.providerOptions?.openai?.previousResponseId, 'resp-1');
  });
});

async function runArchiveGatedReplay(input: {
  query: string;
  selectedResult: unknown;
  unselectedResult: unknown;
  selectedPath: string;
  unselectedPath: string;
  selectedAfterUnselected?: boolean;
}): Promise<{
  prompt: string;
  readRuntimeEventIds: string[];
  usage: Extract<SessionEvent, { type: 'token_usage' }> | undefined;
}> {
  const model = completionModel();
  const events: SessionEvent[] = [];
  const archivedBodies = new Map<string, string>();
  const readRuntimeEventIds: string[] = [];
  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: [],
    newId: idGenerator(),
    now: monotonicClock(),
    contextBudget: {
      name: 'archive-retrieval-gated-test',
      maxHistoryTurns: 1,
      minRecentTurns: 0,
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 0,
      },
      archiveRetrieval: {
        enabled: true,
        mode: 'history_search_gated',
        maxResults: 2,
        maxEstimatedTokens: 4096,
        maxBytes: 4096,
      },
      historySearch: {
        enabled: true,
        maxResults: 1,
        around: 1,
        maxEstimatedTokens: 4096,
      },
      charsPerToken: 1,
    },
    toolResultArchive: testToolResultArchive({
      archiveToolResult: async (event) => {
        archivedBodies.set(event.runtimeEventId, event.serializedResult);
        return { artifactId: `artifact-${event.runtimeEventId}` };
      },
      readToolResultArchive: async (event) => {
        readRuntimeEventIds.push(event.runtimeEventId);
        const body = archivedBodies.get(event.runtimeEventId);
        assert.ok(body);
        return event.bodySha256 === sha256(body)
          ? { ok: true, serializedResult: body }
          : { ok: false, reason: 'corrupt' };
      },
    }),
  });
  const selectedEvents = archiveGatedTurnEvents('a', input.selectedPath, input.selectedResult);
  const unselectedEvents = archiveGatedTurnEvents(
    'b',
    input.unselectedPath,
    input.unselectedResult,
  );
  const runtimeContext = [
    ...(input.selectedAfterUnselected ? unselectedEvents : selectedEvents),
    ...(input.selectedAfterUnselected ? selectedEvents : unselectedEvents),
    runtimeTextEvent({
      id: 'rt-new',
      turnId: 'turn-new',
      role: 'user',
      author: 'user',
      text: 'newer retained context',
    }),
  ];

  for await (const event of backend.send({
    turnId: 'turn-current',
    text: input.query,
    context: [],
    runtimeContext,
  })) {
    events.push(event);
  }

  const prompt = JSON.stringify(compactPrompt(model));
  if (typeof prompt !== 'string') assert.fail('model prompt was not captured');
  const usage = events.find(
    (event): event is Extract<SessionEvent, { type: 'token_usage' }> =>
      event.type === 'token_usage',
  );
  return { prompt, readRuntimeEventIds, usage };
}

// The checkpoint write gate validates summary structure (#3029), so stub
// summaries must be shaped like real checkpoints while keeping their
// sentinel text greppable.
function structuredSummary(body: string): string {
  return `## Goal\n${body}\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
}

function archiveGatedTurnEvents(suffix: 'a' | 'b', path: string, result: unknown): RuntimeEvent[] {
  return [
    runtimeEvent({
      id: `rt-call-${suffix}`,
      turnId: `turn-${suffix}`,
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: `tool-${suffix}`, name: 'Read', args: { path } },
    }),
    runtimeEvent({
      id: `rt-result-${suffix}`,
      turnId: `turn-${suffix}`,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: `tool-${suffix}`,
        name: 'Read',
        result,
        isError: false,
      },
    }),
  ];
}

describe('AiSdkBackend steering durability and identity', () => {
  const steeringBackend = (
    model: MockLanguageModelV4,
    options: Partial<Pick<AiSdkBackendInput, 'supportsVision' | 'readAttachmentBytes'>> = {},
  ): AiSdkBackend =>
    createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      ...options,
    });

  const pullOnce = (
    text: string,
  ): (() => Array<{ id: string; messageId: string; content: { text: string } }>) => {
    let pulled = false;
    return () => {
      if (pulled) return [];
      pulled = true;
      return [{ id: `lease-${text}`, messageId: `message-${text}`, content: { text } }];
    };
  };

  const nextSteeringEvent = async (
    iterator: AsyncIterator<SessionEvent>,
  ): Promise<SessionEvent> => {
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, 'stream ended before the steering echo');
      const event = next.value as SessionEvent;
      if (event.type === 'steering_message') return event;
    }
  };

  test('holds the provider request until the steering event is durably consumed', async () => {
    // Persist-before-include: the initial user message is durable before the
    // backend is invoked, and a steered message holds the same line via the
    // seq-ack boundary — the consumer's pull is the ack, and AgentRun persists
    // each event before pulling the next.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const iterator = backend
      .send({
        turnId: 'turn-1',
        text: 'start',
        context: [],
        pullSteering: pullOnce('persist me first'),
      })
      [Symbol.asyncIterator]();

    // The generator suspends at the steering yield: the event is delivered
    // but not yet acked, so the persist boundary has not been crossed.
    await nextSteeringEvent(iterator);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(model.doStreamCalls.length, 0);

    // Resuming consumption acks the steering event; only now may the provider
    // request start, and it carries the steered directive.
    const events: SessionEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      events.push(next.value as SessionEvent);
    }
    assert.equal(model.doStreamCalls.length, 1);
    assert.equal(JSON.stringify(model.doStreamCalls[0]?.prompt).includes('persist me first'), true);
    assert.equal(
      events.some((event) => event.type === 'complete' && event.stopReason === 'end_turn'),
      true,
    );
  });

  test('persists canonical steering content and materializes attachments for the model', async () => {
    const model = textCompletionModel('done');
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const image = {
      kind: 'image' as const,
      name: 'first.png',
      mimeType: 'image/png',
      bytes: pngBytes.length,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath: 'first.png' },
    };
    const document = {
      kind: 'pdf' as const,
      name: 'second.pdf',
      mimeType: 'application/pdf',
      bytes: 12,
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath: 'second.pdf' },
    };
    const backend = steeringBackend(model, {
      supportsVision: true,
      readAttachmentBytes: async (ref) => {
        assert.deepEqual(ref, image.ref);
        return { ok: true, bytes: pngBytes };
      },
    });
    const content = {
      text: 'inspect the authoritative inputs',
      displayText: 'human-only command',
      attachments: [image, document],
    };
    let pulled = false;
    const acked: string[] = [];
    const iterator = backend
      .send({
        turnId: 'turn-1',
        text: 'start',
        context: [],
        pullSteering: () => {
          if (pulled) return [];
          pulled = true;
          return [{ id: 'lease-content', messageId: 'message-content', content }];
        },
        ackSteering: (leaseIds) => acked.push(...leaseIds),
      })
      [Symbol.asyncIterator]();

    const steeringEvent = await nextSteeringEvent(iterator);
    assert.equal(steeringEvent.type, 'steering_message');
    if (steeringEvent.type !== 'steering_message') assert.fail('expected steering event');
    assert.deepEqual(steeringEvent.content, content);
    assert.equal(model.doStreamCalls.length, 0);
    assert.deepEqual(acked, []);
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {}
    assert.deepEqual(acked, ['lease-content']);

    const prompt = compactPrompt(model) as Array<{ role: string; content: unknown }>;
    const parts = prompt.at(-1)?.content as Array<{
      type: string;
      text?: string;
      mediaType?: string;
      data?: unknown;
    }>;
    assert.deepEqual(
      parts.map((part) => part.type),
      ['text', 'file'],
    );
    assert.equal(
      parts[0]?.text,
      buildSteeringEnvelope(
        'inspect the authoritative inputs\n\n<attachment>\nThe attachment content is unavailable to Read.\nname: "first.png"\nmime_type: "image/png"\n</attachment>\n<attachment>\nThe attachment content is unavailable to Read.\nname: "second.pdf"\nmime_type: "application/pdf"\n</attachment>',
      ),
    );
    assert.equal(parts[1]?.mediaType, 'image/png');
    assert.notEqual(parts[1]?.data, undefined);
    assert.equal(JSON.stringify(prompt).includes('human-only command'), false);
  });

  test('a steering message never reaches the provider when the consumer detaches before the ack', async () => {
    // The persist path failed or the turn is being torn down: the consumer
    // walks away without acking the steering event. The dying request must
    // never be sent carrying a directive the ledger does not have, and the
    // lease is nacked so the queue reclaims the message.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const acked: string[] = [];
    const nacked: string[] = [];
    const iterator = backend
      .send({
        turnId: 'turn-1',
        text: 'start',
        context: [],
        pullSteering: pullOnce('abandoned steer'),
        ackSteering: (leaseIds) => acked.push(...leaseIds),
        nackSteering: (leaseIds) => nacked.push(...leaseIds),
      })
      [Symbol.asyncIterator]();

    await nextSteeringEvent(iterator);
    await iterator.return?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(model.doStreamCalls.length, 0);
    assert.deepEqual(acked, []);
    assert.deepEqual(nacked, ['lease-abandoned steer']);
  });

  test('a user prompt that equals the envelope text never cancels a real steer', async () => {
    // Identity, not text: the dedupe key is the structured steering marker,
    // so a user message that happens to BE the envelope text verbatim cannot
    // forge (or absorb) a steering message.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const forged = buildSteeringEnvelope('fake');
    await drain(
      backend.send({
        turnId: 'turn-1',
        text: forged,
        context: [],
        pullSteering: pullOnce('fake'),
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: forged }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('fake') }] },
    ]);
  });

  test('a degraded stored-message projection presents prior steering exactly once, in envelope form', async () => {
    // A blocking replay diagnostic (here: a tool-role text event) degrades the
    // whole ledger to the StoredMessage projection, which cannot carry the
    // RuntimeEvent steering marker. The sidecar (keyed by the projection's
    // stable ids) restores the canonical envelope + structured identity, so
    // the steering appears exactly once and dedupe still works by id.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const steeredEvent = runtimeTextEvent({
      id: 'rt-steer',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'steered earlier',
    });
    (steeredEvent.content as { steering?: true }).steering = true;
    const degradingEvent = runtimeTextEvent({
      id: 'rt-bad',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'boom',
    });
    (degradingEvent as { role: string }).role = 'tool';
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [
          { type: 'user', id: 'rt-u', turnId: 'turn-prev', ts: 1, text: 'original ask' },
          { type: 'user', id: 'rt-steer', turnId: 'turn-prev', ts: 2, text: 'steered earlier' },
          { type: 'assistant', id: 'rt-a', turnId: 'turn-prev', ts: 3, text: 'ok', modelId: 'm' },
        ],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'original ask',
          }),
          steeredEvent,
          degradingEvent,
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'ok',
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original ask' }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('steered earlier') }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);
  });

  test('the degraded-projection sidecar restores steering keyed by providerEventId', async () => {
    // A StoredMessage projection may carry the provider's event id, not the
    // runtime event id, as the message's stable id. The sidecar must match on
    // that key too, or the degraded replay silently loses the steering
    // identity (bare text, no envelope, no dedupe id).
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const steeredEvent = runtimeTextEvent({
      id: 'rt-steer',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'steered earlier',
    });
    (steeredEvent.content as { steering?: true }).steering = true;
    steeredEvent.refs = { providerEventId: 'prov-steer' };
    const degradingEvent = runtimeTextEvent({
      id: 'rt-bad',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'boom',
    });
    (degradingEvent as { role: string }).role = 'tool';
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [
          { type: 'user', id: 'prov-steer', turnId: 'turn-prev', ts: 1, text: 'steered earlier' },
          { type: 'assistant', id: 'prov-a', turnId: 'turn-prev', ts: 2, text: 'ok', modelId: 'm' },
        ],
        runtimeContext: [
          steeredEvent,
          degradingEvent,
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'ok',
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('steered earlier') }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);
  });

  test('the degraded-projection sidecar restores steering keyed by storedMessageId', async () => {
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const steeredEvent = runtimeTextEvent({
      id: 'rt-steer',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'steered earlier',
    });
    (steeredEvent.content as { steering?: true }).steering = true;
    steeredEvent.refs = { storedMessageId: 'sm-steer' };
    const degradingEvent = runtimeTextEvent({
      id: 'rt-bad',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'boom',
    });
    (degradingEvent as { role: string }).role = 'tool';
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [
          { type: 'user', id: 'sm-steer', turnId: 'turn-prev', ts: 1, text: 'steered earlier' },
          { type: 'assistant', id: 'sm-a', turnId: 'turn-prev', ts: 2, text: 'ok', modelId: 'm' },
        ],
        runtimeContext: [
          steeredEvent,
          degradingEvent,
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'ok',
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('steered earlier') }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);
  });

  test('a steer that equals the current prompt still injects its envelope', async () => {
    // Bare text is not an identity: deducting the steer against the verbatim
    // user prompt would drop the directive from the provider request entirely
    // while the ledger still records a steering_message. The envelope is the
    // identity, and it never collides with plain user text.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    await drain(
      backend.send({
        turnId: 'turn-1',
        text: 'repeat this',
        context: [],
        pullSteering: pullOnce('repeat this'),
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'repeat this' }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('repeat this') }] },
    ]);
  });

  test('a steer that equals a historical user message still injects its envelope', async () => {
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'now do something else',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'repeat this',
          }),
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'done before',
          }),
        ],
        pullSteering: pullOnce('repeat this'),
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'repeat this' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done before' }] },
      { role: 'user', content: [{ type: 'text', text: 'now do something else' }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('repeat this') }] },
    ]);
  });

  test('two identical steers inject two envelopes', async () => {
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    let pulled = false;
    await drain(
      backend.send({
        turnId: 'turn-1',
        text: 'start',
        context: [],
        pullSteering: () => {
          if (pulled) return [];
          pulled = true;
          return [
            { id: 'lease-1', messageId: 'message-1', content: { text: 'do it' } },
            { id: 'lease-2', messageId: 'message-2', content: { text: 'do it' } },
          ];
        },
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('do it') }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('do it') }] },
    ]);
  });

  test('a prior-turn steering event replays in its canonical envelope form', async () => {
    // The persisted steering event carries raw text for the UI; every model
    // projection wraps it. A future turn's history must show the model the
    // same form the original request used — one canonical provider projection.
    const model = textCompletionModel('done');
    const backend = steeringBackend(model);
    const steeredEvent = runtimeTextEvent({
      id: 'rt-steer',
      turnId: 'turn-prev',
      role: 'user',
      author: 'user',
      text: 'steered earlier',
    });
    (steeredEvent.content as { steering?: true }).steering = true;
    await drain(
      backend.send({
        turnId: 'turn-current',
        text: 'continue',
        context: [],
        runtimeContext: [
          runtimeTextEvent({
            id: 'rt-u',
            turnId: 'turn-prev',
            role: 'user',
            author: 'user',
            text: 'original ask',
          }),
          steeredEvent,
          runtimeTextEvent({
            id: 'rt-a',
            turnId: 'turn-prev',
            role: 'model',
            author: 'agent',
            text: 'ok',
          }),
        ],
      }),
    );

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'original ask' }] },
      { role: 'user', content: [{ type: 'text', text: buildSteeringEnvelope('steered earlier') }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);
  });

  test('persists provider metadata a canonical event can read back', async () => {
    // The failure this pins is not in the sanitiser, it is at this seam.
    //
    // A field the response did not carry arrives as an explicit `undefined` —
    // Anthropic sends `{ type: 'direct', toolId: undefined }` when there is no
    // tool id. JSON drops such a property, so the persisted event no longer
    // reads back as it was written and `encodeCanonicalRuntimeEvent` refuses
    // it. That refusal marked the runtime event store unavailable and the
    // turn's terminal write then threw, so every turn that called any tool
    // died about a tenth of a second after the tool returned.
    //
    // Asserting on the sanitiser alone cannot catch a regression here: the
    // sanitiser is a pure function and could not have produced the bug. This
    // streams the shape a real provider sends and encodes what was persisted.
    const anchor = runtimeTextEvent({
      id: 'runtime-user',
      turnId: 'turn-1',
      role: 'user',
      author: 'user',
      text: 'call the tool',
    });
    const ledger: RuntimeEvent[] = [anchor];
    const mappingMemory = createSessionEventMapMemory();
    const mappingContext: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'call the tool',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'ok.md' }),
                  providerMetadata: {
                    anthropic: { caller: { type: 'direct', toolId: undefined } },
                  },
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: emptyUsage(),
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'Done.' },
                { type: 'text-end', id: 'text-1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'end_turn' },
                  usage: emptyUsage(),
                },
              ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Read',
          description: 'read',
          parameters: z.object({ path: z.string() }),
          impl: async () => ({ body: 'ok' }),
        },
      ],
      loadTurnRuntimeEvents: async () => ledger,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({
      turnId: 'turn-1',
      text: 'call the tool',
      context: [],
      headAnchorRuntimeEvent: anchor,
    })) {
      const mapped = mapSessionEventToRuntimeEvent(event, mappingContext, mappingMemory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    }

    // Every persisted event has to survive the encoder, because one that does
    // not takes the store — and the turn — with it.
    for (const event of ledger) {
      assert.doesNotThrow(
        () => encodeCanonicalRuntimeEvent(event),
        `a persisted ${event.content?.kind} event must read back as it was written`,
      );
    }
  });

  test('rebuilds reasoning metadata rather than persisting what the provider sent', async () => {
    // The tool-call seam above carries `providerOptions` from the stream into
    // the persisted event, so an omitted provider field arrives as an explicit
    // `undefined` and the canonical encoder refuses the write. Reasoning looks
    // like the same seam and is not: `translateChunk` rebuilds the reasoning
    // metadata from two named string fields, so nothing the provider sends
    // reaches the event verbatim and no `undefined` can ride along.
    //
    // This pins that, because it is the only reason the reasoning path needs
    // no sanitiser. If reasoning metadata is ever passed through instead, this
    // test fails and says so.
    const anchor = runtimeTextEvent({
      id: 'runtime-user',
      turnId: 'turn-1',
      role: 'user',
      author: 'user',
      text: 'think about it',
    });
    const ledger: RuntimeEvent[] = [anchor];
    const mappingMemory = createSessionEventMapMemory();
    const mappingContext: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'think about it',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'reasoning-1' },
            {
              type: 'reasoning-delta',
              id: 'reasoning-1',
              delta: 'weighing it up',
              providerMetadata: {
                openai: { itemId: 'item-1', reasoningEncryptedContent: undefined },
              },
            },
            { type: 'reasoning-end', id: 'reasoning-1' },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Done.' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: emptyUsage(),
            },
          ] satisfies LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      loadTurnRuntimeEvents: async () => ledger,
      newId: idGenerator(),
      now: monotonicClock(),
    });

    for await (const event of backend.send({
      turnId: 'turn-1',
      text: 'think about it',
      context: [],
      headAnchorRuntimeEvent: anchor,
    })) {
      const mapped = mapSessionEventToRuntimeEvent(event, mappingContext, mappingMemory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    }

    const thinking = ledger.find((event) => event.content?.kind === 'thinking');
    assert.ok(thinking, 'the reasoning part has to reach the ledger for this to pin anything');
    assert.deepEqual(
      thinking.content?.kind === 'thinking' ? thinking.content.providerOptions : undefined,
      { openai: { itemId: 'item-1' } },
      'the omitted field was not carried, because the metadata was rebuilt',
    );
    for (const event of ledger) {
      assert.doesNotThrow(
        () => encodeCanonicalRuntimeEvent(event),
        `a persisted ${event.content?.kind} event must read back as it was written`,
      );
    }
  });

  test('merges citation metadata across multiple provider text items', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'One' },
            {
              type: 'text-end',
              id: 'text-1',
              providerMetadata: {
                openai: {
                  itemId: 'message-1',
                  annotations: [{ type: 'url_citation', start_index: 0, end_index: 3 }],
                },
              },
            },
            { type: 'text-start', id: 'text-2' },
            { type: 'text-delta', id: 'text-2', delta: 'Two' },
            {
              type: 'text-end',
              id: 'text-2',
              providerMetadata: {
                openai: {
                  itemId: 'message-2',
                  annotations: [{ type: 'url_citation', start_index: 0, end_index: 3 }],
                },
              },
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: emptyUsage(),
            },
          ] as LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const appended: StoredMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({ turnId: 'turn-1', text: 'cite twice', context: [] }));

    const assistant = appended.find(
      (message): message is AssistantMessage => message.type === 'assistant',
    );
    assert.equal(assistant?.text, 'OneTwo');
    assert.deepEqual(assistant?.providerOptions, {
      openai: {
        annotations: [
          { type: 'url_citation', start_index: 0, end_index: 3 },
          { type: 'url_citation', start_index: 3, end_index: 6 },
        ],
      },
    });
  });

  test('executes native WebSearch inside the primary provider stream', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'search-1',
              toolName: 'WebSearch',
              input: '{}',
              providerExecuted: true,
            },
            {
              type: 'tool-result',
              toolCallId: 'search-1',
              toolName: 'WebSearch',
              result: {
                action: { type: 'search', queries: ['latest Maka'] },
                sources: [{ type: 'url', url: 'https://maka.example/' }],
              },
              providerExecuted: true,
            },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Maka is current.' },
            {
              type: 'text-end',
              id: 'text-1',
              providerMetadata: {
                openai: {
                  itemId: 'message-1',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://maka.example/',
                      title: 'Maka',
                      startIndex: 0,
                      endIndex: 4,
                    },
                  ],
                },
              },
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: emptyUsage(),
            },
          ] as LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const appended: StoredMessage[] = [];
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        appended.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [buildNativeWebSearchTool()],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];

    await collectEvents(backend.send({ turnId: 'turn-1', text: 'search', context: [] }), events);

    assert.equal(
      model.doStreamCalls[0]?.tools?.some(
        (tool) => tool.type === 'provider' && tool.id === 'openai.web_search',
      ),
      true,
    );
    const start = events.find((event) => event.type === 'tool_start');
    assert.equal(start?.type === 'tool_start' ? start.providerExecuted : undefined, true);
    const result = events.find((event) => event.type === 'tool_result');
    assert.equal(result?.type === 'tool_result' ? result.providerExecuted : undefined, true);
    assert.deepEqual(result?.type === 'tool_result' ? result.content : undefined, {
      kind: 'web_search',
      provider: 'model',
      query: 'latest Maka',
      rows: [
        {
          title: 'maka.example',
          url: 'https://maka.example/',
          snippet: '',
          source: 'maka.example',
        },
      ],
    });
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    const assistant = appended.find(
      (message): message is AssistantMessage => message.type === 'assistant',
    );
    assert.deepEqual(assistant?.providerOptions, {
      openai: {
        itemId: 'message-1',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://maka.example/',
            title: 'Maka',
            startIndex: 0,
            endIndex: 4,
          },
        ],
      },
    });
    const mappingMemory = createSessionEventMapMemory();
    const anchor = runtimeTextEvent({
      id: 'native-search-user',
      turnId: 'turn-1',
      role: 'user',
      author: 'user',
      text: 'search',
    });
    const mappingContext: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'invocation-search',
      runId: 'run-search',
      turnId: 'turn-1',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'search',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    for (const event of events) {
      const mapped = mapSessionEventToRuntimeEvent(event, mappingContext, mappingMemory);
      if (mapped.partial !== true && mapped.content) {
        assert.doesNotThrow(() => encodeCanonicalRuntimeEvent(mapped));
      }
    }
  });

  test('projects CC-format Anthropic web search without exposing encrypted content', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'search-cc-1',
              toolName: 'WebSearch',
              input: JSON.stringify({ query: 'latest Maka' }),
              providerExecuted: true,
            },
            {
              type: 'tool-result',
              toolCallId: 'search-cc-1',
              toolName: 'WebSearch',
              result: [
                {
                  type: 'web_search_result',
                  url: 'https://maka.example/',
                  title: 'Maka',
                  pageAge: '2026-08-04',
                  encryptedContent: 'encrypted-result',
                },
              ],
              providerExecuted: true,
            },
            { type: 'text-start', id: 'text-cc-1' },
            { type: 'text-delta', id: 'text-cc-1', delta: 'Maka is current.' },
            { type: 'text-end', id: 'text-cc-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: emptyUsage(),
            },
          ] as LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [buildNativeWebSearchTool({ adapter: 'anthropic-messages' })],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const events: SessionEvent[] = [];

    await collectEvents(backend.send({ turnId: 'turn-1', text: 'search', context: [] }), events);

    assert.equal(
      model.doStreamCalls[0]?.tools?.some(
        (tool) => tool.type === 'provider' && tool.id === 'anthropic.web_search_20250305',
      ),
      true,
    );
    const result = events.find((event) => event.type === 'tool_result');
    const start = events.find((event) => event.type === 'tool_start');
    assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, {
      query: 'latest Maka',
    });
    assert.deepEqual(result?.type === 'tool_result' ? result.content : undefined, {
      kind: 'web_search',
      provider: 'model',
      query: 'latest Maka',
      rows: [
        {
          title: 'Maka',
          url: 'https://maka.example/',
          snippet: '2026-08-04',
          source: 'maka.example',
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(result?.type === 'tool_result' ? result.content : null),
      /encrypted-result/,
    );
  });
});

function textCompletionModel(text: string): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: 1,
          reasoning: 0,
        },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}

function completionModel(): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: 1,
          reasoning: 0,
        },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}

function emptyUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function imageReplayBackend(
  model: MockLanguageModelV4,
  options: { supportsVision: boolean; readAttachmentBytes: AttachmentByteReader },
): AiSdkBackend {
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: [],
    newId: idGenerator(),
    now: monotonicClock(),
    ...options,
  });
}

function imageReplayInput(): BackendSendInput {
  return {
    turnId: 'turn-current',
    text: 'continue',
    context: [],
    runtimeContext: [
      runtimeTextEvent({
        id: 'rt-u',
        turnId: 'turn-prev',
        role: 'user',
        author: 'user',
        text: 'read it',
      }),
      runtimeEvent({
        id: 'rt-call',
        turnId: 'turn-prev',
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'chart.png' } },
      }),
      runtimeEvent({
        id: 'rt-result',
        turnId: 'turn-prev',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          isError: false,
          result: {
            kind: 'image',
            mimeType: 'image/png',
            ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
          },
        },
      }),
    ],
  };
}

function countingToolLoopModel(toolCallsBeforeStop?: number): {
  model: MockLanguageModelV4;
  callCount: () => number;
} {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      const shouldStop = toolCallsBeforeStop !== undefined && calls > toolCallsBeforeStop;
      const chunks: LanguageModelV4StreamPart[] = shouldStop
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-final' },
            { type: 'text-delta', id: 'text-final', delta: 'done' },
            { type: 'text-end', id: 'text-final' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `tool-${calls}`,
              toolName: 'Read',
              input: JSON.stringify({ path: `notes-${calls}.md` }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  return { model, callCount: () => calls };
}

function runtimeTextEvent(input: {
  id: string;
  turnId: string;
  role: 'user' | 'model';
  author: 'user' | 'agent';
  text: string;
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    content: { kind: 'text', text: input.text },
  };
}

function runtimeEvent(input: {
  id: string;
  turnId: string;
  role: RuntimeEvent['role'];
  author: RuntimeEvent['author'];
  content?: RuntimeEvent['content'];
  status?: RuntimeEvent['status'];
  actions?: RuntimeEvent['actions'];
  refs?: RuntimeEvent['refs'];
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    ...(input.content ? { content: input.content } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    ...(input.refs ? { refs: input.refs } : {}),
  };
}

function synthesisBlock(input: {
  queryKey: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}): SynthesisCacheBlock {
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: `synth-${input.queryKey}`,
    sessionId: 'session-1',
    createdAt: 2,
    highWaterName: `after-gated-${input.queryKey}`,
    highWaterSeq: 1,
    coverage: {
      queryKeys: [input.queryKey],
      turnIds: [input.turnId],
      runtimeEventIds: [input.runtimeEventId],
      toolNames: ['Read'],
      toolCallIds: [input.toolCallId],
      artifactIds: [input.artifactId],
      bodySha256: [input.bodySha256],
    },
    summary: 'SYNTHESIS_SENTINEL_KEY_ALPHA',
    limitations: ['Does not include raw tool output.'],
    sourceRefs: [
      {
        kind: 'archived_tool_result',
        sessionId: 'session-1',
        turnId: input.turnId,
        runtimeEventId: input.runtimeEventId,
        toolCallId: input.toolCallId,
        toolName: 'Read',
        artifactId: input.artifactId,
        bodySha256: input.bodySha256,
        originalEstimatedTokens: input.originalEstimatedTokens,
        originalBytes: input.originalBytes,
        placeholderReason: 'stale_tool_result_pruned_before_compact',
      },
    ],
    createdFrom: 'gated_archive_retrieval',
  };
}

function compactPrompt(model: MockLanguageModelV4): unknown {
  return model.doStreamCalls[0]?.prompt.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function modelCallSettings(model: MockLanguageModelV4): unknown {
  const call = model.doStreamCalls[0] as unknown as Record<string, unknown> | undefined;
  if (!call) return {};
  const { prompt: _prompt, ...rest } = call;
  return rest;
}

function modelToolNames(model: MockLanguageModelV4): string[] {
  return sortedModelToolNames(Object.keys(modelTools(model)));
}

function modelTools(model: MockLanguageModelV4): Record<string, unknown> {
  const call = model.doStreamCalls[0] as unknown as Record<string, unknown> | undefined;
  const tools = call?.tools;
  if (!tools) return {};
  if (Array.isArray(tools)) {
    const out: Record<string, unknown> = {};
    for (const tool of tools) {
      if (tool && typeof tool === 'object') {
        const record = tool as Record<string, unknown>;
        const name =
          typeof record.name === 'string'
            ? record.name
            : typeof record.toolName === 'string'
              ? record.toolName
              : undefined;
        if (name) out[name] = tool;
      }
    }
    return out;
  }
  if (typeof tools === 'object') return tools as Record<string, unknown>;
  return {};
}

function sortedModelToolNames(toolNames: readonly string[]): string[] {
  return [...toolNames].sort((a, b) => {
    if (a === INVALID_TOOL_NAME) return 1;
    if (b === INVALID_TOOL_NAME) return -1;
    return a.localeCompare(b);
  });
}

function toolSchemaPromptSegment(
  carrier: { promptSegments?: readonly { kind: string; toolCount?: number }[] } | undefined,
): { toolCount?: number } | undefined {
  return carrier?.promptSegments?.find((segment) => segment.kind === 'tool_schema');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function testTool(name: string, parameters: unknown): MakaTool {
  return {
    name,
    description: `${name} description`,
    parameters,
    impl: async () => ({ ok: true }),
  };
}

function nativeApplyPatchTool(): MakaTool {
  return {
    name: 'apply_patch',
    description: 'Apply one patch operation',
    parameters: z.object({}),
    providerTool: { kind: 'openai-apply-patch' },
    impl: async () => ({ status: 'completed' }),
  };
}

async function collectEvents(
  iterable: AsyncIterable<SessionEvent>,
  events: SessionEvent[],
  record?: (event: SessionEvent) => void,
): Promise<void> {
  for await (const event of iterable) {
    record?.(event);
    events.push(event);
  }
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

function durableTurnHarness(
  turnId: string,
  text: string,
  identity: { runId?: string; invocationId?: string } = {},
) {
  const runId = identity.runId ?? 'run-1';
  const invocationId = identity.invocationId ?? 'invocation-1';
  const anchor: RuntimeEvent = {
    id: `runtime-user-${turnId}`,
    invocationId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const ledger: RuntimeEvent[] = [anchor];
  const memory = createSessionEventMapMemory();
  const ctx: InvocationContext = {
    sessionId: 'session-1',
    invocationId,
    runId,
    turnId,
    source: 'desktop',
    startedAt: 1,
    request: {
      sessionId: 'session-1',
      turnId,
      text,
      source: 'desktop',
      initialRuntimeEvent: anchor,
    },
    newId: idGenerator(),
    now: monotonicClock(),
  };
  return {
    anchor,
    ledger,
    loadTurnRuntimeEvents: async (requestedTurnId: string) =>
      ledger.filter((event) => event.turnId === requestedTurnId),
    input: (overrides: Partial<BackendSendInput> = {}): BackendSendInput => ({
      turnId,
      text,
      context: [],
      headAnchorRuntimeEvent: anchor,
      ...overrides,
    }),
    record: (event: SessionEvent): void => {
      const mapped = mapSessionEventToRuntimeEvent(event, ctx, memory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    },
  };
}

async function drainDurably(
  iterable: AsyncIterable<SessionEvent>,
  durable: ReturnType<typeof durableTurnHarness>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    durable.record(event);
    events.push(event);
  }
  return events;
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function manualWatchdogTimer(): {
  clock: NonNullable<AiSdkBackendInput['streamWatchdogTimer']>;
  fire: () => void;
  armCount: () => number;
} {
  let pending: { readonly token: object; readonly callback: () => void } | undefined;
  let armCount = 0;
  return {
    clock: {
      setTimer: (callback) => {
        armCount += 1;
        const token = {};
        pending = { token, callback };
        return token;
      },
      clearTimer: (token) => {
        if (pending?.token === token) pending = undefined;
      },
    },
    fire: () => {
      assert.ok(pending, 'watchdog timer must be armed');
      const callback = pending.callback;
      pending = undefined;
      callback();
    },
    armCount: () => armCount,
  };
}

function hangingProviderStream(
  chunks: readonly LanguageModelV4StreamPart[],
  signal: AbortSignal | undefined,
  abortMode: 'error' | 'close' = 'error',
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      const abort = () => {
        if (abortMode === 'close') controller.close();
        else controller.error(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
  });
}

function header(permissionMode: SessionHeader['permissionMode'] = 'ask'): SessionHeader {
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
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode,
    schemaVersion: 1,
  };
}

function sandboxSnapshot(): SandboxDiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    platform: 'darwin',
    profile: {
      name: 'workspace-write',
      type: 'managed',
      fileSystem: 'workspace-write',
      network: 'restricted',
      cwd: '/tmp/maka',
      workspaceRoots: ['/tmp/maka'],
      protectedMetadata: ['.git', '.agents', '.codex'],
    },
    capabilities: {
      command: {
        status: 'available',
        backend: 'macos-seatbelt',
        selectionReason: 'platform_sandbox_selected',
      },
      filesystem: {
        status: 'available',
        backend: 'macos-seatbelt',
        selectionReason: 'platform_sandbox_selected',
      },
    },
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not met before timeout');
}

/**
 * The execution scope for one turn, opened the same way `send()` opens it.
 * Tests that drive ToolRuntime directly (without a provider stream) use this so
 * they exercise the real per-turn wiring instead of a backend-wide singleton.
 */
interface TestTurnScope {
  turnId: string;
  abortController: AbortController;
  toolRuntime: ToolRuntime;
  watchdog: { pause(): void; resume(): void } | null;
  runTrace: RunTrace | null;
}

function backendInternals(backend: AiSdkBackend): {
  activeTurns: Set<TestTurnScope>;
  openTurnScope(input: { turnId: string; text: string; context: [] }): TestTurnScope;
} {
  return backend as unknown as {
    activeTurns: Set<TestTurnScope>;
    openTurnScope(input: { turnId: string; text: string; context: [] }): TestTurnScope;
  };
}

/** The live scope for a turn, opening one when the test drives a turn directly. */
function turnScope(backend: AiSdkBackend, turnId: string): TestTurnScope {
  const internals = backendInternals(backend);
  for (const scope of internals.activeTurns) if (scope.turnId === turnId) return scope;
  return internals.openTurnScope({ turnId, text: '', context: [] });
}

function runtimeExecute(
  backend: AiSdkBackend,
  tool: MakaTool,
  turnId: string,
  eventSink: { push(event: SessionEvent): void },
) {
  const runtime = turnScope(backend, turnId).toolRuntime;
  const durableEventSink: DurableSessionEventSink = {
    push: (event) => eventSink.push(event),
    pushAndWaitUntilConsumed: async (event) => eventSink.push(event),
  };
  return async (
    input: unknown,
    context: { toolCallId: string; abortSignal: AbortSignal },
  ): Promise<unknown> =>
    (
      await runtime.settleToolCall({
        tool,
        turnId,
        toolCallId: context.toolCallId,
        input,
        abortSignal: context.abortSignal,
        eventSink: durableEventSink,
      })
    ).result;
}
