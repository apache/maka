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
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';
import { getMcpCatalog } from '../../renderer/mcp-catalog.js';
import { providerDisplay } from '../../renderer/settings/provider-display-copy.js';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';

test('language selector offers every preference with locale-appropriate labels', () => {
  assert.deepEqual(getSettingsPreferencesCopy('zh-CN').personalization.localeOptions, [
    ['auto', '跟随系统'],
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
  ]);
  assert.deepEqual(getSettingsPreferencesCopy('zh-TW').personalization.localeOptions, [
    ['auto', '自動（跟隨系統）'],
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
  ]);
  assert.deepEqual(getSettingsPreferencesCopy('en').personalization.localeOptions, [
    ['auto', 'Follow system'],
    ['zh-CN', 'Simplified Chinese'],
    ['zh-TW', 'Traditional Chinese'],
    ['en', 'English'],
  ]);
});

test('Traditional Chinese settings copy uses Taiwan terminology', () => {
  const copy = getSettingsPreferencesCopy('zh-TW');
  assert.equal(copy.sections.network, '網路');
  assert.equal(copy.appearance.paletteLabels.default, '預設');
  assert.equal(copy.appearance.appIconImport, '匯入圖示…');
  assert.equal(copy.about.clipboardUnavailable, '剪貼簿不可用或被系統拒絕。');
});

test('Traditional Chinese MCP catalog does not fall back to Simplified Chinese', () => {
  const catalog = getMcpCatalog('zh-TW');
  assert.equal(catalog.find((entry) => entry.id === 'filesystem')?.name, '本機檔案');
  assert.equal(catalog.find((entry) => entry.id === 'google-calendar')?.name, 'Google 日曆');
  assert.equal(catalog.find((entry) => entry.id === 'playwright')?.category, '設計與開發');
});

test('Traditional Chinese provider cards use Taiwan connection terminology', () => {
  assert.equal(providerDisplay('deepseek', 'zh-TW').description, 'DeepSeek 官方 API 連線');
  assert.match(providerDisplay('github-copilot', 'zh-TW').description, /訂閱連線/);
});

test('Traditional Chinese bot settings use Taiwan integration terminology', () => {
  const copy = getBotSettingsCopy('zh-TW');
  assert.match(copy.providers.wecom.help, /串接/);
  assert.doesNotMatch(copy.providers.wecom.help, /接入/);
  assert.match(copy.overview.more, /串接更多/);
  assert.doesNotMatch(copy.overview.more, /渠道|訪問|匹配/);
});
