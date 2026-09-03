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
import { test } from 'node:test';

import { resumeParkToastCopy } from '../runtime-resume-copy.js';

const CJK = /[\u3400-\u9fff]/u;

test('resolves English park copy for every known reason with no Chinese (#4489)', () => {
  const reasons = [
    'dangling_tool_state',
    'pending_permission',
    'workspace_identity_mismatch',
    'tool_catalog_mismatch',
    'provider_replay_unsupported',
    'runtime_lineage_claim_mismatch',
    'continuation_started_indeterminate',
    'resume_feature_disabled',
  ];
  const copy = resumeParkToastCopy(reasons, 'en');
  const fallback = resumeParkToastCopy([], 'en').description;

  assert.equal(copy.title, 'This round cannot be resumed yet');
  assert.equal(CJK.test(copy.title), false);
  assert.equal(CJK.test(copy.description), false);
  for (const reason of reasons) {
    const single = resumeParkToastCopy([reason], 'en');
    assert.notEqual(single.description, fallback, reason);
    assert.equal(CJK.test(single.description), false, reason);
  }
});

test('keeps the Chinese copy for zh', () => {
  const copy = resumeParkToastCopy(['pending_permission'], 'zh');

  assert.equal(copy.title, '暂时无法继续这一轮');
  assert.equal(copy.description, '上次执行仍在等待权限确认。');
});

test('resolves the missing-candidate special case per locale', () => {
  assert.deepEqual(resumeParkToastCopy(['resume_candidate_missing'], 'en'), {
    title: 'Nothing to resume',
    description: 'This task is already up to date.',
  });
  assert.deepEqual(resumeParkToastCopy(['resume_candidate_missing'], 'zh'), {
    title: '没有可恢复的任务',
    description: '任务已是最新状态。',
  });
});

test('falls back to the generic description for unknown reasons and dedupes repeats', () => {
  const unknown = resumeParkToastCopy(['not_a_known_reason'], 'en');
  assert.equal(unknown.title, 'This round cannot be resumed yet');
  assert.equal(unknown.description, 'This task does not currently meet the conditions to continue.');

  const deduped = resumeParkToastCopy(['pending_permission', 'pending_permission'], 'zh');
  assert.equal(deduped.description, '上次执行仍在等待权限确认。');
});
