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
import { PluginLlmService } from '../plugin-llm-service.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('llm generation uses Host authority unless a matching adapter overrides it', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const llm = new PluginLlmService(root, agents);
  llm.bindRuntime({
    generate: async (_input, invocation) => ({ text: invocation.sessionId, modelId: 'host' }),
  });
  const plugin = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 1 },
  });
  plugin.llm.register({
    id: 'fixture.model',
    supports: (model) => model === 'fixture/model',
    generate: async () => ({ text: 'adapter', modelId: 'fixture/model' }),
  });
  const context: MakaToolContext = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
  await agents.withInvocation(context, async () => {
    assert.equal((await llm.generate({ prompt: 'hello' })).text, 'session-a');
    assert.equal((await llm.generate({ prompt: 'hello', model: 'fixture/model' })).text, 'adapter');
  });
  await root.fiber.dispose();
});
