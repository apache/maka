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

import { nextId } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeToolStepProgress, type SessionEvent } from '@maka/core/events';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import type { MakaTool } from '../tool-runtime.js';

test('ToolRuntime emits only valid progress through the shared codec', async () => {
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: testHeader(),
    connection: testConnection(),
    modelId: 'test-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const tool: MakaTool = {
    name: 'ProgressTool',
    description: 'Report bounded progress',
    parameters: {},
    impl: async (_args, context) => {
      context.emitProgress?.(0, 2);
      context.emitProgress?.(1, 2);
      context.emitProgress?.(3, 2);
      return { ok: true };
    },
  };

  await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: {},
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  const progress = events.flatMap((event) =>
    event.type === 'tool_progress' ? [decodeToolStepProgress(event.chunk)] : [],
  );
  assert.deepEqual(progress, [
    { current: 0, total: 2 },
    { current: 1, total: 2 },
  ]);
});

function testHeader(): SessionHeader {
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
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'anthropic',
    defaultModel: 'test-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
