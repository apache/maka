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
import { PluginAgentService, type PluginAgentRuntime } from '../plugin-agent-service.js';
import { Context } from '../plugin-kernel.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('ctx.agent follows the exact asynchronous Tool invocation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  assert.equal(root.agent, undefined);

  const invocation = toolContext('session-a');
  await agents.withInvocation(invocation, async () => {
    await Promise.resolve();
    assert.equal(root.agent?.id, 'session-a');
    assert.equal(agents.requireInvocation().turnId, 'turn-a');
  });
  assert.equal(root.agent, undefined);
  await root.fiber.dispose();
});

test('Agent handles expose the complete control and query surface', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const calls: string[] = [];
  const descriptor = { id: 'child', sessionId: 'child', root: false };
  const runtime: PluginAgentRuntime = {
    create: async () => descriptor,
    resume: async () => descriptor,
    get: async () => descriptor,
    list: async () => [descriptor],
    roots: async () => [],
    followup: async () => calls.push('followup'),
    steer: async () => calls.push('steer'),
    inject: async () => calls.push('inject'),
    cancel: async () => calls.push('cancel'),
    whenIdle: async () => {
      calls.push('whenIdle');
    },
    snapshot: async () => calls.push('snapshot'),
    inbox: async () => calls.push('inbox'),
    result: async () => calls.push('result'),
    artifacts: async () => calls.push('artifacts'),
    transcript: async () => calls.push('transcript'),
    dispose: async () => {
      calls.push('dispose');
    },
  };
  agents.bindRuntime(runtime);
  const agent = await agents.create();
  await agent.followup('next');
  await agent.steer('now');
  await agent.inject('context');
  await agent.cancel();
  await agent.whenIdle();
  await agent.snapshot();
  await agent.inbox();
  await agent.result();
  await agent.artifacts();
  await agent.transcript();
  await agent.dispose();
  assert.deepEqual(calls, [
    'followup',
    'steer',
    'inject',
    'cancel',
    'whenIdle',
    'snapshot',
    'inbox',
    'result',
    'artifacts',
    'transcript',
    'dispose',
  ]);
  await root.fiber.dispose();
});

function toolContext(sessionId: string): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}
