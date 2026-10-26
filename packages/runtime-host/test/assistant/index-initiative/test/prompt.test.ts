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
import {
  DISCOVERY_TASK,
  JUDGEMENT_TASK,
  NOTEBOOK_RULES,
  wakeInput,
} from '../../../../src/assistant/index-initiative/prompt.js';
import { BOT_ROLE } from '../../../../src/assistant/bot/host.js';
test('proactive instructions match the approved text verbatim and retain the assistant contract', () => {
  assert.match(DISCOVERY_TASK, /从生活和工作等多个方面出发，结合时间线索，探索不同方向/);
  assert.match(JUDGEMENT_TASK, /记事本保存的是可能有用的线索，不是需要推进的任务/);
  assert.match(JUDGEMENT_TASK, /判断它现在能给用户带来什么价值，再决定是否深入调查和交流/);
  assert.match(NOTEBOOK_RULES, /只有明确用户反馈可以关闭/);
  const input = wakeInput({
    role: 'exploration',
    now: '2026-10-22T00:00:00Z',
    viewPath: '/private/notebook.md',
    outputPath: '/private/operations.json',
    first: true,
  });
  assert.ok(input.includes(DISCOVERY_TASK));
  assert.ok(input.includes(NOTEBOOK_RULES));
  assert.doesNotMatch(input, /10 个|六个|3 个发散|DiscoveryCandidates/);
  assert.match(BOT_ROLE, /SendUser/);
  assert.match(BOT_ROLE, /Sleep/);
  assert.match(BOT_ROLE, /MatterDelegate/);
});

test('every judgement wake asks for autonomous investigation of the whole notebook', () => {
  for (const first of [true, false]) {
    const input = wakeInput({
      role: 'judgement',
      now: '2026-10-23T00:00:00Z',
      viewPath: '/private/notebook.md',
      outputPath: '/private/operations.json',
      first,
    });
    assert.match(input, /基于用户的全局信息和整份记事本自主调查并判断，不只看新内容或本轮增量/);
  }
});
