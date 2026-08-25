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
import {
  collectWindowsPackageSourceClosure,
  readWindowsReleasePathPatterns,
  windowsReleasePatternCoversSource,
} from './windows-package-source-closure.mjs';

test('the Windows package trigger covers the packaged worker and driver import closure', async () => {
  const closure = await collectWindowsPackageSourceClosure();
  const patterns = readWindowsReleasePathPatterns();
  const missing = closure.filter(
    (sourcePath) =>
      !patterns.some((pattern) => windowsReleasePatternCoversSource(sourcePath, pattern)),
  );

  for (const expected of [
    'packages/core/src/absolute-path.ts',
    'packages/core/src/sandbox-boundary.ts',
    'packages/core/src/serialized-byte-length.ts',
    'packages/core/src/windows-path.ts',
    'packages/runtime/src/child-fd-input.ts',
    'packages/runtime/src/child-process-lifecycle.ts',
    'packages/runtime/src/process-tree-terminator.ts',
  ]) {
    assert.ok(closure.includes(expected), `closure omitted ${expected}`);
  }
  assert.deepEqual(missing, []);
});

test('the Windows package workflow path list has no duplicate entries', () => {
  const patterns = readWindowsReleasePathPatterns();
  assert.equal(new Set(patterns).size, patterns.length);
});
