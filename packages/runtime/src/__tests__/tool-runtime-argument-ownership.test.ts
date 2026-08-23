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

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';

import type { SessionHeader } from '@maka/core/session';

import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

interface InvocationArgs {
  path: string;
  content: string;
  layout: {
    cols: number;
  };
}

describe('ToolRuntime argument ownership', () => {
  test('keeps each runtime owner isolated from the canonical invocation', async () => {
    const initialArgs: InvocationArgs = {
      path: 'notes.md',
      content: 'approved',
      layout: { cols: 120 },
    };
    const providerArgs = structuredClone(initialArgs);
    const observed = new Map<string, InvocationArgs>();
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: testHeader(),
      connection: testConnection(),
      modelId: 'test-model',
      appendMessage: async (message) => {
        if (message.type !== 'tool_call') return;
        observeAndMutate(observed, 'storage', message.args);
      },
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      recordToolArtifacts: (input) => {
        observeAndMutate(observed, 'artifact', input.args);
      },
    });
    const tool: MakaTool<InvocationArgs> = {
      name: 'Write',
      description: 'Write a file',
      parameters: {},
      impl: async (args) => {
        observeAndMutate(observed, 'implementation', args);
        return { ok: true, path: '/tmp/maka/notes.md' };
      },
    };
    await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input: providerArgs,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => {
          if (event.type === 'tool_start') {
            observeAndMutate(observed, 'event', event.args);
          }
        },
        pushAndWaitUntilConsumed: async (event) => {
          if (event.type === 'tool_start') {
            observeAndMutate(observed, 'event', event.args);
          }
        },
      },
    });
    mutateArgs(providerArgs, 'provider');

    const owners = ['storage', 'event', 'implementation', 'artifact'];
    for (const owner of owners) {
      assert.deepEqual(observed.get(owner), initialArgs);
    }
    assert.equal(providerArgs.content, 'provider');
  });
});

function observeAndMutate(
  observed: Map<string, InvocationArgs>,
  owner: string,
  value: unknown,
): void {
  observed.set(owner, structuredClone(value) as InvocationArgs);
  mutateArgs(value, owner);
}

function mutateArgs(value: unknown, owner: string): void {
  const mutable = value as InvocationArgs;
  mutable.content = owner;
  mutable.layout.cols = owner.length;
}

function testHeader(): SessionHeader {
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

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}
