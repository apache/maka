import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clientSettingsConfirmation,
} from '../client-settings-confirmation-copy.js';
import { projectPickerTitle } from '../project-picker-copy.js';

test('localizes native picker and client settings confirmation copy', () => {
  assert.equal(projectPickerTitle('zh'), '添加项目');
  assert.deepEqual(
    clientSettingsConfirmation(
      [{ key: 'keepSystemAwake', current: false, next: true }],
      'zh',
    ),
    {
      message: '允许 Maka 更新此客户端的设置吗？',
      detail: '保持系统唤醒: 关闭 → 开启',
      buttons: ['应用更改', '取消'],
    },
  );
});
