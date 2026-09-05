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
import { getHealthCenterCopy } from '../../renderer/locales/settings-health-copy.js';

test('labels blocker counts as global across filtered health views', () => {
  assert.equal(
    getHealthCenterCopy('zh-CN').blockers.send(1, 6),
    '全部健康信号中，1/6 条会阻塞发送',
  );
  assert.equal(
    getHealthCenterCopy('en').blockers.send(1, 6),
    'Across all health signals, 1 of 6 blocks sending',
  );
});

test('Traditional Chinese health copy localizes structured signal text', () => {
  const copy = getHealthCenterCopy('zh-TW');
  const signal = {
    id: 'connection:test',
    label: '測試 运行态',
    scope: 'llm_connection' as const,
    layer: 'validation' as const,
    status: 'ok' as const,
    source: 'connection_test' as const,
    checkedAt: 1,
    message: '凭据与端点验证已通过。',
    detail: '这是连接验证结果，不代表发送、流式输出或中断通路已经运行通过。',
    blocksSend: false,
  };
  assert.equal(copy.layers.configuration.label, '設定');
  assert.equal(copy.signalLabel(signal), '測試 執行狀態');
  assert.equal(copy.signalMessage(signal), '憑證與端點驗證已通過。');
  assert.match(copy.signalDetail(signal) ?? '', /串流輸出/);
});
