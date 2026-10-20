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

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { BotOnboardingSnapshot } from '@maka/core/bot-onboarding';
import { botOnboardingStatusCopy, getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';

test('provides concise localized retry health without provider error text', () => {
  const zh = getBotSettingsCopy('zh-CN');
  const en = getBotSettingsCopy('en');
  assert.equal(
    zh.onboarding.retrying('network', 2, 7),
    '网络暂时异常；连续失败 2 次，约 7 秒后自动重试。',
  );
  assert.equal(
    en.onboarding.retrying('network', 2, 7),
    'The network is temporarily unavailable; 2 consecutive failures. Retrying automatically in about 7s.',
  );
});

for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
  test(`retry presentation preserves scanned instructions and clears on recovery (${locale})`, () => {
    const shared = getBotSettingsCopy(locale).onboarding;
    const copy = shared.providers.dingtalk;
    const snapshot: BotOnboardingSnapshot = {
      sessionId: 'onboarding', provider: 'dingtalk', state: 'waiting',
      nextPollAfterMs: 7_000, canOpenInBrowser: false,
      retryHealth: { category: 'network', consecutiveFailures: 2 },
    };
    const retry = shared.retrying('network', 2, 7);
    assert.equal(botOnboardingStatusCopy(snapshot, false, null, copy, locale), retry);
    snapshot.state = 'scanned';
    assert.equal(botOnboardingStatusCopy(snapshot, false, null, copy, locale), `${copy.scanned} ${retry}`);
    assert.equal(botOnboardingStatusCopy(snapshot, true, null, copy, locale), shared.generating);
    assert.equal(botOnboardingStatusCopy(snapshot, false, 'failed', copy, locale), 'failed');
    delete snapshot.retryHealth;
    assert.equal(botOnboardingStatusCopy(snapshot, false, null, copy, locale), copy.scanned);
    snapshot.state = 'waiting';
    assert.equal(botOnboardingStatusCopy(snapshot, false, null, copy, locale), copy.waiting);
  });
}
