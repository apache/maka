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
import { buildRuntimeHostUpgradeDialogOptions } from '../runtime-host-upgrade-copy.js';

const conflict = {
  kind: 'upgrade_required',
  restartable: true,
  registration: {},
  handshake: {
    activity: {
      connections: 2,
      activeOperations: 1,
      processUptimeSeconds: 120,
      residencies: [
        { label: 'scheduled-task', count: 2 },
        { label: 'daily-review', count: 1 },
      ],
    },
  },
} as never;

test('localizes upgrade activity without changing decision indexes', () => {
  const en = buildRuntimeHostUpgradeDialogOptions(conflict, true, 'en');
  const zh = buildRuntimeHostUpgradeDialogOptions(conflict, true, 'zh');
  assert.deepEqual(en.buttons, ['Restart Runtime Host', 'Wait', 'Cancel Startup']);
  assert.deepEqual(zh.buttons, ['重启 Runtime Host', '等待', '取消启动']);
  assert.equal(en.defaultId, 1);
  assert.equal(zh.defaultId, 1);
  assert.match(zh.detail ?? '', /仍有 2 个其他客户端连接/);
  assert.match(zh.detail ?? '', /每日回顾: 1/);
  assert.match(en.detail ?? '', /Scheduled Task: 2/);
  assert.match(zh.detail ?? '', /计划任务: 2/);
});
