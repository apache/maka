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
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';

const time = '2026-10-22T10:00:00Z';
const note = (id = 'tea', tags = ['tea']) => ({
  topicId: id,
  title: id,
  text: '一次喝茶的经历，当前偏好尚待了解。',
  occurredAt: '2026-01',
  sources: ['历史用户交流'],
  tags,
});
const draft = (notes = [], feedbackDecisions = [], messages = []) => ({
  notes,
  feedbackDecisions,
  messages,
});
const rule = (
  quote,
  status = 'closed',
  topicIds = [],
  tags = ['tea'],
  reason = '用户不再喝茶',
  resumeAt = null,
) => ({ quote, status, topicIds, tags, reason, resumeAt });
const resolveFeedback = (feedbackId, rules) => ({
  feedbackId,
  understanding: '按用户原话理解范围',
  rules,
});
const commit = (b, id, d, role = 'judgement', revision = b.revision()) =>
  b.commitDraft({ role, operationId: id, expectedFeedbackRevision: revision, draft: d });
function fixture(t) {
  const b = new Notebook(':memory:', () => time);
  t.after(() => b.close());
  commit(b, 'initial', draft([note()]), 'exploration');
  return b;
}

test('research may append context but cannot change state or invent user feedback', (t) => {
  const b = fixture(t);
  assert.throws(
    () => commit(b, 'bad', draft([{ ...note(), status: 'closed' }])),
    /Unsupported note field/,
  );
  assert.throws(
    () => commit(b, 'fake', draft([], [resolveFeedback('invented', [rule('不喝茶')])])),
    /Real user feedback/,
  );
  commit(b, 'context', draft([{ ...note(), text: '查过近期交流，尚未找到新的品饮记录。' }]));
  assert.equal(b.state('tea').status, 'open');
  assert.equal(b.topics().get('tea').notes.length, 2);
});
test('explicit broad feedback applies to multiple existing and future topics', (t) => {
  const b = fixture(t);
  commit(b, 'more', draft([note('oolong'), note('coffee', ['coffee'])]), 'exploration');
  b.recordFeedback({ id: 'f', text: '我不喝茶了，不用再推荐喝茶相关的东西。' });
  commit(b, 'close', draft([], [resolveFeedback('f', [rule('我不喝茶了')])]));
  assert.equal(b.state('tea').status, 'closed');
  assert.equal(b.state('oolong').status, 'closed');
  assert.equal(b.state('coffee').status, 'open');
  commit(b, 'later', draft([note('green-tea')]), 'exploration');
  assert.equal(b.state('green-tea').status, 'closed');
  assert.match(b.render({ topicIds: ['green-tea'] }), /状态：关闭/);
});
test('scope-specific user reopening overrides only that scope and preserves old facts', (t) => {
  const b = fixture(t);
  commit(b, 'more', draft([note('oolong')]), 'exploration');
  b.recordFeedback({ id: 'f', text: '不喝茶了' });
  commit(b, 'close', draft([], [resolveFeedback('f', [rule('不喝茶了')])]));
  b.recordFeedback({ id: 'f2', text: '乌龙茶可以继续推荐' });
  commit(
    b,
    'open',
    draft(
      [],
      [
        resolveFeedback('f2', [
          rule('乌龙茶可以继续推荐', 'open', ['oolong'], [], '用户重新开放乌龙茶'),
        ]),
      ],
    ),
  );
  assert.equal(b.state('oolong').status, 'open');
  assert.equal(b.state('tea').status, 'closed');
  assert.equal(b.events('note').length, 2);
});
test('deferral requires reason or time; closure requires reason and a real quote', (t) => {
  const b = fixture(t);
  b.recordFeedback({ id: 'f', text: '暂时别推荐茶，明天再说' });
  for (const r of [
    rule('别推荐茶', 'deferred', [], ['tea'], '', null),
    rule('别推荐茶', 'closed', [], ['tea'], '', null),
    rule('伪造的话'),
  ])
    assert.throws(() =>
      commit(b, 'bad-' + JSON.stringify(r), draft([], [resolveFeedback('f', [r])])),
    );
  commit(
    b,
    'defer',
    draft(
      [],
      [
        resolveFeedback('f', [
          rule('明天再说', 'deferred', [], ['tea'], '', '2026-10-23T10:00:00Z'),
        ]),
      ],
    ),
  );
  assert.equal(b.state('tea').status, 'deferred');
  assert.equal(b.state('tea', '2026-10-24T00:00:00Z').status, 'open');
});
test('pending feedback remains visible to both roles; stale work cannot commit', (t) => {
  const b = fixture(t),
    revision = b.revision();
  b.recordFeedback({ id: 'f', text: '这是给朋友看的，不是我的爱好' });
  assert.match(b.render(), /这是给朋友看的/);
  assert.match(b.render(), /待理解/);
  assert.throws(
    () => commit(b, 'old', draft([note('other')]), 'exploration', revision),
    /FEEDBACK_CHANGED/,
  );
  assert.throws(
    () => commit(b, 'unread', draft([], [], [{ text: '喝茶推荐', topicIds: ['tea'] }])),
    /pending user feedback/,
  );
  commit(
    b,
    'understand',
    draft(
      [
        {
          ...note(),
          text: '用户说明资料是给朋友看的。',
          occurredAt: time,
          sources: ['用户反馈 f'],
        },
      ],
      [resolveFeedback('f', [])],
    ),
  );
  assert.equal(b.state('tea').status, 'open');
  assert.equal(b.pendingFeedback().length, 0);
});
test('prepared, failed and unconfirmed sends are not sent; confirmed receipts are idempotent', async (t) => {
  const b = fixture(t);
  const {
    preparedIds: [id],
  } = commit(b, 'p', draft([], [], [{ text: '一条内容', topicIds: ['tea'] }]));
  assert.equal(b.state('tea').displayStatus, 'open');
  await assert.rejects(
    b.deliver(
      id,
      async () => {
        throw Error('offline');
      },
      'test-bridge',
    ),
    /offline/,
  );
  await assert.rejects(
    b.deliver(id, async () => ({ delivered: false, messageIds: ['m'] }), 'test-bridge'),
    /No confirmed/,
  );
  let count = 0;
  const sender = async () => {
    count++;
    return { delivered: true, messageIds: ['m'] };
  };
  await b.deliver(id, sender, 'test-bridge');
  await b.deliver(id, sender, 'test-bridge');
  assert.equal(count, 1);
  assert.equal(b.state('tea').displayStatus, 'sent');
  assert.equal(b.state('tea').status, 'open');
  b.recordFeedback({ id: 'f', text: '不喝茶了', replyTo: id + ':delivered' });
  commit(b, 'f-close', draft([], [resolveFeedback('f', [rule('不喝茶了')])]));
  assert.equal(b.state('tea').displayStatus, 'closed');
  assert.equal(b.state('tea').receipts.length, 1);
});
test('new feedback after preparation prevents stale delivery', async (t) => {
  const b = fixture(t);
  const {
    preparedIds: [id],
  } = commit(b, 'p', draft([], [], [{ text: '一条内容', topicIds: ['tea'] }]));
  b.recordFeedback({ id: 'f', text: '先别发推荐' });
  let called = false;
  await assert.rejects(
    b.deliver(
      id,
      async () => {
        called = true;
        return { delivered: true, messageIds: ['m'] };
      },
      'test-bridge',
    ),
    /FEEDBACK_CHANGED/,
  );
  assert.equal(called, false);
});
test('whole draft is atomic and operation retries do not duplicate records', (t) => {
  const b = fixture(t),
    d = draft([note('new')]);
  const r = commit(b, 'ok', d, 'exploration');
  assert.deepEqual(commit(b, 'ok', d, 'exploration'), r);
  assert.equal(b.topics().get('new').notes.length, 1);
  assert.throws(() => commit(b, 'ok', draft([note('different')]), 'exploration'), /conflict/);
  assert.throws(() =>
    commit(b, 'bad', draft([note('rollback')], [], [{ text: 'oops', topicIds: ['missing'] }])),
  );
  assert.equal(b.topics().has('rollback'), false);
});
test('notes preserve sources, links, and recording time without inventing occurrence dates', (t) => {
  const b = new Notebook(':memory:', () => time);
  t.after(() => b.close());
  const old = {
    topicId: 'old',
    title: '旧经历',
    text: '一月剪辑过短片。',
    occurredAt: null,
    sources: ['memory-original:abc', 'https://example.org/article'],
    related: ['other'],
  };
  b.appendNote(old, 'old-note', '2026-09-01T00:00:00Z');
  b.appendNote(old, 'old-note', '2026-09-01T00:00:00Z');
  b.appendNote(
    {
      topicId: 'other',
      title: '其他认识',
      text: '另一条认识。',
      occurredAt: null,
      sources: ['历史记录'],
    },
    'other-note',
  );
  assert.equal(b.events('note').length, 2);
  assert.equal(b.topics().get('old').notes[0].occurredAt, null);
  assert.equal(b.topics().get('old').notes[0].recordedAt, '2026-09-01T00:00:00Z');
  const view = b.render();
  assert.match(view, /一月剪辑过短片/);
  assert.ok(view.includes('来源：memory-original:abc；https://example.org/article'));
  assert.match(view, /关联主题：other/);
});
test('state, feedback, and receipts survive reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'notebook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  let b = new Notebook(path, () => time);
  commit(b, 'init', draft([note()]), 'exploration');
  b.recordFeedback({ id: 'f', text: '不喝茶了' });
  commit(b, 'close', draft([], [resolveFeedback('f', [rule('不喝茶了')])]));
  b.close();
  b = new Notebook(path, () => time);
  assert.equal(b.state('tea').status, 'closed');
  assert.equal(b.events('feedback').length, 1);
  b.close();
});
test('a feedback message can contain several changes and simple context without fabricated bans', (t) => {
  const b = fixture(t);
  commit(b, 'more', draft([note('coffee', ['coffee'])]), 'exploration');
  b.recordFeedback({ id: 'f', text: '茶不喝了，咖啡这周忙先别推荐。旧简历是朋友的。' });
  commit(
    b,
    'multi',
    draft(
      [
        {
          topicId: 'cv',
          title: '简历',
          text: '旧简历是朋友的。',
          occurredAt: time,
          sources: ['用户反馈 f'],
          tags: ['career'],
        },
      ],
      [
        resolveFeedback('f', [
          rule('茶不喝了'),
          rule('咖啡这周忙先别推荐', 'deferred', [], ['coffee'], '用户这周忙'),
        ]),
      ],
    ),
  );
  assert.equal(b.state('tea').status, 'closed');
  assert.equal(b.state('coffee').status, 'deferred');
  assert.equal(b.state('cv').status, 'open');
  assert.equal(b.pendingFeedback().length, 0);
});
test('acknowledging closed and deferred topics commits feedback, context, and messages together', async (t) => {
  const b = fixture(t);
  commit(
    b,
    'more',
    draft([note('coffee', ['coffee']), note('reading', ['reading'])]),
    'exploration',
  );
  b.recordFeedback({ id: 'f', text: '不喝茶了，咖啡最近睡不好先别推荐，小说可以继续。' });
  const result = commit(
    b,
    'ack',
    draft(
      [
        {
          ...note('coffee', ['coffee']),
          text: '用户最近睡不好，希望暂时不推荐咖啡。',
          sources: ['用户反馈 f'],
        },
      ],
      [
        resolveFeedback('f', [
          rule('不喝茶了'),
          rule('咖啡最近睡不好先别推荐', 'deferred', [], ['coffee'], '最近睡不好'),
        ]),
      ],
      [
        {
          text: '记住了，茶不再推荐，咖啡先放一放，小说仍可以聊。',
          topicIds: ['tea', 'coffee', 'reading'],
        },
      ],
    ),
  );
  assert.equal(result.notesAdded, 1);
  assert.equal(result.feedbackProcessed, 1);
  assert.equal(b.pendingFeedback().length, 0);
  const [id] = result.preparedIds;
  await b.deliver(
    id,
    async () => ({ delivered: true, messageIds: ['ack-visible'] }),
    'test-bridge',
  );
  assert.equal(b.events('delivery').length, 1);
  assert.equal(b.state('tea').status, 'closed');
  assert.equal(b.state('coffee').status, 'deferred');
  assert.equal(b.state('reading').status, 'open');
  assert.equal(b.topics().get('coffee').notes.length, 2);
});
test('judgement can send several directions without adding notes, including context about a closed topic', async (t) => {
  const b = fixture(t);
  commit(b, 'more', draft([note('reading', ['reading'])]), 'exploration');
  b.recordFeedback({ id: 'f', text: '不喝茶了' });
  commit(b, 'close', draft([], [resolveFeedback('f', [rule('不喝茶了')])]));
  const count = b.events('note').length;
  const { preparedIds } = commit(
    b,
    'several',
    draft(
      [],
      [],
      [
        { text: '之前那份茶叶资料是朋友的，已经按你的反馈记下了。', topicIds: ['tea'] },
        { text: '那本书有中文馆藏，也可以线上预约。', topicIds: ['reading'] },
      ],
    ),
  );
  for (const id of preparedIds)
    await b.deliver(id, async () => ({ delivered: true, messageIds: [id] }), 'test-bridge');
  assert.equal(b.events('note').length, count);
  assert.equal(b.events('delivery').length, 2);
  assert.equal(b.state('tea').status, 'closed');
});
test('restored occurrence time and recording time stay distinct and visible, with explicit unknowns', (t) => {
  const b = new Notebook(':memory:', () => time);
  t.after(() => b.close());
  b.appendNote(
    {
      topicId: 'old',
      title: '旧事项',
      text: '5月做过的项目',
      occurredAt: '5月（项目开发）',
      sources: ['历史记录'],
    },
    'dated-note',
    '2026-10-22T10:00:00Z',
  );
  b.appendNote(
    {
      topicId: 'old',
      title: '旧事项',
      text: '没有日期的资料',
      occurredAt: null,
      sources: ['旧资料'],
    },
    'undated-note',
    '2026-10-22T10:00:00Z',
  );
  const notes = b.topics().get('old').notes;
  assert.equal(notes[0].occurredAt, '5月（项目开发）');
  assert.equal(notes[0].recordedAt, '2026-10-22T10:00:00Z');
  assert.equal(notes[1].occurredAt, null);
  const rendered = b.render();
  assert.match(rendered, /发生时间：5月（项目开发）｜记录时间：2026-10-22T10:00:00Z/);
  assert.match(rendered, /发生时间：未知｜记录时间：2026-10-22T10:00:00Z/);
  assert.match(rendered, /状态：开放/);
  assert.match(rendered, /不表示事情仍在进行/);
});
