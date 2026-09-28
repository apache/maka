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
  bindToolResultArchiveDecoder,
  type ToolResultArchiveCapability,
} from '../tool-result-archive-capability.js';
import type { MakaToolContext } from '../tool-runtime.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

describe('AiSdkBackend tool-result archive capability', () => {
  test('advertises Read when the session archives tool results', async () => {
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
      capturedTools[0]?.includes('Read'),
      'a session that archives tool results must advertise the tool its placeholders name',
    );
  });

  test('advertises no Read when the session archives nothing', async () => {
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
      !capturedTools[0]?.includes('Read'),
      'a session that never archives has nothing to decode, so the CLI stays free of the tool',
    );
  });

  test('resource-only Read preserves Session scope and grants no file access', async () => {
    const seen: string[] = [];
    const archive = createToolResultArchiveCapability({
      archiveToolResult: async () => ({ ledger: true }),
      readArchivedToolResultResource: async (input) => {
        seen.push(input.sessionId);
        return { ok: true, serializedResult: JSON.stringify({ content: 'first\nsecond' }) };
      },
    });
    const read = bindToolResultArchiveDecoder([], archive)[0]!;
    const page = await read.impl(
      { path: 'maka://runtime/tool-results/event-1', offset: 1, limit: 1 },
      toolContext(),
    );
    assert.equal((page as { content: string }).content, 'second');
    assert.deepEqual(seen, ['session-1']);
    await assert.rejects(
      async () => read.impl({ path: '/etc/passwd' }, toolContext()),
      /File access is not available/,
    );
    assert.equal(
      bindToolResultArchiveDecoder([read], archive).filter((tool) => tool.name === 'Read').length,
      1,
    );
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
