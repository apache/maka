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
import { test } from 'node:test';
import type { SandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';
import { PluginAgentService } from '../plugin-agent-service.js';
import { PluginApprovalService } from '../plugin-approval-service.js';
import { Context } from '../plugin-kernel.js';
import { PluginUserQuestionService } from '../plugin-user-question-service.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('questions and approvals use the exact current Tool interaction authority', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const approval = new PluginApprovalService(root, agents);
  const questions = new PluginUserQuestionService(root, agents);
  const calls: string[] = [];
  const context: MakaToolContext = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    askUserQuestion: async (items) => {
      calls.push(`question:${items[0]?.question}`);
      return { answers: [{ question: items[0]?.question ?? '', answer: 'yes' }] };
    },
    requestUserForm: async (form) => {
      calls.push(`form:${form.message}`);
      return { action: 'accept', values: { choice: 'yes' } };
    },
    requestSandboxBoundary: async (expansion, justification) => {
      calls.push(`approval:${justification}`);
      return {
        request: {
          sessionId: 'session-a',
          requestId: 'request-a',
          status: 'approved',
          baseRevision: 0,
          expansion,
          justification,
          createdAt: 1,
          settledAt: 2,
        },
        boundary: { kind: 'bypass', revision: 1 },
        changed: true,
      };
    },
  };

  await agents.withInvocation(context, async () => {
    await questions.ask([{ question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }]);
    await questions.requestForm({
      message: 'Choose',
      requester: { name: 'fixture' },
      fields: [
        {
          kind: 'single_select',
          name: 'choice',
          label: 'Choice',
          required: true,
          options: [{ value: 'yes', label: 'Yes' }],
        },
      ],
    });
    await approval.request({
      expansion: { kind: 'workspace_write', paths: ['/workspace'] } as SandboxBoundaryExpansion,
      justification: 'write output',
    });
  });
  assert.deepEqual(calls, ['question:Continue?', 'form:Choose', 'approval:write output']);
  await root.fiber.dispose();
});

test('interaction services reject calls outside an Agent invocation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const approval = new PluginApprovalService(root, agents);
  const questions = new PluginUserQuestionService(root, agents);
  assert.throws(() => questions.ask([]), /active Agent invocation/u);
  assert.throws(
    () => approval.request({ expansion: {} as SandboxBoundaryExpansion, justification: 'x' }),
    /active Agent invocation/u,
  );
  await root.fiber.dispose();
});
