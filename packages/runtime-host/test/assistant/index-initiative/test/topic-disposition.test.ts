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
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';

// Topic disposition (#6359): "investigated", "withheld" and "told" stay separate,
// and information that really changed can reopen a topic the user closed.
const time = '2026-10-22T10:00:00Z';
const note = (id = 'tea', tags = ['tea'], text = '一次喝茶的经历，当前偏好尚待了解。') => ({
  topicId: id,
  title: id,
  text,
  occurredAt: '2026-01',
  sources: ['历史用户交流'],
  tags,
});
const draft = (extra = {}) => ({
  notes: [],
  feedbackDecisions: [],
  messages: [],
  withheld: [],
  reopened: [],
  ...extra,
});
const closeRule = (quote, status = 'closed', resumeAt = null) => ({
  quote,
  status,
  topicIds: ['tea'],
  tags: [],
  reason: '用户不再关注',
  resumeAt,
});
const resolution = (feedbackId, rules) => ({
  feedbackId,
  understanding: '按用户原话理解范围',
  rules,
});
const commit = (b, id, d, role = 'judgement') =>
  b.commitDraft({ role, operationId: id, expectedFeedbackRevision: b.revision(), draft: d });
function feedback(b, id, text) {
  const delivery = `delivery:${id}`;
  b.put(delivery, 'delivery', { text: '先前主动推荐', topicIds: ['tea'], messageIds: [delivery] });
  b.recordFeedback({ id, text, replyTo: delivery });
}
function fixture(t) {
  const b = new Notebook(':memory:', () => time);
  t.after(() => b.close());
  commit(b, 'initial', draft({ notes: [note()] }), 'exploration');
  return b;
}
function closeTea(b, status = 'closed', resumeAt = null) {
  feedback(b, 'f', '不用再推荐茶了');
  commit(
    b,
    'close',
    draft({
      feedbackDecisions: [resolution('f', [closeRule('不用再推荐茶了', status, resumeAt)])],
    }),
  );
}

test('a withheld topic is recorded as withheld, not as told, and the model sees it', (t) => {
  const b = fixture(t);
  const result = commit(
    b,
    'judge',
    draft({ withheld: [{ topicId: 'tea', reason: '只是旧背景，没有当前价值' }] }),
  );
  assert.equal(result.withheldRecorded, 1);
  const s = b.state('tea');
  assert.equal(s.withheld.length, 1);
  assert.equal(s.receipts.length, 0, 'withholding is not delivery');
  assert.equal(s.displayStatus, 'open', 'withholding does not mark the topic as sent');
  assert.match(b.render({ topicIds: ['tea'] }), /已调查但未告知用户.*只是旧背景/);
});

test('withheld needs a known topic and a reason, and only judgement may write it', (t) => {
  const b = fixture(t);
  assert.throws(
    () => commit(b, 'a', draft({ withheld: [{ topicId: 'nope', reason: 'x' }] })),
    /Unknown withheld topic/,
  );
  assert.throws(
    () => commit(b, 'b', draft({ withheld: [{ topicId: 'tea', reason: '' }] })),
    /Withheld needs a topic and a reason/,
  );
  assert.throws(
    () => commit(b, 'c', draft({ withheld: [{ topicId: 'tea', reason: 'x' }] }), 'exploration'),
    /Exploration only appends knowledge/,
  );
  assert.equal(b.state('tea').withheld.length, 0, 'a rejected draft leaves nothing behind');
});

test('a rejected topic with no change is not reopened', (t) => {
  const b = fixture(t);
  closeTea(b);
  assert.equal(b.state('tea').status, 'closed');
  // The only note on the topic predates the user's feedback: nothing has changed.
  assert.throws(
    () => commit(b, 'r', draft({ reopened: [{ topicId: 'tea', reason: '感觉可以再提' }] })),
    /needs a note on this topic recorded after the user feedback/,
  );
  assert.equal(b.state('tea').status, 'closed');
});

test('a material change reopens a closed topic, and the notebook says why', (t) => {
  const b = fixture(t);
  closeTea(b);
  commit(
    b,
    'change',
    draft({
      notes: [note('tea', ['tea'], '用户所在城市将举办茶博会，下周开幕。')],
      reopened: [{ topicId: 'tea', reason: '茶博会即将开幕，是新的具体机会' }],
    }),
  );
  const s = b.state('tea');
  assert.equal(s.status, 'open');
  assert.equal(s.reopenedByChange, true);
  assert.match(b.render({ topicIds: ['tea'] }), /因信息出现重大变化，经判断重新开放.*茶博会/);
});

test('the user decides last: a newer user rule beats an earlier reopening', (t) => {
  const b = fixture(t);
  closeTea(b);
  commit(
    b,
    'change',
    draft({
      notes: [note('tea', ['tea'], '茶博会即将开幕。')],
      reopened: [{ topicId: 'tea', reason: '茶博会即将开幕' }],
    }),
  );
  assert.equal(b.state('tea').status, 'open');
  feedback(b, 'f2', '还是别推荐茶了');
  commit(
    b,
    'close-again',
    draft({ feedbackDecisions: [resolution('f2', [closeRule('还是别推荐茶了')])] }),
  );
  const s = b.state('tea');
  assert.equal(s.status, 'closed');
  assert.equal(s.reopenedByChange, undefined);
});

test('only a topic the user closed or deferred can be reopened', (t) => {
  const b = fixture(t);
  assert.throws(
    () => commit(b, 'r', draft({ reopened: [{ topicId: 'tea', reason: 'x' }] })),
    /Only a topic the user closed or deferred can be reopened/,
  );
});

test('a deferred topic can be reopened early by a material change', (t) => {
  const b = fixture(t);
  closeTea(b, 'deferred', '2027-01-01T00:00:00Z');
  assert.equal(b.state('tea').status, 'deferred');
  commit(
    b,
    'change',
    draft({
      notes: [note('tea', ['tea'], '茶博会提前到本周。')],
      reopened: [{ topicId: 'tea', reason: '茶博会提前，等不到恢复时间' }],
    }),
  );
  assert.equal(b.state('tea').status, 'open');
});
