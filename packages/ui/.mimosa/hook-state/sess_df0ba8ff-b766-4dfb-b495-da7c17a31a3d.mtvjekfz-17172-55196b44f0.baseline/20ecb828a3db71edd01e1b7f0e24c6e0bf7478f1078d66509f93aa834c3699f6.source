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
import { describeLoadToolResult } from '../tool-format.js';

test('custom load-tool groups use Traditional Chinese action copy', () => {
  const result = describeLoadToolResult(
    { group: 'custom' },
    {
      activated: ['custom_tool'],
      group: { id: 'custom', label: '自訂工具', description: '專案工具' },
    },
    'zh-TW',
  );
  assert.equal(result?.actionLabel, '啟用 自訂工具');
  assert.equal(result?.title, '自訂工具 已啟用');
});
