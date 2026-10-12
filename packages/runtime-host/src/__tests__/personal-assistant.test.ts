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
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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
import { DatabaseSync } from 'node:sqlite';
import { CorpusStore } from '../assistant/memory-network/corpus.js';
import { createMatterStore } from '../assistant/proactive-matters/store.js';
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

test('adopting all three stores preserves coverage, references, unfinished groups, and waiting tasks across repeated restarts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const directories = Object.fromEntries(
    ['memory-network', 'proactive-matters', 'index-initiative'].map((name) => [
      name,
      join(f.root, '旧数据 中文 #', name),
    ]),
  );
  const memory = new CorpusStore(directories['memory-network']);
  const messages = [{ id: 'original-1', type: 'user', text: '等供应商回复后核对交期' }];
  memory.ingest('old-chat', messages);
  memory.rememberRecord(
    { key: 'old-chat', source: 'maka', id: 'old-chat', revision: 'v1' },
    messages,
  );
  const cursor = memory.capture(['maka'], ['old-chat']);
  const ref = memory.references()[0].ref;
  const events = memory.create('事件', '保留来龙去脉', ['old-chat']);
  const todos = memory.create('未完成', '只记尚未完成的承诺', ['old-chat']);
  const work = memory.begin(events.id, cursor.id, ['old-chat']);
  memory.write(events.id, 'vendor', `[供应商](memory-original:${ref})`, 0, ['old-chat']);
  memory.checkpoint(events.id, work.id, 1, '已整理', true, ['old-chat'], 'old-worker');
  const pending = memory.begin(todos.id, cursor.id, ['old-chat']);
  const worker = {
    sessionId: 'old-worker',
    groupIndexIds: [events.id, todos.id],
    groupNumber: 2,
    status: 'paused',
  };
  memory.saveWorker(todos.id, worker);
  memory.close();

  const now = Date.now();
  const tasks = createMatterStore(directories['proactive-matters'], { now: () => now });
  const task = tasks.create({
    sessionId: 'old-task',
    cwd: f.root,
    title: '交期核验',
    request: '等供应商确认交期',
  });
  const active = tasks.claim(task.id)!.matter;
  tasks.settle(
    task.id,
    active.activation!.id,
    {
      expectedRevision: active.revision,
      stateText: '已询问供应商',
      disposition: 'wait',
      waitingFor: '供应商回复',
      wakes: [{ kind: 'at', at: now + 86400000 }],
      summary: '已询问',
      reason: '等待回复',
      update: '已经联系，等待确认',
    },
    'old-settle',
  );
  tasks.finish(task.id, active.activation!.id);
  const savedTask = tasks.get(task.id);
  const savedUpdates = tasks.updates();
  tasks.close();
  const initiative = new InitiativeStore(directories['index-initiative'], 'old-owner');
  initiative.lease();
  initiative.bind({ sessionId: 'old-assistant', cwd: f.root }, '原有推荐要求');
  const savedBinding = initiative.get();
  initiative.close();

  for (const [name, directory] of Object.entries(directories))
    await f.legacy.mutate({ extensionId: 'dev.maka.' + name, scopeId: 'profile' }, 'storage', [
      { key: 'data-directory', value: directory },
    ]);
  const entries = Object.keys(directories).map((name) => ({
    id: name,
    packageId: 'dev.maka.' + name,
    rootId: 'profile',
    children: [],
    config: { tickMs: 60000, intervalMs: 43200000, maxConcurrentJobs: 2 },
  }));
  for (let pass = 0; pass < 2; pass++) {
    const service =
      pass === 0 ? f.service : new PersonalAssistantService(f.directory, f.dependencies);
    try {
      await service.recover(f.legacy, entries as any);
      service.start();
      assert.deepEqual(((await service.call('assistant.binding', {})) as any).state, savedBinding);
      const state = (await service.call('matters.list', {})) as any;
      assert.equal(state.matters.length, 1);
      assert.equal(state.matters[0].status, 'waiting');
      assert.deepEqual(state.matters[0].wakes, savedTask.matter.wakes);
      assert.equal(state.matters[0].stateText, savedTask.matter.stateText);
      assert.deepEqual(state.matters[0].updates, savedUpdates);
      const settings = JSON.parse(await readFile(join(f.directory, 'assistant.json'), 'utf8'));
      for (const [name, directory] of Object.entries(directories)) {
        assert.equal(settings[name].directory, directory);
        assert.equal(settings[name].config.tickMs, 60000);
      }
    } finally {
      await service.close();
    }
    const reopened = new CorpusStore(directories['memory-network']);
    try {
      assert.equal(reopened.boundary(events.id), cursor.id);
      assert.equal(reopened.boundary(todos.id), null);
      assert.deepEqual(reopened.work(todos.id), pending);
      assert.deepEqual(reopened.worker(todos.id), worker);
      assert.equal(
        reopened.content(events.id, 'vendor', ['old-chat']).text,
        `[供应商](memory-original:${ref})`,
      );
      assert.equal(reopened.original(ref, ['old-chat']).backlinks.length, 1);
      assert.deepEqual(reopened.cursor(cursor.id), cursor);
      assert.equal(reopened.pending(events.id, cursor.id, ['old-chat']), 0);
    } finally {
      reopened.close();
    }
  }
  const resumed = createMatterStore(directories['proactive-matters'], {
    now: () => now + 86400001,
  });
  try {
    resumed.enqueueDue();
    resumed.enqueueDue();
    assert.equal(resumed.get(task.id).events.length, 1);
    assert.ok(resumed.claim(task.id));
    assert.equal(resumed.claim(task.id), null);
    assert.deepEqual(resumed.updates(), savedUpdates);
  } finally {
    resumed.close();
  }
  for (const [name, filename] of [
    ['memory-network', 'network.sqlite'],
    ['proactive-matters', 'matters.sqlite'],
    ['index-initiative', 'initiative.sqlite'],
  ]) {
    const db = new DatabaseSync(join(directories[name], filename), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally {
      db.close();
    }
  }
});

test('ambiguous or malformed adopted settings fail closed without creating replacement databases', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entry = {
    id: 'old',
    packageId: 'dev.maka.memory-network',
    rootId: 'profile',
    children: [],
    config: {},
  };
  await assert.rejects(
    f.service.recover(f.legacy, [entry, { ...entry, id: 'duplicate' }] as any),
    /Multiple legacy configurations/,
  );
  await assert.rejects(readFile(join(f.directory, 'assistant.json')), { code: 'ENOENT' });
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'assistant.json'), '{broken');
  const service = new PersonalAssistantService(f.directory, f.dependencies);
  try {
    await assert.rejects(service.recover(f.legacy, []), SyntaxError);
    assert.equal(await readFile(join(f.directory, 'assistant.json'), 'utf8'), '{broken');
    await assert.rejects(readFile(join(f.directory, 'memory-network', 'network.sqlite')), {
      code: 'ENOENT',
    });
  } finally {
    await service.close();
  }
});
