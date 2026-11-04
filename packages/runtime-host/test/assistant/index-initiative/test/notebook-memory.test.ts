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
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';

const note = (text = '导出失败，怀疑缺少依赖。', topicId = 'export') => ({
  topicId,
  title: topicId,
  text,
  occurredAt: null,
  sources: ['执行记录 R1'],
  tags: ['export'],
});
const commit = (book: Notebook, operationId: string, draft: any) =>
  book.commitDraft({
    role: 'exploration',
    operationId,
    expectedFeedbackRevision: book.revision(),
    draft,
  });
const correction = (entryId = 'initial:note:0', expectedRevision = 1) => ({
  entryId,
  expectedRevision,
  text: '依赖已安装，当前证据指向版本不兼容。',
  kind: 'observation',
  sources: ['版本检查 R2'],
  occurredAt: null,
  reason: '新检查排除了依赖缺失。',
});
function fixture(t: any) {
  const book = new Notebook(':memory:');
  t.after(() => book.close());
  commit(book, 'initial', { notes: [note()] });
  return book;
}
function directory(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'notebook-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(root, 'notebook.sqlite');
}
function pages(book: Notebook, input: any) {
  let result: any = book.readMemory(input);
  const items = [...result.items];
  while (result.nextCursor) {
    result = book.readMemory({ ...input, cursor: result.nextCursor });
    items.push(...result.items);
  }
  return items;
}

test('legacy events migrate without changing originals or promoting observations to facts', (t) => {
  const file = directory(t);
  const old = new DatabaseSync(file);
  old.exec(
    'CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,at TEXT NOT NULL,payload TEXT NOT NULL)',
  );
  const original = JSON.stringify(note());
  old
    .prepare('INSERT INTO events(id,kind,at,payload) VALUES(?,?,?,?)')
    .run('legacy-note', 'note', '2026-11-01T00:00:00Z', original);
  old.close();
  const book = new Notebook(file);
  try {
    const item = (book.readMemory({ view: 'topic', topicId: 'export' }) as any).items[0];
    assert.equal(item.id, 'legacy-note');
    assert.equal(item.revision, 1);
    assert.equal(item.kind, 'legacy');
    assert.equal(
      book.db.prepare('SELECT payload FROM events WHERE id=?').get('legacy-note')!.payload,
      original,
    );
    assert.equal(book.events().length, 1);
  } finally {
    book.close();
  }
  const legacy = new DatabaseSync(file);
  legacy
    .prepare('INSERT INTO events(id,kind,at,payload) VALUES(?,?,?,?)')
    .run(
      'after-rollback',
      'note',
      '2026-11-02T00:00:00Z',
      JSON.stringify(note('回退到旧版本后的新增笔记。')),
    );
  legacy.close();
  const restored = new Notebook(file);
  try {
    assert.equal(pages(restored, { view: 'topic', topicId: 'export' }).length, 2);
  } finally {
    restored.close();
  }
});

test('an explicit correction replaces the current entry and retains readable historical versions', (t) => {
  const book = fixture(t);
  commit(book, 'correct', { updates: [correction()] });
  const items = pages(book, { view: 'topic', topicId: 'export' });
  assert.equal(items.length, 1);
  assert.equal(items[0].revision, 2);
  assert.equal(items[0].text, correction().text);
  assert.equal(book.event('initial:note:0').payload.text, note().text);
  const old = book.readMemory({ view: 'entry', entryId: items[0].id, revision: 1 }) as any;
  assert.equal(JSON.parse(old.text).text, note().text);
  assert.equal(book.state('export').status, 'open');
});

test('replaying a correction is idempotent and stale or failed batches roll back every projection', (t) => {
  const book = fixture(t);
  const updates = [correction()];
  const result = commit(book, 'correct', { updates });
  const before = book.events().length;
  assert.deepEqual(commit(book, 'correct', { updates }), result);
  assert.equal(book.events().length, before);
  assert.throws(
    () => commit(book, 'correct', { updates: [{ ...correction(), text: 'changed retry' }] }),
    /conflict/,
  );
  assert.throws(
    () => commit(book, 'stale', { notes: [note('应当回滚', 'new-topic')], updates }),
    /ENTRY_CHANGED/,
  );
  assert.equal(book.events().length, before);
  assert.equal(book.topics().has('new-topic'), false);
  assert.equal(book.memory.current('initial:note:0').revision, 2);
});

test('two connections cannot silently overwrite the same entry revision', (t) => {
  const file = directory(t);
  const first = new Notebook(file);
  commit(first, 'initial', { notes: [note()] });
  const second = new Notebook(file);
  try {
    assert.equal(second.memory.current('initial:note:0').revision, 1);
    commit(first, 'first', { updates: [correction()] });
    assert.throws(() => commit(second, 'second', { updates: [correction()] }), /ENTRY_CHANGED/);
    assert.equal(second.memory.current('initial:note:0').revision, 2);
  } finally {
    second.close();
    first.close();
  }
});

test('snapshot pages survive unrelated writes, concurrent correction and reopening the database', (t) => {
  const file = directory(t);
  let book = new Notebook(file);
  try {
    commit(book, 'many', { notes: [note('one'), note('two'), note('three')] });
    const first = book.readMemory({ view: 'topic', topicId: 'export', limit: 1 }) as any;
    assert.equal(first.items[0].text, 'one');
    commit(book, 'change', {
      updates: [correction('many:note:1')],
      notes: [note('four'), note('another topic', 'other')],
    });
    book.close();
    book = new Notebook(file);
    const second = book.readMemory({
      view: 'topic',
      topicId: 'export',
      limit: 1,
      cursor: first.nextCursor,
    }) as any;
    assert.equal(second.items[0].text, 'two');
    assert.equal(second.items[0].revision, 1);
    const third = book.readMemory({
      view: 'topic',
      topicId: 'export',
      limit: 1,
      cursor: second.nextCursor,
    }) as any;
    assert.equal(third.items[0].text, 'three');
    assert.equal(third.nextCursor, null);
    const fresh = pages(book, { view: 'topic', topicId: 'export' });
    assert.equal(fresh.length, 4);
    assert.ok(fresh.some((entry) => entry.revision === 2));
    assert.throws(
      () => book.readMemory({ view: 'topic', topicId: 'other', cursor: first.nextCursor }),
      /Invalid notebook cursor/,
    );
    assert.throws(
      () => book.readMemory({ view: 'topic', topicId: 'export', cursor: 'tampered' }),
      /Invalid notebook cursor/,
    );
  } finally {
    book.close();
  }
});

test('Chinese search excludes superseded text and preserves two-character searches', (t) => {
  const book = fixture(t);
  commit(book, 'correct', { updates: [correction()] });
  assert.equal(pages(book, { view: 'topic', topicId: 'export', query: '缺少依赖' }).length, 0);
  assert.equal(pages(book, { view: 'topic', topicId: 'export', query: '版本不兼容' }).length, 1);
  assert.equal(pages(book, { view: 'topic', topicId: 'export', query: '版本' }).length, 1);
});

test('research checkpoints retain silent investigations without creating duplicate knowledge', (t) => {
  const book = fixture(t);
  commit(book, 'checked', {
    checkpoints: [
      { topicId: 'export', text: '已复查，等待修复验证。', entryIds: ['initial:note:0'] },
    ],
  });
  assert.equal(pages(book, { view: 'topic', topicId: 'export' }).length, 1);
  assert.ok(
    pages(book, { view: 'history', topicId: 'export' }).some(
      (event) => event.text === '已复查，等待修复验证。',
    ),
  );
  assert.equal(book.state('export').status, 'open');
  assert.throws(
    () =>
      commit(book, 'bad', {
        checkpoints: [{ topicId: 'export', text: 'bad', entryIds: ['missing'] }],
      }),
    /Checkpoint entries/,
  );
});

test('history exposes withheld reasons as text and pending feedback excludes unrelated legacy chat', (t) => {
  const book = fixture(t);
  book.recordWithheld({ topicId: 'export', reason: '尚无新的可行动信息。' }, 'withheld');
  assert.ok(
    pages(book, { view: 'history', topicId: 'export' }).some(
      (event) => event.text === '尚无新的可行动信息。',
    ),
  );
  assert.ok(
    pages(book, { view: 'history', topicId: 'export' }).every((event) => !('payload' in event)),
    'read views have one consistent text field; raw payloads are accessed explicitly',
  );
  book.put('old-chat', 'feedback', { text: 'legacy ordinary chat', replyTo: null });
  book.put('old-rule', 'feedback-resolution', {
    feedbackId: 'old-chat',
    understanding: 'legacy interpretation',
    rules: [
      { quote: 'legacy', status: 'closed', reason: 'legacy', topicIds: ['export'], tags: [] },
    ],
  });
  assert.equal(pages(book, { view: 'feedback' }).length, 0);
  assert.equal(pages(book, { view: 'rules' }).length, 0);
});

test('large legacy entries remain fully readable with bounded Unicode-safe pages', (t) => {
  const book = fixture(t);
  const value = '来源包含中文与表情😊。'.repeat(1200);
  commit(book, 'large', { notes: [note(value)] });
  const rows = pages(book, { view: 'topic', topicId: 'export', limit: 1 });
  const stub = rows.find((row) => row.id === 'large:note:0');
  assert.equal(stub.truncated, true);
  let page: any = book.readMemory(stub.read);
  let body = page.text;
  while (page.nextCursor) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 7500);
    page = book.readMemory({ ...stub.read, cursor: page.nextCursor });
    body += page.text;
  }
  assert.equal(JSON.parse(body).text, value);
});

test('ordinary knowledge writes cannot invent feedback, policy or delivery receipts', (t) => {
  const book = fixture(t);
  assert.throws(
    () => commit(book, 'bad-note', { notes: [{ ...note(), status: 'closed' }] }),
    /Unsupported note field/,
  );
  assert.throws(
    () => commit(book, 'bad-update', { updates: [{ ...correction(), status: 'closed' }] }),
    /Invalid memory update/,
  );
  assert.throws(
    () => commit(book, 'bad-message', { messages: [{ text: 'send now', topicIds: ['export'] }] }),
    /Exploration only/,
  );
  assert.equal(book.state('export').status, 'open');
  assert.equal(book.events('delivery').length, 0);
});

test('current projections rebuild from committed history without another model call', (t) => {
  const book = fixture(t);
  commit(book, 'correct', { updates: [correction()] });
  commit(book, 'checkpoint', { checkpoints: [{ topicId: 'export', text: '等待修复验证。' }] });
  const before = pages(book, { view: 'topic', topicId: 'export' });
  const events = book.events();
  book.memory.rebuild();
  assert.deepEqual(pages(book, { view: 'topic', topicId: 'export' }), before);
  assert.deepEqual(book.events(), events);
  assert.equal(pages(book, { view: 'topic', topicId: 'export', query: '版本不兼容' }).length, 1);
});

test('a topic snapshot does not hide feedback that arrived after its first page', (t) => {
  const book = fixture(t);
  commit(book, 'second', { notes: [note('第二项认识。')] });
  const first = book.readMemory({ view: 'topic', topicId: 'export', limit: 1 }) as any;
  book.put('sent', 'delivery', {
    text: '已告知导出问题。',
    topicIds: ['export'],
    messageIds: ['sent'],
  });
  book.recordFeedback({ id: 'feedback', text: '暂时不再提醒', replyTo: 'sent' });
  book.commitDraft({
    role: 'judgement',
    operationId: 'policy',
    expectedFeedbackRevision: book.revision(),
    draft: {
      feedbackDecisions: [
        {
          feedbackId: 'feedback',
          understanding: '用户要求暂缓本事项提醒。',
          rules: [
            {
              quote: '暂时不再提醒',
              status: 'deferred',
              reason: '按用户要求',
              topicIds: ['export'],
              tags: [],
            },
          ],
        },
      ],
    },
  });
  const next = book.readMemory({
    view: 'topic',
    topicId: 'export',
    limit: 1,
    cursor: first.nextCursor,
  }) as any;
  assert.equal(next.through, first.through);
  assert.equal(next.currentUserPolicy.status, 'deferred');
  assert.ok(next.feedbackRevision > first.feedbackRevision);
});

test('repeated research does not move an old topic ahead of newly discovered topics', (t) => {
  const book = fixture(t);
  commit(book, 'new-topic', { notes: [note('新方向。', 'recent')] });
  commit(book, 'old-topic', { notes: [note('旧方向的新细节。')] });
  const first = book.readMemory({ view: 'catalog', limit: 1 }) as any;
  assert.equal(first.items[0].id, 'recent');
  commit(book, 'later-topic', { notes: [note('翻页期间的新主题。', 'later')] });
  const next = book.readMemory({ view: 'catalog', limit: 1, cursor: first.nextCursor }) as any;
  assert.equal(next.items[0].id, 'export');
  assert.equal(next.nextCursor, null);
  assert.equal((book.readMemory({ view: 'catalog', limit: 1 }) as any).items[0].id, 'later');
  assert.throws(
    () => book.readMemory({ view: 'history', query: 'ignored filter' }),
    /query is supported/,
  );
});

test('oversized catalog and history items retain the correct expansion route', (t) => {
  const book = fixture(t);
  commit(book, 'long-title', {
    notes: [{ ...note('一条认识。', 'long'), title: '很长的旧标题'.repeat(1000) }],
  });
  const catalog = book.readMemory({ view: 'catalog' }) as any;
  const topic = catalog.items.find((item: any) => item.id === 'long');
  assert.equal(topic.truncated, true);
  assert.deepEqual(topic.read, { view: 'topic', topicId: 'long' });
  const entries = book.readMemory(topic.read) as any;
  const original = book.readMemory(entries.items[0].read) as any;
  assert.equal(original.view, 'entry');
  commit(book, 'large-correction', {
    updates: [{ ...correction(), text: '很长的修正内容。'.repeat(1000) }],
  });
  const history = pages(book, { view: 'history', topicId: 'export' });
  const update = history.find((item) => item.kind === 'entry-update');
  assert.equal(update.truncated, true);
  assert.deepEqual(update.read, { view: 'event', eventId: update.id });
  assert.equal((book.readMemory(update.read) as any).view, 'event');
});
