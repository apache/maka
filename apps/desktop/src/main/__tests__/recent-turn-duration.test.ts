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
import { recentTurnCopy } from '../../renderer/features/workbar/ui/recent-turn-overlay.js';

test('workbar progress displays localized hours at the hour boundary', () => {
  for (const [locale, before, at, later] of [
    ['en', 'Working for 59m 59s', 'Working for 1h 0m 0s', 'Working for 1h 29m 5s'],
    ['zh-CN', '已处理 59 分钟 59 秒', '已处理 1 小时 0 分钟 0 秒', '已处理 1 小时 29 分钟 5 秒'],
    ['zh-TW', '已處理 59 分鐘 59 秒', '已處理 1 小時 0 分鐘 0 秒', '已處理 1 小時 29 分鐘 5 秒'],
  ] as const) {
    assert.equal(recentTurnCopy[locale].processingFor(3599), before);
    assert.equal(recentTurnCopy[locale].processingFor(3600), at);
    assert.equal(recentTurnCopy[locale].processingFor(5345), later);
  }
});
