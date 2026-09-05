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
import { computeEditedSource } from '../edit-replace.js';

describe('computeEditedSource — exact match', () => {
  test('replaces the single occurrence and reports an exact match + line range', () => {
    assert.deepEqual(computeEditedSource('hello world', 'world', 'Maka', 'a.txt'), {
      content: 'hello Maka',
      matchedVia: 'exact',
      startLine: 1,
      endLine: 1,
    });
  });

  test('reports the matched multi-line range (1-based, inclusive)', () => {
    const content = 'a\nb\nTARGET1\nTARGET2\nc\n';
    const result = computeEditedSource(content, 'TARGET1\nTARGET2', 'X', 'a.txt');
    assert.equal(result.content, 'a\nb\nX\nc\n');
    assert.equal(result.startLine, 3);
    assert.equal(result.endLine, 4);
  });

  test('inserts new_string literally (no $-pattern interpretation)', () => {
    const result = computeEditedSource('const x = old;', 'old', '$&value', 'a.txt');
    assert.equal(result.content, 'const x = $&value;');
  });

  test('throws with the where label when old_string is absent', () => {
    assert.throws(
      () => computeEditedSource('hello', 'absent', 'x', 'src/a.txt'),
      /old_string not found in src\/a\.txt/,
    );
  });

  test('throws with the match count when old_string is not unique', () => {
    assert.throws(
      () => computeEditedSource('a a a', 'a', 'b', 'b.txt'),
      /old_string is not unique in b\.txt \(3 matches\)/,
    );
  });

  test('rejects identical old_string and new_string', () => {
    assert.throws(() => computeEditedSource('abc', 'abc', 'abc', 'b.txt'), /identical/);
  });

  test('rejects an empty old_string', () => {
    assert.throws(() => computeEditedSource('abc', '', 'x', 'b.txt'), /must not be empty/);
  });
});

describe('computeEditedSource — fuzzy cascade', () => {
  test('line-trimmed: tolerates indentation drift on a multi-line block', () => {
    const content = 'function f() {\n    return 1;\n}\n'; // 4-space body
    const oldString = 'function f() {\n  return 1;\n}'; // model used 2-space body
    const result = computeEditedSource(
      content,
      oldString,
      'function f() {\n    return 2;\n}',
      'f.ts',
    );
    assert.equal(result.matchedVia, 'line-trimmed');
    assert.equal(result.content, 'function f() {\n    return 2;\n}\n');
    assert.equal(result.startLine, 1);
    assert.equal(result.endLine, 3);
  });

  test('whitespace: tolerates collapsed internal whitespace', () => {
    const content = 'const  x   =   1;';
    const result = computeEditedSource(content, 'const x = 1;', 'const x = 2;', 'w.ts');
    assert.equal(result.matchedVia, 'whitespace');
    assert.equal(result.content, 'const x = 2;');
  });

  test('escape: tolerates literal backslash escapes in old_string', () => {
    const content = 'line1\nline2';
    const result = computeEditedSource(content, 'line1\\nline2', 'X', 'e.ts');
    assert.equal(result.matchedVia, 'escape');
    assert.equal(result.content, 'X');
    assert.equal(result.startLine, 1);
    assert.equal(result.endLine, 2);
  });

  test('line-trimmed: preserves a trailing newline in old_string (no extra blank line)', () => {
    const content = '  abcde\n  fghij\n';
    const result = computeEditedSource(content, 'abcde\nfghij\n', 'xxxxx\nyyyyy\n', 'n.ts');
    assert.equal(result.matchedVia, 'line-trimmed');
    assert.equal(result.content, 'xxxxx\nyyyyy\n');
    assert.equal(result.startLine, 1);
    assert.equal(result.endLine, 2);
  });

  test("a span's trailing newline is a terminator, not an extra line, for endLine", () => {
    assert.deepEqual(computeEditedSource('abc\n', 'abc\n', 'def\n', 'r.ts'), {
      content: 'def\n',
      matchedVia: 'exact',
      startLine: 1,
      endLine: 1,
    });
  });
});

describe('computeEditedSource — anti-corruption guards', () => {
  test('rejects multiple distinct fuzzy candidates instead of guessing', () => {
    const content = 'function a() {\n  x;\n}\nfunction a() {\n   x;\n}\n';
    const oldString = 'function a() {\n    x;\n}'; // matches both blocks by trimmed lines
    assert.throws(
      () => computeEditedSource(content, oldString, 'Y', 'a.ts'),
      /different line-trimmed candidates/,
    );
  });

  test('rejects a fuzzy span that occurs more than once', () => {
    const content = 'function a() {\n  x;\n}\nfunction a() {\n  x;\n}\n';
    const oldString = 'function a() {\n    x;\n}';
    assert.throws(
      () => computeEditedSource(content, oldString, 'Y', 'a.ts'),
      /occurs more than once/,
    );
  });

  test('rejects a too-short old_string for a non-exact match', () => {
    const content = 'a   b';
    assert.throws(() => computeEditedSource(content, 'a b', 'c', 's.ts'), /too short/);
  });

  test('a multi-line old_string never collapses onto a single line (whitespace)', () => {
    const content = 'header\nalpha beta\nfooter\n';
    assert.throws(() => computeEditedSource(content, 'alpha\nbeta', 'X', 'w.ts'), /not found/);
  });
});

describe('computeEditedSource — verbatim replacement (no indentation migration)', () => {
  test('fuzzy match writes new_string verbatim; the file indentation is NOT migrated', () => {
    const content = 'def f():\n        return 1\n'; // 8-space body on disk
    const oldString = 'def f():\n    return 1'; // model used a 4-space body
    const newString = 'def f():\n    return 2'; // model's new_string is also 4-space
    const result = computeEditedSource(content, oldString, newString, 'p.py');
    assert.equal(result.matchedVia, 'line-trimmed');
    // new_string is inserted exactly as given (4-space), deliberately NOT
    // re-indented to the file's 8-space — callers own the final formatting.
    assert.equal(result.content, 'def f():\n    return 2\n');
  });
});

describe('computeEditedSource — oversized / binary fuzzy guards', () => {
  test('binary (NUL) file: exact still edits, fuzzy is refused', () => {
    const nul = String.fromCharCode(0);
    const content = 'alpha' + nul + 'needle here';
    assert.equal(
      computeEditedSource(content, 'needle here', 'replaced', 'b.bin').content,
      'alpha' + nul + 'replaced',
    );
    assert.throws(() => computeEditedSource(content, 'needle  here', 'x', 'b.bin'), /looks binary/);
  });

  test('oversized file: exact still edits, fuzzy is refused', () => {
    const content = 'x'.repeat(1_000_001) + '\nunique anchor line\n'; // > MAX_FUZZY_SOURCE_BYTES
    assert.equal(
      computeEditedSource(content, 'unique anchor line', 'edited anchor', 'big.txt').matchedVia,
      'exact',
    );
    assert.throws(
      () => computeEditedSource(content, '  unique anchor line  ', 'x', 'big.txt'),
      /too large to fuzzy-match/,
    );
  });
});
