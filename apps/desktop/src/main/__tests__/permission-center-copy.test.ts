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
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';

test('presents a granted OS permission as a verified success', () => {
  assert.equal(getPermissionCenterCopy('zh-CN').osStates.granted.tone, 'success');
  assert.equal(getPermissionCenterCopy('en').osStates.granted.tone, 'success');
});

test('renders capability reason codes per locale', () => {
  const zh = getPermissionCenterCopy('zh-CN');
  const en = getPermissionCenterCopy('en');
  assert.equal(zh.reasons['missing platform credentials'], '未配置平台凭据');
  assert.equal(en.reasons['missing platform credentials'], 'Platform credentials are not configured');
  assert.equal(zh.reasons.cu_executor_recovering, 'maka-cu executor 正在启动或恢复。');
  assert.equal(en.reasons.cu_executor_recovering, 'The maka-cu executor is starting or recovering.');
});

test('composes the computer-use backend status from snapshot facts per locale', () => {
  const zh = getPermissionCenterCopy('zh-CN');
  const en = getPermissionCenterCopy('en');
  assert.equal(
    zh.cuBackendStatus(['辅助功能', '屏幕录制'], 'healthy'),
    'maka-cu artifact 已通过本地完整性检查。等待辅助功能、屏幕录制权限。操作与截图 service 已就绪；按目标与动作类别授权后可操作本机应用。',
  );
  assert.equal(
    zh.cuBackendStatus([], 'not_run'),
    'maka-cu artifact 已通过本地完整性检查。service 将在首次调用时启动；按目标与动作类别授权后可操作本机应用。',
  );
  assert.equal(
    en.cuBackendStatus(['Accessibility'], 'degraded'),
    'The maka-cu artifact passed the local integrity check. Waiting for Accessibility permission. The maka-cu service is starting or recovering.',
  );
});
