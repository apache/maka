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
import { dictateIntoDraft, speechEndpoint } from '../app/composerDictation.ts';

test('dictation replaces the captured UTF-16 selection in an editable draft', async () => {
  const draft = '🎙今天开会';
  const range = { start: 2, end: 4 };
  const calls = [];
  const editor = {
    focus() {},
    async replaceRange(request) {
      calls.push(request);
      return true;
    },
  };
  await dictateIntoDraft(
    editor,
    draft,
    range,
    async () => '明天',
    () => true,
  );
  assert.deepEqual(calls, [
    { ...range, expectedSelection: range, expectedText: draft, text: '明天' },
  ]);
});

test('cancelling or switching conversations leaves the composer alone', async () => {
  const editor = { focus: assert.fail, replaceRange: assert.fail };
  for (const [result, current] of [
    [null, true],
    ['hello', false],
  ]) {
    await dictateIntoDraft(
      editor,
      '',
      { start: 0, end: 0 },
      async () => result,
      () => current,
    );
  }
});

test('a concurrent edit preserves both the draft and the returned transcription', async () => {
  const editor = {
    focus() {},
    async replaceRange() {
      return false;
    },
  };
  assert.deepEqual(
    await dictateIntoDraft(
      editor,
      'hello',
      { start: 5, end: 5 },
      async () => 'world',
      () => true,
    ),
    { kind: 'changed', text: 'world' },
  );
});

test('launcher dictation finishes after a phrase and a pause, including a quiet tail', () => {
  const sample = speechEndpoint(0);
  for (const at of [300, 390, 480]) assert.equal(sample(at, 0.6), undefined);
  assert.equal(sample(1400, 0.06), undefined);
  assert.equal(sample(1500, 0.5), undefined);
  assert.equal(sample(2699, 0.05), undefined);
  assert.equal(sample(2700, 0.05), 'finish');
});

test('silence or a single click never submits an empty launcher recording', () => {
  const sample = speechEndpoint(0);
  assert.equal(sample(100, 0.95), undefined);
  assert.equal(sample(190, 0.01), undefined);
  assert.equal(sample(12000, 0.01), 'cancel');
  assert.equal(speechEndpoint(0)(120000, -1), 'cancel');
  const limit = speechEndpoint(0);
  limit(0, 0.8);
  limit(180, 0.8);
  assert.equal(limit(120000, -1), 'finish');
});
