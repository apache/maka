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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './host-fixture.js';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

async function setup(t: any) {
  const f = await fixture();
  t.after(() => f.close());
  const state = {
    reads: [] as string[],
    allowed: true,
    active: 0,
    peak: 0,
    fail: false,
    scopeVersion: 1,
    revokeDuringRead: false,
    changeScopeDuringRead: false,
  };
  const objects = Array.from({ length: 24 }, (_, i) => ({
    id: `m${i}`,
    revision: '1',
    kind: 'message',
    title: '群聊',
    updatedAt: i + 1,
    locator: { id: `m${i}` },
  }));
  for (const source of ['one', 'two'])
    f.sources.register({
      id: source,
      description: source,
      queryHelp: 'cursor',
      get scope() {
        return { room: source, version: state.scopeVersion };
      },
      enumerate: async () => ({ items: objects }),
      query: async (q: any) => {
        state.peak = Math.max(state.peak, ++state.active);
        await new Promise((r) => setTimeout(r, 10));
        state.active--;
        if (source === 'two' && state.fail) throw Error('Offline');
        return q.cursor
          ? { items: objects.slice(20) }
          : { items: objects.slice(0, 20), next: '20' };
      },
      authorize: async (items: any[]) => (state.allowed ? items.map((o) => o.id) : []),
      read: async (object: any) => {
        state.reads.push(source + ':' + object.id);
        if (state.revokeDuringRead) state.allowed = false;
        if (state.changeScopeDuringRead) state.scopeVersion++;
        return {
          status: 'ok',
          object,
          content:
            object.id === 'm23'
              ? '长正文'.repeat(2000)
              : `完整消息 ${object.id} ` + '正文'.repeat(40),
        };
      },
    });
  return { f, state, objects };
}

test('content queries batch sources concurrently, page whole records, resume after restart and preserve refs', async (t) => {
  const { f, state } = await setup(t);
  let result = await f.invoke('MemorySourceQuery', {
    queries: [{ source: 'one' }, { source: 'two' }],
    maxChars: 1500,
  });
  assert.equal(state.peak, 2);
  const seen: any[] = [];
  const page = result.nextPage;
  assert.ok(page);
  assert.match(result.items[0].content, /完整消息/);
  assert.equal(result.items[0].locator, undefined);
  assert.equal(result.items[0].citation, undefined);
  await f.remote('matters.authorize-session', { sessionId: 'another' });
  await assert.rejects(
    f.invokeAs('another', 'MemorySourceQuery', { page }),
    /another operation or session/,
  );
  await f.restart();
  const replay = await f.invoke('MemorySourceQuery', { page, maxChars: 1500 });
  assert.deepEqual(
    replay.items,
    (await f.invoke('MemorySourceQuery', { page, maxChars: 1500 })).items,
  );
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
    seen.push(...result.items);
    if (!result.nextPage) break;
    result = await f.invoke('MemorySourceQuery', {
      page: result.nextPage,
      maxChars: 1500,
    });
  }
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen.map((x) => x.ref)).size, 40);
  assert.ok(seen.every((x) => x.status === 'ok' && !x.truncated));
  assert.deepEqual(
    result.sources.map((x: any) => x.next),
    ['20', '20'],
  );
  const next = await f.invoke('MemorySourceQuery', {
    source: 'one',
    query: { cursor: '20' },
    view: 'content',
  });
  assert.equal(next.items[0].content.startsWith('完整消息 m20'), true);
  const legacy = await f.invoke('MemoryOriginal', { ref: seen[0].ref });
  assert.equal(legacy.content, seen[0].content);
  state.allowed = false;
  const denied = await f.invoke('MemorySourceQuery', { page });
  assert.ok(denied.items.every((x: any) => x.status === 'error' && x.content === undefined));
});

test('batch read failures stay explicit; long originals can be reconstructed without losing content', async (t) => {
  const { f, state } = await setup(t);
  state.fail = true;
  const result = await f.invoke('MemorySourceQuery', {
    queries: [{ source: 'one' }, { source: 'two' }],
  });
  assert.match(result.sources[1].error, /Offline/);
  assert.ok(result.items.length);
  const found = await f.invoke('MemorySourceQuery', {
    source: 'one',
    query: { cursor: '20' },
  });
  const ref = found.items.at(-1).ref;
  let offset = 0,
    text = '';
  for (;;) {
    const page = await f.invoke('MemoryOriginal', {
      ref,
      view: 'content',
      offsetChars: offset,
      maxChars: 1000,
    });
    const item = page.items[0];
    assert.equal(item.offsetChars, offset);
    text += item.content;
    if (item.nextOffsetChars === null) break;
    assert.ok(item.nextOffsetChars > offset);
    offset = item.nextOffsetChars;
  }
  assert.equal(text, '长正文'.repeat(2000));
  const batch = await f.invoke('MemoryOriginal', {
    refs: found.items.slice(0, 2).map((x: any) => x.ref),
  });
  assert.equal(batch.items.length, 2);
  assert.ok(batch.items.every((x: any) => x.content.startsWith('完整消息')));
});

test('history metadata pagination reads only the requested late page; keyword offsets stay correct', async (t) => {
  const { f, state } = await setup(t);
  const range = await f.invoke('MemoryRange', { sources: ['one'] });
  const page = await f.invoke('MemoryHistory', {
    to: range.to,
    source: 'one',
    mode: 'messages',
    offset: 20,
    limit: 1,
  });
  assert.equal(page.items.length, 1);
  assert.equal(
    state.reads.length,
    1,
    'earlier bodies must not be fetched for a metadata-only offset',
  );
  const all = await f.invoke('MemoryHistory', {
    to: range.to,
    source: 'one',
    mode: 'messages',
    limit: 100,
  });
  assert.equal(page.items[0].ref, all.items[20].ref);
  const query = await f.invoke('MemoryHistory', {
    to: range.to,
    source: 'one',
    mode: 'messages',
    query: '完整消息',
    offset: 2,
    limit: 2,
  });
  const expected = all.items
    .filter((x: any) => JSON.stringify(x.message).includes('完整消息'))
    .slice(2, 4);
  assert.deepEqual(query.items, expected);
});

test('continued reads reject scope changes and read-time permission revocation', async (t) => {
  const { f, state } = await setup(t);
  const result = await f.invoke('MemorySourceQuery', {
    source: 'one',
    view: 'content',
    maxChars: 1000,
  });
  assert.ok(result.nextPage);
  state.scopeVersion++;
  await assert.rejects(f.invoke('MemorySourceQuery', { page: result.nextPage }), /scope changed/);
  state.revokeDuringRead = true;
  const denied = await f.invoke('MemorySourceQuery', { source: 'two', view: 'content' });
  assert.ok(denied.items.length);
  assert.ok(denied.items.every((x: any) => x.status === 'error' && x.content === undefined));
});

test('scope changes during a body read cannot return the old scoped batch', async (t) => {
  const { f, state } = await setup(t);
  state.changeScopeDuringRead = true;
  await assert.rejects(
    f.invoke('MemorySourceQuery', { source: 'one', view: 'content' }),
    /scope changed/,
  );
});

test('large requested character budgets still fit the runtime byte limit with Chinese and continuation metadata', async (t) => {
  const { f } = await setup(t);
  let result = await f.invoke('MemorySourceQuery', {
    queries: [{ source: 'one' }, { source: 'two' }],
    maxChars: 24000,
  });
  const refs = new Set<string>();
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
    for (const item of result.items) {
      assert.ok(!item.truncated);
      refs.add(item.ref);
    }
    if (!result.nextPage) break;
    result = await f.invoke('MemorySourceQuery', { page: result.nextPage, maxChars: 24000 });
  }
  assert.equal(refs.size, 40);
});

for (const tool of ['MemorySourceQuery', 'MemoryOriginal']) {
  for (const maxChars of [1000, 24000]) {
    test(`${tool} rechecks completed reads after another source waits (budget ${maxChars})`, {
      timeout: 10000,
    }, async (t) => {
      const f = await fixture();
      t.after(() => f.close());
      let allowed = true,
        readOne = false;
      let release!: () => void, firstChecked!: () => void, secondStarted!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checked = new Promise<void>((resolve) => {
        firstChecked = resolve;
      });
      const started = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      t.after(release);
      for (const id of ['fast', 'slow']) {
        const object = { id, revision: '1', kind: 'message', title: id, locator: { id } };
        f.sources.register({
          id,
          description: id,
          queryHelp: '{}',
          scope: { room: id },
          enumerate: async () => ({ items: [object] }),
          query: async () => ({ items: [object] }),
          authorize: async (objects: any[]) => {
            const ids = id === 'fast' && !allowed ? [] : objects.map((o) => o.id);
            // Signal after the first body's individual post-I/O check has completed.
            if (id === 'fast' && readOne) setImmediate(firstChecked);
            return ids;
          },
          read: async () => {
            if (id === 'slow') {
              secondStarted();
              await waiting;
            } else readOne = true;
            return { status: 'ok', object, content: `${id}-private-body ` + 'x'.repeat(500) };
          },
        });
      }
      const refs: string[] = [];
      for (const source of ['fast', 'slow']) {
        const page = await f.invoke('MemorySourceQuery', { source });
        refs.push(page.items[0].ref);
      }
      const input =
        tool === 'MemorySourceQuery'
          ? { queries: [{ source: 'fast' }, { source: 'slow' }], maxChars }
          : { refs, maxChars };
      const pending = f.invoke(tool, input);
      try {
        await Promise.all([checked, started]);
        allowed = false;
        assert.deepEqual((await f.invoke('MemorySourceQuery', { source: 'fast' })).items, []);
        const rejected = assert.rejects(pending, /permission changed before batch return/);
        release();
        await rejected;
        const db = new DatabaseSync(join(f.root, 'data/network.sqlite'), { readOnly: true });
        try {
          assert.equal(db.prepare('SELECT count(*) AS n FROM memory_read_pages').get()!.n, 0);
        } finally {
          db.close();
        }
        allowed = true;
        const retry = await f.invoke(tool, input);
        assert.match(retry.items[0].content, /fast-private-body/);
        assert.equal(!!retry.nextPage, maxChars === 1000);
      } finally {
        release();
        await pending.catch(() => {});
      }
    });
  }
}
