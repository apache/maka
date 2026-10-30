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
import { intakeFixture } from './intake-fixture.js';

async function setup(t: any, count = 3) {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < count; i++) f.add('event-' + i, '客户材料 ' + i + ' 变化'.repeat(300));
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  const batch = (await f.q.intake.next())!;
  f.q.store.update((s: any) => {
    s.workerSession = 'worker';
    s.active = { id: 'activation', eventBatch: batch, reports: [] };
  });
  return { f, batch };
}
test('wake stays small despite huge legacy background; bodies are read lazily and not consumed', async (t) => {
  const { f, batch } = await setup(t);
  batch.context = { memory: '旧背景'.repeat(100000) };
  const wake = JSON.stringify(f.q.intake.presentation(batch));
  assert.ok(Buffer.byteLength(wake) < 4096);
  assert.doesNotMatch(wake, /客户材料|旧背景/);
  const page = await f.q.intake.read({ batchId: batch.id, limit: 1 }, 'worker');
  assert.equal(page.events.length, 1);
  assert.ok(page.next);
  assert.match(page.events[0].content, /客户材料/);
  assert.deepEqual(await f.q.intake.read({ batchId: batch.id, limit: 1 }, 'worker'), page);
  assert.equal(f.q.intake.remaining(batch).length, batch.ids.length);
});
test('only explicit assessed IDs advance; quiet acknowledgement is idempotent', async (t) => {
  const { f, batch } = await setup(t);
  const input = {
    key: 'one',
    batchId: batch.id,
    processedEventIds: [batch.ids[0]],
    messages: [],
  };
  await f.q.report(input, 'worker');
  await f.q.report(input, 'worker');
  assert.equal(f.q.intake.remaining(batch).length, batch.ids.length - 1);
  assert.equal(f.delivered.size, 0);
  await assert.rejects(
    f.q.report({ ...input, processedEventIds: [batch.ids[1]] }, 'worker'),
    /different/,
  );
  await assert.rejects(
    f.q.report({ ...input, key: 'foreign', processedEventIds: ['new-arrival'] }, 'worker'),
    /outside/,
  );
});
test('permissions and active caller are checked on reads and acknowledgement', async (t) => {
  const { f, batch } = await setup(t);
  await assert.rejects(f.q.intake.read({ batchId: batch.id }, 'owner'), /active/);
  await assert.rejects(f.q.intake.read({ batchId: 'old-batch' }, 'worker'), /active/);
  f.allow(false);
  const page = await f.q.intake.read({ batchId: batch.id }, 'worker');
  assert.equal(page.events.length, 0);
  assert.equal(page.unavailable.length, batch.ids.length);
  await assert.rejects(
    f.q.report(
      {
        key: 'denied',
        batchId: batch.id,
        processedEventIds: batch.ids,
        messages: ['secret'],
      },
      'worker',
    ),
    /permission/,
  );
  assert.equal(f.delivered.size, 0);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='investigated'").get()
      ?.n,
    0,
  );
});
test('report and event acknowledgement roll back together if persistence fails', async (t) => {
  const { f, batch } = await setup(t);
  f.q.store.db.exec(
    "CREATE TRIGGER reject_state BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  );
  await assert.rejects(
    f.q.report(
      {
        key: 'atomic',
        batchId: batch.id,
        processedEventIds: batch.ids,
        messages: ['客户有新要求'],
      },
      'worker',
    ),
    /disk failure/,
  );
  assert.equal(f.q.intake.remaining(batch).length, batch.ids.length);
  assert.equal(f.delivered.size, 0);
  f.q.store.db.exec('DROP TRIGGER reject_state');
});
test('large serialized originals page losslessly, including escaped text and unicode', async (t) => {
  const { f, batch } = await setup(t, 1);
  const text = '汉😀\\"\n'.repeat(20000);
  f.q.store.db
    .prepare("UPDATE intake_events SET payload=json_set(payload,'$.content',?) WHERE id=?")
    .run(text, batch.ids[0]);
  let next: any = { offset: 0, contentOffset: 0 },
    received = '',
    pages = 0;
  while (next) {
    const page = await f.q.intake.read({ batchId: batch.id, ...next }, 'worker');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50000);
    received += page.events[0].content;
    next = page.next;
    pages++;
    assert.ok(pages < 100);
  }
  assert.ok(pages > 1);
  assert.equal(received, text);
});
test('transient source failure leaves records queued, healthy sources remain readable', async (t) => {
  const { f, batch } = await setup(t);
  const original = f.ctx.sources.authorize;
  f.ctx.sources.authorize = async () => {
    throw Error('network outage');
  };
  const page = await f.q.intake.read({ batchId: batch.id }, 'worker');
  assert.equal(page.events.length, 0);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='investigate'").get()
      ?.n,
    batch.ids.length,
  );
  assert.equal(f.q.intake.remaining(batch).length, 0); // no finish-hook polling during outage
  f.ctx.sources.authorize = original;
  assert.equal(
    (await f.q.intake.read({ batchId: batch.id }, 'worker')).events.length,
    batch.ids.length,
  );
});
test('unfinished batch and partial acknowledgements survive restart without replaying completed events', async (t) => {
  const { f, batch } = await setup(t);
  await f.q.report(
    {
      key: 'partial',
      batchId: batch.id,
      processedEventIds: [batch.ids[0]],
      messages: [],
    },
    'worker',
  );
  await f.restart();
  assert.equal(f.q.state().pending.eventBatch.id, batch.id);
  f.q.store.update((s: any) => {
    s.active = s.pending;
    s.pending = null;
  });
  const page = await f.q.intake.read({ batchId: batch.id }, 'worker');
  assert.equal(page.events.filter((e: any) => e.status === 'investigated').length, 1);
  assert.equal(f.q.intake.remaining(batch).length, batch.ids.length - 1);
});
