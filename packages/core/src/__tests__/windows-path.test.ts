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
import { describe, it } from 'node:test';

import { canonicalWindowsPath, isCanonicalWindowsPath } from '../windows-path.js';

// The predicate and throwing wrapper must reject the same observable path shapes.
const NON_CANONICAL_WINDOWS_PATHS = [
  '',
  '/workspace/project',
  'C:workspace\\project',
  'C:/workspace/project',
  'C:\\workspace/project',
  'C:\\workspace\\\\project',
  'C:\\workspace\\.\\project',
  'C:\\workspace\\..\\project',
  'C:\\workspace\\project\\',
  '\\\\server\\share\\project',
  '\\\\?\\C:\\workspace\\project',
  '\\\\.\\C:\\workspace\\project',
  'C:\\workspace\\file:stream',
  'C:\\workspace\\\0project',
] as const;

describe('isCanonicalWindowsPath', () => {
  it('accepts volume roots and normalized drive-absolute paths', () => {
    for (const path of ['C:\\', 'z:\\workspace', 'D:\\资料\\课程.txt']) {
      assert.equal(isCanonicalWindowsPath(path), true, path);
    }
  });

  it('rejects paths outside the canonical local-drive contract', () => {
    for (const path of NON_CANONICAL_WINDOWS_PATHS) {
      assert.equal(isCanonicalWindowsPath(path), false, JSON.stringify(path));
    }
  });
});

describe('canonicalWindowsPath', () => {
  it('returns a canonical path unchanged', () => {
    const path = 'd:\\Workspace\\Project\\File.TXT';

    assert.equal(canonicalWindowsPath(path), path);
  });

  it('throws for every non-canonical path shape', () => {
    for (const path of NON_CANONICAL_WINDOWS_PATHS) {
      assert.throws(() => canonicalWindowsPath(path), Error, JSON.stringify(path));
    }
  });
});
