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
import { getAgentGraphPanelCopy } from '../../renderer/agent-graph-panel.js';

test('Traditional Chinese Agent Graph copy does not use Simplified fallbacks', () => {
  const copy = getAgentGraphPanelCopy('zh-TW');
  assert.equal(copy.loading, '正在讀取 Graph 狀態…');
  assert.equal(copy.openSession, '開啟子任務');
  assert.equal(copy.currentEpoch, '目前');
  assert.equal(copy.status('active'), '執行中');
});
