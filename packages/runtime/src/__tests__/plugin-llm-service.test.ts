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
import { MakaPluginTransactionBuffer } from '../plugin-runtime.js';
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

test('LLM adapters publish atomically across hot reload and never revive retired generations', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const llm = new PluginLlmService(root, agents);
  llm.bindRuntime({
    generate: async () => ({ text: 'host', modelId: 'host' }),
  });
  const previous = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 1 },
  });
  const disposePrevious = previous.llm.register(adapter('previous'));
  const candidateOwner = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 2 },
  });
  const transaction = new MakaPluginTransactionBuffer(candidateOwner);
  const candidate = candidateOwner.extend({ makaTransaction: transaction });
  const disposeCandidate = candidate.llm.register(adapter('candidate'));

  assert.equal(await generate(agents, llm), 'previous', 'staged candidates stay invisible');
  await transaction.commit();
  assert.equal(await generate(agents, llm), 'candidate');

  await disposePrevious();
  assert.equal(
    await generate(agents, llm),
    'candidate',
    'retiring the old generation keeps the new',
  );
  await disposeCandidate();
  assert.equal(await generate(agents, llm), 'host', 'unload cannot revive the retired generation');
  await root.fiber.dispose();
});

test('failed LLM adapter publication restores the live generation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const llm = new PluginLlmService(root, agents);
  llm.bindRuntime({
    generate: async () => ({ text: 'host', modelId: 'host' }),
  });
  const previous = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 1 },
  });
  previous.llm.register(adapter('previous'));
  const candidateOwner = root.extend({
    maka: { rootId: 'profile', packageId: 'fixture', entryId: 'fixture', generation: 2 },
  });
  const transaction = new MakaPluginTransactionBuffer(candidateOwner);
  const candidate = candidateOwner.extend({ makaTransaction: transaction });
  candidate.llm.register(adapter('candidate'));
  transaction.stage('fixture.failure', () => {
    throw new Error('candidate activation failed');
  });

  await assert.rejects(() => transaction.commit(), /candidate activation failed/u);
  assert.equal(await generate(agents, llm), 'previous');
  await root.fiber.dispose();
});

test('LLM adapter custom cancellation preserves Host cancellation', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const llm = new PluginLlmService(root, agents);
  const hostAbort = new AbortController();
  const pluginAbort = new AbortController();
  let observed: AbortSignal | undefined;
  llm.bindRuntime({
    generate: async (input) => {
      observed = input.signal;
      return { text: 'host', modelId: 'host' };
    },
  });

  await agents.withInvocation(toolContext(hostAbort.signal), () =>
    llm.generate({ prompt: 'hello', signal: pluginAbort.signal }),
  );
  assert.equal(observed?.aborted, false);
  hostAbort.abort(new Error('Host stopped'));
  assert.equal(observed?.aborted, true);
  assert.equal(pluginAbort.signal.aborted, false);
  await root.fiber.dispose();
});

function adapter(text: string) {
  return {
    id: 'fixture.model',
    supports: (model: string) => model === 'fixture/model',
    generate: async () => ({ text, modelId: 'fixture/model' }),
  };
}

async function generate(agents: PluginAgentService, llm: PluginLlmService): Promise<string> {
  return await agents.withInvocation(
    toolContext(),
    async () => (await llm.generate({ prompt: 'hello', model: 'fixture/model' })).text,
  );
}

function toolContext(abortSignal = new AbortController().signal): MakaToolContext {
  return {
    sessionId: 'session-a',
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal,
    emitOutput: () => undefined,
  };
}
