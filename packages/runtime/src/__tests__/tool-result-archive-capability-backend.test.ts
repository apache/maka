import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';

import type { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
} from '../tool-result-archive-capability.js';
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
});

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
