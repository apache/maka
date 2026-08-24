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
import { describe, test } from 'node:test';

import { isLikelySandboxDenial } from '../sandbox/detect.js';

describe('isLikelySandboxDenial', () => {
  test('recognizes explicit sandbox denial evidence from either output stream', () => {
    for (const input of [
      { stdout: '', stderr: 'Operation not permitted' },
      { stdout: '', stderr: 'launching sandbox-exec profile' },
      { stdout: '', stderr: 'dyld: file system sandbox blocked mmap()' },
      { stdout: 'The operation was sandboxed and denied by policy', stderr: '' },
    ]) {
      assert.equal(isLikelySandboxDenial({ ...input, sandboxed: true }), true);
    }
  });

  test('requires an active sandbox and unambiguous denial evidence', () => {
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'Operation not permitted', sandboxed: false }),
      false,
    );
    assert.equal(
      isLikelySandboxDenial({ stdout: '', stderr: 'permission denied', sandboxed: true }),
      false,
    );
    assert.equal(
      isLikelySandboxDenial({
        stdout: 'command not found',
        stderr: 'exit code 127',
        sandboxed: true,
      }),
      false,
    );
  });
});
