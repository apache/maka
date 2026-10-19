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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageCache } from '../src/message-cache.js';
import { MessageSync } from '../src/message-sync.js';
import { SyncSchedule } from '../src/sync-schedule.js';
const scope = {
  instanceId: 'scheduled',
  accountId: 'user',
  appId: 'app',
  containers: [],
  startTime: 0,
};
const call = { sessionId: 'assistant', cwd: '/tmp', abortSignal: new AbortController().signal };
function due(cache: MessageCache) {
  cache.db.exec("UPDATE sync_schedule SET payload=json_set(payload,'$.nextAt',0)");
}
test('an expired scheduler cannot overwrite its successor or publish a stale page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-fencing-'));
  const cache = new MessageCache(dir, scope, Buffer.alloc(32, 1).toString('base64url'));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const api = (stale: boolean) => async (_method: any, path: string) => {
    if (path.endsWith('/chats')) {
      if (stale) {
        entered();
        await gate;
      }
      return { items: [{ chat_id: 'c' }] };
    }
    if (path.endsWith('/search')) return { items: [] };
    return {
      items: [
        {
          message_id: stale ? 'stale' : 'current',
          chat_id: 'c',
          create_time: String(Date.now() - 60000),
          msg_type: 'text',
          body: { content: 'evidence' },
        },
      ],
    };
  };
  const firstSync = new MessageSync(cache, api(true), async () => {});
  const secondSync = new MessageSync(cache, api(false), async () => {});
  const first = new SyncSchedule(firstSync),
    second = new SyncSchedule(secondSync);
  try {
    await first.control({ action: 'enable' }, call);
    await started;
    cache.db.exec('UPDATE sync_schedule_lease SET until_at=0');
    await second.tick();
    const boundary = cache.boundary();
    assert.equal(boundary, 1);
    release();
    await first.tick();
    assert.equal(cache.boundary(), boundary);
    assert.deepEqual(
      cache.rows().map((row: any) => row.id),
      ['current'],
    );
    assert.equal(second.get().error, null);
    assert.ok(second.get().lastSuccessAt);
  } finally {
    release();
    await first.close();
    await second.close();
    await firstSync.close();
    await secondSync.close();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('default off; failed page survives reload; only complete batches publish; no replay storm after downtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-schedule-'));
  const cache = new MessageCache(dir, scope, Buffer.alloc(32, 1).toString('base64url'));
  let failure = true,
    requests: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const api = async (_method: any, path: string, params: any) => {
    requests.push(path + ':' + (params.page_token ?? ''));
    if (path.endsWith('/chats')) return { items: [{ chat_id: 'c' }] };
    if (path.endsWith('/search')) return { items: [] };
    if (params.page_token === 'second' && failure) throw Error('503 temporary source outage');
    return {
      items: params.page_token
        ? []
        : [
            {
              message_id: 'm',
              chat_id: 'c',
              create_time: String((now - 60) * 1000),
              body: { content: 'new evidence' },
              msg_type: 'text',
            },
          ],
      ...(params.page_token ? {} : { has_more: true, page_token: 'second' }),
    };
  };
  const sync = new MessageSync(cache, api, async () => {});
  let scheduler = new SyncSchedule(sync);
  try {
    await scheduler.tick();
    assert.equal(requests.length, 0);
    await scheduler.control({ action: 'enable' }, call);
    await scheduler.tick();
    const first = scheduler.get();
    assert.ok(first.error);
    assert.ok(first.pendingRange);
    assert.equal(cache.boundary(), 0);
    await scheduler.close();
    scheduler = new SyncSchedule(sync);
    failure = false;
    requests = [];
    due(cache);
    await scheduler.tick();
    assert.ok(scheduler.get().lastSuccessAt);
    assert.equal(scheduler.get().error, null);
    assert.equal(requests.filter((x) => x.endsWith('/chats:')).length, 0);
    assert.ok(requests.some((x) => x.endsWith('/messages:second')));
    assert.equal(cache.boundary(), 1);
    const before = requests.length;
    await scheduler.tick();
    assert.equal(requests.length, before);
    // One overdue check covers the gap, not one replay for every missed interval.
    due(cache);
    await scheduler.tick();
    const after = requests.length;
    await scheduler.tick();
    assert.equal(requests.length, after);
    await scheduler.control({ action: 'pause' }, call);
    due(cache);
    await scheduler.tick();
    assert.equal(requests.length, after);
    await scheduler.control({ action: 'check' }, call);
    await scheduler.tick();
    assert.equal(scheduler.get().enabled, false);
    assert.equal(scheduler.get().checkRequested, false);
  } finally {
    await scheduler.close();
    await sync.close();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('changed source scope disables old schedule without deleting published data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-scope-'));
  const key = Buffer.alloc(32, 1).toString('base64url');
  let cache = new MessageCache(dir, scope, key);
  let sync = new MessageSync(
      cache,
      async () => ({ items: [] }),
      async () => {},
    ),
    scheduler = new SyncSchedule(sync);
  try {
    await scheduler.control({ action: 'enable' }, call);
    await scheduler.tick();
    await scheduler.close();
    await sync.close();
    cache.close();
    cache = new MessageCache(dir, { ...scope, containers: [{ type: 'chat', id: 'other' }] }, key);
    let calls = 0;
    sync = new MessageSync(
      cache,
      async () => {
        calls++;
        return { items: [] };
      },
      async () => {},
    );
    scheduler = new SyncSchedule(sync);
    assert.equal(scheduler.get().enabled, false);
    assert.equal(scheduler.get().scopeChanged, true);
    await scheduler.tick();
    assert.equal(calls, 0);
    await scheduler.control({ action: 'enable' }, call);
    await scheduler.tick();
    assert.equal(scheduler.get().scopeChanged, undefined);
  } finally {
    await scheduler.close();
    await sync.close();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
