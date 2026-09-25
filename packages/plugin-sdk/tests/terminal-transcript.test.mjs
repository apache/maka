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
import test from 'node:test';
import { block, fixture, logicalPage, size } from './terminal-transcript-harness.mjs';

test('v5 builders and immutable document snapshots with contiguous semantic changes', async () => {
  const original = block('first', '你好');
  const f = await fixture({ blocks: [original] });
  original.content.text = 'caller changed its input';
  assert.equal(
    f.tui.view({
      title: 'Activity',
      revision: '1',
      root: f.tui.transcript('body', f.store.resource),
    }).version,
    5,
  );
  const handle = await f.open();
  assert.deepEqual(await f.next(handle), { kind: 'ready', fence: 0 });
  f.store.append(original.key, ' 🚀', '2');
  f.store.replace(block('second'));
  f.store.replace(block('first', 'updated', '3'));
  f.store.timing({ turn: 'turn', start_ms: 1, end: { at_ms: 2, outcome: 'completed' } });
  f.store.remove(block('second').key);
  const append = await f.next(handle);
  assert.equal(append.kind, 'append');
  assert.equal(append.offset, 6);
  assert.equal(append.block_base, '1');
  assert.equal(append.block_revision, '2');
  assert.equal((await f.next(handle)).append, true);
  const replace = await f.next(handle);
  assert.equal(replace.append, false);
  assert.equal(replace.base, 2);
  assert.equal(replace.revision, 3);
  assert.equal((await f.next(handle)).kind, 'timing');
  assert.equal((await f.next(handle)).kind, 'remove');
  const old = await logicalPage(f, 0);
  assert.equal(old.records[0].content.text, '你好');
  const other = await f.open('other');
  assert.deepEqual(await f.next(other), { kind: 'ready', fence: 5 });
  assert.equal((await logicalPage(f, 5, 'tail', null, 'other')).records[0].content.text, 'updated');
  const denied = await f.invoke(
    'activity.read',
    { resource: 'activity', fence: 0, direction: 'tail' },
    'stranger',
  );
  assert.equal(denied.code, 'revoked');
  assert.equal(
    (await f.invoke('activity.read', { resource: 'different', fence: 0, direction: 'tail' })).code,
    'revoked',
  );
  await f.runtime.dispose();
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 2);
});

test('bounded history windows, Unicode JSON fragments and document-bound replayable cursors', async () => {
  const big = block('big', '# Unicode\n' + '𠮷 \"quoted\" 文本\n'.repeat(20000));
  const f = await fixture({
    blocks: [...Array.from({ length: 300 }, (_, i) => block(`h${i}`)), big],
  });
  await f.open();
  await f.open('other');
  const tail = await logicalPage(f, 0);
  assert.equal(tail.records.length, 256);
  assert.deepEqual(tail.records.at(-1), big);
  assert.ok(tail.older);
  const bad = await f.invoke(
    'activity.read',
    { resource: 'activity', fence: 0, direction: 'older', cursor: tail.older },
    'other',
  );
  assert.equal(bad.code, 'invalid');
  const older = await logicalPage(f, 0, 'older', tail.older);
  assert.equal(older.records.length, 45);
  assert.equal(older.records[0].key.message, 'h0');
  assert.equal(older.older, null);
  const newer = await logicalPage(f, 0, 'newer', older.newer);
  assert.deepEqual(newer.records, tail.records);
  await f.runtime.dispose();
});

test('single large record exceeds the 4 MiB page budget without truncation', async () => {
  const big = block('big', '界'.repeat(1500000));
  const f = await fixture({ blocks: [block('before'), big, block('after')] });
  await f.open();
  const tail = await logicalPage(f, 0);
  assert.deepEqual(
    tail.records.map((entry) => entry.key.message),
    ['after'],
  );
  const middle = await logicalPage(f, 0, 'older', tail.older);
  assert.deepEqual(middle.records, [big]);
  assert.ok(middle.older);
  assert.ok(middle.newer);
  await f.runtime.dispose();
});

test('large live replacement uses ordered fragments with one stream revision', async () => {
  const f = await fixture();
  const handle = await f.open();
  await f.next(handle);
  const big = block('big', '😀 \"\n'.repeat(20000));
  f.store.replace(big);
  let json = '';
  for (;;) {
    const event = await f.next(handle);
    assert.ok(size(event) < 64 * 1024);
    assert.equal(event.kind, 'replace');
    assert.equal(event.append, true);
    assert.equal(event.base, 0);
    assert.equal(event.revision, 1);
    assert.equal(event.record.offset, Buffer.byteLength(json));
    assert.ok(Buffer.byteLength(event.record.json) <= 8192);
    json += event.record.json;
    if (Buffer.byteLength(json) === event.record.total) break;
  }
  assert.deepEqual(JSON.parse(json), big);
  await f.runtime.dispose();
});

test('cancel unblocks Next, retires cursors and closes exactly once', async () => {
  const f = await fixture({ blocks: [block('one')] });
  const handle = await f.open();
  await f.next(handle);
  const pending = f.next(handle);
  await f.runtime.streamClose(handle);
  assert.equal(await pending, null);
  await f.runtime.streamClose(handle);
  assert.equal(f.store.stats.closed, 1);
  assert.equal(
    (await f.invoke('activity.read', { resource: 'activity', fence: 0, direction: 'tail' })).code,
    'revoked',
  );
  await f.store.close();
  await f.store.close();
  assert.throws(() => f.store.replace(block('two')), { code: 'revoked' });
  await f.runtime.dispose();
});

test('slow readers are invalidated on queue overflow, never silently skipped', async () => {
  const f = await fixture({ blocks: [block('live', '')] });
  const handle = await f.open();
  await f.next(handle);
  for (let i = 2; i <= 8195; i++) f.store.append(block('live').key, 'x', String(i));
  assert.deepEqual(await f.next(handle), { kind: 'invalidated' });
  assert.equal(await f.next(handle), null);
  assert.equal(f.store.stats.invalidated, 1);
  assert.equal(f.store.stats.active, 0);
  assert.equal(
    (await f.invoke('activity.read', { resource: 'activity', fence: 0, direction: 'tail' })).code,
    'revoked',
  );
  await f.runtime.dispose();
});

test('partial registration failure withdraws the page method', async () => {
  const f = await fixture({}, async (ctx) => {
    for (let i = 0; i < 127; i++) await ctx.remote.method(`seed${i}`, () => null);
    await assert.rejects(ctx.tui.transcriptResource('activity'), /capacity/);
    return null;
  });
  assert.equal(f.registrations.length, 127);
  assert.equal(
    f.registrations.some((entry) => entry.name === 'activity.read'),
    false,
  );
  await f.runtime.dispose();
});

test('invalid semantic ranges and ambiguous revisions are rejected before publishing', async () => {
  const f = await fixture({ blocks: [block('one', '你好')] });
  assert.throws(() => f.store.replace(block('one', 'changed')), /new revision/);
  assert.throws(
    () =>
      f.store.replace({
        ...block('bad', '你好'),
        content: { text: '你好', emphasis: { start: 1, end: 3 } },
      }),
    /UTF-8 range/,
  );
  assert.throws(() => f.store.replace({ ...block('tool'), kind: 'tool' }), /kind/);
  assert.equal(f.store.stats.updates, 0);
  await f.runtime.dispose();
});

test('the external Board fixture exposes paged activity without token-driven View changes', async () => {
  const { default: activate } = await import(
    '../../../crates/cli/tests/fixtures/board-plugin/host.mjs'
  );
  const f = await fixture({}, activate);
  const descriptor = f.registrations.find((entry) => entry.name === 'board').terminalView;
  assert.equal(descriptor.version, 5);
  const view = await f.invoke('board', { kind: 'read', route: { activity: true }, locale: 'en' });
  assert.equal(view.value.view.version, 5);
  const resource = view.value.view.root.children.find(
    (node) => node.kind === 'transcript',
  ).resource;
  assert.equal(resource.id, 'board-activity');
  const opened = await f.invoke(resource.stream, {
    resource: resource.id,
    route: null,
    locale: 'en',
  });
  assert.equal(opened.kind, 'value');
  const handle = opened.value;
  assert.deepEqual(await f.next(handle), { kind: 'ready', fence: 0 });
  let page = (await f.invoke(resource.read, { resource: resource.id, fence: 0, direction: 'tail' }))
    .value;
  let fragments = 0;
  const tools = [];
  for (;;) {
    assert.ok(size(page) < 64 * 1024);
    fragments += page.records.filter((record) => record.kind === 'fragment').length;
    tools.push(
      ...page.records.filter((record) => record.kind === 'block' && record.block.kind === 'tool'),
    );
    if (!page.continuation) break;
    page = (
      await f.invoke(resource.read, {
        resource: resource.id,
        fence: 0,
        direction: 'continue',
        cursor: page.continuation,
      })
    ).value;
  }
  assert.ok(fragments > 1);
  assert.ok(page.older);
  assert.equal(tools.length, 2);
  assert.ok(tools.every((record) => record.block.affinity === 'read'));
  const stats = async () => (await f.invoke('activity-stats', null)).value;
  const before = await stats();
  assert.ok(before.reportBytes > 64 * 1024);
  await f.invoke('activity-append', 'Streaming **Unicode** — 继续 🚀');
  const update = await f.next(handle);
  assert.equal(update.kind, 'append');
  assert.equal(update.text, 'Streaming **Unicode** — 继续 🚀');
  assert.equal((await stats()).viewReads, before.viewReads);
  await f.runtime.streamClose(handle);
  const after = await stats();
  assert.equal(after.active, 0);
  assert.equal(after.closed, 1);
  await f.runtime.dispose();
});
