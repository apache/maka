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
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
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

async function fixture(enabled: boolean | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'maka-native-assistant-中文-'));
  const ctx = new Context();
  const agents = new PluginAgentService(ctx);
  const llm = new PluginLlmService(ctx, agents);
  const sessionQuery = new PluginSessionQueryService(ctx, agents);
  const sources = new PluginSourceService(ctx, agents);
  const pluginTools = new PluginToolService(ctx, { agents });
  const marked: string[][] = [];
  const dependencies = {
    prepareBotWake: async () => 'ready' as const,
    allocateWorkspace: async (): Promise<{ projectId: string }> => {
      throw Error('Not configured');
    },
    stopSessions: async () => {},
    markBackgroundSessions: async (ids: readonly string[]) => {
      marked.push([...ids]);
    },
    agents,
    llm,
    sessionQuery,
    sources,
    resolveTools: (id: string, core: any) => pluginTools.resolve(id, core),
  };
  const directory = join(root, 'native');
  if (enabled !== null) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'enablement.json'), JSON.stringify({ enabled }));
  }
  const legacy = new HostPluginDataRuntime(root);
  const service = new PersonalAssistantService(directory, dependencies);
  return {
    root,
    service,
    legacy,
    directory,
    dependencies,
    marked,
    close: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('absent preference enables native tools and APIs without installing plugins or invoking a model', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.service.recover(f.legacy, []);
  assert.equal(f.service.enabled, true);
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
  const initialBinding: any = await f.service.call('assistant.binding', {});
  assert.equal(initialBinding.state, null);
  assert.equal(initialBinding.bot.working, false);
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
  old.bind({ sessionId: 'existing-chat', cwd: f.root });
  old.save({ ...old.get(), instructions: 'obsolete saved instructions' });
  old.release(); // The successor can acquire ownership and clean obsolete configuration.
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
  assert.equal(Object.hasOwn(binding.state, 'instructions'), false);
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

  await mkdir(directories['proactive-matters'], { recursive: true });
  const delegation = new DatabaseSync(join(directories['proactive-matters'], 'delegations.sqlite'));
  delegation.exec(
    'CREATE TABLE delegations(owner TEXT NOT NULL, task_key TEXT NOT NULL, session TEXT NOT NULL UNIQUE, title TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(owner,task_key))',
  );
  delegation
    .prepare('INSERT INTO delegations VALUES(?,?,?,?,?)')
    .run('old-assistant', 'task', 'old-task', '交期核验', '等回复');
  delegation.close();
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
  initiative.bind({ sessionId: 'old-assistant', cwd: f.root });
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
      assert.deepEqual([...f.marked.at(-1)!].sort(), ['old-task', 'old-worker']);
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
  await f.service.recover(f.legacy, [entry, { ...entry, id: 'duplicate' }] as any);
  f.service.start();
  assert.equal(f.service.enabled, false);
  assert.match(
    ((await f.service.call('assistant.enablement', {})) as any).error,
    /Multiple legacy configurations/,
  );
  assert.deepEqual(f.service.tools, []);
  await assert.rejects(readFile(join(f.directory, 'assistant.json')), { code: 'ENOENT' });
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'assistant.json'), '{broken');
  const service = new PersonalAssistantService(f.directory, f.dependencies);
  try {
    await service.recover(f.legacy, []);
    service.start();
    assert.equal(service.enabled, false);
    assert.ok(((await service.call('assistant.enablement', {})) as any).error);
    assert.equal(await readFile(join(f.directory, 'assistant.json'), 'utf8'), '{broken');
    await assert.rejects(readFile(join(f.directory, 'memory-network', 'network.sqlite')), {
      code: 'ENOENT',
    });
    await rm(join(f.directory, 'assistant.json'));
    await service.call('assistant.set-enabled', { enabled: true });
    assert.deepEqual(await service.call('assistant.enablement', {}), { enabled: true });
  } finally {
    await service.close();
  }
});

test('explicitly disabled stays cold: no legacy adoption, databases, tools, prompts or schedulers', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  let legacyReads = 0;
  f.legacy.read = async () => {
    legacyReads++;
    throw Error('must not adopt while off');
  };
  await f.service.recover(f.legacy, []);
  f.service.start();
  assert.deepEqual(await f.service.call('assistant.enablement', {}), { enabled: false });
  assert.deepEqual(f.service.tools, []);
  assert.deepEqual(
    await f.service.prompt({ sessionId: 'ordinary', turnId: 'turn', cwd: f.root }, 'normal prompt'),
    {
      text: 'normal prompt',
      contexts: [],
      sourceRevision: undefined,
    },
  );
  assert.deepEqual(
    await f.service.beforeFinish({
      sessionId: 'ordinary',
      turnId: 'turn',
      signal: new AbortController().signal,
    }),
    { allow: true },
  );
  for (const method of [
    'assistant.binding',
    'assistant.allocate-workspace',
    'assistant.bind',
    'assistant.control',
    'assistant.recover',
    'assistant.status',
  ])
    await assert.rejects(f.service.call(method, {}), /disabled/);
  assert.deepEqual(await readdir(f.directory), ['enablement.json']);
  assert.equal(legacyReads, 0);
  assert.deepEqual(f.marked, []);
});

test('master switch is persistent, repeatable, rejects stale tools and retains stored data', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  let stops = 0;
  f.dependencies.stopSessions = async () => {
    stops++;
  };
  await f.service.recover(f.legacy, []);
  f.service.start();
  await assert.rejects(f.service.call('assistant.set-enabled', { enabled: 'yes' }), /boolean/);
  const initiative = new InitiativeStore(join(f.directory, 'index-initiative'), 'inspection');
  initiative.lease();
  initiative.bind({ sessionId: 'retained-assistant', cwd: f.root });
  initiative.release();
  initiative.close();
  await Promise.all([
    f.service.call('assistant.set-enabled', { enabled: true }),
    f.service.call('assistant.set-enabled', { enabled: true }),
  ]);
  assert.equal(f.marked.length, 1, 'one runtime generation, despite concurrent enable requests');
  const names = f.service.tools.map((t) => t.name);
  const captured = f.service.tools.find((t) => t.name === 'InitiativeStatus')!;
  const settings = await readFile(join(f.directory, 'assistant.json'), 'utf8');
  await f.service.call('assistant.set-enabled', { enabled: false });
  assert.equal(f.service.enabled, false);
  assert.deepEqual(f.service.tools, []);
  assert.throws(() => captured.impl({}, {} as any), /shutting down/);
  assert.ok(stops > 0);
  assert.equal(await readFile(join(f.directory, 'assistant.json'), 'utf8'), settings);
  await f.service.close();
  const again = new PersonalAssistantService(f.directory, f.dependencies);
  t.after(() => again.close());
  await again.recover(f.legacy, []);
  again.start();
  assert.equal(again.enabled, false);
  assert.equal(f.marked.length, 1, 'restart while off does not initialize stores');
  await again.call('assistant.set-enabled', { enabled: true });
  assert.deepEqual(
    again.tools.map((t) => t.name),
    names,
  );
  assert.equal(
    ((await again.call('assistant.binding', {})) as any).state.sessionId,
    'retained-assistant',
  );
  assert.equal(again.tools.length, new Set(names).size);
  await again.call('assistant.set-enabled', { enabled: false });
});

test('explicit disable overrides component configuration; enable failure stays disabled and can be retried', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'assistant.json'), '{broken');
  await f.service.recover(f.legacy, []);
  f.service.start();
  assert.equal(f.service.enabled, false);
  await assert.rejects(f.service.call('assistant.set-enabled', { enabled: true }), SyntaxError);
  assert.equal(f.service.enabled, false);
  await assert.rejects(readFile(join(f.directory, 'memory-network', 'network.sqlite')), {
    code: 'ENOENT',
  });
  await rm(join(f.directory, 'assistant.json'));
  await f.service.call('assistant.set-enabled', { enabled: true });
  assert.equal(f.service.enabled, true);
});

test('disable fences admission before waiting for stop and serializes re-enable', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.service.recover(f.legacy, []);
  f.service.start();
  let release!: () => void;
  let stopping!: () => void;
  const began = new Promise<void>((r) => (stopping = r));
  const wait = new Promise<void>((r) => (release = r));
  f.dependencies.stopSessions = async () => {
    stopping();
    await wait;
  };
  const off = f.service.call('assistant.set-enabled', { enabled: false });
  await began;
  assert.equal(f.service.enabled, false);
  assert.deepEqual(f.service.tools, []);
  await assert.rejects(f.service.call('assistant.bind', {}), /disabled/);
  const on = f.service.call('assistant.set-enabled', { enabled: true });
  assert.equal(f.service.enabled, false);
  release();
  await off;
  await on;
  assert.equal(f.service.enabled, true);
});

for (const preference of ['{broken', JSON.stringify({ enabled: true })]) {
  test(`assistant startup failure is isolated with persisted preference ${preference}`, async (t) => {
    const f = await fixture(true);
    t.after(f.close);
    await writeFile(join(f.directory, 'enablement.json'), preference);
    await writeFile(join(f.directory, 'assistant.json'), '{broken');
    await f.service.recover(f.legacy, []);
    f.service.start();
    assert.equal(f.service.enabled, false);
    assert.deepEqual(f.service.tools, []);
    assert.ok(((await f.service.call('assistant.enablement', {})) as any).error);
    assert.equal(await readFile(join(f.directory, 'enablement.json'), 'utf8'), preference);
    assert.equal(await readFile(join(f.directory, 'assistant.json'), 'utf8'), '{broken');
    await assert.rejects(f.service.call('assistant.status', {}), /disabled/);
  });
}

test('assistant workspace allocation accepts no Client path and leaves binding creation unchanged', async (t) => {
  const f = await fixture(true);
  t.after(f.close);
  let allocations = 0;
  f.dependencies.allocateWorkspace = async () => {
    allocations++;
    return { projectId: 'host-project' };
  };
  await f.service.recover(f.legacy, []);
  f.service.start();
  await assert.rejects(f.service.call('assistant.allocate-workspace', { cwd: '/client/path' }));
  assert.equal(allocations, 0);
  assert.deepEqual(await f.service.call('assistant.allocate-workspace', {}), {
    projectId: 'host-project',
  });
  assert.equal(allocations, 1);
  assert.equal(((await f.service.call('assistant.binding', {})) as any).state, null);
});
