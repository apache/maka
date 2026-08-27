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

import {
  isNormalizedAbsolutePath,
  pathWithinRoot,
  samePath,
  trimTrailingPathSeparators,
} from '../absolute-path.js';

describe('isNormalizedAbsolutePath', () => {
  it('accepts normalized POSIX and Windows drive-absolute paths', () => {
    for (const path of [
      '/workspace/project/src/index.ts',
      '/workspace/课程/第一课.txt',
      'C:\\',
      'c:\\workspace\\src\\index.ts',
      'D:\\资料\\课程.txt',
    ]) {
      assert.equal(isNormalizedAbsolutePath(path), true, path);
    }
  });

  it('rejects non-absolute and lexically non-canonical paths', () => {
    // Each literal isolates one lexical rejection so a failure identifies the broken contract.
    const invalidPaths = [
      ['', 'empty input'],
      ['workspace/project', 'relative POSIX path'],
      ['C:workspace\\project', 'drive-relative Windows path'],
      ['/workspace\\project', 'backslash in POSIX path'],
      ['C:\\workspace/project', 'slash in Windows path'],
      ['/workspace//project', 'duplicate POSIX separator'],
      ['C:\\workspace\\\\project', 'duplicate Windows separator'],
      ['/workspace/./project', 'POSIX current-directory segment'],
      ['/workspace/../project', 'POSIX parent-directory segment'],
      ['C:\\workspace\\.\\project', 'Windows current-directory segment'],
      ['C:\\workspace\\..\\project', 'Windows parent-directory segment'],
      ['/workspace/project/', 'trailing POSIX separator'],
      ['C:\\workspace\\project\\', 'trailing Windows separator'],
      ['\\\\server\\share\\project', 'UNC path'],
      ['\\\\?\\C:\\workspace\\project', 'Windows extended-length device path'],
      ['\\\\.\\C:\\workspace\\project', 'Windows device path'],
      ['C:\\workspace\\file:stream', 'NTFS alternate data stream'],
      ['/workspace/\0project', 'NUL in POSIX path'],
      ['C:\\workspace\\\0project', 'NUL in Windows path'],
    ] as const;

    for (const [path, reason] of invalidPaths) {
      assert.equal(isNormalizedAbsolutePath(path), false, reason);
    }
  });
});

describe('pathWithinRoot', () => {
  it('matches roots and descendants without accepting shared string prefixes', () => {
    assert.equal(pathWithinRoot('/workspace', '/workspace'), true);
    assert.equal(pathWithinRoot('/workspace/src/index.ts', '/workspace'), true);
    assert.equal(pathWithinRoot('/workspace2/src/index.ts', '/workspace'), false);

    assert.equal(pathWithinRoot('C:\\', 'C:\\'), true);
    assert.equal(pathWithinRoot('C:\\Windows\\System32', 'C:\\'), true);
    assert.equal(pathWithinRoot('C:\\workspace', 'C:\\workspace'), true);
    assert.equal(pathWithinRoot('C:\\workspace\\src\\index.ts', 'C:\\workspace'), true);
    assert.equal(pathWithinRoot('C:\\workspace2\\src\\index.ts', 'C:\\workspace'), false);
  });

  it('compares Windows paths case-insensitively while preserving POSIX case', () => {
    assert.equal(pathWithinRoot('C:\\WORKSPACE\\Src\\index.ts', 'c:\\workspace'), true);
    assert.equal(pathWithinRoot('/Workspace/src/index.ts', '/workspace'), false);
    assert.equal(pathWithinRoot('/workspace/src/index.ts', 'C:\\workspace'), false);
  });

  it('trims trailing separators before applying the containment contract', () => {
    // Matchers tolerate separators copied from shells while validators keep stored paths canonical.
    assert.equal(pathWithinRoot('/workspace/src///', '/workspace///'), true);
    assert.equal(pathWithinRoot('C:\\workspace\\src\\\\', 'C:\\workspace\\\\'), true);
  });

  it('rejects non-canonical candidates and roots', () => {
    assert.equal(pathWithinRoot('/workspace/../secret', '/workspace'), false);
    assert.equal(pathWithinRoot('/workspace/src', '/workspace/../workspace'), false);
    assert.equal(pathWithinRoot('C:\\workspace\\..\\secret', 'C:\\workspace'), false);
    assert.equal(pathWithinRoot('C:\\workspace\\src', '\\\\server\\share'), false);
    assert.equal(pathWithinRoot('/workspace/\0secret', '/workspace'), false);
  });
});

describe('samePath', () => {
  it('uses platform comparison rules and ignores trailing separators', () => {
    assert.equal(samePath('/workspace/project///', '/workspace/project'), true);
    assert.equal(samePath('/Workspace/project', '/workspace/project'), false);
    assert.equal(samePath('C:\\Workspace\\Project\\', 'c:\\workspace\\project'), true);
    assert.equal(samePath('C:\\workspace', 'D:\\workspace'), false);
    assert.equal(samePath('/workspace', 'C:\\workspace'), false);
  });
});

describe('trimTrailingPathSeparators', () => {
  it('preserves filesystem roots and removes every other trailing separator', () => {
    assert.equal(trimTrailingPathSeparators('/'), '/');
    assert.equal(trimTrailingPathSeparators('C:\\'), 'C:\\');
    assert.equal(trimTrailingPathSeparators('/workspace/project///'), '/workspace/project');
    assert.equal(
      trimTrailingPathSeparators('C:\\workspace\\project\\\\\\'),
      'C:\\workspace\\project',
    );
  });
});
