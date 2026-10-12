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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginAgentService } from '@maka/runtime/plugin-agent-service';
import { PluginLlmService } from '@maka/runtime/plugin-llm-service';
import { PluginSessionQueryService } from '@maka/runtime/plugin-session-query-service';
import { PluginSourceService } from '@maka/runtime/plugin-source-service';
import { PluginToolService } from '@maka/runtime/plugin-tool-service';
import { PersonalAssistantService } from '../assistant/service.js';
import { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';
import { InitiativeStore } from '../assistant/index-initiative/store.js';
import { PERSONAL_ASSISTANT_OPERATION_SPECS } from '../protocol/personal-assistant.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-native-assistant-中文-'));
  const ctx = new Context();
  const agents = new PluginAgentService(ctx);
  const llm = new PluginLlmService(ctx, agents);
  const sessionQuery = new PluginSessionQueryService(ctx, agents);
  const sources = new PluginSourceService(ctx, agents);
  const pluginTools = new PluginToolService(ctx, { agents });
  const dependencies = {
    agents,
    llm,
    sessionQuery,
    sources,
    resolveTools: (id: string, core: any) => pluginTools.resolve(id, core),
  };
  const directory = join(root, 'native');
  const legacy = new HostPluginDataRuntime(root);
  const service = new PersonalAssistantService(directory, dependencies);
  return {
    root,
    service,
    legacy,
    directory,
    dependencies,
    close: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('native tools and APIs initialize without installing any plugin or invoking a model', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.service.recover(f.legacy, []);
  const names = f.service.tools.map((x) => x.name);
  for (const name of [
    'MemoryIndexCreateGroup',
    'MemoryHistory',
    'MatterDelegate',
    'MatterSettle',
    'InitiativeControl',
  ])
    assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
  await assert.rejects(f.service.call('assistant.binding', {}), /not ready/);
  f.service.start();
  f.service.start();
  assert.deepEqual(await f.service.call('assistant.binding', {}), { state: null });
  const status: any = await f.service.call('assistant.status', {});
  assert.equal(status.readiness.memory, true);
  assert.equal(status.readiness.tasks, true);
  assert.equal(status.sourceSync.installed, false);
  assert.deepEqual(status.memory.indexes, []);
  await assert.rejects(f.service.call('arbitrary.tool', {}), /Unknown/);
  const read = f.service.tools.find((x) => x.name === 'InitiativeStatus')!;
  f.service.beginDrain();
  await assert.rejects(f.service.call('assistant.binding', {}), /not ready/);
  // Existing model turns may finish their tool work during drain; close fences it.
  await f.service.close();
  assert.throws(() => read.impl({}, {} as any), /shutting down/);
});

test('legacy data path and assistant conversation are adopted in place and persist after restart', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const original = join(f.root, '原有 数据 #');
  const old = new InitiativeStore(original, 'old-owner');
  old.lease();
  old.bind({ sessionId: 'existing-chat', cwd: f.root }, 'preserve these instructions');
  old.close();
  await f.legacy.mutate(
    { extensionId: 'dev.maka.index-initiative', scopeId: 'profile' },
    'storage',
    [{ key: 'data-directory', value: original }],
  );
  await f.service.recover(f.legacy, []);
  f.service.start();
  const binding: any = await f.service.call('assistant.binding', {});
  assert.equal(binding.state.sessionId, 'existing-chat');
  assert.equal(binding.state.enabled, false);
  const settings = JSON.parse(await readFile(join(f.directory, 'assistant.json'), 'utf8'));
  assert.equal(settings['index-initiative'].directory, original);
  assert.equal(binding.state.instructions, 'preserve these instructions');
  await f.service.close();
  // Once adopted, unrelated edits to obsolete plugin storage must not replace the native authority.
  await f.legacy.mutate(
    { extensionId: 'dev.maka.index-initiative', scopeId: 'profile' },
    'storage',
    [{ key: 'data-directory', value: join(f.root, 'wrong') }],
  );
  const again = new PersonalAssistantService(f.directory, f.dependencies);
  try {
    await again.recover(f.legacy, []);
    again.start();
    assert.deepEqual(await again.call('assistant.binding', {}), binding);
  } finally {
    await again.close();
  }
});

test('desktop API is an explicit allowlist; guest-style arbitrary tool and legacy mutation RPCs are not admitted', () => {
  const spec = PERSONAL_ASSISTANT_OPERATION_SPECS['personal-assistant.call'];
  assert.equal(operationAllowsRemoteOwner('personal-assistant.call'), true);
  assert.deepEqual(spec.decodeInput({ method: 'assistant.binding', input: {} }), {
    method: 'assistant.binding',
    input: {},
  });
  for (const method of [
    'MatterSettle',
    'matters.authorize-session',
    'matters.edit',
    'plugin.install',
  ])
    assert.throws(() => spec.decodeInput({ method, input: {} }));
  assert.throws(() =>
    spec.decodeInput({ method: 'assistant.binding', input: {}, sessionId: 'somebody-else' }),
  );
});
