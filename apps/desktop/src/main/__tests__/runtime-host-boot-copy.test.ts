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
import { getStartupRecoveryCopy } from '../runtime-host-boot-copy.js';

test('startup recovery copy preserves Traditional Chinese', () => {
  const copy = getStartupRecoveryCopy('zh-TW');
  assert.equal(copy.storageRoot.title, 'Maka 工作區需要修復');
  assert.match(copy.storageRoot.detail('C:\\Maka'), /磁碟識別碼/);
  assert.equal(copy.runtimeHost.title, '預設 Runtime Host 無法連線');
  assert.match(copy.runtimeHost.detail('失敗'), /設定中處理/);
});
