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
import { getConversationCopy } from '../conversation-copy.js';

test('labels the Chinese default thinking level as default', () => {
  assert.equal(getConversationCopy('zh-CN').model.defaultLevel, '默认');
  assert.equal(getConversationCopy('zh-TW').model.defaultLevel, '預設');
});

test('explains why folder-reference messages cannot be edited and resent', () => {
  assert.equal(
    getConversationCopy('zh-CN').messages.editMessageDisabledDirectoryReferences,
    '包含文件夹引用的历史消息暂不支持编辑并重发',
  );
  assert.equal(
    getConversationCopy('en').messages.editMessageDisabledDirectoryReferences,
    'Edit & resend does not yet support messages with folder references',
  );
});

test('labels incomplete transcript boundaries without inventing missing Turn counts', () => {
  assert.deepEqual(getConversationCopy('zh-CN').chat.transcriptGap, {
    olderDescription: '上方还有未加载的较早消息',
    olderAction: '加载较早消息',
    newerDescription: '下方还有未加载的较新消息',
    newerAction: '加载较新消息',
  });
  assert.deepEqual(getConversationCopy('zh-TW').chat.transcriptGap, {
    olderDescription: '上方還有未載入的較早訊息',
    olderAction: '載入較早訊息',
    newerDescription: '下方還有未載入的較新訊息',
    newerAction: '載入較新訊息',
  });
  assert.deepEqual(getConversationCopy('en').chat.transcriptGap, {
    olderDescription: 'Earlier messages above are not loaded.',
    olderAction: 'Load earlier messages',
    newerDescription: 'Newer messages below are not loaded.',
    newerAction: 'Load newer messages',
  });
});

test('context usage explains missing data without exposing provider internals', () => {
  assert.equal(
    getConversationCopy('zh-CN').messages.systemNotes.contextUsageUnavailable,
    '暂无用量数据',
  );
  assert.equal(
    getConversationCopy('en').messages.systemNotes.contextUsageUnavailable,
    'No usage data is available for this request.',
  );
});

test('context usage tooltip leads with the measured share', () => {
  assert.equal(
    getConversationCopy('zh-CN').messages.systemNotes.contextUsageShare(12_345, 128_000),
    '已用 12,345 / 128,000 token（10%）',
  );
  assert.equal(
    getConversationCopy('en').messages.systemNotes.contextUsageShare(12_345, 128_000),
    'This request used 12,345 / 128,000 tokens (10%).',
  );
});

test('context usage tooltip keeps measured usage when the limit is unknown', () => {
  assert.equal(
    getConversationCopy('zh-CN').messages.systemNotes.contextUsageNoWindow(12_345),
    '已用 12,345 token；上下文上限未知',
  );
  assert.equal(
    getConversationCopy('en').messages.systemNotes.contextUsageNoWindow(12_345),
    'This request used 12,345 tokens; no context limit is available for this model.',
  );
});

/**
 * A subscription quota window can hand the runtime an hour-scale Retry-After;
 * the banner must count down in humanized d/h/m/s units rather than a raw
 * five-digit second count that reads as a frozen hang (#3401).
 */
test('providerRetryScheduled humanizes hour-scale delays in both locales', () => {
  const zh = getConversationCopy('zh-CN').messages.providerRetryScheduled;
  const zhTw = getConversationCopy('zh-TW').messages.providerRetryScheduled;
  const en = getConversationCopy('en').messages.providerRetryScheduled;

  // Sub-second and zero inputs still read as one second (never "0秒后重试").
  assert.equal(zh(0, 2, 10), '1秒后重试（2/10）');
  assert.equal(en(0, 2, 10), 'Retrying in 1s (2/10)');

  // Short delays keep the compact seconds-only form.
  assert.equal(zh(1, 2, 10), '1秒后重试（2/10）');
  assert.equal(en(1, 2, 10), 'Retrying in 1s (2/10)');
  assert.equal(zh(45, 2, 10), '45秒后重试（2/10）');
  assert.equal(en(45, 2, 10), 'Retrying in 45s (2/10)');

  // Minute-, hour-, and day-scale delays spell out the units.
  assert.equal(zh(75, 2, 10), '1分 15秒后重试（2/10）');
  assert.equal(en(75, 2, 10), 'Retrying in 1m 15s (2/10)');
  assert.equal(zh(16_083, 2, 10), '4小时 28分 3秒后重试（2/10）');
  assert.equal(zhTw(16_083, 2, 10), '4小時 28分 3秒後重試（2/10）');
  assert.equal(en(16_083, 2, 10), 'Retrying in 4h 28m 3s (2/10)');
  assert.equal(zh(90_061, 2, 10), '1天 1小时 1分 1秒后重试（2/10）');
  assert.equal(en(90_061, 2, 10), 'Retrying in 1d 1h 1m 1s (2/10)');

  // Zero-order units are skipped, not rendered as "0分".
  assert.equal(zh(3_600, 2, 10), '1小时后重试（2/10）');
  assert.equal(en(86_400, 2, 10), 'Retrying in 1d (2/10)');
});
