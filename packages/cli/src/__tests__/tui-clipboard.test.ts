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
import { copyToClipboard, osc52ClipboardSequence } from '../tui-clipboard.js';

describe('osc52ClipboardSequence', () => {
  test('wraps base64-encoded UTF-8 in the OSC 52 clipboard sequence', () => {
    const base64 = Buffer.from('héllo', 'utf8').toString('base64');
    assert.equal(osc52ClipboardSequence('héllo'), `\x1b]52;c;${base64}\x07`);
  });

  test('encodes an empty string as an empty payload', () => {
    assert.equal(osc52ClipboardSequence(''), '\x1b]52;c;\x07');
  });

  test('emits a bare sequence with no tmux DCS passthrough wrapper', () => {
    // tmux forwards bare OSC 52 with `set-clipboard on`; passthrough would need
    // `allow-passthrough on` (off by default) and is intentionally not used.
    const sequence = osc52ClipboardSequence('hi');
    assert.equal(sequence.startsWith('\x1b]52;'), true);
    assert.equal(sequence.includes('\x1bPtmux;'), false);
  });
});

describe('copyToClipboard', () => {
  test('writes the OSC 52 sequence to the terminal', () => {
    const writes: string[] = [];
    copyToClipboard({ write: (d) => writes.push(d) }, 'hi');
    assert.deepEqual(writes, [osc52ClipboardSequence('hi')]);
  });
});
