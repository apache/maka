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
import { connectionLastTestMessageDisplay } from '../../renderer/features/connection-settings/index.js';
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
    id: 'connection:test:runtime',
    label: '測試',
    scope: 'llm_connection' as const,
    layer: 'validation' as const,
    status: 'ok' as const,
    source: 'connection_test' as const,
    checkedAt: 1,
    message: 'validation_passed' as const,
    detail: { kind: 'validation_scope_note' as const },
    blocksSend: false,
  };
  assert.equal(copy.layers.configuration.label, '設定');
  assert.equal(copy.signalLabel(signal), '測試 執行狀態');
  assert.equal(copy.signalMessage(signal), '憑證與端點驗證已通過。');
  assert.match(copy.signalDetail(signal) ?? '', /串流輸出/);
});

const signal = (overrides: Partial<import('@maka/core/health').HealthSignal>): import('@maka/core/health').HealthSignal => ({
  id: 'connection:demo',
  label: 'Demo',
  scope: 'llm_connection',
  layer: 'configuration',
  status: 'info',
  source: 'settings',
  checkedAt: 0,
  message: 'not_default_source',
  ...overrides,
});

test('renders configuration message codes distinctly in both locales', () => {
  const zh = getHealthCenterCopy('zh-CN');
  const en = getHealthCenterCopy('en');
  assert.equal(zh.signalMessage(signal({ message: 'not_default_source' })), '不是工作区的默认模型来源。');
  assert.equal(en.signalMessage(signal({ message: 'not_default_source' })), 'Not the workspace default model source.');
  assert.equal(zh.signalMessage(signal({ message: 'no_models_enabled' })), '没有启用任何模型。');
  assert.equal(en.signalMessage(signal({ message: 'no_models_enabled' })), 'No models are enabled on this connection.');
});

test('renders runtime probe details from structured params, not string parsing', () => {
  const detail = { kind: 'runtime_probe_result', modelId: 'claude-sonnet-5', latencyMs: 812, errorClass: 'timeout' } as const;
  assert.equal(
    getHealthCenterCopy('zh-CN').signalDetail(signal({ detail })),
    '模型=claude-sonnet-5 · 延迟=812ms · 错误类型=请求超时',
  );
  assert.equal(
    getHealthCenterCopy('en').signalDetail(signal({ detail })),
    'Model=claude-sonnet-5 · Latency=812ms · Error type=Request timed out',
  );

  const rateLimited = { ...detail, errorClass: 'rate_limit' };
  assert.equal(
    getHealthCenterCopy('zh-CN').signalDetail(signal({ detail: rateLimited })),
    '模型=claude-sonnet-5 · 延迟=812ms · 错误类型=rate_limit',
  );
  assert.equal(
    getHealthCenterCopy('en').signalDetail(signal({ detail: rateLimited })),
    'Model=claude-sonnet-5 · Latency=812ms · Error type=rate_limit',
  );
});

test('keeps zh capability reasons and hides wrong-locale ones', () => {
  const zhReason = { kind: 'capability_reason', reason: '未配置平台凭据' } as const;
  assert.equal(getHealthCenterCopy('zh-CN').signalDetail(signal({ detail: zhReason })), '未配置平台凭据');
  assert.equal(
    getHealthCenterCopy('en').signalDetail(signal({ detail: zhReason })),
    'See the corresponding settings page for details.',
  );

  const enReason = { kind: 'capability_reason', reason: 'Slack requires a Bot Token.' } as const;
  assert.equal(
    getHealthCenterCopy('zh-CN').signalDetail(signal({ detail: enReason })),
    '状态详情请见对应设置页。',
  );
  assert.equal(
    getHealthCenterCopy('en').signalDetail(signal({ detail: enReason })),
    'See the corresponding settings page for details.',
  );
});

test('maps connection test error classes without exposing machine tokens', () => {
  const auth = { kind: 'last_test_error_class', errorClass: 'auth' } as const;
  assert.equal(getHealthCenterCopy('zh-CN').signalDetail(signal({ detail: auth })), '鉴权失败');
  assert.equal(getHealthCenterCopy('en').signalDetail(signal({ detail: auth })), 'Authentication failed');

  const unknown = { kind: 'last_test_message' } as const;
  assert.equal(
    getHealthCenterCopy('zh-CN').signalDetail(signal({ detail: unknown })),
    '连接测试状态暂时无法显示，请重新测试。',
  );
  assert.equal(
    getHealthCenterCopy('en').signalDetail(signal({ detail: unknown })),
    'The connection test status is temporarily unavailable. Test again.',
  );
});

test('maps connection test error classes in connection details', () => {
  assert.equal(connectionLastTestMessageDisplay('auth', 'zh-CN'), '鉴权失败');
  assert.equal(connectionLastTestMessageDisplay('auth', 'en'), 'Authentication failed');
});

test('suffixes runtime signal labels per locale from the id, not the producer', () => {
  const runtime = signal({ id: 'connection:demo:runtime', label: 'Demo' });
  assert.equal(getHealthCenterCopy('zh-CN').signalLabel(runtime), 'Demo 运行态');
  assert.equal(getHealthCenterCopy('en').signalLabel(runtime), 'Demo runtime');
});
