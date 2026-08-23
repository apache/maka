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
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';

import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import { ToolRuntime } from '../tool-runtime.js';

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

describe('AskUserQuestion runtime round trip', () => {
  test('parks the tool, emits one request, and persists one nullable JSON result', async () => {
    const appended: StoredMessage[] = [];
    const events: SessionEvent[] = [];
    let id = 0;
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'c' } as never,
      modelId: 'm',
      appendMessage: async (message) => {
        appended.push(message);
      },
      newId: () => `id-${++id}`,
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const resultPromise = runtime
      .settleToolCall({
        tool: buildAskUserQuestionTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        input: {
          questions: [
            {
              question: 'Choose an approach',
              options: [
                { label: 'Extend', description: 'Reuse the runtime seam' },
                { label: 'Separate' },
              ],
            },
            {
              question: 'Keep the default?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => events.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      })
      .then((settlement) => settlement.result);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = events.find((event) => event.type === 'user_question_request');
    assert.ok(request);
    assert.equal(request.toolUseId, 'tool-1');
    assert.equal(runtime.pendingUserQuestionCount(), 1);

    assert.equal(
      runtime.respondToUserQuestion({
        requestId: request.requestId,
        answers: ['Extend', null],
      }),
      true,
    );

    assert.deepEqual(await resultPromise, {
      answers: [
        { question: 'Choose an approach', answer: 'Extend' },
        { question: 'Keep the default?', answer: null },
      ],
    });
    const results = appended.filter((message) => message.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.content, {
      kind: 'json',
      value: {
        answers: [
          { question: 'Choose an approach', answer: 'Extend' },
          { question: 'Keep the default?', answer: null },
        ],
      },
    });
  });

  test('turn abort rejects the parked tool and ignores a late response', async () => {
    const events: SessionEvent[] = [];
    let id = 0;
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'c' } as never,
      modelId: 'm',
      appendMessage: async () => {},
      newId: () => `id-${++id}`,
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const resultPromise = runtime
      .settleToolCall({
        tool: buildAskUserQuestionTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        input: {
          questions: [
            {
              question: 'Continue?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => events.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      })
      .then((settlement) => settlement.result);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = events.find((event) => event.type === 'user_question_request');
    assert.ok(request);

    runtime.endTurn('aborted');

    assert.deepEqual(await resultPromise, {
      error: `Turn turn-1 aborted before user question ${request.requestId} was answered`,
    });
    assert.equal(
      runtime.respondToUserQuestion({
        requestId: request.requestId,
        answers: ['Yes'],
      }),
      false,
    );
  });

  test('cell abort releases a parked question without waiting for turn teardown', async () => {
    const events: SessionEvent[] = [];
    let id = 0;
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: { providerType: 'openai', slug: 'c' } as never,
      modelId: 'm',
      appendMessage: async () => {},
      newId: () => `id-${++id}`,
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const controller = new AbortController();
    const pending = runtime.settleToolCall({
      tool: buildAskUserQuestionTool(),
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      input: {
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
      abortSignal: controller.signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    while (!events.some((event) => event.type === 'user_question_request')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const request = events.find((event) => event.type === 'user_question_request');
    assert.ok(request);
    controller.abort(new Error('cell aborted'));

    const settlement = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('question did not release after cell abort')), 50),
      ),
    ]);
    assert.match(String((settlement.result as { error: string }).error), /cell aborted/i);
    assert.equal(runtime.pendingUserQuestionCount(), 0);
    assert.equal(
      runtime.respondToUserQuestion({
        requestId: request.requestId,
        answers: ['Yes'],
      }),
      false,
    );
  });
});
