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
import { filesystemLeaseKeyForPlatform } from '../filesystem-lease-key.js';
import { containsPath } from '../preparation/claims.js';

describe('filesystem lease keys', () => {
  it('preserves POSIX canonical paths', () => {
    assert.equal(filesystemLeaseKeyForPlatform('/work/A.txt', 'linux'), '/work/A.txt');
    assert.equal(filesystemLeaseKeyForPlatform('/work/A.txt', 'darwin'), '/work/A.txt');
  });

  it('case-folds Windows paths without locale-sensitive APIs', () => {
    assert.equal(
      filesystemLeaseKeyForPlatform('C:\\work\\src\\a.txt', 'win32'),
      filesystemLeaseKeyForPlatform('C:\\WORK\\SRC\\A.TXT', 'win32'),
    );
    assert.equal(filesystemLeaseKeyForPlatform('C:\\work\\iı.txt', 'win32'), 'C:\\WORK\\II.TXT');
  });

  it('checks separator boundaries instead of using a bare prefix', () => {
    assert.equal(containsPath('/work/src', '/work/src/a.ts'), true);
    assert.equal(containsPath('/work/src', '/work/src2/a.ts'), false);
    assert.equal(containsPath('C:\\work\\src', 'C:\\work\\src\\a.ts'), true);
  });
});
