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
import test from 'node:test';
import { displayMemoryPath } from '../../renderer/settings/memory-settings-labels.js';

test('shortens Memory paths with their native separator', () => {
  assert.equal(
    displayMemoryPath('/Users/alice/.maka/memory/MEMORY.md'),
    '…/.maka/memory/MEMORY.md',
  );
  assert.equal(
    displayMemoryPath('C:\\Users\\alice\\.maka\\memory\\MEMORY.md'),
    '…\\.maka\\memory\\MEMORY.md',
  );
  assert.equal(
    displayMemoryPath('\\\\server\\share\\.maka\\memory\\MEMORY.md'),
    '…\\.maka\\memory\\MEMORY.md',
  );
});

test('leaves short Memory paths unchanged', () => {
  assert.equal(displayMemoryPath('/data/MEMORY.md'), '/data/MEMORY.md');
  assert.equal(displayMemoryPath('C:\\data\\MEMORY.md'), 'C:\\data\\MEMORY.md');
});
