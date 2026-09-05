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
import { buildRuntimeHostUpgradeDialog } from '../runtime-host-upgrade-copy.js';
import { createRuntimeHostUpgradePrompts } from '../runtime-host-upgrade-dialog.js';

const conflict = {
  kind: 'upgrade_required',
  restartable: true,
  registration: { pid: 42, lifecycleMode: 'ephemeral' },
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
} as unknown as Parameters<typeof buildRuntimeHostUpgradeDialog>[0];

test('localizes upgrade activity without changing decision indexes', () => {
  const en = buildRuntimeHostUpgradeDialog(
    conflict,
    'restart',
    'en',
  ).options;
  const zh = buildRuntimeHostUpgradeDialog(
    conflict,
    'restart',
    'zh-CN',
  ).options;
  const zhTw = buildRuntimeHostUpgradeDialog(
    conflict,
    'restart',
    'zh-TW',
  ).options;
  assert.deepEqual(en.buttons, ['Restart Runtime Host', 'Wait', 'Cancel Startup']);
  assert.deepEqual(zh.buttons, ['重启 Runtime Host', '等待', '取消启动']);
  assert.equal(en.defaultId, en.cancelId);
  assert.equal(zh.defaultId, zh.cancelId);
  assert.match(zh.detail ?? '', /仍有 2 个其他客户端连接/);
  assert.match(zh.detail ?? '', /每日回顾: 1/);
  assert.match(en.detail ?? '', /Scheduled Task: 2/);
  assert.match(zh.detail ?? '', /计划任务: 2/);
  assert.deepEqual(zhTw.buttons, ['重啟 Runtime Host', '等待', '取消啟動']);
  assert.match(zhTw.detail ?? '', /仍有 2 個其他客戶端連線/);
  assert.match(zhTw.detail ?? '', /每日回顧: 1/);
  assert.match(en.detail ?? '', /Process ID \(PID\):/);
});

test('maps the non-default replacement choice to the replace decision', async () => {
  const prompts = createRuntimeHostUpgradePrompts(
    async () => 'en',
    async (options) => {
      assert.deepEqual(options.buttons, ['Stop Host and Continue', 'Wait', 'Cancel Startup']);
      assert.equal(options.defaultId, 2);
      assert.equal(options.cancelId, 2);
      assert.match(options.detail ?? '', /Maka will stop this Host/);
      return { response: 0, checkboxChecked: false };
    },
  );
  assert.equal(
    await prompts.nonRestartable(
      {
        kind: 'upgrade_required',
        restartable: false,
        registration: { pid: 42, lifecycleMode: 'ephemeral' },
      } as never,
      'replace_may_interrupt_work',
    ),
    'replace',
  );
});

test('defaults non-restartable prompts to cancellation', async () => {
  const conflict = {
    kind: 'upgrade_required',
    restartable: false,
    registration: { pid: 42, lifecycleMode: 'service' },
  } as never;
  const prompts = createRuntimeHostUpgradePrompts(
    async () => 'en',
    async (options) => {
      assert.deepEqual(options.buttons, ['Cancel Startup']);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.doesNotMatch(options.detail ?? '', /If you wait/u);
      return { response: 0, checkboxChecked: false };
    },
  );
  assert.equal(
    await prompts.nonRestartable(conflict, 'cancel_only'),
    'cancel',
  );

  const waitDialog = buildRuntimeHostUpgradeDialog(
    {
      kind: 'upgrade_required',
      restartable: false,
      registration: { pid: 42, lifecycleMode: 'ephemeral' },
    } as never,
    'wait',
    'en',
  ).options;
  assert.deepEqual(waitDialog.buttons, ['Wait', 'Cancel Startup']);
  assert.equal(waitDialog.defaultId, waitDialog.cancelId);
});

test('does not offer passive waiting when a supervised Host can restart', async () => {
  const prompts = createRuntimeHostUpgradePrompts(
    async () => 'en',
    async (options) => {
      assert.deepEqual(options.buttons, ['Restart Runtime Host', 'Cancel Startup']);
      assert.equal(options.defaultId, options.cancelId);
      assert.doesNotMatch(options.detail ?? '', /If you wait/u);
      return { response: 0, checkboxChecked: false };
    },
  );

  assert.equal(
    await prompts.restartable({
      ...conflict,
      registration: { pid: 42, lifecycleMode: 'service' },
    } as never),
    'restart',
  );
});

test('explains when the safe replacement check could not verify idle state', () => {
  const conflict = {
    kind: 'upgrade_required' as const,
    restartable: false as const,
    registration: { pid: 42, lifecycleMode: 'service' as const },
  } as Parameters<typeof buildRuntimeHostUpgradeDialog>[0];
  const dialog = buildRuntimeHostUpgradeDialog(
    conflict,
    'replace_may_interrupt_work',
    'zh-CN',
  );

  assert.match(dialog.options.detail ?? '', /无法确认此 Host 是否处于空闲状态/u);
  assert.doesNotMatch(dialog.options.detail ?? '', /无法报告后台活动/u);
  assert.equal(dialog.options.defaultId, dialog.options.cancelId);
});
