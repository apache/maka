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
