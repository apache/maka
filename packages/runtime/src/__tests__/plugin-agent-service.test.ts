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
  const invocation = toolContext('session-a');
  const agent = await agents.withInvocation(invocation, () => agents.create());
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

test('Agent access fails closed without an invocation and handles retain their authority', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const observed: string[] = [];
  const descriptor = { id: 'child', sessionId: 'child', root: false };
  agents.bindRuntime({
    create: async (_options, initiator) => {
      observed.push(`create:${initiator.sessionId}`);
      return descriptor;
    },
    resume: async () => descriptor,
    get: async () => descriptor,
    list: async () => [descriptor],
    roots: async () => [],
    followup: async (_id, _message, initiator) => {
      observed.push(`followup:${initiator.sessionId}`);
    },
    steer: async () => undefined,
    inject: async () => undefined,
    cancel: async () => undefined,
    whenIdle: async () => undefined,
    snapshot: async () => undefined,
    inbox: async () => undefined,
    result: async () => undefined,
    artifacts: async () => undefined,
    transcript: async () => undefined,
    dispose: async () => undefined,
  });

  await assert.rejects(() => agents.list(), /requires an active Agent invocation/u);
  const handle = await agents.withInvocation(toolContext('session-a'), () => agents.create());
  await agents.withInvocation(toolContext('session-b'), () => handle.followup('next'));
  assert.deepEqual(observed, ['create:session-a', 'followup:session-a']);
  await root.fiber.dispose();
});

test('Agent custom cancellation preserves the originating invocation cancellation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const descriptor = { id: 'child', sessionId: 'child', root: false };
  const signals: AbortSignal[] = [];
  agents.bindRuntime({
    create: async (options) => {
      if (options.signal) signals.push(options.signal);
      return descriptor;
    },
    resume: async (options) => {
      if (options.signal) signals.push(options.signal);
      return descriptor;
    },
    get: async () => descriptor,
    list: async () => [descriptor],
    roots: async () => [],
    followup: async () => undefined,
    steer: async () => undefined,
    inject: async () => undefined,
    cancel: async () => undefined,
    whenIdle: async (_id, signal) => {
      if (signal) signals.push(signal);
    },
    snapshot: async () => undefined,
    inbox: async () => undefined,
    result: async () => undefined,
    artifacts: async () => undefined,
    transcript: async () => undefined,
    dispose: async () => undefined,
  });
  const hostAbort = new AbortController();
  const pluginAbort = new AbortController();
  const invocation = { ...toolContext('session-a'), abortSignal: hostAbort.signal };

  await agents.withInvocation(invocation, async () => {
    const created = await agents.create({ signal: pluginAbort.signal });
    await agents.resume({ sessionId: 'child', signal: pluginAbort.signal });
    await created.whenIdle(pluginAbort.signal);
  });
  hostAbort.abort(new Error('Host stopped'));
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(pluginAbort.signal.aborted, false);
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
