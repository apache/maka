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
import { getSessionHoverCardCopy } from '../session-hover-card-copy.js';

test('localizes task and project hover card summaries', () => {
  const zh = getSessionHoverCardCopy('zh-CN');
  const en = getSessionHoverCardCopy('en');

  assert.equal(zh.sessionDetailsLabel('发布说明'), '发布说明 任务详情');
  assert.equal(zh.projectDetailsLabel('Maka'), 'Maka 项目详情');
  assert.equal(zh.groupDetailsLabel('未归属项目'), '未归属项目 分组详情');
  assert.equal(zh.taskCount(3), '3 个任务');
  assert.equal(en.sessionDetailsLabel('Release notes'), 'Release notes task details');
  assert.equal(en.projectDetailsLabel('Maka'), 'Maka project details');
  assert.equal(en.groupDetailsLabel('No project'), 'No project group details');
  assert.equal(en.taskCount(1), '1 task');
  assert.equal(en.taskCount(2), '2 tasks');
});
