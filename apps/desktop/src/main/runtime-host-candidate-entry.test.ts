/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDesktopRuntimeHostEntry } from './runtime-host-candidate-entry.js';

test('explicit development helper selects the admitted managed candidate', () => {
  assert.equal(selectDesktopRuntimeHostEntry({
    isPackaged: false, isE2e: false, managedFilesDevHelper: '{"schemaVersion":1}',
  }), './test-only/managed-files-candidate-main.js');
});

test('ordinary development startup does not require a helper', () => {
  assert.equal(selectDesktopRuntimeHostEntry({
    isPackaged: false, isE2e: false, managedFilesDevHelper: undefined,
  }), './execution-candidate-main.js');
});

test('packaged startup never selects a development or fake backend', () => {
  for (const isE2e of [true, false]) {
    assert.equal(selectDesktopRuntimeHostEntry({
      isPackaged: true, isE2e, managedFilesDevHelper: '{}',
    }), './execution-candidate-main.js');
  }
});

test('E2E keeps its separate fake-backend entry', () => {
  assert.equal(selectDesktopRuntimeHostEntry({
    isPackaged: false, isE2e: true, managedFilesDevHelper: '{}',
  }), './test-only/execution-candidate-e2e-main.js');
});

test('invalid explicit opt-in reaches admission rather than silently falling back', () => {
  assert.equal(selectDesktopRuntimeHostEntry({
    isPackaged: false, isE2e: false, managedFilesDevHelper: '',
  }), './test-only/managed-files-candidate-main.js');
});
