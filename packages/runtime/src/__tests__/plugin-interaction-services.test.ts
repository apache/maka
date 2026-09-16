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
import { PluginAgentService } from '../plugin-agent-service.js';

import { Context } from '../plugin-kernel.js';
import { PluginUserQuestionService } from '../plugin-user-question-service.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('form custom cancellation preserves Host invocation cancellation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const questions = new PluginUserQuestionService(root, agents);
  const hostAbort = new AbortController();
  const pluginAbort = new AbortController();
  let observed: AbortSignal | undefined;
  const context: MakaToolContext = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal: hostAbort.signal,
    emitOutput: () => undefined,
    requestUserForm: async (_form, options) => {
      observed = options?.cancellationSignal;
      return { action: 'cancel', values: {} };
    },
  };

  await agents.withInvocation(context, () =>
    questions.requestForm(
      { message: 'Choose', requester: { name: 'fixture' }, fields: [] },
      { signal: pluginAbort.signal },
    ),
  );
  assert.equal(observed?.aborted, false);
  hostAbort.abort(new Error('Host stopped'));
  assert.equal(observed?.aborted, true);
  assert.equal(pluginAbort.signal.aborted, false);
  await root.fiber.dispose();
});
