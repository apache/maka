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

import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createWorkHubVoiceQueueTools } from '../server/workhub-voice-queue-tools.js';
import {
  decodeVoiceDelivery,
  decodeVoiceState,
  decodeVoiceObservation,
} from '../protocol/workhub-voice-state.js';
import { VOICE_QUEUE_FILENAME, WorkHubVoiceStateStore } from '../server/workhub-voice-state.js';
const item = (id: string, text = id) => ({ id, text, context: 'private' });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'voice-queue-'));
  const store = new WorkHubVoiceStateStore(join(root, VOICE_QUEUE_FILENAME));
  const claim = (id: string, deliveryId = 'delivery-one') => ({
    ...item(id),
    callId: 'call',
    deliveryId,
    status: 'reserved' as const,
  });
  return { root, store, claim, close: () => rm(root, { recursive: true, force: true }) };
}
test('ranking merges consumed IDs and preserves unchanged bodies without a model rewrite', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: ['A', 'B', 'C'].map((id) => item(id)) });
    await f.store.delivery(f.claim('A'));
    await f.store.delivery({ ...f.claim('A'), status: 'sent' });
    const result = await f.store.update({
      upsert: [item('D')],
      order: ['C', 'A', 'B', 'D'],
    });
    assert.deepEqual(
      result.queue,
      ['C', 'B', 'D'].map((id) => item(id)),
    );
    assert.deepEqual(
      result.deliveries.map((d) => [d.id, d.status]),
      [['A', 'sent']],
    );
    assert.deepEqual(await new WorkHubVoiceStateStore(f.store.path).read(), result);
    assert.ok((await f.store.log({ kind: 'queue_changed' })).entries.length > 0);
  } finally {
    await f.close();
  }
});
test('reservation and stale ranking merge atomically in either order across store instances', async () => {
  for (const reserveFirst of [true, false]) {
    const f = await fixture();
    try {
      await f.store.update({ upsert: [item('A'), item('B')] });
      const other = new WorkHubVoiceStateStore(f.store.path);
      const reserve = () => f.store.delivery(f.claim('A'));
      const rank = () => other.update({ order: ['A', 'B'] });
      await Promise.all(reserveFirst ? [reserve(), rank()] : [rank(), reserve()]);
      assert.deepEqual((await f.store.read()).queue, [item('B')]);
      assert.equal((await f.store.read()).deliveries[0]?.status, 'reserved');
    } finally {
      await f.close();
    }
  }
});
test('a ranking does not delete candidates added after its snapshot', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A')] });
    await new WorkHubVoiceStateStore(f.store.path).enqueue({
      kind: 'update',
      id: 'B',
      text: 'New report',
    });
    const result = await f.store.update({ order: ['A'] });
    assert.deepEqual(
      result.queue.map((i) => i.id),
      ['A', 'B'],
    );
    await f.store.update({ remove: ['A'] });
    assert.deepEqual(
      (await f.store.read()).queue.map((i) => i.id),
      ['B'],
    );
  } finally {
    await f.close();
  }
});
test('consumed or reserved IDs ignore stale edits and preserve the frozen delivery', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.delivery(f.claim('A'));
    await f.store.update({
      upsert: [item('A', 'changed')],
      order: ['B', 'A'],
    });
    assert.equal((await f.store.read()).deliveries[0]?.text, 'A');
    await f.store.delivery({ ...f.claim('A'), status: 'sent' });
    await f.store.update({
      upsert: [item('A', 'stale')],
      order: ['A', 'B'],
    });
    assert.deepEqual((await f.store.read()).queue, [item('B')]);
  } finally {
    await f.close();
  }
});
test('an unsent reservation releases safely and stale receipts cannot consume its replacement', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A')] });
    const old = f.claim('A');
    await f.store.delivery(old);
    await f.store.delivery({ ...old, status: 'release' });
    assert.deepEqual((await f.store.read()).queue, [item('A')]);
    const fresh = f.claim('A', 'delivery-two');
    await f.store.delivery(fresh);
    await f.store.delivery({ ...old, status: 'sent' });
    await f.store.delivery({ ...fresh, callId: 'other-call', status: 'sent' });
    assert.equal((await f.store.read()).deliveries[0]?.status, 'reserved');
    await f.store.delivery({ ...fresh, status: 'sent' });
    assert.equal((await f.store.read()).deliveries[0]?.status, 'sent');
  } finally {
    await f.close();
  }
});
test('a cancellation during reservation cannot resurrect on release', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.delivery(f.claim('A'));
    await f.store.update({ remove: ['A'] });
    await f.store.delivery({ ...f.claim('A'), status: 'release' });
    assert.deepEqual((await f.store.read()).queue, [item('B')]);
  } finally {
    await f.close();
  }
});
test('list edits do not conflict with consumption', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.delivery(f.claim('A'));
    await f.store.update({ order: ['A', 'B'] });
    const obsolete = await f.store.update({ remove: ['B'] });
    assert.deepEqual(obsolete.queue, []);
  } finally {
    await f.close();
  }
});
test('uncertain delivery stays fenced after restart and cannot be automatically retried', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.delivery(f.claim('A'));
    await f.store.delivery({ ...f.claim('A'), status: 'uncertain' });
    const restarted = new WorkHubVoiceStateStore(f.store.path);
    await restarted.delivery(f.claim('B'));
    await restarted.update({ order: ['A', 'B'] });
    assert.deepEqual((await restarted.read()).queue, [item('B')]);
    assert.equal((await restarted.read()).deliveries.length, 1);
  } finally {
    await f.close();
  }
});

test('failed validation leaves the atomic queue intact; symlink state is refused', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A')] });
    await assert.rejects(f.store.update({ upsert: [item('B', 'x'.repeat(32_001))] }));
    assert.deepEqual((await f.store.read()).queue, [item('A')]);
    await writeFile(join(f.root, 'target'), '{}');
    await rm(f.store.logPath, { force: true });
    await symlink(join(f.root, 'target'), f.store.logPath);
    await assert.rejects(f.store.read(), /symbolic link/);
    assert.equal(await readFile(join(f.root, 'target'), 'utf8'), '{}');
  } finally {
    await f.close();
  }
});
test('wire state is structured and rejects duplicate IDs and fake completion receipts', () => {
  assert.deepEqual(decodeVoiceState({ queue: [], deliveries: [] }), { queue: [], deliveries: [] });
  assert.throws(() => decodeVoiceState({ queue: [item('A'), item('A')], deliveries: [] }));
  assert.throws(() => decodeVoiceState({ list: '' }));
  assert.throws(() =>
    decodeVoiceDelivery({ ...item('A'), callId: 'c', deliveryId: 'd', status: 'output_ended' }),
  );
});

test('one request can prepare multiple speech items and revise them through the sole list tool', async () => {
  const f = await fixture();
  const tool = createWorkHubVoiceQueueTools().find((t) => t.name === 'voice_queue_update')!;
  const context = {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 't',
    toolCallId: 'c',
    cwd: f.root,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  try {
    await f.store.request({ id: 'request', callId: 'call', userTurnId: 'user' });
    const planets = Array.from({ length: 8 }, (_, i) => item(`p${i + 1}`, `Planet ${i + 1}`)).map(
      (p) => ({ ...p, context: '' }),
    );
    await tool.impl(
      { upsert: planets.map(({ id, text }) => ({ id, text })), order: planets.map((p) => p.id) },
      context,
    );
    assert.deepEqual((await f.store.read()).queue, planets);
    assert.equal(tool.resultPresentation, undefined);
    await tool.impl({ upsert: [{ id: 'p2', text: 'Revised planet' }] }, context);
    assert.equal((await f.store.read()).queue[1]!.text, 'Revised planet');
    const original = planets[0]!;
    await f.store.delivery({ ...original, callId: 'call', deliveryId: 'd', status: 'reserved' });
    await tool.impl(
      {
        upsert: [
          { id: 'p1', text: 'Too late' },
          { id: 'p2', text: 'Next' },
        ],
      },
      context,
    );
    assert.equal((await f.store.read()).deliveries[0]!.text, original.text);
    assert.equal((await f.store.read()).queue[0]!.text, 'Next');
    await assert.rejects(async () =>
      tool.impl(
        {
          publications: [
            { id: 'extra', kind: 'answer', text: 'Introduction', requestId: 'request' },
          ],
        },
        context,
      ),
    );
    assert.equal((await f.store.read()).queue.length, 7);
  } finally {
    await f.close();
  }
});

test('prepared text survives release and old live shapes are rejected', async () => {
  const f = await fixture();
  const prepared = item('continue', 'Observed output stopped at X. Explain Y next.');
  try {
    await f.store.update({ upsert: [prepared] });
    const delivery = {
      ...prepared,
      callId: 'call',
      deliveryId: 'delivery',
      status: 'reserved' as const,
    };
    await f.store.delivery(delivery);
    const released = await f.store.delivery({ ...delivery, status: 'release' });
    assert.deepEqual(released.queue, [prepared]);
    await assert.rejects(
      f.store.update({
        upsert: [{ ...prepared, continuation: { topic: 'X', intent: 'Y' } } as typeof prepared],
      }),
    );
    assert.throws(() => decodeVoiceState({ queue: [], deliveries: [], deferred: true }));
    await f.store.request({ id: 'request', callId: 'call', userTurnId: 'user' });
    const state = await f.store.enqueue({
      id: 'reply',
      kind: 'answer',
      requestId: 'request',
      text: 'result',
    });
    const answer = state.queue[0]!;
    await f.store.update({ upsert: [{ ...answer, text: 'rewritten' }] });
    assert.equal(
      (await f.store.read()).queue.find((item) => item.id === answer.id)?.text,
      'rewritten',
    );
    const forged = await f.store.delivery({
      ...answer,
      reply: { ...answer.reply!, userTurnId: 'other' },
      callId: 'call',
      deliveryId: 'd',
      status: 'reserved',
    });
    assert.equal(forged.deliveries.length, 0);
  } finally {
    await f.close();
  }
});

test('old JSON state is not imported and unsupported SQLite state is rejected without rewriting', async () => {
  const f = await fixture();
  try {
    const oldPath = join(f.root, 'voice-queue.json');
    const old = JSON.stringify({
      version: 1,
      queue: [{ id: 'old', continuation: { topic: 'x', intent: 'y' } }],
    });
    await writeFile(oldPath, old);
    assert.deepEqual((await f.store.read()).queue, []);
    assert.equal(await readFile(oldPath, 'utf8'), old);
    await f.store.update({ upsert: [item('current')] });
    const db = new DatabaseSync(f.store.logPath);
    const current = JSON.parse(String(db.prepare('SELECT data FROM voice_state').get()!.data));
    try {
      for (const unsupported of [
        { ...current, version: 1 },
        { ...current, version: 2 },
        { ...current, currentState: 'obsolete' },
        { ...current, observations: [] },
      ]) {
        const raw = JSON.stringify(unsupported);
        db.prepare('UPDATE voice_state SET data=?').run(raw);
        await assert.rejects(f.store.read(), /Unsupported voice state format/);
        assert.equal(db.prepare('SELECT data FROM voice_state').get()!.data, raw);
      }
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('model tools keep active state small and recover full archived scripts with explicit pages', async () => {
  const f = await fixture();
  const tools = createWorkHubVoiceQueueTools();
  const context = {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 't',
    toolCallId: 'c',
    cwd: f.root,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  const call = (name: string, input: unknown) =>
    tools
      .find((t) => t.name === name)!
      .impl(name === 'voice_queue_update' ? modelUpdate(input) : input, context) as Promise<any>;
  try {
    const text = '历史原稿'.repeat(1000);
    const old = item('old', text);
    await f.store.update({ upsert: [old] });
    const delivery = {
      ...old,
      callId: 'previous-call',
      deliveryId: 'd',
      status: 'reserved' as const,
    };
    await f.store.delivery(delivery);
    await f.store.delivery({ ...delivery, status: 'sent' });
    const active = await call('voice_queue_read', {});
    assert.deepEqual(active.queue, []);
    assert.doesNotMatch(JSON.stringify(active), /历史原稿/);
    assert.ok(Buffer.byteLength(JSON.stringify(active)) < 1000);
    const page = await call('voice_log_read', { kind: 'queue_changed', limit: 1 });
    assert.equal(page.entries[0].data.upsert[0].text, text);
    assert.equal(page.encoding, undefined);
    const receipt = await call('voice_queue_update', {
      upsert: [item('new')],
    });
    assert.deepEqual(receipt.queue, [{ id: 'new' }]);
    assert.doesNotMatch(JSON.stringify(receipt), /历史原稿/);
    await assert.rejects(
      call('voice_queue_update', { currentState: '界'.repeat(2000), remove: ['new'] }),
    );
    assert.deepEqual(
      (await f.store.current()).queue.map((t) => t.id),
      ['new'],
    );
  } finally {
    await f.close();
  }
});

test('log is append-only, retries are idempotent, and failed mutations roll back log and list together', async () => {
  const f = await fixture();
  try {
    const input = {
      id: 'raw-batch',
      callId: 'call',

      entries: [{ id: 'raw-one', kind: 'transport', data: { type: 'turn.delta', delta: 'heard' } }],
    };
    await f.store.receiveObservation(input);
    await f.store.receiveObservation(input);
    assert.equal((await f.store.log({ kind: 'transport' })).entries.length, 1);
    assert.equal((await f.store.read()).review, undefined);
    const before = (await f.store.log({ limit: 64 })).entries.length;
    await assert.rejects(
      f.store.receiveObservation({
        ...input,
        id: 'bad',
        entries: [
          { id: 'rollback', kind: 'transport', data: { text: 'must roll back' } },
          { id: 'raw-one', kind: 'transport', data: { text: 'identity reused' } },
        ],
      }),
      /identity reused/,
    );
    assert.equal((await f.store.log({ limit: 64 })).entries.length, before);
    const db = new DatabaseSync(f.store.logPath);
    try {
      assert.throws(() => db.exec('DELETE FROM voice_log'), /append-only/);
      assert.throws(() => db.exec("UPDATE voice_log SET data='{}'"), /append-only/);
    } finally {
      db.close();
    }
    await f.store.update({ upsert: [item('page-one')] });
    await f.store.update({ upsert: [item('page-two')] });
    const first = await f.store.log({ limit: 1 });
    assert.ok(first.nextAfter);
    const second = await f.store.log({ after: first.nextAfter, limit: 1 });
    assert.ok(second.entries[0].sequence > first.entries[0].sequence);
  } finally {
    await f.close();
  }
});

test('archive stores changed bodies once and compact lifecycle receipts', async () => {
  const f = await fixture();
  try {
    await f.store.update({
      upsert: [item('a', 'unique first body'), item('b', 'unique second body')],
    });
    await f.store.update({ upsert: [item('b', 'replacement body')] });
    const changes = (await f.store.log({ kind: 'queue_changed' })).entries;
    assert.deepEqual((changes[1]!.data as { upsert: unknown[] }).upsert, [
      item('b', 'replacement body'),
    ]);
    await f.store.delivery({
      ...item('a', 'unique first body'),
      callId: 'c',
      deliveryId: 'd',
      status: 'reserved',
    });
    await f.store.delivery({
      ...item('a', 'unique first body'),
      callId: 'c',
      deliveryId: 'd',
      status: 'sent',
    });
    assert.doesNotMatch(
      JSON.stringify((await f.store.log({ kind: 'delivery_sent' })).entries),
      /unique first body/,
    );
  } finally {
    await f.close();
  }
});

function modelUpdate(input: unknown): unknown {
  const value = input as { upsert?: Array<{ id: string; text: string }> };
  return {
    ...value,
    ...(value.upsert ? { upsert: value.upsert.map(({ id, text }) => ({ id, text })) } : {}),
  };
}

test('resolving uncertain delivery releases transport without replaying its item', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.delivery(f.claim('A'));
    await assert.rejects(f.store.update({ resolveDeliveries: ['delivery-one'] }), /Only uncertain/);
    await f.store.delivery({ ...f.claim('A'), status: 'uncertain' });
    await f.store.update({ resolveDeliveries: ['delivery-one'], upsert: [item('A')] });
    const state = await f.store.snapshot();
    assert.deepEqual(
      state.queue.map((i) => i.id),
      ['B'],
    );
    assert.equal(state.deliveries[0]!.status, 'resolved');
    assert.equal((await f.store.current()).blocked.length, 0);
    const next = await f.store.delivery(f.claim('B', 'delivery-two'));
    assert.equal(next.deliveries.length, 2);
  } finally {
    await f.close();
  }
});

test('voice log snapshots freeze a turn across new writes, filters and store recreation', async (t) => {
  const f = await fixture();
  t.mock.method(Date, 'now', () => 123456789);
  try {
    await f.store.update({ upsert: [item('A')] });
    const first = await f.store.log({ kind: 'queue_changed' }, 'snapshot-turn');
    await f.store.update({ upsert: [item('B')] });
    const restarted = new WorkHubVoiceStateStore(f.store.path);
    const same = await restarted.log({ kind: 'queue_changed' }, 'snapshot-turn');
    assert.deepEqual(
      same,
      first,
      'same timestamp writes must still be outside the sequence snapshot',
    );
    assert.deepEqual(
      (await restarted.log({ query: '"B"', snapshot: Number.MAX_SAFE_INTEGER }, 'snapshot-turn'))
        .entries,
      [],
    );
    assert.deepEqual((await restarted.log({ snapshot: 0 }, 'snapshot-turn')).entries, []);
    assert.deepEqual(await restarted.log({ kind: 'queue_changed' }, 'snapshot-turn'), first);
    const next = await restarted.log({ kind: 'queue_changed' }, 'next-turn');
    assert.ok(next.snapshot > first.snapshot);
    assert.match(JSON.stringify(next.entries), /"B"/);
    assert.deepEqual(
      (await restarted.current()).queue.map((x) => x.id),
      ['A', 'B'],
      'snapshots do not block list edits',
    );
  } finally {
    await f.close();
  }
});

test('explicit zero snapshot stays empty while later turns see appended records', async () => {
  const f = await fixture();
  try {
    const first = await f.store.log({ snapshot: 0 }, 'empty-turn');
    assert.equal(first.snapshot, 0);
    await f.store.update({ upsert: [item('later')] });
    assert.deepEqual(await f.store.log({}, 'empty-turn'), first);
    assert.ok((await f.store.log({}, 'later-turn')).entries.length > 0);
    await assert.rejects(f.store.log({ snapshot: -1 }), /snapshot/);
    await assert.rejects(f.store.log({ snapshot: 1.5 }), /snapshot/);
  } finally {
    await f.close();
  }
});

test('snapshot sequence pagination excludes records appended between pages', async () => {
  const f = await fixture();
  try {
    for (const id of ['A', 'B', 'C']) await f.store.update({ upsert: [item(id)] });
    const first = await f.store.log({ kind: 'queue_changed', limit: 1 });
    await f.store.update({ upsert: [item('D')] });
    const entries = [...first.entries];
    let after = first.nextAfter;
    while (after !== undefined) {
      const page = await f.store.log({
        kind: 'queue_changed',
        after,
        snapshot: first.snapshot,
        limit: 1,
      });
      assert.equal(page.snapshot, first.snapshot);
      entries.push(...page.entries);
      after = page.nextAfter;
    }
    assert.deepEqual(
      entries.flatMap((x) => (x.data as { upsert: { id: string }[] }).upsert.map((i) => i.id)),
      ['A', 'B', 'C'],
    );
  } finally {
    await f.close();
  }
});

test('voice history reads whole native turns with record pagination and no character slicing', async () => {
  const f = await fixture();
  const context = {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 'turn-reader',
    toolCallId: 'read',
    cwd: f.root,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  const call = (input: unknown, turnId = context.turnId) =>
    createWorkHubVoiceQueueTools()
      .find((t) => t.name === 'voice_log_read')!
      .impl(input, { ...context, turnId }) as Promise<any>;
  try {
    const long = '完整的长故事'.repeat(2000);
    for (let i = 0; i < 7; i++)
      await f.store.recordTranscript({
        id: `fact-${i}`,
        callId: 'call',
        nativeTurnId: `native-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        text: i === 1 ? long : `轮次${i}`,
      });
    await f.store.receiveObservation({
      id: 'delta',
      callId: 'call',
      entries: [
        {
          id: 'part-a',
          kind: 'transcript_delta',
          data: { nativeTurnId: 'open', role: 'assistant', delta: '尚未' },
        },
        { id: 'event', kind: 'interruption', data: { userTurnId: 'user' } },
        {
          id: 'part-b',
          kind: 'transcript_delta',
          data: { nativeTurnId: 'open', role: 'assistant', delta: '结束' },
        },
      ],
    });
    const first = await call({ callId: 'call' });
    assert.equal(first.turns.length, 6);
    assert.equal(first.turns[1].text, long);
    assert.equal(first.turns[1].role, 'assistant');
    assert.equal(first.turns[1].status, 'done');
    assert.equal(first.encoding, undefined);
    await f.store.recordTranscript({
      id: 'later',
      callId: 'call',
      nativeTurnId: 'later',
      role: 'user',
      text: '新消息',
    });
    const second = await call({
      callId: 'call',
      after: first.nextAfter,
      snapshot: first.snapshot,
      limit: 2,
    });
    assert.deepEqual(
      second.turns.map((t: any) => t.turnId),
      ['native-6', 'open'],
    );
    assert.equal(second.turns[1].text, '尚未结束');
    assert.equal(second.turns[1].status, 'in_progress');
    assert.equal(second.nextAfter, undefined);
    // A cursor inside an unfinished turn still returns all of that turn's text.
    const deltas = await f.store.log({ kind: 'transcript_delta', callId: 'call' });
    const tail = await call({ callId: 'call', after: deltas.entries[0]!.sequence });
    assert.equal(tail.turns[0].text, '尚未结束');
    assert.deepEqual((await call({ callId: 'call', query: '新消息' })).turns, []);
    assert.equal((await call({ callId: 'call', query: '新消息' }, 'new-reader')).turns.length, 1);
    assert.equal((await call({ callId: 'call', kind: 'interruption' })).entries.length, 1);
    await f.store.recordTranscript({
      id: 'open-final',
      callId: 'call',
      nativeTurnId: 'open',
      role: 'assistant',
      text: '最终完整内容',
    });
    const completed = await call({ callId: 'call', relatedId: 'open' }, 'final-reader');
    assert.equal(completed.turns.length, 1);
    assert.equal(completed.turns[0].status, 'done');
    assert.equal(completed.turns[0].text, '最终完整内容');
    await assert.rejects(call({ textOffset: 1400 }));
  } finally {
    await f.close();
  }
});

test('idle review freezes complete log range and acknowledges only that range without queue edits', async () => {
  const f = await fixture();
  const log = (id: string, kind = 'transcript_delta') =>
    f.store.receiveObservation({
      id,
      callId: 'call',
      entries: [{ id, kind, data: { role: 'assistant', delta: id } }],
    });
  try {
    await log('first');
    await log('audio-stopped', 'playback_activity');
    const review = await f.store.claimReview('call', 'review-1');
    assert.ok(review);
    assert.equal(review.through, (await f.store.log({ callId: 'call' })).entries.at(-1)!.sequence);
    await log('second');
    assert.equal(await f.store.claimReview('call', 'duplicate'), undefined);
    const frozen = await f.store.log({ callId: 'call' }, 'voice-maintenance-review-1');
    assert.ok(!JSON.stringify(frozen).includes('second'));
    await f.store.finishReview(review.id, true);
    const next = await f.store.claimReview('call', 'review-2');
    assert.ok(next);
    assert.equal(next.after, review.through);
    assert.ok(next.through > review.through);
    await f.store.finishReview(next.id, true);
    for (let n = 0; n < 50; n++)
      assert.equal(await f.store.claimReview('call', `poll-${n}`), undefined);
    assert.deepEqual((await f.store.read()).queue, []);
    assert.equal(
      await new WorkHubVoiceStateStore(f.store.path).claimReview('call', 'restart'),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('queued speech permits review; busy admission release retries, failed execution waits for new facts', async () => {
  const f = await fixture();
  try {
    await f.store.receiveObservation({
      id: 'write',
      callId: 'call',
      entries: [{ id: 'fact', kind: 'interruption', data: {} }],
    });
    await f.store.update({ upsert: [item('pending')] });
    assert.ok(await f.store.claimReview('call', 'queued'));
    await f.store.releaseReview('queued');
    assert.ok(await f.store.claimReview('call', 'busy'));
    await f.store.releaseReview('busy');
    assert.ok(await f.store.claimReview('call', 'retry'));
    await f.store.finishReview('retry', false);
    assert.equal(await f.store.claimReview('call', 'hot-loop'), undefined);
    await f.store.receiveObservation({
      id: 'write2',
      callId: 'call',
      entries: [{ id: 'new-fact', kind: 'transcript', data: {} }],
    });
    const retry = await f.store.claimReview('call', 'new-input');
    assert.ok(retry);
    assert.equal(retry.after, 0, 'failed work must not advance the cursor');
  } finally {
    await f.close();
  }
});

test('correlated replies are durable, isolated from list edits, and never reserved by another call', async () => {
  const f = await fixture();
  try {
    await f.store.request({ id: 'request', callId: 'call', userTurnId: 'user' });
    const input = {
      id: 'result',
      requestId: 'request',
      kind: 'answer' as const,
      text: '文件已完成',
    };
    let state = await f.store.enqueue(input);
    assert.deepEqual(state.queue, []);
    assert.equal(state.responses?.[0]?.reply?.id, 'request');
    assert.deepEqual(await new WorkHubVoiceStateStore(f.store.path).read(), state);
    await f.store.enqueue(input);
    await assert.rejects(f.store.enqueue({ ...input, text: '改写结果' }), /identity reused/);
    await assert.rejects(
      f.store.enqueue({ ...input, id: 'unknown', requestId: 'missing' }),
      /Unknown voice request/,
    );
    await assert.rejects(f.store.update({ upsert: [item('result')] }), /Native replies/);
    await assert.rejects(
      f.store.enqueue({ id: 'result', kind: 'question', text: 'collision' }),
      /Native reply ID/,
    );
    await f.store.update({ upsert: [item('supplement')], remove: ['result'] });
    const response = state.responses![0]!;
    const delivery = {
      ...response,
      callId: 'other-call',
      deliveryId: 'native-delivery',
      status: 'reserved' as const,
    };
    assert.equal((await f.store.delivery(delivery)).responses?.length, 1);
    state = await f.store.delivery({ ...delivery, callId: 'call' });
    assert.equal(state.responses?.length ?? 0, 0);
    assert.deepEqual(
      state.queue.map((i) => i.id),
      ['supplement'],
    );
    // A reserved native reply does not fence the supplemental list.
    assert.equal(
      (await f.store.delivery(f.claim('supplement', 'supplement-delivery'))).queue.length,
      0,
    );
    await f.store.delivery({ ...delivery, callId: 'call', status: 'sent' });
    state = await f.store.enqueue(input);
    assert.equal(state.responses?.length ?? 0, 0, 'duplicate after delivery must not replay');
    assert.equal((await f.store.log({ kind: 'reply_prepared' })).entries.length, 1);
  } finally {
    await f.close();
  }
});

test('final transcripts atomically remove only their own fragments and reject late fragment resurrection', async () => {
  const f = await fixture();
  const fragment = (id: string, nativeTurnId: string) => ({
    id,
    kind: 'transcript_delta',
    data: { nativeTurnId, role: 'user', delta: id },
  });
  try {
    await f.store.receiveObservation({
      id: 'obs',
      callId: 'call',
      entries: [fragment('a', 'turn'), fragment('b', 'turn'), fragment('open', 'other-turn')],
    });
    await f.store.receiveObservation({
      id: 'other',
      callId: 'other-call',
      entries: [fragment('different-call', 'turn')],
    });
    const before = await f.store.log({ callId: 'call' });
    const final = {
      id: 'final',
      callId: 'call',
      nativeTurnId: 'turn',
      role: 'user' as const,
      text: '最终完整内容',
    };
    await f.store.recordTranscript(final);
    const state = await f.store.log({ callId: 'call' });
    assert.deepEqual(
      state.entries.filter((e) => e.kind === 'transcript_delta').map((e) => e.id),
      ['open'],
    );
    assert.equal(state.entries.filter((e) => e.kind === 'transcript').length, 1);
    assert.equal(
      (await f.store.log({ callId: 'other-call', kind: 'transcript_delta' })).entries.length,
      1,
    );
    await f.store.receiveObservation({
      id: 'late',
      callId: 'call',
      entries: [fragment('late-fragment', 'turn'), fragment('a', 'turn')],
    });
    await f.store.recordTranscript(final);
    assert.equal(
      (await f.store.log({ callId: 'call', kind: 'transcript_delta' })).entries.length,
      1,
    );
    assert.equal((await f.store.log({ callId: 'call', kind: 'transcript' })).entries.length, 1);
    // A fixed sequence ceiling must not reveal a newer final as a substitute.
    assert.equal(
      (await f.store.log({ callId: 'call', snapshot: before.snapshot, kind: 'transcript' })).entries
        .length,
      0,
    );
    assert.equal(
      (await f.store.log({ callId: 'call', after: before.snapshot, kind: 'transcript' })).entries
        .length,
      1,
    );
    const db = new DatabaseSync(f.store.logPath);
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM voice_log WHERE kind='transcript_delta' AND call_id='call' AND json_extract(data,'$.nativeTurnId')='turn'",
          )
          .get()!.n,
        0,
      );
      assert.throws(() => db.exec("DELETE FROM voice_log WHERE kind='transcript'"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM voice_log WHERE id='open'"), /append-only/);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('Jev discard matches exact content and preserves concurrent WorkHub changes', async () => {
  const f = await fixture();
  try {
    await f.store.update({ upsert: [item('A'), item('B')] });
    await f.store.update({ upsert: [item('A', 'updated')] });
    const state = await f.store.receiveObservation({
      id: 'jev-discard',
      callId: 'call',
      entries: [],
      discard: [item('A'), item('B')],
    });
    assert.deepEqual(state.queue, [item('A', 'updated')]);
    assert.equal(state.review, undefined);
  } finally {
    await f.close();
  }
});

test('approved non-head reservation requires the entire checked list to still match', async () => {
  const f = await fixture();
  try {
    const queue = [item('repair'), item('ready')];
    await f.store.update({ upsert: queue });
    await f.store.update({ upsert: [item('new')] });
    const stale = await f.store.delivery({ ...f.claim('ready'), expectedQueue: queue });
    assert.equal(stale.deliveries.length, 0);
    const current = await f.store.delivery({ ...f.claim('ready'), expectedQueue: stale.queue });
    assert.equal(current.deliveries[0]?.id, 'ready');
    assert.deepEqual(
      current.queue.map((i) => i.id),
      ['repair', 'new'],
    );
  } finally {
    await f.close();
  }
});
