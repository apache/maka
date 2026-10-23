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

// Regression tests for #6249 and #6250. The proactive discovery Session investigates
// and reports; it must not create, adopt, or mutate conversation-owned Matters or
// memory indexes, and must not appear to hold those tools in its catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './fixture.js';

async function setup() {
  const f = await fixture({ matters: true });
  await f.remote('assistant.bind', { sessionId: 'owner' });
  f.setIndexRunner(async () => {});
  f.setRunner(async () => {});
  await f.invoke('InitiativeEnable', {});
  await f.invoke('InitiativeControl', { action: 'check' });
  await until(async () => !!(await f.invoke('InitiativeStatus')).discoverySession);
  const discovery = (await f.invoke('InitiativeStatus')).discoverySession as string;
  return { f, discovery };
}

test('discovery Session cannot delegate a Matter the conversation cannot see (#6249)', async () => {
  const { f, discovery } = await setup();
  try {
    await assert.rejects(
      f.invokeAs(discovery, 'MatterDelegate', {
        taskKey: 'probe',
        title: 'probe',
        request: 'probe',
      }),
    );
    const tasks = await f.invokeAs('owner', 'MatterTasks', {});
    assert.equal((tasks.items ?? []).length, 0);
  } finally {
    await f.close();
  }
});

test('discovery catalog omits conversation-mutating tools and keeps read and report tools (#6250)', async () => {
  const { f, discovery } = await setup();
  try {
    const visible = f
      .filterTools(discovery, f.tools.resolve(discovery, []).tools)
      .map((tool: any) => tool.name);
    for (const name of [
      'MatterDelegate',
      'MatterAdopt',
      'MatterSettle',
      'MemoryIndexWrite',
      'MemoryIndexControl',
      'SendUser',
    ])
      assert.ok(!visible.includes(name), `catalog still exposes ${name}`);
    for (const name of ['DiscoveryReport', 'DiscoveryContext', 'MemoryIndexRead', 'MatterOverview'])
      assert.ok(visible.includes(name), `catalog lost ${name}`);
  } finally {
    await f.close();
  }
});

test('discovery Session cannot write, edit, checkpoint, control or create conversation memory indexes (#6250)', async () => {
  const { f, discovery } = await setup();
  try {
    const range = await f.invoke('MemoryRange', {});
    const index = await f.invoke('MemoryIndexCreate', {
      name: 'Owner index',
      instructions: 'owner',
      cursor: range.to,
      background: true,
    });
    const indexId = index.index.id;
    const seededRead = await f.invoke('MemoryIndexRead', { indexId });
    await f.invoke('MemoryIndexWrite', {
      indexId,
      key: 'owner-key',
      expectedRevision: seededRead.index.revision,
      text: 'OWNER TEXT',
    });
    const seeded = await f.invoke('MemoryIndexRead', { indexId });
    await assert.rejects(
      f.invokeAs(discovery, 'MemoryIndexWrite', {
        indexId,
        key: 'owner-key',
        expectedRevision: seeded.index.revision,
        text: 'INJECTED',
      }),
    );
    await assert.rejects(
      f.invokeAs(discovery, 'MemoryIndexEdit', {
        indexId,
        key: 'owner-key',
        oldText: 'OWNER',
        newText: 'INJECTED',
        expectedRevision: seeded.index.revision,
      }),
    );
    await assert.rejects(
      f.invokeAs(discovery, 'MemoryIndexCheckpoint', {
        indexId,
        rangeId: seeded.range.rangeId,
        expectedRevision: seeded.index.revision,
        notes: 'injected',
        complete: false,
      }),
    );
    await assert.rejects(f.invokeAs(discovery, 'MemoryIndexControl', { indexId, action: 'pause' }));
    await assert.rejects(
      f.invokeAs(discovery, 'MemoryIndexCreate', {
        name: 'Injected',
        instructions: 'injected',
        cursor: range.to,
        background: false,
      }),
    );
    const content = await f.invoke('MemoryIndexContent', { indexId, key: 'owner-key' });
    assert.equal(content.text, 'OWNER TEXT');
    assert.equal(
      (await f.invoke('MemoryIndexRead', { indexId })).index.revision,
      seeded.index.revision,
    );
  } finally {
    await f.close();
  }
});

test('discovery Session cannot adopt an unassigned Matter from the conversation (#6250)', async () => {
  const { f, discovery } = await setup();
  try {
    await f.invokeAs('owner', 'MatterStart', { title: 'legacy', request: 'legacy request' });
    const before = (await f.invokeAs('owner', 'MatterOverview', {})).legacy ?? [];
    assert.equal(before.length, 1);
    await assert.rejects(f.invokeAs(discovery, 'MatterAdopt', { id: before[0].id }));
    const after = (await f.invokeAs('owner', 'MatterOverview', {})).legacy ?? [];
    assert.equal(after.length, 1);
  } finally {
    await f.close();
  }
});

test('discovery Session cannot control or amend a conversation-delegated task (#6250)', async () => {
  const { f, discovery } = await setup();
  try {
    const task = await f.invoke('MatterDelegate', {
      taskKey: 'owner-task',
      title: 'owner task',
      request: 'owner request',
    });
    await assert.rejects(
      f.invokeAs(discovery, 'MatterTaskControl', { id: task.id, action: 'cancel' }),
    );
    await assert.rejects(
      f.invokeAs(discovery, 'MatterTaskMessage', { id: task.id, text: 'injected requirement' }),
    );
    assert.notEqual((await f.invoke('MatterTasks', { id: task.id })).status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('discovery Session keeps read access to conversation memory (regression guard)', async () => {
  const { f, discovery } = await setup();
  try {
    const range = await f.invoke('MemoryRange', {});
    const index = await f.invoke('MemoryIndexCreate', {
      name: 'Readable index',
      instructions: 'readable',
      cursor: range.to,
      background: true,
    });
    const read = await f.invokeAs(discovery, 'MemoryIndexRead', { indexId: index.index.id });
    assert.equal(read.index.id, index.index.id);
    await f.invokeAs(discovery, 'MatterOverview', {});
  } finally {
    await f.close();
  }
});
