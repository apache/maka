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
import * as Main from '../.artifacts/main-api.mjs';

test('generic Recall history corpus is privacy guarded and excludes simulated/archived history', async () => {
  const deps = {
    getPrivacyContext: async () => ({ incognitoActive: true }),
    listSessions: async () => {
      throw Error('must not read history');
    },
  };
  await assert.rejects(Main.listRecallHistorySessions(deps, 'a'), /privacy|incognito/);
  await assert.rejects(
    Main.listRecallHistorySessions({ ...deps, getPrivacyContext: async () => ({}) }, 'a'),
    /privacy/,
  );
  const result = await Main.listRecallHistorySessions(
    {
      getPrivacyContext: async () => ({ incognitoActive: false }),
      listSessions: async () => [
        { id: 'real', backend: 'ai-sdk' },
        { id: 'simulated', backend: 'fake' },
        { id: 'archived', backend: 'ai-sdk', isArchived: true },
      ],
    },
    'real',
  );
  assert.deepEqual(
    result.map((s: any) => s.id),
    ['real'],
  );
});

const create = async (f: any, name = 'Events', sources = ['maka']) => {
  const range = await f.invoke('MemoryRange', { sources });
  return f.invoke('MemoryIndexCreate', {
    name,
    instructions: 'Organize events with context and timelines',
    cursor: range.to,
  });
};
const pending = (range: any) =>
  range.sources.reduce(
    (n: number, s: any) => n + s.newOrChangedMessages + s.removedMessages,
    0,
  );

for (const bundle of [false, true])
  test(`bundle=${bundle}: cursors, normal worker tools, backlinks and independent indexes`, async (t) => {
    const f = await fixture(bundle);
    t.after(() => f.close());
    const first = await create(f, 'Candidate Todo');
    assert.equal(first.range.completed, true);
    assert.equal(first.coverage.cursor, first.range.to);
    assert.equal(first.contents.total, 1);
    assert.equal(first.maintenance.running, false);
    const toolNames = f.tools.resolve('agent-chat', []).tools.map((x: any) => x.name);
    // Exercise the real plugin registry and first-step tool gating, before any search.
    const plan = new Main.ToolAvailabilityRuntime(
      f.tools.resolve('fresh-chat', []).tools,
      {},
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare(new Map());
    assert.ok(plan.activeTools.includes('MemoryExtract'));
    assert.ok(plan.providerTools.some((tool: any) => tool.name === 'MemoryExtract'));
    assert.ok(!plan.gating.gatedNames.has('MemoryExtract'));
    assert.ok(plan.gating.gatedNames.has('MemoryHistory'));
    assert.ok(!toolNames.includes('MemoryIndexBatch'));
    assert.ok(!toolNames.includes('MemoryIndexCommit'));
    const history = await f.invoke('MemoryHistory', { to: first.range.to, mode: 'messages' });
    const ref = history.items[0].ref;
    const timeline = await create(f, 'Timeline');
    assert.equal((await f.invoke('MemoryOriginal', { ref })).backlinks.length, 2);
    const reads = f.reads.length;
    f.sessions.get('chat-b')!.push({
      id: 'c',
      type: 'user',
      text: 'Vendor contacted yesterday. No further contact needed.',
    });
    await f.invoke('MemoryIndexRead', { indexId: first.index.id });
    assert.equal(f.reads.length, reads);
    const range = await f.invoke('MemoryRange', { indexId: first.index.id });
    assert.equal(pending(range), 1);
    assert.deepEqual(f.reads.slice(reads), ['chat-b']);
    const delta = await f.invoke('MemoryHistory', {
      from: range.from,
      to: range.to,
      mode: 'messages',
      query: 'contacted',
    });
    assert.equal(delta.items.length, 1);
    assert.equal(
      (await f.invoke('MemoryIndexRead', { indexId: first.index.id })).coverage.cursor,
      first.range.to,
    );
    const updated = await f.invoke('MemoryIndexMaintain', { indexId: first.index.id });
    assert.equal(updated.contents.total, 0);
    assert.equal((await f.invoke('MemoryOriginal', { ref })).backlinks.length, 1);
    assert.equal(pending(await f.invoke('MemoryRange', { indexId: timeline.index.id })), 1);
    f.setIncognito(true);
    await assert.rejects(f.invoke('MemoryOriginal', { ref }), /Incognito/);
    await assert.rejects(f.invoke('MemoryIndexList', {}), /Incognito/);
  });

test('all types and fields by default; filtering and pagination are explicit choices', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  f.sessions.set('chat-a', [
    { id: 'u', type: 'user', text: 'Question' },
    { id: 't', type: 'tool_result', text: 'Tool evidence' },
    {
      id: 'c',
      type: 'assistant',
      text: 'Working',
      providerOptions: { openai: { phase: 'commentary' } },
    },
    { id: 'r', type: 'assistant', text: '', thinking: 'Reasoning' },
    { id: 'a', type: 'assistant', text: 'Answer' },
    { id: 's', type: 'turn_state', state: 'complete' },
  ] as any);
  const range = await f.invoke('MemoryRange', {});
  const all = await f.invoke('MemoryHistory', {
    to: range.to,
    recordId: 'chat-a',
    mode: 'messages',
  });
  assert.equal(all.items.length, 6);
  assert.equal(all.items[3].message.thinking, 'Reasoning');
  const filtered = await f.invoke('MemoryHistory', {
    to: range.to,
    recordId: 'chat-a',
    mode: 'messages',
    types: ['tool_result'],
  });
  assert.deepEqual(
    filtered.items.map((x: any) => x.message.id),
    ['t'],
  );
  const conversation = await f.invoke('MemoryHistory', {
    to: range.to,
    recordId: 'chat-a',
    mode: 'messages',
    view: 'conversation',
  });
  assert.deepEqual(
    conversation.items.map((x: any) => x.message.id),
    ['u', 'a'],
  );
  const page = await f.invoke('MemoryHistory', {
    to: range.to,
    recordId: 'chat-a',
    mode: 'messages',
    limit: 2,
    offset: 2,
  });
  assert.equal(page.nextOffset, 4);
  assert.deepEqual(
    page.items.map((x: any) => x.message.id),
    ['c', 'r'],
  );
  assert.equal(
    (await f.invoke('MemoryOriginal', { ref: all.items[3].ref })).message.thinking,
    'Reasoning',
  );
});

for (const trigger of ['time'])
  test(`${trigger} drives a normal independent background Session`, async (t) => {
    const f = await fixture(false, {
      tickMs: 15,
      intervalMs: 20,
      retryMs: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.after(async () => {
      release();
      await f.close();
    });
    const first = await create(f);
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    f.setBeforeWorker(async () => {
      entered();
      await gate;
    });
    f.sessions.get('chat-b')!.push({ id: 'delta', type: 'user', text: 'Delivery arrived' });
    let timer: any;
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('scheduler did not run')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const during = await f.invoke('MemoryIndexRead', { indexId: first.index.id });
    assert.equal(during.maintenance.running, true);
    assert.equal(during.coverage.cursor, first.coverage.cursor);
    assert.equal(during.contents.total, first.contents.total);
    release();
    const done = await f.invoke('MemoryIndexMaintain', { indexId: first.index.id });
    assert.equal(done.range.completed, true);
    assert.notEqual(done.coverage.cursor, first.coverage.cursor);
  });

test('multi-source cursors distinguish colliding IDs, edits and late historical records', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let rev = 1,
    reads = 0;
  let messages = [{ id: 'a', type: 'user', ts: 100, text: 'Feishu procurement started' }];
  const dispose = f.query.registerHistorySource({
    id: 'feishu',
    description: 'Test adapter',
    list: async () => [{ id: 'chat-a', historyRevision: String(rev) }],
    read: async () => {
      reads++;
      return { session: { id: 'chat-a' }, messages };
    },
  });
  t.after(() => dispose());
  const first = await create(f, 'Events', ['maka', 'feishu']);
  assert.equal(first.range.sources.length, 2);
  assert.equal(reads, 1);
  messages = [
    { id: 'a', type: 'user', ts: 100, text: 'Cancelled' },
    { id: 'late', type: 'user', ts: 1, text: 'Late historical note' },
  ];
  rev++;
  const range = await f.invoke('MemoryRange', { indexId: first.index.id });
  assert.equal(range.sources.find((s: any) => s.source === 'maka').newOrChangedMessages, 0);
  const delta = await f.invoke('MemoryHistory', {
    from: range.from,
    to: range.to,
    source: 'feishu',
    mode: 'messages',
  });
  assert.equal(delta.items.length, 2);
  const old = await f.invoke('MemoryHistory', {
    to: first.range.to,
    source: 'feishu',
    mode: 'messages',
  });
  assert.equal(old.items[0].message.text, 'Feishu procurement started');
  await f.invoke('MemoryRange', { indexId: first.index.id });
  assert.equal(reads, 2);
  const updated = await f.invoke('MemoryIndexMaintain', { indexId: first.index.id });
  assert.equal(updated.coverage.cursor, range.to);
});

test('worker may choose arbitrary content; edits do not checkpoint and unfinished work is retained', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    calls++;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const summary = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await f.invokeAs(sessionId, 'MemoryIndexWrite', {
      indexId,
      key: 'my own organization',
      text: '# Preliminary notes',
      expectedRevision: summary.index.revision,
    });
  });
  const first = await create(f);
  assert.equal(calls, 1, 'no forced batch loop');
  assert.equal(first.coverage.cursor, null);
  assert.equal(first.contents.total, 1);
  assert.match(first.maintenance.lastError, /without completing/);
  assert.equal(first.maintenance.running, false);
  await assert.rejects(
    f.invoke('MemoryIndexWrite', {
      indexId: first.index.id,
      key: 'x',
      text: 'stale',
      expectedRevision: 0,
    }),
    /changed/,
  );
  await f.invoke('MemoryIndexEdit', {
    indexId: first.index.id,
    key: 'my own organization',
    oldText: 'Preliminary',
    newText: 'Working',
    expectedRevision: first.index.revision,
  });
  await assert.rejects(
    f.invoke('MemoryIndexCheckpoint', {
      indexId: first.index.id,
      rangeId: first.range.rangeId,
      expectedRevision: first.index.revision,
      notes: 'stale',
      complete: true,
    }),
    /changed/,
  );
  f.setWorkerRunner(undefined as any);
  const retried = await f.invoke('MemoryIndexMaintain', { indexId: first.index.id });
  assert.equal(retried.range.completed, true);
  assert.equal(retried.maintenance.lastError, undefined);
  assert.equal(retried.contents.total, 2);
});

test('mid-run arrivals stay outside the captured range and become the next delta', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let injected = false;
  f.setBeforeWorker(async () => {
    if (injected) return;
    injected = true;
    f.sessions.get('chat-b')!.push({ id: 'mid-run', type: 'user', text: 'New demand' });
    await f.invoke('MemoryRange', {});
  });
  const first = await create(f);
  const range = await f.invoke('MemoryRange', { indexId: first.index.id });
  assert.equal(pending(range), 1);
  const firstDoc = await f.invoke('MemoryIndexContent', {
    indexId: first.index.id,
    key: 'events',
  });
  assert.ok(!firstDoc.text.includes('New demand'));
  const second = await f.invoke('MemoryIndexMaintain', { indexId: first.index.id });
  assert.equal(second.coverage.cursor, range.to);
  assert.equal(pending(await f.invoke('MemoryRange', { indexId: first.index.id })), 0);
});

test('content without citations cannot bypass source visibility revocation', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const first = await create(f);
  await f.invoke('MemoryIndexWrite', {
    indexId: first.index.id,
    key: 'summary',
    text: 'Derived private information',
    expectedRevision: first.index.revision,
  });
  f.sessions.delete('chat-a');
  await assert.rejects(
    f.invoke('MemoryIndexContent', { indexId: first.index.id, key: 'summary' }),
    /visibility/,
  );
  await assert.rejects(f.invoke('MemoryHistory', { to: first.range.to }), /visibility/);
});

test('false checkpoints continue the same Session and range until true, without a round cap', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const workerIds = new Set<string>(),
    rangeIds = new Set<string>(),
    cursors = new Set<string>();
  let calls = 0,
    active = 0;
  let joined: Promise<any> | undefined;
  f.setWorkerRunner(async (sessionId, prompt) => {
    assert.equal(++active, 1, 'continuation must wait for the prior turn to settle');
    const round = ++calls;
    workerIds.add(sessionId);
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const summary = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    rangeIds.add(summary.range.rangeId);
    cursors.add(summary.range.to);
    assert.equal(summary.coverage.cursor, null);
    if (round > 1) {
      assert.match(prompt, /previous turn saved complete=false/);
      assert.match(prompt, /Only set complete=true when finished/);
      assert.equal(summary.notes, `Remaining work after ${round - 1}`);
      const old = await f.invokeAs(sessionId, 'MemoryIndexContent', {
        indexId,
        key: 'events',
      });
      assert.equal(old.text, `Progress ${round - 1}`);
    }
    const write = await f.invokeAs(sessionId, 'MemoryIndexWrite', {
      indexId,
      key: 'events',
      text: `Progress ${round}`,
      expectedRevision: summary.index.revision,
    });
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: summary.range.rangeId,
      expectedRevision: write.revision,
      notes: `Remaining work after ${round}`,
      complete: round === 8,
    });
    if (round === 1) {
      joined = f.invoke('MemoryIndexMaintain', { indexId });
      f.sessions.get('chat-b')!.push({ id: 'later', type: 'user', text: 'Arrived mid-run' });
      await f.invoke('MemoryRange', {});
    }
    active--;
  });
  const result = await create(f);
  assert.equal((await joined).index.id, result.index.id);
  assert.equal(calls, 8, 'seven false checkpoints must not hit a five-round cap');
  assert.equal(workerIds.size, 1);
  assert.equal(f.workers.size, 1);
  assert.equal(rangeIds.size, 1);
  assert.equal(cursors.size, 1);
  assert.equal(result.range.completed, true);
  assert.equal(result.coverage.cursor, [...cursors][0]);
  assert.equal(result.maintenance.lastError, undefined);
  assert.equal(result.maintenance.running, false);
  assert.equal(pending(await f.invoke('MemoryRange', { indexId: result.index.id })), 1);
});

test('an old false checkpoint is not reused when the next turn submits no checkpoint', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    if (++calls > 1) return;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: s.range.rangeId,
      expectedRevision: s.index.revision,
      notes: 'Only first turn reported progress',
      complete: false,
    });
  });
  const result = await create(f);
  assert.equal(calls, 2);
  assert.equal(result.coverage.cursor, null);
  assert.match(result.maintenance.lastError, /without completing/);
});

test('another Session cannot request continuation through its false checkpoint', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    calls++;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await f.invoke('MemoryIndexCheckpoint', {
      indexId,
      rangeId: s.range.rangeId,
      expectedRevision: s.index.revision,
      notes: 'Foreground note, not worker completion',
      complete: false,
    });
  });
  const result = await create(f);
  assert.equal(calls, 1);
  assert.match(result.maintenance.lastError, /without completing/);
});

test('false then true in one turn finishes without an extra continuation', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    calls++;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    for (const complete of [false, true])
      await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
        indexId,
        rangeId: s.range.rangeId,
        expectedRevision: s.index.revision,
        notes: complete ? 'Finished' : 'Still working',
        complete,
      });
  });
  const result = await create(f);
  assert.equal(calls, 1);
  assert.equal(result.range.completed, true);
});

test('a stopped worker is not restarted by false or by the maintenance timer', async (t) => {
  const f = await fixture(false, { tickMs: 10, retryMs: 1, intervalMs: 1, threshold: 1 });
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    calls++;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: s.range.rangeId,
      expectedRevision: s.index.revision,
      notes: 'Unfinished, then user stopped the worker',
      complete: false,
    });
    f.workers.get(sessionId)!.status = 'aborted';
  });
  const result = await create(f);
  assert.equal(result.maintenance.continuationStopped, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(result.coverage.cursor, null);
  assert.match(result.maintenance.lastError, /aborted/);
});

test('a timeout after false cancels the active turn without immediately continuing it', async (t) => {
  const f = await fixture(false, { runTimeoutMs: 30 });
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    calls++;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: s.range.rangeId,
      expectedRevision: s.index.revision,
      notes: 'Still working in this turn',
      complete: false,
    });
    await new Promise((r) => setTimeout(r, 100));
  });
  const result = await create(f);
  assert.equal(calls, 1);
  assert.equal(f.cancellations(), 1);
  assert.equal(result.coverage.cursor, null);
  assert.match(result.maintenance.lastError, /timeout/i);
});

test('each continuation receives a fresh per-turn timeout', async (t) => {
  const f = await fixture(false, { runTimeoutMs: 90 });
  t.after(() => f.close());
  let calls = 0;
  f.setWorkerRunner(async (sessionId, prompt) => {
    const round = ++calls;
    const indexId = /Organize index ([^. ]+)/.exec(prompt)![1];
    const s = await f.invokeAs(sessionId, 'MemoryIndexRead', { indexId });
    await new Promise((r) => setTimeout(r, 60));
    await f.invokeAs(sessionId, 'MemoryIndexCheckpoint', {
      indexId,
      rangeId: s.range.rangeId,
      expectedRevision: s.index.revision,
      notes: `Round ${round}`,
      complete: round === 3,
    });
  });
  const result = await create(f);
  assert.equal(calls, 3);
  assert.equal(result.range.completed, true);
  assert.equal(f.cancellations(), 0);
});

for (const bundle of [false, true])
  test(`bundle=${bundle}: complete directory, batch/full/search and lightweight backlinks`, async (t) => {
    const f = await fixture(bundle);
    t.after(() => f.close());
    const first = await create(f);
    const indexId = first.index.id;
    let revision = first.index.revision;
    for (let n = 0; n < 105; n++) {
      const write = await f.invoke('MemoryIndexWrite', {
        indexId,
        key: `event-${String(n).padStart(3, '0')}`,
        text: `# Event ${n}\n${'Evidence '.repeat(150)}${n === 104 ? 'Late unique finding' : ''}`,
        expectedRevision: revision,
      });
      revision = write.revision;
    }
    const summary = await f.invoke('MemoryIndexRead', { indexId });
    assert.equal(summary.contents.total, 106);
    assert.equal(summary.contents.items.length, 106);
    assert.equal(summary.contents.next, null);
    assert.equal(summary.contents.items[0].body, undefined);
    const directory = await f.invoke('MemoryIndexContent', { indexId });
    assert.equal(directory.items.length, 106);
    assert.equal(directory.next, null);
    const batch = await f.invoke('MemoryIndexContent', {
      indexId,
      keys: ['event-000', 'event-104', 'missing'],
    });
    assert.equal(batch.items.length, 2);
    assert.match(batch.items[1].text, /Late unique finding/);
    assert.deepEqual(batch.missingKeys, ['missing']);
    const full = await f.invoke('MemoryIndexContent', { indexId, view: 'full' });
    assert.equal(full.items.length, 106);
    assert.ok(full.items.every((e: any) => e.text.length > 0));
    const search = await f.invoke('MemoryIndexContent', {
      indexId,
      query: 'UNIQUE finding',
      view: 'full',
    });
    assert.deepEqual(
      search.items.map((e: any) => e.key),
      ['event-104'],
    );
    const small = await f.invoke('MemoryIndexContent', {
      indexId,
      view: 'full',
      maxChars: 10,
    });
    assert.equal(small.items.length, 1);
    assert.equal(
      small.items[0].text,
      full.items[0].text,
      'do not truncate even an oversized first document',
    );
    assert.equal(small.exceedsBudget, true);
    const rest = await f.invoke('MemoryIndexContent', {
      indexId,
      view: 'full',
      after: small.next,
    });
    assert.deepEqual(
      [...small.items, ...rest.items],
      full.items,
      'resume without duplicate or omitted documents',
    );
    const limited = await f.invoke('MemoryIndexContent', { indexId, limit: 50 });
    assert.equal(limited.items.length, 50);
    const history = await f.invoke('MemoryHistory', { to: first.range.to, mode: 'messages' });
    const ref = history.items[0].ref;
    const original = await f.invoke('MemoryOriginal', { ref });
    assert.equal(original.backlinks.length, 1);
    assert.equal(original.backlinks[0].body, undefined);
    assert.equal(original.backlinks[0].indexId, indexId);
    const expanded = await f.invoke('MemoryOriginal', { ref, expandBacklinks: true });
    const linked = await f.invoke('MemoryIndexContent', {
      indexId,
      key: original.backlinks[0].key,
    });
    assert.equal(expanded.backlinks[0].body, linked.text);
    const plan = new Main.ToolAvailabilityRuntime(
      f.tools.resolve('fresh-chat', []).tools,
      {},
      { name: 'invalid', description: 'invalid', parameters: {}, impl: () => ({}) },
    ).prepare(new Map());
    for (const name of [
      'MemoryIndexList',
      'MemoryIndexRead',
      'MemoryIndexContent',
      'MemoryOriginal',
    ])
      assert.ok(plan.activeTools.includes(name), `${name} is available without search`);
    f.sessions.delete('chat-a');
    await assert.rejects(
      f.invoke('MemoryIndexContent', { indexId, view: 'full' }),
      /visibility/,
    );
    await assert.rejects(
      f.invoke('MemoryIndexContent', { indexId, query: 'unique' }),
      /visibility/,
    );
  });
