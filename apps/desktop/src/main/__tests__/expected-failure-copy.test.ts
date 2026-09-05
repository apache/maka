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
  getProviderSettingsCopy,
  providerPanelActionErrorMessage,
} from '../../renderer/features/connection-settings/index.js';
import {
  getSettingsProjectsCopy,
  runtimeHostManagementErrorMessage,
  type SettingsProjectsCopy,
} from '../../renderer/locales/settings-projects-copy.js';

test('Runtime Host management codes render per locale and unknown codes fall back', () => {
  const rendered = (code: string) => ({
    zh: runtimeHostManagementErrorMessage(code, 'zh-CN'),
    en: runtimeHostManagementErrorMessage(code, 'en'),
  });
  assert.deepEqual(rendered('active_tasks'), {
    zh: 'Runtime Host 正在执行任务，请稍后再试',
    en: 'Runtime Host still owns active work. Try again later.',
  });
  assert.deepEqual(rendered('linger_disabled'), {
    zh: '请先为当前用户启用 systemd linger，服务才能在登出后继续运行',
    en: 'Enable systemd linger for this user so the service keeps running after logout.',
  });
  assert.deepEqual(rendered('package_integrity_mismatch'), {
    zh: '更新包校验失败',
    en: 'The update package failed its integrity check.',
  });
  const unknownFallback = {
    zh: '请查看服务日志了解详情',
    en: 'Check the service logs for details.',
  };
  for (const code of [
    'deployment_commit_unknown',
    'update_policy_commit_outcome_unknown',
    'some_future_code',
    'constructor',
  ]) {
    assert.deepEqual(rendered(code), unknownFallback);
  }
});

test('provider action errors never echo a raw Chinese message', () => {
  const error = new Error('连接失败，请稍后重试');
  assert.equal(
    providerPanelActionErrorMessage(error, 'zh-CN'),
    getProviderSettingsCopy('zh-CN').shared.actionFallback,
  );
  assert.equal(
    providerPanelActionErrorMessage(error, 'en'),
    getProviderSettingsCopy('en').shared.actionFallback,
  );
});

test('stale connection errors render the same copy with or without IPC wrapping', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
    for (const message of [
      'connection_stale',
      "Error invoking remote method 'connections:delete': Error: Unable to delete Connection: connection_stale",
    ]) {
      assert.equal(
        providerPanelActionErrorMessage(new Error(message), locale),
        getProviderSettingsCopy(locale).shared.connectionStale,
      );
    }
  }
});
