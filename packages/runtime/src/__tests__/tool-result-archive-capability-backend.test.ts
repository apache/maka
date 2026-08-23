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
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';

import type { SessionHeader } from '@maka/core/session';

import type { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
} from '../tool-result-archive-capability.js';
import { buildToolResultArchiveResourceRef } from '../tool-result-archive-resource.js';
import { ARCHIVED_TOOL_RESULT_REWRITE_VERSION } from '../tool-result-archive.js';
import type { MakaToolContext } from '../tool-runtime.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

// The pruned tool-result placeholder is a runtime-generated protocol value that
// names `ArchiveRead` as the way back to the content. These tests observe the
// tool surface the provider actually receives, not an internal array: the
// defects in #2025 and on the child-agent path were both "the model was told to
// call a tool that was never advertised to it".

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

describe('AiSdkBackend tool-result archive capability', () => {
  test('advertises ArchiveRead when the session archives tool results', async () => {
    const capturedTools: string[][] = [];
    const model = capturingModel(capturedTools);

    await drain(
      backendWith(model, capability()).send({
        turnId: 'turn-1',
        text: 'hello',
        context: [],
      }),
    );

    assert.ok(
      capturedTools[0]?.includes('ArchiveRead'),
      'a session that archives tool results must advertise the tool its placeholders name',
    );
  });

  test('advertises no ArchiveRead when the session archives nothing', async () => {
    const capturedTools: string[][] = [];
    const model = capturingModel(capturedTools);

    await drain(
      backendWith(model, undefined).send({
        turnId: 'turn-1',
        text: 'hello',
        context: [],
      }),
    );

    assert.ok(capturedTools.length > 0, 'expected the model to be called');
    assert.ok(
      !capturedTools[0]?.includes('ArchiveRead'),
      'a session that never archives has nothing to decode, so the CLI stays free of the tool',
    );
  });

  test('the decoder reads back what the writer archived', async () => {
    // Indivisibility is about one authority, not two co-present fields: the
    // tool the model is told to call must reach the storage the writer used.
    const store = new Map<string, string>();
    const archive = createToolResultArchiveCapability({
      archiveToolResult: async (event) => {
        store.set(event.bodySha256, event.serializedResult);
        return { artifactId: `artifact-${event.bodySha256.slice(0, 8)}` };
      },
      readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
      readArchivedToolResultResource: async (input) => {
        const serializedResult = store.get(input.bodySha256);
        return serializedResult === undefined
          ? { ok: false, reason: 'not_found' }
          : { ok: true, serializedResult };
      },
    });

    const serializedResult = JSON.stringify({ kind: 'text', text: 'the pruned body' });
    const bodySha256 = 'a'.repeat(64);
    const written = await archive.services.archiveToolResult({
      sessionId: 'session-1',
      runtimeEventId: 'event-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'Bash',
      result: undefined,
      serializedResult,
      bodySha256,
      originalEstimatedTokens: 1_000,
      originalBytes: Buffer.byteLength(serializedResult),
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      reason: 'active_current_turn_tool_result_pruned_before_next_step',
    });
    assert.ok(written, 'the writer must report where it archived the body');

    const page = (await archive.archiveReadTool.impl(
      {
        ref: buildToolResultArchiveResourceRef({
          artifactId: written.artifactId,
          bodySha256,
          originalBytes: Buffer.byteLength(serializedResult),
        }),
        operation: 'read',
      },
      toolContext(),
    )) as { ok: boolean; content: string };

    assert.equal(page.ok, true, 'the ref the placeholder carries must resolve');
    assert.equal(page.content, serializedResult);
    // Kept from the built-in tool contract this replaced: the decoder is a read,
    // which is what lets it travel to a read-only child.
    assert.equal(archive.archiveReadTool.activityKind, 'read');
  });

  test('the decoder reads as the invoking session', async () => {
    // A ref carries no session identity, so the session boundary is only as
    // strong as the id the tool passes down from its own invocation context.
    const seen: { sessionId: string }[] = [];
    const archive = createToolResultArchiveCapability({
      archiveToolResult: async () => ({ artifactId: 'artifact-1' }),
      readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
      readArchivedToolResultResource: async (input) => {
        seen.push({ sessionId: input.sessionId });
        return { ok: true, serializedResult: JSON.stringify({ kind: 'agent_swarm', items: [] }) };
      },
    });

    await archive.archiveReadTool.impl(
      {
        ref: buildToolResultArchiveResourceRef({
          artifactId: `tool-result-archive-${'a'.repeat(32)}`,
          bodySha256: 'b'.repeat(64),
          originalBytes: 128,
        }),
        operation: 'inspect',
      },
      { ...toolContext(), sessionId: 'session-invoking' },
    );

    assert.equal(seen[0]?.sessionId, 'session-invoking');
  });

  test('the decoder ignores itemId outside query instead of refusing the call', async () => {
    const archive = createToolResultArchiveCapability({
      archiveToolResult: async () => ({ artifactId: 'artifact-1' }),
      readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
      readArchivedToolResultResource: async () => ({
        ok: true,
        serializedResult: JSON.stringify({ presets: [{ id: 'fast-reader' }] }),
      }),
    });
    const parameters = archive.archiveReadTool.parameters as {
      validate(
        input: unknown,
      ): Promise<{ success: true; value: unknown } | { success: false; error: unknown }>;
    };
    const parsed = await parameters.validate({
      ref: buildToolResultArchiveResourceRef({
        artifactId: `tool-result-archive-${'a'.repeat(32)}`,
        bodySha256: 'b'.repeat(64),
        originalBytes: 128,
      }),
      operation: 'inspect',
      itemId: { malformed: true },
      offset: 'not-a-number',
      limit: -1,
      ignored: true,
    });

    assert.equal(parsed.success, true);

    const missingQueryItem = await parameters.validate({
      ref: buildToolResultArchiveResourceRef({
        artifactId: `tool-result-archive-${'a'.repeat(32)}`,
        bodySha256: 'b'.repeat(64),
        originalBytes: 128,
      }),
      operation: 'query',
      ignored: true,
    });
    assert.equal(missingQueryItem.success, false, 'required branch fields still fail closed');
  });
});

function toolContext(): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp/maka',
    toolCallId: 'call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function capability(): ToolResultArchiveCapability {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => ({ artifactId: 'artifact-1' }),
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
  });
}

function backendWith(
  model: MockLanguageModelV4,
  toolResultArchive: ToolResultArchiveCapability | undefined,
): AiSdkBackend {
  let n = 0;
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    // The host binds no tools at all: whether the decoder reaches the model is
    // not a host wiring question.
    tools: [],
    ...(toolResultArchive ? { toolResultArchive } : {}),
    newId: () => `id-${++n}`,
    now: () => 1,
  });
}

function capturingModel(capturedTools: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      capturedTools.push((stepTools ?? []).map((tool) => tool.name));
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
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    void _;
  }
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
