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
import {
  copyToClipboard,
  MAX_CLIPBOARD_TEXT_BYTES,
  osc52ClipboardSequence,
} from '../tui-clipboard.js';

describe('osc52ClipboardSequence', () => {
  test('wraps base64-encoded UTF-8 in the OSC 52 clipboard sequence', () => {
    const base64 = Buffer.from('héllo', 'utf8').toString('base64');
    assert.equal(osc52ClipboardSequence('héllo'), `\x1b]52;c;${base64}\x07`);
  });

  test('encodes an empty string as an empty payload', () => {
    assert.equal(osc52ClipboardSequence(''), '\x1b]52;c;\x07');
  });

  test('emits a bare sequence with no tmux DCS passthrough wrapper', () => {
    // The bare sequence is the correct primitive; tmux forwards it only with
    // `set-clipboard on` (default `external` drops it) and an `Ms` terminfo cap.
    // DCS passthrough is avoided: it needs `allow-passthrough on`, off by default.
    const sequence = osc52ClipboardSequence('hi');
    assert.equal(sequence.startsWith('\x1b]52;'), true);
    assert.equal(sequence.includes('\x1bPtmux;'), false);
  });
});

describe('copyToClipboard', () => {
  test('writes the OSC 52 sequence to the terminal and reports the byte count', () => {
    const writes: string[] = [];
    const result = copyToClipboard({ write: (d) => writes.push(d) }, 'hi');
    assert.deepEqual(writes, [osc52ClipboardSequence('hi')]);
    assert.deepEqual(result, { ok: true, bytes: 2 });
  });

  test('accepts a payload exactly at the byte limit', () => {
    const writes: string[] = [];
    const text = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES);
    const result = copyToClipboard({ write: (d) => writes.push(d) }, text);
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
  });

  test('refuses an oversized payload and writes nothing', () => {
    // Past a terminal's OSC-string buffer the sequence is silently truncated,
    // not echoed, so an oversized copy must fail readably rather than emit.
    const writes: string[] = [];
    const text = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1);
    const result = copyToClipboard({ write: (d) => writes.push(d) }, text);
    assert.deepEqual(result, {
      ok: false,
      reason: 'too_large',
      bytes: MAX_CLIPBOARD_TEXT_BYTES + 1,
      limit: MAX_CLIPBOARD_TEXT_BYTES,
    });
    assert.deepEqual(writes, []);
  });

  test('measures the limit in UTF-8 bytes, not JS string length', () => {
    // 2000 '€' is 2000 JS chars (under the limit) but 6000 UTF-8 bytes (over it),
    // so a length-based check would wrongly accept it.
    const writes: string[] = [];
    const text = '€'.repeat(2000);
    assert.ok(text.length <= MAX_CLIPBOARD_TEXT_BYTES);
    assert.ok(Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES);
    const result = copyToClipboard({ write: (d) => writes.push(d) }, text);
    assert.equal(result.ok, false);
    assert.deepEqual(writes, []);
  });
});
