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
  aboutChannelSummary,
  aboutUpdateRow,
} from '../../renderer/settings/about-update-status.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

const copy = getSettingsPreferencesCopy('zh-CN').about;

test('a packaged nightly says so, never 正式版', () => {
  assert.match(
    aboutChannelSummary({ buildMode: 'packaged', updateChannel: 'nightly' }, copy),
    /会覆盖正式版安装/,
  );
  assert.equal(
    aboutChannelSummary({ buildMode: 'packaged', updateChannel: 'release' }, copy),
    '正式发布版，自动接收稳定更新。',
  );
});

test('buildMode decides before updateChannel, whose dev value is a placeholder', () => {
  assert.equal(
    aboutChannelSummary({ buildMode: 'dev', updateChannel: 'nightly' }, copy),
    '本地开发构建，不检查更新。',
  );
});

const current = '0.2.0-dev.11.20260831';
const latest = '0.2.0-dev.12.20260901';

test('the row only offers a check where the service would honour one', () => {
  assert.equal(aboutUpdateRow(null, copy).action, 'check');
  assert.equal(aboutUpdateRow({ state: 'idle', currentVersion: current }, copy).action, 'check');
  assert.equal(
    aboutUpdateRow({ state: 'not-available', currentVersion: current }, copy).action,
    'check',
  );
  assert.equal(
    aboutUpdateRow({ state: 'checking', currentVersion: current }, copy).action,
    'checking',
  );
  // The service returns the current status untouched for these, so the check
  // button is disabled rather than a control that does nothing when pressed.
  for (const state of ['available', 'verifying', 'installing'] as const) {
    assert.equal(
      aboutUpdateRow({ state, currentVersion: current, latestVersion: latest }, copy).action,
      'busy',
      state,
    );
  }
});

test('the version lives on the second line, so the label never truncates against the button', () => {
  for (const state of ['available', 'verifying', 'downloaded', 'installing'] as const) {
    const row = aboutUpdateRow({ state, currentVersion: current, latestVersion: latest }, copy);
    assert.equal(row.label.includes(latest), false, state);
    assert.ok(row.description.includes(`v${latest}`), state);
  }
});

test('the nightly steady states each read as themselves', () => {
  const downloading = aboutUpdateRow(
    {
      state: 'downloading',
      currentVersion: current,
      latestVersion: latest,
      progress: { percent: 42.4, bytesPerSecond: 1, transferred: 1, total: 2 },
    },
    copy,
  );
  assert.deepEqual(downloading, {
    label: '正在下载（42%）',
    description: 'v0.2.0-dev.12.20260901，完成后可在这里重启安装。',
    action: 'busy',
  });

  const downloaded = aboutUpdateRow(
    { state: 'downloaded', currentVersion: current, latestVersion: latest },
    copy,
  );
  assert.deepEqual(downloaded, {
    label: '新版本已下载',
    description: 'v0.2.0-dev.12.20260901，重启 Maka 即可完成安装。',
    action: 'install',
  });
});

test('a failure names the step that failed and offers the check again', () => {
  const download = aboutUpdateRow(
    {
      state: 'error',
      currentVersion: current,
      latestVersion: latest,
      operation: 'download',
      message: 'ECONNRESET',
    },
    copy,
    { errorDetail: (message) => `网络错误：${message}` },
  );
  assert.deepEqual(download, {
    label: '下载更新失败',
    description: '网络错误：ECONNRESET',
    action: 'check',
  });

  const check = aboutUpdateRow(
    { state: 'error', currentVersion: current, operation: 'check', message: 'offline' },
    copy,
  );
  assert.equal(check.label, '检查更新失败');
  assert.equal(check.description, 'offline');
  assert.equal(check.action, 'check');
});
