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
import { projectToolResult } from '../acp-projection.js';

for (const { name, oldText, newText, expected } of [
  {
    name: 'newline-terminated files',
    oldText: 'a\n',
    newText: 'b\n',
    expected: '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  },
  {
    name: 'files without a final newline',
    oldText: 'a',
    newText: 'b',
    expected:
      '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n',
  },
  {
    name: 'an empty old file',
    oldText: '',
    newText: 'b\n',
    expected: '--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1,1 @@\n+b\n',
  },
]) {
  test(`ACP file diff represents ${name}`, () => {
    assert.deepEqual(
      projectToolResult([{ type: 'diff', path: 'file.txt', oldText, newText }], undefined),
      { kind: 'file_diff', paths: ['file.txt'], diff: expected },
    );
  });
}
