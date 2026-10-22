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

import { readFileSync } from 'node:fs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, until } from '../../index-initiative/test/fixture.js';
import { MessageCache } from '../../../../../../scripts/plugins/feishu-source/src/message-cache.js';
import { MessageSync } from '../../../../../../scripts/plugins/feishu-source/src/message-sync.js';
import { SyncSchedule } from '../../../../../../scripts/plugins/feishu-source/src/sync-schedule.js';

test('source sync → stale index → fresh original → discovery Inbox → Bot reply → independent task feedback → incremental maintenance', async () => {
  const cwd = process.cwd();

  let f: any;
  try {
    f = await fixture({ matters: true });
  } finally {
    process.chdir(cwd);
  }
  const scope = {
    instanceId: 'closure',
    accountId: 'test-user',
    appId: 'test-app',
    containers: [],
    startTime: 0,
  };
  const cache = new MessageCache(
    join(f.root, 'source-cache'),
    scope,
    Buffer.alloc(32, 1).toString('base64url'),
  );
  const now = Math.floor(Date.now() / 1000);
  let body = '演示环境验收尚未通过',
    reads = 0;
  const sync = new MessageSync(
    cache,
    async (_method, path) => {
      if (path.endsWith('/chats')) return { items: [{ chat_id: 'test-chat' }] };
      if (path.endsWith('/search')) return { items: [] };
      reads++;
      return {
        items: [
          {
            message_id: 'test-message',
            chat_id: 'test-chat',
            create_time: String((now - 100) * 1000),
            msg_type: 'text',
            body: { content: body },
          },
        ],
      };
    },
    async () => {},
  );
  const schedule = new SyncSchedule(sync);
  const source = 'feishu.closure.messages';
  let failure: unknown,
    indexRuns = 0;
  try {
    await sync.sync({ startTime: now - 1000, endTime: now }, { invocation: {} });
    f.ctx
      .extend({
        maka: {
          rootId: 'profile',
          packageId: 'test-source',
          entryId: 'test-source',
          generation: 1,
        },
      })
      .sources.register(cache.source(source, async () => {}));
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setIndexRunner(async ({ index, invoke }: any) => {
      indexRuns++;
      const q = await invoke('MemorySourceQuery', { source, query: {} });
      const original = await invoke('MemoryOriginal', { ref: q.items[0].ref });
      const write = await invoke('MemoryIndexWrite', {
        indexId: index.index.id,
        key: 'acceptance',
        expectedRevision: index.index.revision,
        text: original.content.body.content + ' ' + q.items[0].citation,
      });
      await invoke('MemoryIndexCheckpoint', {
        indexId: index.index.id,
        rangeId: index.range.rangeId,
        expectedRevision: write.revision,
        complete: true,
        notes: '按事件核对原文',
      });
    });
    const range = await f.invoke('MemoryRange', { sources: [source] });
    const created = await f.invoke('MemoryIndexCreate', {
      name: '验收事件',
      instructions: '记录事件进展并引用原文',
      cursor: range.to,
    });
    const id = created.index.id,
      boundary = created.freshness.coveredCursor;
    body = '演示环境验收已通过，离线材料已确认';
    await schedule.control({ action: 'enable' }, { sessionId: 'owner', cwd: f.root });
    await schedule.tick();
    await schedule.control({ action: 'pause' }, { sessionId: 'owner', cwd: f.root });
    assert.ok(schedule.get().lastSuccessAt);
    const observed = await f.invoke('MemoryIndexRead', { indexId: id });
    assert.equal(observed.freshness.coveredCursor, boundary);
    assert.notEqual(observed.freshness.observedCursor, boundary);
    assert.equal(indexRuns, 1, 'source sync and observation do not run index model');
    const count = reads,
      visible: string[] = [];
    f.setRunner(async ({ id: sessionId, prompt, invoke }: any) => {
      try {
        if (prompt.startsWith('Runtime heartbeat')) {
          assert.notEqual(sessionId, 'owner');
          const index = await invoke('MemoryIndexRead', { indexId: id });
          assert.equal(index.freshness.coveredCursor, boundary);
          const q = await invoke('MemorySourceQuery', { source, query: {} });
          const original = await invoke('MemoryOriginal', { ref: q.items[0].ref });
          assert.equal(original.content.body.content, body);
          await invoke('DiscoveryReport', { text: '演示验收和离线材料都已确认，可以准备演示。' });
          return;
        }
        if (prompt.startsWith('Inbox 有新消息')) {
          const inbox = await invoke('InboxCheck', {});
          for (const row of inbox.items) {
            const entry = JSON.parse(row.content);
            const text =
              row.type === 'discovery'
                ? entry
                : entry.status === 'completed'
                  ? '已核对最新原文，委派任务完成。'
                  : undefined;
            if (text) {
              await invoke('SendUser', { messageId: row.id, messages: [{ text }] });
              visible.push(text);
            }
          }
          await invoke('Sleep', {});
          return;
        }
        const context = JSON.parse(
          prompt.split('Matter workspace (paths and host metadata):\n')[1],
        );
        const v = await invoke('MatterRead', { activationId: context.activationId });
        const q = await invoke('MemorySourceQuery', { source, query: {} });
        const original = await invoke('MemoryOriginal', { ref: q.items[0].ref });
        await invoke('MatterWriteFile', {
          path: v.files.draft,
          content: original.content.body.content,
        });
        await invoke('MatterSettle', {
          note: readFileSync(v.files.draft, 'utf8'),
          disposition: 'complete',
          summary: '核对最新验收原文',
          reason: '验收及材料均确认',
          update: '演示验收和材料核对完成。',
        });
      } catch (e) {
        failure = e;
        throw e;
      }
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(
      async () => failure || (!(await f.invoke('InitiativeStatus')).active && visible.length === 1),
    );
    if (failure) throw failure;
    await f.invoke('InitiativeControl', { action: 'pause' });
    assert.equal(reads, count, 'memory reads do not implicitly scan remote chat history');
    const task = await f.invoke('MatterDelegate', {
      taskKey: 'acceptance',
      title: '验收确认',
      request: '核对最新演示验收与材料，确认完成后告诉我',
    });
    await until(
      async () =>
        failure || (await f.invoke('MatterTasks', { id: task.id })).status === 'completed',
    );
    if (failure) throw failure;
    await until(() => visible.length === 2);
    await until(async () => (await f.invoke('MatterOverview')).notifications.length === 0);
    await f.invoke('MemoryIndexMaintain', { indexId: id });
    assert.equal(indexRuns, 2);
    assert.notEqual(
      (await f.invoke('MemoryIndexRead', { indexId: id })).freshness.coveredCursor,
      boundary,
    );
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false);
  } finally {
    await schedule.close();
    await sync.close();
    await f.close();
    cache.close();
  }
});
