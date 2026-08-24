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
import { sanitizeUnicodeText } from '../text-sanitize.js';

describe('sanitizeUnicodeText', () => {
  test('passes plain text through unchanged', () => {
    assert.equal(sanitizeUnicodeText('Fix login bug', { maxCodePoints: 80 }), 'Fix login bug');
    assert.equal(sanitizeUnicodeText('会话名称', { maxCodePoints: 80 }), '会话名称');
  });

  test('normalizes to NFC so equivalent spellings match', () => {
    // Decomposed (NFD) e + combining acute, as macOS filenames are recorded.
    const decomposed = 'cafe\u0301';
    assert.notEqual(decomposed, 'caf\u00e9');
    assert.equal(sanitizeUnicodeText(decomposed, { maxCodePoints: 80 }), 'caf\u00e9');
  });

  test('replaces control characters with single spaces', () => {
    // Escaped form keeps the source file text-safe; see the note in text-sanitize.ts.
    assert.equal(
      sanitizeUnicodeText('foo\u0007bar\u001Fbaz', { maxCodePoints: 80 }),
      'foo bar baz',
    );
    assert.equal(sanitizeUnicodeText('line\nbreak\ttab', { maxCodePoints: 80 }), 'line break tab');
    assert.equal(sanitizeUnicodeText('del\u007Fete', { maxCodePoints: 80 }), 'del ete');
  });

  test('replaces bidi format characters with spaces so direction spoofing collapses', () => {
    const spoofed = 'evil\u202Egnp\u202C.txt';
    const cleaned = sanitizeUnicodeText(spoofed, { maxCodePoints: 80 });
    assert.equal(cleaned, 'evil gnp .txt');
    for (const mark of ['\u061C', '\u200E', '\u200F', '\u2066', '\u2069']) {
      assert.equal(sanitizeUnicodeText(`a${mark}b`, { maxCodePoints: 80 }), 'a b');
    }
  });

  test('removes zero-width characters entirely instead of spacing them', () => {
    assert.equal(
      sanitizeUnicodeText('invis\u200Bible\uFEFFname', { maxCodePoints: 80 }),
      'invisiblename',
    );
    assert.equal(
      sanitizeUnicodeText('zero\u2060width\u2063joiners', { maxCodePoints: 80 }),
      'zerowidthjoiners',
    );
    // Removal over replacement keeps compound-emoji sequences' code points intact.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    assert.equal(
      sanitizeUnicodeText(`hi ${family}`, { maxCodePoints: 80 }),
      `hi \u{1F468}\u{1F469}\u{1F467}`,
    );
  });

  test('collapses whitespace runs and trims the ends', () => {
    assert.equal(
      sanitizeUnicodeText('   spaced \t out \n name  ', { maxCodePoints: 80 }),
      'spaced out name',
    );
  });

  test('caps length by code points without splitting surrogate pairs', () => {
    const fox = '\u{1F98A}';
    assert.equal(Array.from(fox).length, 1);
    assert.equal(
      sanitizeUnicodeText(`${fox}${fox}${fox}`, { maxCodePoints: 2 }),
      `${fox}${fox}\u2026`,
    );
  });

  test('supports a silent cap via an empty suffix', () => {
    assert.equal(sanitizeUnicodeText('abcdef', { maxCodePoints: 3, truncatedSuffix: '' }), 'abc');
  });

  test('returns empty string when input sanitizes to nothing', () => {
    assert.equal(sanitizeUnicodeText('', { maxCodePoints: 80 }), '');
    assert.equal(sanitizeUnicodeText('\u200B\u200D\uFEFF', { maxCodePoints: 80 }), '');
    assert.equal(sanitizeUnicodeText('\t\n ', { maxCodePoints: 80 }), '');
  });
});
