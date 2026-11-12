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
import { join } from 'node:path';
import { CorpusStore } from '../../../../src/assistant/memory-network/corpus.js';
import { MemoryController } from '../../../../src/assistant/memory-network/controller.js';
import { fixture } from './host-fixture.js';

async function setup(t: any) {
  const f = await fixture();
  const s = new CorpusStore(join(f.root, 'data'));
  t.after(async () => {
    s.close();
    await f.close();
  });
  const state = { reads: 0, scans: 0, blocked: new Set<string>(), down: new Set<string>() };
  for (const source of ['external', 'extra', 'secret'])
    f.sources.register({
      id: source,
      description: source,
      queryHelp: '{}',
      scope: {},
      enumerate: async () => {
        state.scans++;
        return { items: s.references(source).map((r) => r.object) };
      },
      query: async () => ({ items: [] }),
      authorize: async (objects) => {
        if (state.down.has(source)) throw Error('temporarily unavailable');
        return state.blocked.has(source) ? [] : objects.map((o) => o.id);
      },
      read: async () => {
        state.reads++;
        throw Error('navigation must not fetch bodies');
      },
    });
  const ref = (source: string, id: string, revision = 'v1') =>
    s.rememberReference(source, { id, revision, locator: { id }, kind: 'text' });
  const index = (name: string, sources = ['external']) =>
    s.create(name, '按用户标准整理', [], sources).id;
  const write = (id: string, key: string, refs: any[]) =>
    s.write(
      id,
      key,
      'Long document must not be copied ' +
        refs.map((r) => `[原文](memory-original:${r.ref})`).join(' '),
      s.index(id).revision,
      s.references().map((r) => r.recordKey),
    );
  return { f, s, state, ref, index, write };
}

test('source addition is atomic, idempotent and preserves content, coverage, groups and schedule', async (t) => {
  const { f, s, state, ref, index, write } = await setup(t);
  const original = ref('external', 'one');
  const a = index('A'),
    b = index('B');
  write(a, 'entry', [original]);
  const cursor = s.capture(['external'], []);
  for (const id of [a, b]) {
    const work = s.begin(id, cursor.id, []);
    s.checkpoint(id, work.id, s.index(id).revision, 'complete', true, []);
    s.saveWorker(id, {
      protocol: 'cursor-v1',
      groupIndexIds: [a, b],
      groupNumber: id === a ? 1 : 2,
      sessionId: 'group-worker',
      maintenanceEnabled: false,
      intervalMs: 345600,
      nextCheckAt: null,
    });
  }
  const before = s.index(a),
    worker = s.worker(a);
  const result = await f.invoke('MemoryIndexAddSources', {
    indexIds: [a, b, a],
    sources: ['maka', 'extra', 'extra'],
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].added, ['maka', 'extra']);
  assert.deepEqual(result[0].sources, ['external', 'maka', 'extra']);
  assert.equal(result[0].revision, before.revision + 1);
  assert.equal(result[0].coveredCursor, cursor.id);
  assert.match(result[0].notice, /历史尚未整理/);
  assert.deepEqual(s.worker(a), {
    ...worker,
    lastCheckError: 'Sources appended; source observations need refreshing',
  });
  assert.match(s.content(a, 'entry', [original.recordKey]).text, /Long document/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM links WHERE index_id=?').get(a)!.n, 1);
  const commits = s.db.prepare('SELECT count(*) AS n FROM commits').get()!.n;
  const again = await f.invoke('MemoryIndexAddSources', { indexIds: [a, b], sources: ['extra'] });
  assert.deepEqual(
    again.map((r: any) => r.added),
    [[], []],
  );
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM commits').get()!.n, commits);
  assert.equal(s.index(a).revision, before.revision + 1);
  assert.equal(state.scans, 0);
  assert.equal(state.reads, 0);
  assert.equal(f.llmCalls.length, 0);
  assert.equal(f.workers.size, 0);
  const added = ref('extra', 'new-history');
  const refreshed = await f.invoke('MemoryIndexRead', { indexId: a });
  assert.equal(refreshed.freshness.coveredCursor, cursor.id);
  assert.ok(
    refreshed.freshness.knownPending.sources.some(
      (x: any) => x.source === 'extra' && x.changedRecords === 1,
    ),
  );
  assert.equal(s.work(a)!.to, cursor.id);
  assert.equal(s.worker(a).maintenanceEnabled, false);
  assert.equal(state.reads, 0);
  assert.ok(added.ref);
});

test('source addition validates all indexes and sources, rejects unfinished work, and rolls back all mutations', async (t) => {
  const { f, s, index, ref, write, state } = await setup(t);
  const a = index('A'),
    b = index('B');
  const cursor = s.capture(['external'], []);
  s.begin(b, cursor.id, []);
  const baseline = JSON.stringify(s.list());
  for (const request of [
    { indexIds: [a, b], sources: ['extra'] },
    { indexIds: [a, 'missing'], sources: ['extra'] },
    { indexIds: [a], sources: ['unknown'] },
  ])
    await assert.rejects(f.invoke('MemoryIndexAddSources', request), /unfinished|Unknown/);
  assert.equal(JSON.stringify(s.list()), baseline);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM commits').get()!.n, 0);
  assert.deepEqual(
    (await f.invoke('MemoryIndexAddSources', { indexIds: [b], sources: ['external'] }))[0].added,
    [],
  );
  // A trigger simulates a storage failure after the first member has been updated.
  s.db.exec(
    `CREATE TRIGGER fail_second BEFORE UPDATE ON indexes WHEN OLD.id='${b}' BEGIN SELECT RAISE(ABORT,'injected write failure'); END`,
  );
  s.checkpoint(b, s.work(b)!.id, 0, '', true, []);
  await assert.rejects(
    f.invoke('MemoryIndexAddSources', { indexIds: [a, b], sources: ['extra'] }),
    /injected write/,
  );
  assert.equal(JSON.stringify(s.list()), baseline);
  s.db.exec('DROP TRIGGER fail_second');
  const privateRef = ref('secret', 'hidden');
  const hidden = index('hidden', ['secret']);
  write(hidden, 'private', [privateRef]);
  // Entry permission is relevant even if an index has no completed range.
  state.blocked.add('secret');
  await assert.rejects(
    f.invoke('MemoryIndexAddSources', { indexIds: [a, hidden], sources: ['extra'] }),
    /visible|visibility|accessible/i,
  );
  assert.equal(s.index(a).revision, 0);
  f.setIncognito(true);
  await assert.rejects(
    f.invoke('MemoryIndexAddSources', { indexIds: [a], sources: ['extra'] }),
    /Incognito/,
  );
});

test('links preserve versions, count distinct shared objects, paginate paths, and isolate inaccessible sources', async (t) => {
  const { f, s, state, ref, index, write } = await setup(t);
  const a1 = ref('external', 'a'),
    a2 = ref('external', 'a', 'v2');
  const b = ref('external', 'b'),
    lonely = ref('external', 'lonely');
  const more = ref('extra', 'more'),
    hidden = ref('secret', 'hidden');
  const start = index('start'),
    cross = index('cross', ['external', 'extra']);
  const denied = index('denied', ['external', 'secret']);
  write(start, 'entry', [a1, a2, b, lonely]);
  write(start, 'sibling', [a2]);
  write(cross, 'linked', [a1, a2, b, more]);
  write(denied, 'do-not-leak', [a1, hidden]);
  state.down.add('secret');
  const snapshot = () =>
    JSON.stringify(
      [
        'indexes',
        'entries',
        'links',
        'commits',
        'workers',
        'memory_boundaries',
        'memory_work_ranges',
        'memory_cursors',
        'memory_evidence',
      ].map((table) => s.db.prepare(`SELECT * FROM ${table}`).all()),
    );
  const changes = snapshot();
  const all = await f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry', limit: 50 });
  assert.equal(all.originalCount, 4);
  assert.equal(all.relatedDocumentCount, 2);
  assert.equal(all.total, 8); // 5 cross-index paths + 2 sibling paths + 1 lonely original
  assert.ok(
    all.items.slice(0, 5).every((p: any) => p.related.indexId === cross && p.sharedOriginals === 2),
  );
  assert.ok(
    all.items.slice(5, 7).every((p: any) => p.related.key === 'sibling' && p.sharedOriginals === 1),
  );
  assert.equal(all.items[7].related, null);
  assert.equal(all.items[7].original.ref, lonely.ref);
  for (const path of all.items.filter((p: any) => p.related))
    assert.equal(path.related.sameRevision, path.original.ref === path.related.ref);
  assert.ok(
    all.items.some(
      (p: any) => p.original.ref === a1.ref && p.related?.ref === a2.ref && !p.related.sameRevision,
    ),
  );
  assert.ok(!JSON.stringify(all).includes('Long document'));
  assert.ok(!JSON.stringify(all).includes(denied));
  const collected = [];
  let offset = 0;
  do {
    const page = await f.invoke('MemoryIndexLinks', {
      indexId: start,
      key: 'entry',
      offset,
      limit: 3,
    });
    collected.push(...page.items);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  assert.deepEqual(collected, all.items);
  assert.equal(
    (await f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry', offset: 999 })).nextOffset,
    null,
  );
  assert.equal(state.reads, 0);
  assert.equal(state.scans, 0);
  assert.equal(f.llmCalls.length, 0);
  assert.equal(snapshot(), changes);
  state.down.clear();
  state.blocked.add('secret');
  assert.deepEqual(
    (await f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry' })).items,
    all.items,
  );
  await assert.rejects(
    f.invoke('MemoryIndexLinks', { indexId: denied, key: 'do-not-leak' }),
    /visibility/,
  );
  await assert.rejects(
    f.invoke('MemoryIndexLinks', { indexId: start, key: 'missing' }),
    /Unknown index entry/,
  );
  await assert.rejects(f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry', limit: 51 }));
  await assert.rejects(f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry', offset: -1 }));
  f.setIncognito(true);
  await assert.rejects(f.invoke('MemoryIndexLinks', { indexId: start, key: 'entry' }), /Incognito/);
});

test('all index directory, single and batch content forms expose the same usage', async (t) => {
  const { f, index, write } = await setup(t);
  const id = index('usage');
  write(id, 'one', []);
  write(id, 'two', []);
  const results = [
    (await f.invoke('MemoryIndexList', {})).find((x: any) => x.id === id),
    await f.invoke('MemoryIndexRead', { indexId: id }),
    ...(await Promise.all(
      [{}, { key: 'one' }, { keys: ['one', 'two'] }, { view: 'full' }].map((shape) =>
        f.invoke('MemoryIndexContent', { indexId: id, ...shape }),
      ),
    )),
  ];
  for (const result of results) {
    assert.equal(result.usage, results[0].usage);
    assert.match(result.usage, /目录只用于导航，不代表已读正文/);
    assert.match(result.usage, /MemoryIndexLinks\(indexId,key\)/);
    assert.match(result.usage, /不要求遍历所有索引/);
  }
});

test('source addition refuses a running group even for an already completed member', async (t) => {
  const { f, s, index } = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  t.after(() => release());
  let ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  f.setWorkerRunner(async (session, prompt) => {
    const members = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    const checkpoint = async (indexId: string) => {
      const info = await f.invokeAs(session, 'MemoryIndexRead', { indexId });
      await f.invokeAs(session, 'MemoryIndexCheckpoint', {
        indexId,
        rangeId: info.range.rangeId,
        expectedRevision: info.index.revision,
        complete: true,
        notes: 'done',
      });
    };
    await checkpoint(members[0].indexId);
    ready();
    await gate;
    await checkpoint(members[1].indexId);
  });
  const range = await f.invoke('MemoryRange', {});
  const group = await f.invoke('MemoryIndexCreateGroup', {
    cursor: range.to,
    indexes: [
      { number: 1, name: 'A', instructions: 'A' },
      { number: 2, name: 'B', instructions: 'B' },
    ],
    background: true,
  });
  await started;
  const first = group.members[0].indexId;
  const independent = index('independent', ['maka']);
  assert.equal(s.work(first)!.completed, true);
  await assert.rejects(
    f.invoke('MemoryIndexAddSources', {
      indexIds: [independent, first],
      sources: ['extra'],
    }),
    /running organizing work/,
  );
  assert.deepEqual(s.index(independent).sources, ['maka']);
  assert.deepEqual(
    (
      await f.invoke('MemoryIndexAddSources', {
        indexIds: [first],
        sources: ['maka'],
      })
    )[0].added,
    [],
  );
  release();
});

test('added sources are organized only by explicit maintenance using the existing worker and checkpoint', async (t) => {
  const { f, s, ref } = await setup(t);
  const range = await f.invoke('MemoryRange', {});
  const first = await f.invoke('MemoryIndexCreate', {
    name: 'existing',
    instructions: 'events',
    cursor: range.to,
  });
  const id = first.index.id;
  const sessionId = s.worker(id).sessionId;
  const oldBoundary = s.boundary(id);
  ref('extra', 'new-event');
  await f.invoke('MemoryIndexControl', { indexId: id, action: 'pause' });
  await f.invoke('MemoryIndexAddSources', { indexIds: [id], sources: ['extra'] });
  assert.equal(s.boundary(id), oldBoundary);
  let calls = 0;
  f.setWorkerRunner(async (worker) => {
    calls++;
    assert.equal(worker, sessionId);
    const info = await f.invokeAs(worker, 'MemoryIndexRead', { indexId: id });
    assert.equal(info.range.from, oldBoundary);
    assert.ok(
      info.range.sources.some(
        (source: any) => source.source === 'extra' && source.changedRecords === 1,
      ),
    );
    assert.equal(s.boundary(id), oldBoundary);
    await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
      indexId: id,
      rangeId: info.range.rangeId,
      expectedRevision: info.index.revision,
      notes: 'organized added source',
      complete: true,
    });
  });
  const maintained = await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal(calls, 1);
  assert.equal(maintained.range.completed, true);
  assert.notEqual(maintained.freshness.coveredCursor, oldBoundary);
  assert.equal(s.worker(id).maintenanceEnabled, false);
  assert.equal(s.worker(id).sessionId, sessionId);
});

test('source addition rejects a competing host before changing indexes', async (t) => {
  const { s, index } = await setup(t);
  const id = index('owner protected');
  const competitor = new MemoryController({}, s);
  await assert.rejects(competitor.addSources([id], ['extra']), /ownership changed/);
  assert.equal(s.index(id).revision, 0);
  assert.deepEqual(s.index(id).sources, ['external']);
});

test('list refreshes each shared source once, with concurrent sources and sequential pages', async (t) => {
  const { f, s, index, ref } = await setup(t);
  const scans = new Map<string, number>(),
    auth = new Map<string, number>();
  const entered = new Set<string>();
  let release!: () => void,
    parallel = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(release, 1000);
  t.after(() => clearTimeout(timer));
  for (const source of ['parallel-a', 'parallel-b']) {
    ref(source, 'one');
    f.sources.register({
      id: source,
      description: source,
      scope: {},
      queryHelp: '{}',
      enumerate: async (cursor) => {
        scans.set(source, (scans.get(source) ?? 0) + 1);
        if (!cursor) {
          entered.add(source);
          if (entered.size === 2) {
            parallel = true;
            release();
          }
          await barrier;
          return {
            items: [{ id: 'one', revision: 'v1', kind: 'text', locator: {} }],
            next: 'page2',
          };
        }
        assert.equal(cursor, 'page2');
        return { items: [] };
      },
      authorize: async (objects) => {
        auth.set(source, (auth.get(source) ?? 0) + 1);
        return objects.map((o) => o.id);
      },
      query: async () => ({ items: [] }),
      read: async () => {
        throw Error('must not read bodies');
      },
    });
  }
  const ids = [
    index('A', ['parallel-a']),
    index('B', ['parallel-a', 'parallel-b']),
    index('C', ['parallel-b']),
  ];
  const result = await f.invoke('MemoryIndexList', {});
  assert.equal(parallel, true);
  assert.deepEqual([...scans.values()], [2, 2]);
  assert.deepEqual([...auth.values()], [3, 3]);
  for (const id of ids) {
    const row = result.find((x: any) => x.id === id);
    assert.equal(row.unavailable, undefined);
    assert(row.freshness.observedCursor);
    assert.equal(s.boundary(id), null);
    assert.equal(s.work(id), undefined);
  }
  assert.equal(f.llmCalls.length, 0);
  assert.equal(f.workers.size, 0);
});

test('shared refresh failures preserve old observations and isolate unrelated indexes', async (t) => {
  const { f, s, index, ref } = await setup(t);
  let fail = false,
    scans = 0;
  ref('flaky', 'one');
  f.sources.register({
    id: 'flaky',
    description: 'flaky',
    scope: {},
    queryHelp: '{}',
    enumerate: async () => {
      scans++;
      if (fail) throw Error('scan unavailable');
      return { items: [{ id: 'one', revision: 'v1', kind: 'text', locator: {} }] };
    },
    authorize: async (objects) => objects.map((o) => o.id),
    query: async () => ({ items: [] }),
    read: async () => {
      throw Error('no bodies');
    },
  });
  const a = index('A', ['flaky']),
    b = index('B', ['flaky']),
    c = index('C', ['external']);
  await f.invoke('MemoryIndexList', {});
  const previous = [a, b].map((id) => s.worker(id));
  fail = true;
  const result = await f.invoke('MemoryIndexList', {});
  assert.equal(scans, 2);
  for (const [position, id] of [a, b].entries()) {
    const fresh = result.find((x: any) => x.id === id).freshness;
    assert.equal(fresh.knownPending, null);
    assert.match(fresh.lastCheckError, /scan unavailable/);
    assert.equal(fresh.observedCursor, previous[position].latestCursor);
    assert.equal(fresh.lastCheckedAt, previous[position].lastCheckedAt);
  }
  assert.equal(result.find((x: any) => x.id === c).unavailable, undefined);
  fail = false;
  const recovered = await f.invoke('MemoryIndexList', {});
  assert.equal(scans, 3);
  assert.equal(recovered.find((x: any) => x.id === a).freshness.lastCheckError, null);
});

test('shared history refresh reads each changed session once and keeps index session scopes', async (t) => {
  const { f, s } = await setup(t);
  const a = s.create('A', 'events', ['chat-a'], ['maka']).id;
  const b = s.create('B', 'events', ['chat-b'], ['maka']).id;
  await f.invoke('MemoryIndexList', {});
  assert.deepEqual([...f.reads].sort(), ['chat-a', 'chat-b']);
  const aCursor = s.cursor(s.worker(a).latestCursor);
  const bCursor = s.cursor(s.worker(b).latestCursor);
  assert.notEqual(aCursor.id, bCursor.id);
  f.sessions.get('chat-a')!.push({ id: 'a2', type: 'user', text: 'Update' });
  await f.invoke('MemoryIndexList', {});
  assert.deepEqual([...f.reads].sort(), ['chat-a', 'chat-a', 'chat-b']);
  assert.equal(s.worker(b).latestCursor, bCursor.id);
});

test('a later index reuses an already completed source refresh within the same list', async (t) => {
  const { f, index, ref } = await setup(t);
  let release!: () => void,
    sharedChecks = 0,
    sharedScans = 0;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const source of ['shared', 'slow-gate']) {
    ref(source, 'one');
    f.sources.register({
      id: source,
      description: source,
      scope: {},
      queryHelp: '{}',
      enumerate: async () => {
        if (source === 'shared') sharedScans++;
        return { items: [{ id: 'one', revision: 'v1', kind: 'text', locator: {} }] };
      },
      authorize: async (objects) => {
        if (source === 'shared' && ++sharedChecks === 3) setTimeout(release, 10);
        if (source === 'slow-gate') await finished;
        return objects.map((o) => o.id);
      },
      query: async () => ({ items: [] }),
      read: async () => {
        throw Error('no bodies');
      },
    });
  }
  index('first', ['shared']);
  index('later', ['shared', 'slow-gate']);
  const result = await f.invoke('MemoryIndexList', {});
  assert.equal(sharedScans, 1);
  assert.equal(sharedChecks, 3);
  assert(result.every((row: any) => !row.unavailable));
});
