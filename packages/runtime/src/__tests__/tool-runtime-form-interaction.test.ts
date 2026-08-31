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
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import { z } from 'zod';

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import type { MakaTool } from '../tool-runtime.js';

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

function formTool(): MakaTool<Record<string, never>> {
  return {
    name: 'SyntheticForm',
    description: 'Exercise the provider-neutral form seam.',
    parameters: z.object({}),
    nesting: 'direct_only',
    impl: (_input, context) => {
      if (!context.requestUserForm) throw new Error('Form Interaction is unavailable');
      return context.requestUserForm({
        message: 'Choose deployment settings',
        requester: { name: 'deploy', source: 'Synthetic provider' },
        fields: [
          {
            kind: 'integer',
            name: 'replicas',
            label: 'Replicas',
            required: true,
            minimum: 1,
            maximum: 10,
          },
          {
            kind: 'multi_select',
            name: 'regions',
            label: 'Regions',
            required: false,
            options: [
              { value: 'us', label: 'US' },
              { value: 'eu', label: 'EU' },
            ],
          },
        ],
      });
    },
  };
}

function runtime(events: SessionEvent[]) {
  let id = 0;
  return createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async () => {},
    newId: () => `id-${++id}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
}

function sink(events: SessionEvent[]) {
  return {
    push: (event: SessionEvent) => events.push(event),
    pushAndWaitUntilConsumed: async (event: SessionEvent) => {
      events.push(event);
    },
  };
}

describe('ToolRuntime form Interaction', () => {
  test('parks one Tool call and resumes only after a schema-valid answer', async () => {
    const events: SessionEvent[] = [];
    const toolRuntime = runtime(events);
    const pending = toolRuntime
      .settleToolCall({
        tool: formTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: sink(events),
      })
      .then((settlement) => settlement.result);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = events.find((event) => event.type === 'form_request');
    assert.ok(request);
    assert.equal(toolRuntime.pendingUserFormCount(), 1);
    assert.throws(() =>
      toolRuntime.respondToUserForm({
        requestId: request.requestId,
        action: 'accept',
        values: { replicas: 1.5 },
      }),
    );
    assert.equal(toolRuntime.pendingUserFormCount(), 1);

    assert.equal(
      toolRuntime.respondToUserForm({
        requestId: request.requestId,
        action: 'accept',
        values: { replicas: 3, regions: ['us', 'eu'] },
      }),
      true,
    );
    assert.deepEqual(await pending, {
      action: 'accept',
      values: { replicas: 3, regions: ['us', 'eu'] },
    });
    assert.equal(events.filter((event) => event.type === 'form_answer_ack').length, 1);
  });

  test('keeps decline distinct and rejects a late answer after Turn closure', async () => {
    const events: SessionEvent[] = [];
    const toolRuntime = runtime(events);
    const first = toolRuntime
      .settleToolCall({
        tool: formTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: sink(events),
      })
      .then((settlement) => settlement.result);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstRequest = events.find((event) => event.type === 'form_request');
    assert.ok(firstRequest);
    assert.equal(
      toolRuntime.respondToUserForm({ requestId: firstRequest.requestId, action: 'decline' }),
      true,
    );
    assert.deepEqual(await first, { action: 'decline' });

    const second = toolRuntime
      .settleToolCall({
        tool: formTool(),
        turnId: 'turn-1',
        toolCallId: 'tool-2',
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: sink(events),
      })
      .then((settlement) => settlement.result);
    while (events.filter((event) => event.type === 'form_request').length < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const secondRequest = events.filter((event) => event.type === 'form_request')[1];
    assert.ok(secondRequest);
    await toolRuntime.endTurn('aborted');
    assert.deepEqual(await second, {
      error: `Turn turn-1 aborted before user form ${secondRequest.requestId} was answered`,
    });
    assert.equal(
      toolRuntime.respondToUserForm({ requestId: secondRequest.requestId, action: 'cancel' }),
      false,
    );
  });
});
