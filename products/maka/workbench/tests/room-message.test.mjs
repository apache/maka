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
import {
  applyRoomWatchUpdate,
  buildRoomMentionChoices,
  createSerialQueue,
  extractInlineMentionIds,
  formatInlineMention,
  formatRoomPreviewText,
  isGroupContinuation,
  roomMentionAt,
  roomTextNeedsMarkdown,
  stripInlineMention,
} from '../app/roomMessage.ts';

test('roomMentionAt triggers seamlessly after CJK, punctuation, whitespace, or start of line', () => {
  assert.deepEqual(roomMentionAt('@codex', { start: 6, end: 6 }), {
    start: 0,
    end: 6,
    query: 'codex',
  });
  assert.deepEqual(roomMentionAt('帮我看下@前端', { start: 7, end: 7 }), {
    start: 4,
    end: 7,
    query: '前端',
  });
  assert.deepEqual(roomMentionAt('请(@bot', { start: 6, end: 6 }), {
    start: 2,
    end: 6,
    query: 'bot',
  });
  // Email addresses and already-formatted inline mention tokens must not trigger picker.
  assert.equal(roomMentionAt('contact foo@bar', { start: 15, end: 15 }), null);
  assert.equal(roomMentionAt('[@Alice](maka://session/s1)', { start: 7, end: 7 }), null);
  // Active range selection does not trigger.
  assert.equal(roomMentionAt('@bot', { start: 1, end: 4 }), null);
});

test('inline mention formatting, extraction, and stripping preserve surrounding prose', () => {
  const tokenA = formatInlineMention('ma_alpha', 'Frontend [v2]');
  const tokenB = formatInlineMention('ma_beta', 'Backend');
  const roomRef = formatInlineMention('ma_room', '设计群 [Q4]', 'room');
  assert.equal(roomRef, '[#设计群 \\[Q4\\]](maka://session/ma_room) ');
  assert.equal(formatRoomPreviewText(roomRef), '#设计群 [Q4]');
  assert.equal(roomTextNeedsMarkdown(roomRef), true);
  const draft =
    '请 ' +
    tokenA +
    '改样式，并参考 [详情](maka://session/ma_plain) 和 ' +
    roomRef +
    '给 ' +
    tokenB +
    '对接口';

  assert.deepEqual(extractInlineMentionIds(draft), ['ma_alpha', 'ma_beta']);
  const removed = stripInlineMention(draft, 'ma_alpha');
  assert.equal(removed.includes('ma_alpha'), false);
  assert.equal(removed.includes('改样式'), true);
  assert.deepEqual(extractInlineMentionIds(removed), ['ma_beta']);
});

test('buildRoomMentionChoices includes other active rooms separately from members and conversations', () => {
  const makeSession = (id, title, kind, archived = false) => ({
    id,
    kind,
    title,
    archived,
    activity: 'idle',
    workspace: { path: '/tmp/' + id },
    appliedPreset: null,
  });
  const members = [
    {
      sessionId: 'ma_m1',
      title: 'Alice',
      presetName: 'Frontend',
      workspacePath: '/tmp/w',
      activity: 'idle',
      unavailable: false,
      archived: false,
    },
    {
      sessionId: 'ma_m2',
      title: 'Bob',
      presetName: null,
      workspacePath: '/tmp/w',
      activity: 'working',
      unavailable: false,
      archived: false,
    },
  ];
  const sessions = [
    makeSession('ma_self_room', 'Current Room', 'room'),
    makeSession('ma_other_room', 'Design Sync', 'room'),
    makeSession('ma_archived_room', 'Old Room', 'room', true),
    makeSession('ma_m1', 'Alice', 'agent'),
    makeSession('ma_c1', 'Conv 1', 'agent'),
    makeSession('ma_c2', 'Conv 2', 'agent'),
    makeSession('ma_c3', 'Conv 3', 'agent'),
    makeSession('ma_archived_conv', 'Old Conv', 'agent', true),
  ];

  const rows = buildRoomMentionChoices({
    roomId: 'ma_self_room',
    members,
    sessions,
    alreadyMentioned: new Set(['ma_c2']),
    query: '',
    allLabel: 'All room members',
    allKeywords: ['all', '全体'],
    sectionLimit: 2,
  });

  assert.deepEqual(
    rows.map((r) => [r.kind, r.id, r.kind === 'agent' ? r.isMember : null]),
    [
      ['all', '__all__', null],
      ['agent', 'ma_m1', true],
      ['agent', 'ma_m2', true],
      ['room', 'ma_other_room', null],
      ['agent', 'ma_c1', false],
      ['agent', 'ma_c3', false],
    ],
  );
});

test('isGroupContinuation groups same-author messages within 5 minutes and breaks on replies, gaps, or deletions', () => {
  const baseAt = new Date(2026, 10, 22, 10, 0, 0).getTime();
  const make = (overrides) => ({
    id: 'm',
    sequence: 1,
    at: baseAt,
    author: { kind: 'session', execution: { sessionId: 'alice', runId: 'r1', turnId: 't1' } },
    content: { text: 'hi', attachments: [] },
    replyTo: null,
    mentions: [],
    deliveries: [],
    ...overrides,
  });

  const m1 = make({ id: 'm1', at: baseAt });
  assert.equal(isGroupContinuation(undefined, m1), false);
  assert.equal(isGroupContinuation(m1, make({ id: 'm2', at: baseAt + 60_000 })), true);
  // Gap >= 5 minutes breaks group.
  assert.equal(isGroupContinuation(m1, make({ id: 'm3', at: baseAt + 5 * 60_000 })), false);
  // Different author breaks group.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm4', at: baseAt + 10_000, author: { kind: 'human' } })),
    false,
  );
  // Quoted reply breaks group so reply context stays clearly anchored.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm5', at: baseAt + 10_000, replyTo: 'm0' })),
    false,
  );
  // Deleted message breaks group.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm6', at: baseAt + 10_000, deletedAt: baseAt + 11_000 })),
    false,
  );
});

test('formatRoomPreviewText strips session link URIs and roomTextNeedsMarkdown keeps plain prose compact', () => {
  assert.equal(
    formatRoomPreviewText(
      'Please review [@Room reviewer](maka://session/s1) and [spec](https://example.com)',
    ),
    'Please review @Room reviewer and spec',
  );
  assert.equal(roomTextNeedsMarkdown('The patch is ready.'), false);
  assert.equal(roomTextNeedsMarkdown('Please review [@Room reviewer](maka://session/s1)'), true);
  assert.equal(roomTextNeedsMarkdown('line 1\nline 2'), true);
});

test('applyRoomWatchUpdate catches retractions, skips quiet frames, avoids plain-append rescans, and never confirms unloaded messages', async () => {
  // 1. Retraction between initial read (through=1, rev=10) and watch update (through=1, rev=11).
  let refreshed = 0;
  let appended = 0;
  let loaded = 1;
  const state1 = { through: 1, revision: 10 };
  const ok1 = await applyRoomWatchUpdate(
    state1,
    { through: 1, revision: 11 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async () => {
        appended += 1;
        return true;
      },
      refreshExisting: async () => {
        refreshed += 1;
        return true;
      },
    },
  );
  assert.equal(ok1, true);
  assert.equal(refreshed, 1);
  assert.equal(appended, 0);
  assert.deepEqual(state1, { through: 1, revision: 11 });

  // 2. Quiet frame with matching (through, revision) does zero reads.
  refreshed = 0;
  const ok2 = await applyRoomWatchUpdate(
    state1,
    { through: 1, revision: 11 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async () => {
        appended += 1;
        return true;
      },
      refreshExisting: async () => {
        refreshed += 1;
        return true;
      },
    },
  );
  assert.equal(ok2, true);
  assert.equal(refreshed, 0);
  assert.equal(appended, 0);

  // 3. Plain append (through advances, revision unchanged) calls appendNew(false, 433) without rescanning existing pages.
  const calls = [];
  loaded = 432;
  const state3 = { through: 432, revision: 11 };
  const ok3 = await applyRoomWatchUpdate(
    state3,
    { through: 433, revision: 11 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async (refreshExisting, targetThrough) => {
        calls.push([refreshExisting, targetThrough]);
        loaded = targetThrough;
        return true;
      },
      refreshExisting: async () => {
        refreshed += 1;
        return true;
      },
    },
  );
  assert.equal(ok3, true);
  assert.deepEqual(calls, [[false, 433]]);
  assert.equal(refreshed, 0);
  assert.deepEqual(state3, { through: 433, revision: 11 });

  // 4. Coalesced append + retraction (both through and revision advance) calls appendNew(true, 434).
  const ok4 = await applyRoomWatchUpdate(
    state3,
    { through: 434, revision: 12 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async (refreshExisting, targetThrough) => {
        calls.push([refreshExisting, targetThrough]);
        loaded = targetThrough;
        return true;
      },
      refreshExisting: async () => true,
    },
  );
  assert.equal(ok4, true);
  assert.deepEqual(calls, [
    [false, 433],
    [true, 434],
  ]);
  assert.deepEqual(state3, { through: 434, revision: 12 });

  // 5. Even if an in-flight read returned true after only loading seq 2, a watch frame for seq 3 must NOT confirm through=3.
  let loaded5 = 2;
  const state5 = { through: 2, revision: 10 };
  const ok5 = await applyRoomWatchUpdate(
    state5,
    { through: 3, revision: 10 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded5,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async () => true, // simulated stale in-flight read that did not load seq 3
      refreshExisting: async () => true,
    },
  );
  assert.equal(ok5, false);
  assert.deepEqual(state5, { through: 2, revision: 10 });

  // 6. If stored state.through ever got ahead of loaded tail (e.g. from paging), watch still catches up to 101.
  let loaded6 = 100;
  let caughtUp = false;
  const state6 = { through: 101, revision: 10 };
  const ok6 = await applyRoomWatchUpdate(
    state6,
    { through: 101, revision: 10 },
    {
      hasAfterCursor: () => false,
      loadedThrough: () => loaded6,
      onThrough: () => {},
      onUnseenDelta: () => {},
      appendNew: async (_refreshExisting, targetThrough) => {
        caughtUp = true;
        loaded6 = targetThrough;
        return true;
      },
      refreshExisting: async () => true,
    },
  );
  assert.equal(ok6, true);
  assert.equal(caughtUp, true);
  assert.deepEqual(state6, { through: 101, revision: 10 });
});

test('createSerialQueue prevents newer paging and coalesced watch retract+append from interleaving in either order', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  // Order A: newer() starts first (reads 53..100 before server retracts #90 and appends #101),
  // while watch frame { through: 101, revision: 11 } arrives mid-read.
  {
    const run = createSerialQueue();
    const state = { through: 100, revision: 10 };
    const store = new Map(
      Array.from({ length: 100 }, (_, i) => [i + 1, { seq: i + 1, deleted: false }]),
    );
    let rows = Array.from({ length: 48 }, (_, i) => ({ ...store.get(i + 5) }));
    let afterCursor = 52;
    let unseen = 0;

    const gateNewer = deferred();
    const newerTask = run(async () => {
      // Snapshot 53..100 taken before remote retract+append.
      const snapshot = Array.from({ length: 48 }, (_, i) => ({ ...store.get(i + 53) }));
      await gateNewer.promise;
      rows = [...rows, ...snapshot];
      afterCursor = null;
      unseen = 0;
    });

    // Remote retracts #90 and appends #101 while newerTask is awaiting response.
    store.get(90).deleted = true;
    store.set(101, { seq: 101, deleted: false });

    const watchTask = run(() =>
      applyRoomWatchUpdate(
        state,
        { through: 101, revision: 11 },
        {
          hasAfterCursor: () => afterCursor !== null,
          loadedThrough: () => rows.at(-1)?.seq ?? 0,
          onThrough: () => {},
          onUnseenDelta: (delta) => {
            unseen += delta;
          },
          appendNew: async (refreshExisting) => {
            const last = rows.at(-1).seq;
            for (let s = last + 1; s <= store.size; s++) rows.push({ ...store.get(s) });
            if (refreshExisting) {
              rows = rows.map((r) => ({ ...store.get(r.seq) }));
            }
            return true;
          },
          refreshExisting: async () => {
            rows = rows.map((r) => ({ ...store.get(r.seq) }));
            return true;
          },
        },
      ),
    );

    gateNewer.resolve();
    await newerTask;
    assert.equal(await watchTask, true);
    assert.equal(rows.at(-1).seq, 101);
    assert.equal(rows.find((r) => r.seq === 90).deleted, true);
    assert.equal(unseen, 0);
    assert.deepEqual(state, { through: 101, revision: 11 });
  }

  // Order B: watch starts first (retract #90 + append #101), pauses mid-refresh, and user clicks newer() during pause.
  {
    const run = createSerialQueue();
    const state = { through: 100, revision: 10 };
    const store = new Map(
      Array.from({ length: 100 }, (_, i) => [i + 1, { seq: i + 1, deleted: false }]),
    );
    let rows = Array.from({ length: 48 }, (_, i) => ({ ...store.get(i + 5) }));
    let afterCursor = 52;
    let unseen = 0;

    store.get(90).deleted = true;
    store.set(101, { seq: 101, deleted: false });

    const gateWatch = deferred();
    const watchTask = run(() =>
      applyRoomWatchUpdate(
        state,
        { through: 101, revision: 11 },
        {
          hasAfterCursor: () => afterCursor !== null,
          loadedThrough: () => rows.at(-1)?.seq ?? 0,
          onThrough: () => {},
          onUnseenDelta: (delta) => {
            unseen += delta;
          },
          appendNew: async () => true,
          refreshExisting: async () => {
            await gateWatch.promise;
            rows = rows.map((r) => ({ ...store.get(r.seq) }));
            return true;
          },
        },
      ),
    );

    // User clicks newer() while watch is paused inside refreshExisting(); queue holds newer() until watch finishes.
    const newerTask = run(async () => {
      const start = afterCursor + 1;
      const page = [];
      for (let s = start; s < start + 48 && s <= store.size; s++) page.push({ ...store.get(s) });
      rows = [...rows, ...page];
      afterCursor = rows.at(-1).seq < store.size ? rows.at(-1).seq : null;
    });

    gateWatch.resolve();
    assert.equal(await watchTask, true);
    await newerTask;
    // newer() read after watch completed, so #90 is already retracted and afterCursor points at #100 (with unseen=1 for #101).
    assert.equal(rows.find((r) => r.seq === 90).deleted, true);
    assert.equal(afterCursor, 100);
    assert.equal(unseen, 1);

    // Next newer() reaches 101 and clears unseen cleanly.
    await run(async () => {
      rows = [...rows, { ...store.get(101) }];
      afterCursor = null;
      if (rows.at(-1).seq >= state.through) unseen = 0;
    });
    assert.equal(rows.at(-1).seq, 101);
    assert.equal(unseen, 0);
  }

  // Queue stays healthy after a task rejects.
  const q = createSerialQueue();
  await assert.rejects(
    q(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await q(async () => 42), 42);
});
