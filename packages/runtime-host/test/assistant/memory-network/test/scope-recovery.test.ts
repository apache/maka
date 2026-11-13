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
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './host-fixture.js';

test('stale scope refreshes observations, preserves published contents, and maintenance repairs its range', async (t) => {
  const f = await fixture({ tickMs: 600000 });
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  const first = await f.invoke('MemoryIndexCreate', {
    name: 'Events',
    instructions: 'Organize events',
    cursor: range.to,
    background: false,
  });
  const id = first.index.id;
  const db = new DatabaseSync(join(f.root, 'data/network.sqlite'));
  t.after(() => db.close());
  const rows = () => db.prepare('select * from entries where index_id=?').all(id);
  const saved = rows();
  f.sessions.delete('chat-a');
  f.sessions.set('chat-c', [{ id: 'c', type: 'user', text: 'New requirement' }]);
  const listed = (await f.invoke('MemoryIndexList', {}))[0];
  assert.equal(listed.error.code, 'MEMORY_RANGE_UNAVAILABLE');
  assert.equal(listed.knownPending, null);
  assert.ok(f.reads.includes('chat-c'), 'refresh actually reached the source');
  const worker = JSON.parse(
    String(db.prepare('select payload from workers where index_id=?').get(id)!.payload),
  );
  assert.notEqual(worker.latestCursor, first.coverage.cursor);
  assert.equal(
    db.prepare('select cursor_id from memory_boundaries where index_id=?').get(id)!.cursor_id,
    first.coverage.cursor,
  );
  assert.deepEqual(rows(), saved);
  await assert.rejects(f.invoke('MemoryIndexContent', { indexId: id, view: 'full' }), /visibility/);
  f.setWorkerRunner(async (sessionId) => {
    const info = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId: id });
    assert.equal(info.notes, '', 'notes based on inaccessible originals are not re-exposed');
    const page = await f.invokeAs(sessionId, 'MemoryHistory', {
      from: info.range.from,
      to: info.range.to,
      mode: 'messages',
    });
    assert.ok(page.items.some((x: any) => x.message.text === 'New requirement'));
    assert.ok(!page.items.some((x: any) => x.message.text.includes('equipment vendor')));
    for (const row of saved)
      await f.invokeAs(sessionId, 'MemoryIndexWrite', {
        indexId: id,
        key: row.id,
        text: '',
        expectedRevision: (await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId: id })).index
          .revision,
      });
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId: id,
      rangeId: info.range.rangeId,
      expectedRevision: (await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId: id })).index
        .revision,
      notes: 'Old inaccessible sources excluded',
      complete: true,
    });
  });
  const admission = await f.invoke('MemoryIndexMaintain', { indexId: id, background: true });
  assert.ok(['started', 'reused'].includes(admission.job.status));
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  const repaired = await f.invoke('MemoryIndexRead', { indexId: id });
  assert.equal(repaired.range.completed, true);
  assert.notEqual(repaired.coverage.cursor, first.coverage.cursor);
});

test('unfinished range survives transient failure but renews after visibility changes; stale checkpoints fail', async (t) => {
  const f = await fixture({ tickMs: 600000 });
  t.after(() => f.close());
  let ranges: any[] = [];
  f.setWorkerRunner(async (sessionId, prompt) => {
    const id = /Organize index ([^. ]+)/.exec(prompt)![1];
    ranges.push(await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId: id }));
    // End without checkpoint, simulating an interrupted organizing turn.
    return;
  });
  const range = await f.invoke('MemoryRange', {});
  const first = await f.invoke('MemoryIndexCreate', {
    name: 'Events',
    instructions: 'All events',
    cursor: range.to,
    background: false,
  });
  const id = first.index.id;
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal(ranges[0].range.rangeId, ranges[1].range.rangeId);
  f.sessions.delete('chat-a');
  f.sessions.set('chat-c', [{ id: 'c', type: 'user', text: 'New data' }]);
  const db = new DatabaseSync(join(f.root, 'data/network.sqlite'));
  t.after(() => db.close());
  const work = () =>
    JSON.parse(
      String(
        db.prepare('select payload from memory_work_ranges where index_id=?').get(id)!.payload,
      ),
    );
  const savedWork = work();
  f.setHistoryError(true);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.deepEqual(work(), savedWork, 'failed capture cannot replace unfinished progress');
  f.setHistoryError(false);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.notEqual(ranges[2].range.rangeId, ranges[0].range.rangeId);
  assert.equal(ranges[2].coverage.cursor, null);
  await assert.rejects(
    f.invoke('MemoryIndexCheckpoint', {
      indexId: id,
      rangeId: ranges[0].range.rangeId,
      expectedRevision: 0,
      notes: 'late response',
      complete: true,
    }),
    /superseded/,
  );
});
