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
import test from 'node:test';
import { z } from 'zod';
import type { SessionHeader } from '@maka/core/session';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';
import { parseAutoReviewDecision, type AutoReviewer } from '../auto-review.js';

function fixture(mode: PermissionMode | (() => PermissionMode), autoReview?: AutoReviewer) {
  let id = 0;
  return new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    turnId: 'turn-1',
    newId: () => `event-${++id}`,
    now: Date.now,
    readPermissionMode: async () => (typeof mode === 'function' ? mode() : mode),
    readExecutionBoundary: async () => ({ kind: 'bypass', revision: 0 }),
    getPermissionPauseTarget: () => null,
    ...(autoReview ? { autoReview } : {}),
  });
}
const allowed = {
  decision: 'allow',
  risk: 'low',
  authorization: 'unknown',
  rationale: 'Routine action',
} as const;
const denied = {
  decision: 'deny',
  risk: 'high',
  authorization: 'unknown',
  rationale: 'Destination is not authorized',
} as const;
function settle(
  runtime: ToolRuntime,
  tool: MakaTool,
  origin: 'provider' | 'code_mode' = 'provider',
  signal = new AbortController().signal,
) {
  return runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'call-1',
    input: { destination: 'example.test' },
    origin,
    abortSignal: signal,
    eventSink: { push: () => {}, pushAndWaitUntilConsumed: async () => {} },
  });
}
function action(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'publish',
    description: 'Send data',
    parameters: z.object({ destination: z.string() }),
    impl,
  };
}

test('Bypass executes directly without contacting the review model', async () => {
  let calls = 0;
  const runtime = fixture('bypass', async () => {
    throw new Error('Reviewer must not run');
  });
  await settle(
    runtime,
    action(() => {
      calls++;
      return 'done';
    }),
  );
  assert.equal(calls, 1);
});

test('Auto review happens before execution despite the direct host boundary', async () => {
  const order: string[] = [];
  const runtime = fixture('auto_review', async (request) => {
    order.push('review');
    assert.deepEqual(request.args, { destination: 'example.test' });
    assert.deepEqual(request.userRequests, ['Publish the report to example.test']);
    return allowed;
  });
  runtime.setAutoReviewContext(['Publish the report to example.test'], 'Publish the report');
  await settle(
    runtime,
    action(() => {
      order.push('execute');
      return 'done';
    }),
  );
  assert.deepEqual(order, ['review', 'execute']);
});

for (const origin of ['provider', 'code_mode'] as const) {
  test(`denial prevents ${origin} capability preparation and execution`, async () => {
    let calls = 0;
    const tool = {
      ...action(() => {
        calls++;
      }),
      hostAdmission: 'client_capability' as const,
      prepareExecution: async () => {
        calls++;
        return {
          execute: async () => {
            calls++;
          },
          cancel: () => {},
        };
      },
    };
    const result = await settle(
      fixture('auto_review', async () => denied),
      tool,
      origin,
    );
    assert.equal(calls, 0);
    assert.match(JSON.stringify(result), /Destination is not authorized/);
  });
}

for (const reviewer of [
  undefined,
  async () => {
    throw new Error('offline');
  },
] as const) {
  test(`missing or failing reviewer never falls back to execution: ${reviewer ? 'error' : 'missing'}`, async () => {
    let calls = 0;
    const result = await settle(
      fixture('auto_review', reviewer),
      action(() => {
        calls++;
      }),
    );
    assert.equal(calls, 0);
    assert.match(JSON.stringify(result), /not executed/);
  });
}

test('cancellation after review still prevents execution', async () => {
  const controller = new AbortController();
  let calls = 0;
  const runtime = fixture('auto_review', async () => {
    controller.abort();
    return allowed;
  });
  await settle(
    runtime,
    action(() => {
      calls++;
    }),
    'provider',
    controller.signal,
  );
  assert.equal(calls, 0);
});

test('mode changes take effect at the next dispatch without caching approvals', async () => {
  let mode: PermissionMode = 'bypass';
  let reviews = 0;
  let executions = 0;
  const runtime = fixture(
    () => mode,
    async () => {
      reviews++;
      return denied;
    },
  );
  const tool = action(() => {
    executions++;
    return 'done';
  });
  await settle(runtime, tool);
  mode = 'auto_review';
  await settle(runtime, tool);
  mode = 'bypass';
  await settle(runtime, tool);
  assert.equal(reviews, 1);
  assert.equal(executions, 2);
});

test('new user authorization permits a fresh review after repeated denials', async () => {
  let executions = 0;
  const runtime = fixture('auto_review', async (request) =>
    request.userRequests.includes('Publish to example.test') ? allowed : denied,
  );
  const tool = action(() => {
    executions++;
    return 'done';
  });
  for (let attempt = 0; attempt < 4; attempt++) await settle(runtime, tool);
  assert.equal(executions, 0);
  runtime.addAutoReviewUserRequest('Publish to example.test');
  await settle(runtime, tool);
  assert.equal(executions, 1);
});

test('review output is strict and cannot approve critical risk or unauthorized high risk', () => {
  assert.throws(() => parseAutoReviewDecision('allow'));
  assert.throws(() => parseAutoReviewDecision(JSON.stringify({ ...allowed, injected: true })));
  assert.equal(
    parseAutoReviewDecision(JSON.stringify({ ...allowed, risk: 'critical' })).decision,
    'deny',
  );
  assert.equal(
    parseAutoReviewDecision(JSON.stringify({ ...allowed, risk: 'high' })).decision,
    'deny',
  );
  assert.equal(
    parseAutoReviewDecision(JSON.stringify({ ...allowed, risk: 'high', authorization: 'medium' }))
      .decision,
    'allow',
  );
});

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'auto_review',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
