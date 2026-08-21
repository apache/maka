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
