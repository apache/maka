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
import { parsePatch } from '../../products/maka/workbench/app/patch.ts';

/** A row as `[kind, text]` for meta and hunk rows, else `[kind, old, new, text]`. */
const shape = (rows) =>
  rows.map((row) =>
    row.kind === 'meta' || row.kind === 'hunk'
      ? [row.kind, row.text]
      : [row.kind, row.old, row.new, row.text],
  );

const CASES = [
  {
    name: 'two hunks, no newline at the end',
    patch:
      'diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n@@ -10,2 +10,3 @@ fn x\n ten\n eleven\n+twelve\n\\ No newline at end of file\n',
    rows: [
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['context', 1, 1, 'one'],
      ['removed', 2, null, 'two'],
      ['added', null, 2, 'TWO'],
      ['hunk', '@@ -10,2 +10,3 @@ fn x'],
      ['context', 10, 10, 'ten'],
      ['context', 11, 11, 'eleven'],
      ['added', null, 12, 'twelve'],
      ['meta', '\\ No newline at end of file'],
    ],
  },
  {
    name: 'no newline inside a hunk',
    patch: '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n',
    rows: [
      ['hunk', '@@ -1 +1 @@'],
      ['removed', 1, null, 'a'],
      ['meta', '\\ No newline at end of file'],
      ['added', null, 1, 'b'],
    ],
  },
  {
    name: 'a new file',
    patch:
      'diff --git a/n b/n\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n',
    rows: [
      ['meta', 'new file mode 100644'],
      ['hunk', '@@ -0,0 +1,2 @@'],
      ['added', null, 1, 'x'],
      ['added', null, 2, 'y'],
    ],
  },
  {
    name: 'a deleted file',
    patch:
      'diff --git a/d b/d\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/d\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n',
    rows: [
      ['meta', 'deleted file mode 100644'],
      ['hunk', '@@ -1 +0,0 @@'],
      ['removed', 1, null, 'gone'],
    ],
  },
  {
    name: 'lines added after line 1 of none',
    patch: '@@ -1,0 +1,1 @@\n+first\n@@ -3,0 +4 @@\n+fourth\n',
    rows: [
      ['hunk', '@@ -1,0 +1,1 @@'],
      ['added', null, 1, 'first'],
      ['hunk', '@@ -3,0 +4 @@'],
      ['added', null, 4, 'fourth'],
    ],
  },
  {
    name: 'a removed "-- a" and an added "++ b" inside hunks',
    patch: '@@ -1,2 +1,1 @@\n--- a\n keep\n@@ -5 +4 @@\n-x\n+++ b\n',
    rows: [
      ['hunk', '@@ -1,2 +1,1 @@'],
      ['removed', 1, null, '-- a'],
      ['context', 2, 1, 'keep'],
      ['hunk', '@@ -5 +4 @@'],
      ['removed', 5, null, 'x'],
      ['added', null, 4, '++ b'],
    ],
  },
  {
    name: 'tabs, CRLF and a bare empty context line',
    patch: '@@ -1,3 +1,3 @@\n \tx\r\n\n-a\tb\n+ab\tc\n',
    rows: [
      ['hunk', '@@ -1,3 +1,3 @@'],
      ['context', 1, 1, '    x'],
      ['context', 2, 2, ''],
      ['removed', 3, null, 'a   b'],
      ['added', null, 3, 'ab  c'],
    ],
  },
  {
    name: 'a mode change only',
    patch: 'diff --git a/s b/s\nold mode 100644\nnew mode 100755\n',
    rows: [['meta', 'old mode 100644 · new mode 100755']],
  },
  { name: 'an empty patch', patch: '', rows: [] },
];

for (const { name, patch, rows } of CASES) {
  test(`parsePatch: ${name}`, () => {
    assert.deepEqual(shape(parsePatch(patch)), rows);
  });
}
