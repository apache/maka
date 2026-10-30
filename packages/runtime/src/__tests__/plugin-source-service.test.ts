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
import { Context } from '../plugin-kernel.js';
import { PluginAgentService } from '../plugin-agent-service.js';
import { PluginSourceService, type PluginSourceAdapter } from '../plugin-source-service.js';
import { MakaPluginTransactionBuffer } from '../plugin-runtime.js';

function fixture() {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const service = new PluginSourceService(root, agents);
  const owner = (generation: number, entryId = 'source-entry') =>
    root.extend({
      maka: { rootId: 'profile' as const, packageId: 'source-package', entryId, generation },
    });
  const list = () =>
    agents.withInvocation(
      {
        sessionId: 'test',
        turnId: 'turn',
        cwd: '/tmp',
        toolCallId: 'call',
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
      async () => service.list(),
    );
  return { root, owner, list };
}
function adapter(description: string): PluginSourceAdapter {
  return {
    id: 'example.docs',
    description,
    queryHelp: '',
    scope: {},
    enumerate: async () => ({ items: [] }),
    query: async () => ({ items: [] }),
    authorize: async () => [],
    read: async () => ({ status: 'unavailable' }),
  };
}
test('source hot reload stages publication and old disposal does not remove the replacement', async () => {
  const { root, owner, list } = fixture();
  const old = owner(1).sources.register(adapter('old'));
  const nextOwner = owner(2),
    transaction = new MakaPluginTransactionBuffer(nextOwner);
  const next = nextOwner.extend({ makaTransaction: transaction }).sources.register(adapter('new'));
  assert.equal((await list())[0]!.description, 'old');
  await transaction.commit();
  assert.equal((await list())[0]!.description, 'new');
  await old();
  assert.equal((await list())[0]!.description, 'new');
  await next();
  assert.deepEqual(await list(), []);
  await root.fiber.dispose();
});
test('source failed activation restores the live predecessor and foreign owners cannot replace it', async () => {
  const { root, owner, list } = fixture();
  owner(1).sources.register(adapter('old'));
  const nextOwner = owner(2),
    transaction = new MakaPluginTransactionBuffer(nextOwner);
  nextOwner.extend({ makaTransaction: transaction }).sources.register(adapter('new'));
  transaction.stage('failure', () => {
    throw Error('reject candidate');
  });
  await assert.rejects(transaction.commit(), /reject candidate/);
  assert.equal((await list())[0]!.description, 'old');
  assert.throws(
    () => owner(3, 'another-entry').sources.register(adapter('foreign')),
    /another entry/,
  );
  assert.equal((await list())[0]!.description, 'old');
  await root.fiber.dispose();
});

test('lightweight activity requires caller identity and preserves adapter failures without scanning', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const service = new PluginSourceService(root, agents);
  const owner = root.extend({
    maka: { rootId: 'profile' as const, packageId: 'activity', entryId: 'activity', generation: 1 },
  });
  let scans = 0;
  let permitted = true;
  owner.sources.register({
    ...adapter('observed'),
    activityToken: async (caller) => {
      assert.equal(caller.invocation?.sessionId, 'test');
      if (!permitted) throw Error('permission denied');
      return 'published-42';
    },
    enumerate: async () => {
      scans++;
      return { items: [] };
    },
  });
  owner.sources.register({ ...adapter('unsupported'), id: 'example.legacy' });
  const invoke = <T>(fn: () => T) =>
    agents.withInvocation(
      {
        sessionId: 'test',
        turnId: 'turn',
        cwd: '/tmp',
        toolCallId: 'call',
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
      fn,
    );
  try {
    await assert.rejects(service.activityToken('example.docs'));
    assert.equal(await invoke(() => service.activityToken('example.docs')), 'published-42');
    assert.equal(await invoke(() => service.activityToken('example.legacy')), null);
    permitted = false;
    await assert.rejects(
      invoke(() => service.activityToken('example.docs')),
      /permission denied/,
    );
    assert.equal(scans, 0);
  } finally {
    await root.fiber.dispose();
  }
});

test('change feed validates transport and reauthorizes originals under caller identity', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const service = new PluginSourceService(root, agents);
  const owner = root.extend({
    maka: { rootId: 'profile' as const, packageId: 'changes', entryId: 'changes', generation: 1 },
  });
  let permitted = true;
  const object = { id: 'message', revision: '2', kind: 'message', locator: { id: 'message' } };
  const page = {
    items: [{ id: 'event', group: 'chat', object, content: 'changed' }],
    cursor: '2',
    more: false,
  };
  owner.sources.register({
    ...adapter('changes'),
    changes: async (cursor, limit, caller) => {
      assert.equal(cursor, '1');
      assert.equal(limit, 1);
      assert.equal(caller.invocation?.sessionId, 'test');
      return page;
    },
    authorize: async () => (permitted ? ['message'] : []),
  });
  const abort = new AbortController();
  const invoke = () =>
    agents.withInvocation(
      {
        sessionId: 'test',
        turnId: 'turn',
        cwd: '/tmp',
        toolCallId: 'call',
        abortSignal: abort.signal,
        emitOutput: () => undefined,
      },
      () => service.changes('example.docs', '1', 1),
    );
  try {
    await assert.rejects(service.changes('example.docs', '1', 1));
    const result = await invoke();
    assert.deepEqual(result, page);
    assert.notEqual(result, page);
    permitted = false;
    await assert.rejects(invoke(), /permission denied/);
    permitted = true;
    page.cursor = '';
    await assert.rejects(invoke(), /Invalid source changes/);
    page.cursor = '2';
    abort.abort(Error('cancelled'));
    await assert.rejects(invoke(), /cancelled/);
  } finally {
    await root.fiber.dispose();
  }
});
