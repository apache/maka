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
import { RESUME_PARK_REASON_KEYS, resumeParkToastCopy } from '../runtime-resume-copy.js';

test('renders Chinese copy for the zh locale', () => {
  const copy = resumeParkToastCopy(['pending_permission'], 'zh');
  assert.equal(copy.title, '暂时无法继续这一轮');
  assert.equal(copy.description, '上次执行仍在等待权限确认。');
});

test('renders English copy for the en locale', () => {
  const copy = resumeParkToastCopy(['pending_permission'], 'en');
  assert.equal(copy.title, "This turn can't continue yet");
  assert.equal(copy.description, 'The last run is still waiting for permission approval.');
});

test('localizes the resume_candidate_missing branch', () => {
  assert.deepEqual(resumeParkToastCopy(['resume_candidate_missing'], 'zh'), {
    title: '没有可恢复的任务',
    description: '任务已是最新状态。',
  });
  assert.deepEqual(resumeParkToastCopy(['resume_candidate_missing'], 'en'), {
    title: 'Nothing to resume',
    description: 'This task is already up to date.',
  });
});

test('falls back to a locale-aware message when no reason is recognized', () => {
  assert.equal(
    resumeParkToastCopy(['not_a_real_reason'], 'en').description,
    'This task does not currently meet the conditions to continue.',
  );
  assert.equal(
    resumeParkToastCopy(['not_a_real_reason'], 'zh').description,
    '当前任务不满足继续的条件。',
  );
});

test('keeps every documented reason key translated in both locales', () => {
  // Every documented reason must resolve to a distinct, non-empty string in
  // both locales, and neither locale may fall back for a known key.
  for (const reason of RESUME_PARK_REASON_KEYS) {
    const zh = resumeParkToastCopy([reason], 'zh');
    const en = resumeParkToastCopy([reason], 'en');
    assert.notEqual(zh.description, '当前任务不满足继续的条件。', `zh missing: ${reason}`);
    assert.notEqual(
      en.description,
      'This task does not currently meet the conditions to continue.',
      `en missing: ${reason}`,
    );
    assert.ok(zh.description.length > 0 && en.description.length > 0);
  }
  assert.equal(RESUME_PARK_REASON_KEYS.length, 29);
});
