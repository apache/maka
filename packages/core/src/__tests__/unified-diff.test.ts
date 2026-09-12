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

  test('preserves empty rows without creating a row for the terminating newline', () => {
    assert.deepEqual(parseUnifiedDiffRows(''), [{ kind: 'meta', text: '' }]);
    assert.deepEqual(parseUnifiedDiffRows('\n'), [{ kind: 'meta', text: '' }]);
    assert.deepEqual(parseUnifiedDiffRows('\n\n'), [
      { kind: 'meta', text: '' },
      { kind: 'meta', text: '' },
    ]);

    const diff = '@@ -1,2 +1,2 @@\n\n-old\n+new';
    const expected = [
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: '', oldLine: 1, newLine: 1 },
      { kind: 'del', text: '-old', oldLine: 2 },
      { kind: 'add', text: '+new', newLine: 2 },
    ];
    assert.deepEqual(parseUnifiedDiffRows(diff), expected);
    assert.deepEqual(parseUnifiedDiffRows(`${diff}\n`), expected);
  });

  test('retains carriage returns in CRLF input', () => {
    assert.deepEqual(parseUnifiedDiffRows('--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n'), [
      { kind: 'hunk', text: '@@ -1 +1 @@\r' },
      { kind: 'del', text: '-a\r', oldLine: 1 },
      { kind: 'add', text: '+b\r', newLine: 1 },
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

  test('counts without materializing display rows or splitting the full diff', () => {
    const diff = '--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n kept\n-old\n+new\n';
    const originalPush = Array.prototype.push;
    const originalSplit = String.prototype.split;
    let displayRows = 0;
    let fullLineSplits = 0;
    let stats: ReturnType<typeof countDiffLineStats>;

    // Probe only the synchronous call, restoring globals before assertions or
    // test-runner work. This catches the original allocation regression without
    // depending on machine-specific timing or heap thresholds.
    try {
      Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
        for (const item of items) {
          if (item && typeof item === 'object' && 'kind' in item && 'text' in item) {
            displayRows += 1;
          }
        }
        return Reflect.apply(originalPush, this, items);
      };
      String.prototype.split = function (this: string, ...args: unknown[]): string[] {
        if (this === diff && args[0] === '\n') fullLineSplits += 1;
        return Reflect.apply(originalSplit, this, args);
      };
      stats = countDiffLineStats(diff);
    } finally {
      Array.prototype.push = originalPush;
      String.prototype.split = originalSplit;
    }

    assert.deepEqual(stats, { additions: 1, deletions: 1 });
    assert.deepEqual({ displayRows, fullLineSplits }, { displayRows: 0, fullLineSplits: 0 });
  });

  test('counts actual hunk content, including truncated and zero-count hunks', () => {
    const cases = [
      { diff: '', additions: 0, deletions: 0 },
      { diff: '+foreign\n-old\n', additions: 0, deletions: 0 },
      { diff: '@@ -1,0 +1,0 @@\n+outside\n', additions: 0, deletions: 0 },
      { diff: '@@ -1,9 +1,9 @@\n-old\n+new\n', additions: 1, deletions: 1 },
      { diff: '@@ -1,2 +0,0 @@\n-first\n-second', additions: 0, deletions: 2 },
      { diff: '@@ -1 +1 @@\n--- comment\n+++i\n+outside', additions: 1, deletions: 1 },
      {
        diff: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file',
        additions: 1,
        deletions: 1,
      },
      { diff: '@@ -1,2 +1,2 @@\n\n-old\n+new\n', additions: 1, deletions: 1 },
      { diff: '@@ -1 +1 @@\r\n-old\r\n+new\r\n', additions: 1, deletions: 1 },
      {
        diff: 'diff --git a/x b/x\nBinary files a/x and b/x differ\n',
        additions: 0,
        deletions: 0,
      },
    ];
    for (const { diff, additions, deletions } of cases) {
      assert.deepEqual(countDiffLineStats(diff), { additions, deletions }, diff);
    }
  });

  test('matches independently generated rows and counts across 1,000 seeded multi-file diffs', () => {
    let seed = 0xc083;
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const contents = ['', 'content', '-- comment', '++i', '@@ header-like', 'diff --git', '中文'];

    for (let trial = 0; trial < 1000; trial += 1) {
      const lines: string[] = [];
      const expectedRows: ReturnType<typeof parseUnifiedDiffRows> = [];
      let additions = 0;
      let deletions = 0;
      for (let file = 0, files = random(3) + 1; file < files; file += 1) {
        const separator = `diff --git a/file${file} b/file${file}`;
        lines.push(separator, 'index 1111111..2222222', `--- a/file${file}`, `+++ b/file${file}`);
        expectedRows.push({ kind: 'meta', text: separator });
        for (let hunk = 0, hunks = random(4) + 1; hunk < hunks; hunk += 1) {
          const oldStart = random(1000) + 1;
          const newStart = random(1000) + 1;
          let oldLine = oldStart;
          let newLine = newStart;
          const body: ReturnType<typeof parseUnifiedDiffRows> = [];
          for (let row = 0, rows = random(25) + 1; row < rows; row += 1) {
            const text = contents[random(contents.length)];
            const kind = random(3);
            if (kind === 0) {
              body.push({ kind: 'add', text: `+${text}`, newLine: newLine++ });
              additions += 1;
            } else if (kind === 1) {
              body.push({ kind: 'del', text: `-${text}`, oldLine: oldLine++ });
              deletions += 1;
            } else {
              body.push({ kind: 'ctx', text: ` ${text}`, oldLine: oldLine++, newLine: newLine++ });
            }
          }
          const oldCount = oldLine - oldStart;
          const newCount = newLine - newStart;
          const oldRange =
            oldCount === 1 ? `${oldStart}` : `${oldCount === 0 ? 0 : oldStart},${oldCount}`;
          const newRange =
            newCount === 1 ? `${newStart}` : `${newCount === 0 ? 0 : newStart},${newCount}`;
          const header = `@@ -${oldRange} +${newRange} @@`;
          lines.push(header, ...body.map((row) => row.text));
          expectedRows.push({ kind: 'hunk', text: header }, ...body);
        }
      }
      const diff = lines.join('\n') + (random(2) ? '\n' : '');
      assert.deepEqual(parseUnifiedDiffRows(diff), expectedRows, `rows for trial ${trial}`);
      assert.deepEqual(
        countDiffLineStats(diff),
        { additions, deletions },
        `counts for trial ${trial}`,
      );
    }
  });
});
