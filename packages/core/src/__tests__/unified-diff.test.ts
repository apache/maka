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

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { countDiffLineStats, parseUnifiedDiffRows } from '../unified-diff.js';

describe('parseUnifiedDiffRows', () => {
  test('parses a standard single-hunk diff, omitting file headers', () => {
    const rows = parseUnifiedDiffRows(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' kept', '-old', '+new', ' tail'].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', text: ' kept', oldLine: 1, newLine: 1 },
      { kind: 'del', text: '-old', oldLine: 2 },
      { kind: 'add', text: '+new', newLine: 2 },
      { kind: 'ctx', text: ' tail', oldLine: 3, newLine: 3 },
    ]);
  });

  test('a deleted line whose content starts with `-- ` is a deletion, not a file header', () => {
    // Unified diff writes the deletion of `-- a` as `--- a`: inside a hunk
    // body the first character is the marker, however header-like the rest
    // looks. Heuristic prefix matching hides these lines and desyncs every
    // line number after them.
    const rows = parseUnifiedDiffRows(
      ['@@ -1,3 +1,2 @@', ' SELECT 1;', '--- a', '-SELECT 3;'].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'hunk', text: '@@ -1,3 +1,2 @@' },
      { kind: 'ctx', text: ' SELECT 1;', oldLine: 1, newLine: 1 },
      { kind: 'del', text: '--- a', oldLine: 2 },
      { kind: 'del', text: '-SELECT 3;', oldLine: 3 },
    ]);
  });

  test('an added line whose content starts with `++` is an addition', () => {
    const rows = parseUnifiedDiffRows(
      ['@@ -1,2 +1,3 @@', ' let i = 0;', '+++i;', '+i += 1;', ' return i;'].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { kind: 'ctx', text: ' let i = 0;', oldLine: 1, newLine: 1 },
      { kind: 'add', text: '+++i;', newLine: 2 },
      { kind: 'add', text: '+i += 1;', newLine: 3 },
      { kind: 'ctx', text: ' return i;', oldLine: 2, newLine: 4 },
    ]);
  });

  test('`\\ No newline at end of file` markers carry no number and advance no counter', () => {
    const rows = parseUnifiedDiffRows(
      [
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file',
      ].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: '-old', oldLine: 1 },
      { kind: 'meta', text: '\\ No newline at end of file' },
      { kind: 'add', text: '+new', newLine: 1 },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  test('resumes numbering per hunk and treats post-hunk `---`/`+++` as the next file', () => {
    const rows = parseUnifiedDiffRows(
      [
        '@@ -10,1 +10,1 @@',
        '-a',
        '+b',
        '--- a/second.ts',
        '+++ b/second.ts',
        '@@ -1,1 +1,1 @@',
        '-c',
        '+d',
      ].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'hunk', text: '@@ -10,1 +10,1 @@' },
      { kind: 'del', text: '-a', oldLine: 10 },
      { kind: 'add', text: '+b', newLine: 10 },
      { kind: 'hunk', text: '@@ -1,1 +1,1 @@' },
      { kind: 'del', text: '-c', oldLine: 1 },
      { kind: 'add', text: '+d', newLine: 1 },
    ]);
  });

  test('keeps `diff --git` separators as meta rows and a new-file diff reads from /dev/null', () => {
    const rows = parseUnifiedDiffRows(
      [
        'diff --git a/new.md b/new.md',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1,2 @@',
        '+alpha',
        '+beta',
      ].join('\n'),
    );

    assert.deepEqual(rows, [
      { kind: 'meta', text: 'diff --git a/new.md b/new.md' },
      { kind: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', text: '+alpha', newLine: 1 },
      { kind: 'add', text: '+beta', newLine: 2 },
    ]);
  });

  test('a foreign diff without hunk headers degrades to unnumbered meta rows', () => {
    const rows = parseUnifiedDiffRows(['+function main() {', '-// old comment'].join('\n'));

    assert.deepEqual(rows, [
      { kind: 'meta', text: '+function main() {' },
      { kind: 'meta', text: '-// old comment' },
    ]);
  });
});

describe('countDiffLineStats', () => {
  test('counts every change line, including `--`/`++`-prefixed content', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' kept', '--- a', '+i += 1;', ' tail'].join('\n');

    assert.deepEqual(countDiffLineStats(diff), { additions: 1, deletions: 1 });
  });

  test('ignores file headers and hunk headers', () => {
    const diff = ['--- /dev/null', '+++ b/new.md', '@@ -0,0 +1,2 @@', '+alpha', '+beta'].join('\n');

    assert.deepEqual(countDiffLineStats(diff), { additions: 2, deletions: 0 });
  });
});
