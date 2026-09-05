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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';

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

test('the existing onboarding status surface prefers retry health while present', async () => {
  const source = await readFile(
    new URL('../../../src/renderer/settings/bot-onboarding-modal.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /if \(snapshot\?\.retryHealth\)/);
  assert.match(source, /shared\.retrying\(/);
  assert.match(source, /case 'waiting': return copy\.waiting/);
});
