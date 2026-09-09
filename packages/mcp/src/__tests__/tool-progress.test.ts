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
import { mapMcpToolProgress } from '../tool-progress.js';

test('maps integer MCP progress onto the Host current/total pair', () => {
  assert.deepEqual(mapMcpToolProgress({ progress: 0, total: 1 }), { current: 0, total: 1 });
  assert.deepEqual(mapMcpToolProgress({ progress: 1, total: 3, message: 'working' }), {
    current: 1,
    total: 3,
  });
  assert.deepEqual(
    mapMcpToolProgress({ progress: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER }),
    { current: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
  );
});

test('drops incomplete, inverted, or non-integer MCP progress', () => {
  for (const value of [
    undefined,
    null,
    '1/3',
    { progress: 1 },
    { total: 3 },
    { progress: 0.5, total: 1 },
    { progress: 1, total: 3.5 },
    { progress: -1, total: 2 },
    { progress: 1, total: 0 },
    { progress: 3, total: 2 },
    { progress: Number.MAX_SAFE_INTEGER + 1, total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(mapMcpToolProgress(value), undefined);
  }
});
