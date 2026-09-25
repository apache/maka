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
import { block, fixture, logicalPage } from './terminal-transcript-harness.mjs';

const token = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const read = (i, fence = 0) => ({
  resource: 'activity',
  mount: token(i),
  fence,
  direction: 'tail',
});
const open = (i) => ({ resource: 'activity', mount: token(i), route: null, locale: 'en' });
const value = (reply) => {
  assert.equal(reply.kind, 'value', reply.message);
  return reply.value;
};

test('more than 32 same-source readers page independently and preserve exact mount identity', async (t) => {
  const f = await fixture({ blocks: [block('one')] });
  t.after(() => f.runtime.dispose());
  const handles = [];
  for (let i = 0; i < 40; i++) {
    handles.push(await f.open('doc', token(i)));
    assert.deepEqual(await f.next(handles[i]), { kind: 'ready', fence: 0 });
    assert.equal((await f.page(read(i))).records[0].block.content.text, 'one');
    assert.equal(f.store.stats.active, i + 1);
  }
  const denied = await f.invoke('activity.stream', open(0));
  assert.equal(denied.code, 'invalid');
  assert.match(denied.message, /already open/);
  assert.equal(f.store.stats.opened, 40);
  await f.runtime.streamClose(handles[4]);
  assert.equal(f.store.stats.active, 39);
  assert.equal((await f.invoke('activity.read', read(4))).code, 'revoked');
  const replacement = await f.open('doc', token(40));
  assert.deepEqual(await f.next(replacement), { kind: 'ready', fence: 0 });
  assert.equal((await f.page(read(40))).records[0].block.content.text, 'one');
  await Promise.all([...handles, replacement].map((handle) => f.runtime.streamClose(handle)));
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.opened, 41);
  assert.equal(f.store.stats.closed, 41);
});

test('page changes, transcript and ordinary streams remain available beyond the old stream limit', async (t) => {
  let changed;
  let probes = 0;
  const f = await fixture({}, async ({ tui, remote }) => {
    changed = await tui.changes('changed');
    await remote.stream('probe', () => {
      probes++;
      return {
        next: () => ({ done: true }),
        cancel() {},
        close() {
          probes--;
        },
      };
    });
    return tui.transcriptResource('activity', { blocks: [block('one')] });
  });
  t.after(() => f.runtime.dispose());
  const readers = [];
  const changes = [];
  const extra = [];
  for (let i = 0; i < 40; i++) {
    changes.push(value(await f.invoke('changed', null, `page-${i}`)));
    readers.push(await f.open(`page-${i}`, token(i)));
    assert.deepEqual(await f.next(readers[i]), { kind: 'ready', fence: 0 });
  }
  assert.equal(f.store.stats.active, 40);
  changed();
  assert.deepEqual(
    await Promise.all(changes.map((handle) => f.next(handle))),
    Array(40).fill(null),
  );
  f.store.append(block('one').key, ' live', '2');
  for (const handle of readers) assert.equal((await f.next(handle)).text, ' live');
  for (let i = 0; i < 80; i++) extra.push(value(await f.invoke('probe', null)));
  assert.equal(probes, 80);
  await f.runtime.streamClose(extra.pop());
  extra.push(value(await f.invoke('probe', null)));
  const pending = [...changes, ...readers].map((handle) => f.next(handle));
  const handles = [...changes, ...readers, ...extra];
  await Promise.all(handles.map((handle) => f.runtime.streamClose(handle)));
  assert.deepEqual(await Promise.all(pending), Array(80).fill(null));
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 40);
  assert.equal(probes, 0);
  for (const handle of handles) await assert.rejects(f.runtime.streamNext(handle), /closed/);
  const reopened = [];
  for (let i = 0; i < 160; i++) reopened.push(value(await f.invoke('probe', null)));
  assert.equal(probes, 160, 'every closed stream released its source');
  await Promise.all(reopened.map((handle) => f.runtime.streamClose(handle)));
  assert.equal(probes, 0);
});

test('a large Replace broadcasts one fragment set while preserving snapshots and cancellation', async (t) => {
  let decoded = 0;
  class Decoder extends TextDecoder {
    decode(...args) {
      decoded++;
      return super.decode(...args);
    }
  }
  const f = await fixture({ blocks: [block('one')] }, undefined, Decoder);
  t.after(() => f.runtime.dispose());
  const handles = [];
  for (let i = 0; i < 32; i++) {
    handles.push(await f.open('doc', token(i)));
    await f.next(handles[i]);
  }
  const large = block('one', '界🚀'.repeat(150000), '2');
  f.store.replace(large);
  const fragmentDecodes = decoded;
  let json = '';
  let fragments = 0;
  let retired;
  for (;;) {
    const event = await f.next(handles[0]);
    assert.equal(event.kind, 'replace');
    assert.equal(event.base, 0);
    assert.equal(event.revision, 1);
    assert.equal(event.record.offset, Buffer.byteLength(json));
    for (let i = 1; i < handles.length; i++) {
      if (i !== retired) assert.deepEqual(await f.next(handles[i]), event);
    }
    json += event.record.json;
    fragments++;
    if (retired === undefined) {
      retired = 7;
      await f.runtime.streamClose(handles[retired]);
      assert.equal(f.store.stats.active, 31);
      assert.equal((await f.invoke('activity.read', read(retired))).code, 'revoked');
    }
    if (Buffer.byteLength(json) === event.record.total) break;
  }
  assert.ok(fragments > 100);
  assert.deepEqual(JSON.parse(json), large);
  assert.equal(fragmentDecodes, fragments, 'decode once per fragment, independent of reader count');
  for (let i = 0; i < handles.length; i++) {
    if (i !== retired) assert.equal((await f.page(read(i))).records[0].block.content.text, 'one');
  }
  const replacement = await f.open('doc', token(32));
  assert.deepEqual(await f.next(replacement), { kind: 'ready', fence: 1 });
  assert.deepEqual((await logicalPage(f, 1, 'tail', null, 'doc', token(32))).records, [large]);
  await Promise.all([...handles, replacement].map((handle) => f.runtime.streamClose(handle)));
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 33);
});

test('slow-reader overflow leaves a consuming reader and its shared updates live', async (t) => {
  const f = await fixture({ blocks: [block('one', '')] });
  t.after(() => f.runtime.dispose());
  const handles = [];
  for (let i = 0; i < 40; i++) {
    handles.push(await f.open('doc', token(i)));
    await f.next(handles[i]);
  }
  for (let revision = 1; revision <= 8193; revision++) {
    f.store.append(block('one').key, 'x', String(revision + 1));
    const event = await f.next(handles[0]);
    assert.equal(event.kind, 'append');
    assert.equal(event.base, revision - 1);
    assert.equal(event.revision, revision);
  }
  assert.equal(f.store.stats.active, 1);
  assert.equal(f.store.stats.invalidated, 39);
  for (const handle of handles.slice(1)) {
    assert.deepEqual(await f.next(handle), { kind: 'invalidated' });
    assert.equal(await f.next(handle), null);
  }
  f.store.append(block('one').key, ' continuing', '8195');
  assert.equal((await f.next(handles[0])).text, ' continuing');
  await Promise.all(handles.map((handle) => f.runtime.streamClose(handle)));
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 40);
});

test('historical versions count once and retire oldest snapshots without losing current data', async (t) => {
  const text = '界'.repeat(3 * 1024 * 1024);
  const f = await fixture({
    blocks: [block('one', text)],
    timings: [{ turn: 'turn', start_ms: 1 }],
  });
  t.after(() => f.runtime.dispose());
  const handles = [];
  const reader = async (i, fence) => {
    const handle = await f.open('doc', token(i));
    handles.push(handle);
    assert.deepEqual(await f.next(handle), { kind: 'ready', fence });
    return handle;
  };
  const replace = (revision) => {
    f.store.replace(block('one', text, String(revision)));
    f.store.timing({ turn: 'turn', start_ms: revision });
  };
  await reader(0, 0);
  await reader(1, 0);
  replace(2);
  await reader(2, 2);
  replace(3);
  const fast = await reader(3, 4);
  assert.equal(f.store.stats.invalidated, 0, 'two readers share the same old version budget');
  replace(4);
  assert.equal(f.store.stats.invalidated, 2);
  assert.equal(f.store.stats.active, 2);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await f.next(handles[i]), { kind: 'invalidated' });
    assert.equal((await f.invoke('activity.read', read(i))).code, 'revoked');
  }
  const event = await f.next(fast);
  assert.equal(event.kind, 'replace');
  assert.equal(event.base, 4);
  assert.equal(event.revision, 5);
  assert.equal(event.record.revision, '4');
  assert.equal((await f.page(read(2, 2))).records[0].revision, '2');
  await reader(4, 6);
  const current = await logicalPage(f, 6, 'tail', null, 'doc', token(4));
  assert.equal(current.records[0].revision, '4');
  assert.equal(current.records[0].content.text, text);
  assert.deepEqual(current.timings, [{ turn: 'turn', start_ms: 4 }]);
  await Promise.all(handles.map((handle) => f.runtime.streamClose(handle)));
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 5);
  await reader(5, 6);
  replace(5);
  await reader(6, 8);
  replace(6);
  assert.equal(f.store.stats.active, 2);
  assert.equal(f.store.stats.invalidated, 2, 'released versions no longer consume the budget');
  await f.store.close();
  await f.store.close();
  assert.throws(() => f.store.timing({ turn: 'turn', start_ms: 7 }), { code: 'revoked' });
  assert.equal(f.store.stats.active, 0);
  assert.equal(f.store.stats.closed, 7);
});
