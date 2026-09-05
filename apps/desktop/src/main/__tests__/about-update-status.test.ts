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
import {
  aboutChannelFacts,
  aboutUpdateStatusDetail,
} from '../../renderer/settings/about-update-status.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

const copy = getSettingsPreferencesCopy('zh-CN').about;

test('a packaged nightly is tokened Nightly, never 正式版', () => {
  const facts = aboutChannelFacts({ buildMode: 'packaged', updateChannel: 'nightly' }, copy);
  assert.deepEqual(facts.token, { label: 'Nightly', color: 'orange' });
  assert.match(facts.summary, /会覆盖正式版安装/);
});

test('a packaged release wears no token — it is the default state', () => {
  const facts = aboutChannelFacts({ buildMode: 'packaged', updateChannel: 'release' }, copy);
  assert.equal(facts.token, null);
  assert.equal(facts.summary, '正式发布版，自动接收稳定更新。');
});

test('buildMode decides before updateChannel, whose dev value is a placeholder', () => {
  const facts = aboutChannelFacts({ buildMode: 'dev', updateChannel: 'nightly' }, copy);
  assert.deepEqual(facts.token, { label: '本地开发版', color: 'gray' });
  assert.equal(facts.summary, '本地开发构建，不检查更新。');
});

test('the nightly steady states each read as themselves', () => {
  const detail = (status: Parameters<typeof aboutUpdateStatusDetail>[0]) =>
    aboutUpdateStatusDetail(status, copy, { isDevBuild: false });

  assert.equal(
    detail({
      state: 'downloading',
      currentVersion: '0.2.0-dev.11.20260831',
      latestVersion: '0.2.0-dev.12.20260901',
      progress: { percent: 42.4, bytesPerSecond: 1, transferred: 1, total: 2 },
    }),
    '正在下载 v0.2.0-dev.12.20260901（42%）…',
  );
  assert.equal(
    detail({
      state: 'verifying',
      currentVersion: '0.2.0-dev.11.20260831',
      latestVersion: '0.2.0-dev.12.20260901',
    }),
    '正在验证 v0.2.0-dev.12.20260901 的发布来源…',
  );
  assert.equal(
    detail({
      state: 'downloaded',
      currentVersion: '0.2.0-dev.11.20260831',
      latestVersion: '0.2.0-dev.12.20260901',
    }),
    'v0.2.0-dev.12.20260901 已下载，可在侧栏选择重启安装。',
  );
});
