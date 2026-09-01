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
import type { CuDispatchBackend } from '@maka/runtime/computer-use-types';
import { selectComputerUseBackend } from '../select-backend.js';

const backend: CuDispatchBackend = {
  async preflight() {
    return { accessibility: true, screenRecording: true };
  },
  async run() {
    return { outcome: { ok: true, tier: 'ax', verified: true } };
  },
};

test('selector has a Windows platform seam and does not select Windows on macOS', () => {
  const selected = selectComputerUseBackend({
    platform: 'win32',
    binaryPath: 'helper.exe',
    expectedBinarySha256: '0'.repeat(64),
    createWindowsBackend: () => backend,
  });
  assert.equal(selected.backendId, 'windows-native');
  const mac = selectComputerUseBackend({
    platform: 'darwin',
    binaryPath: 'helper.exe',
    expectedBinarySha256: '0'.repeat(64),
    createBackend: () => backend,
  });
  assert.equal(mac.backendId, 'maka-cu');
});
