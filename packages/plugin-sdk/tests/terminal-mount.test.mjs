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
import { block, fixture, mount } from './terminal-transcript-harness.mjs';

const second = '00000000-0000-4000-8000-000000000002';
const read = (mount, cursor = null) => ({
  resource: 'activity',
  mount,
  fence: 0,
  direction: cursor ? 'older' : 'tail',
  cursor,
});

test('same source in one document owns independent snapshots, cursors and cancellation', async () => {
  const f = await fixture({ blocks: Array.from({ length: 300 }, (_, i) => block(`r${i}`)) });
  const a = await f.open('doc', mount);
  const b = await f.open('doc', second);
  await f.next(a);
  await f.next(b);
  assert.equal(f.store.stats.active, 2);
  const pageA = await f.page(read(mount));
  const pageB = await f.page(read(second));
  assert.equal(pageA.records.length, 256);
  assert.notEqual(pageA.older, pageB.older);
  const denied = await f.invoke('activity.read', read(second, pageA.older));
  assert.equal(denied.code, 'invalid');
  f.store.append(block('r299').key, ' live', '2');
  assert.deepEqual(await f.next(a), await f.next(b));
  assert.equal((await f.page(read(mount))).records.at(-1).block.content.text, 'r299');
  assert.equal((await f.page(read(second))).records.at(-1).block.content.text, 'r299');
  await f.runtime.streamClose(a);
  assert.equal(f.store.stats.active, 1);
  assert.equal((await f.invoke('activity.read', read(mount))).code, 'revoked');
  assert.equal((await f.page(read(second))).records.length, 256);
  f.store.append(block('r299').key, ' still live', '3');
  assert.equal((await f.next(b)).text, ' still live');
  await f.runtime.streamClose(b);
  assert.equal(f.store.stats.closed, 2);
  await f.runtime.dispose();
});

test('mount UUID is mandatory and scoped to the exact caller and document', async () => {
  const f = await fixture({ blocks: [block('one')] });
  await f.open();
  const open = { resource: 'activity', route: null, locale: 'en' };
  assert.equal((await f.invoke('activity.stream', open)).code, 'invalid');
  assert.equal(
    (await f.invoke('activity.read', { resource: 'activity', fence: 0, direction: 'tail' })).code,
    'invalid',
  );
  assert.equal((await f.invoke('activity.read', read(mount), 'other')).code, 'revoked');
  const endpoint = f.registrations.find(({ name }) => name === 'activity.read');
  const foreign = await f.runtime.invoke(endpoint.callback, read(mount), {
    documentId: 'doc',
    clientInstanceId: 'other-client',
    sessionId: null,
  });
  assert.equal(foreign.code, 'revoked');
  assert.equal((await f.invoke('activity.stream', { ...open, mount })).code, 'invalid');
  assert.deepEqual(JSON.parse(JSON.stringify(endpoint.observation)), {
    role: 'transcript_read',
    resource: { ...f.store.resource },
  });
  await f.runtime.dispose();
});
