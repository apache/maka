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
import { subscriptionResultMessage } from '../../renderer/features/connection-settings/index.js';

test('Traditional Chinese subscription errors reject raw Simplified backend copy', () => {
  assert.equal(
    subscriptionResultMessage('GitHub Copilot 登录已过期。', '請重新登入。', 'zh-TW'),
    '請重新登入。',
  );
  assert.equal(
    subscriptionResultMessage('network unreachable', '請重新登入。', 'zh-TW'),
    '網路錯誤',
  );
});
