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
import { describe, it } from 'node:test';

import { __TEST__ } from '../telegram-bridge.js';

const { utf16Len, prefixWithinUtf16, splitForTelegram } = __TEST__;

describe('Telegram UTF-16 limits', () => {
  it('truncates prefixes without splitting surrogate pairs', () => {
    for (const [text, limit, expected] of [
      ['hello', 100, 'hello'],
      ['abcdef', 3, 'abc'],
      ['a😀', 2, 'a'],
    ] as const) {
      assert.equal(prefixWithinUtf16(text, limit), expected, text);
    }
  });

  it('splits oversized text within limits, on code points, and preferably at newlines', () => {
    assert.deepEqual(splitForTelegram('hello world'), ['hello world']);

    const asciiInput = 'a'.repeat(8500);
    const chunks = splitForTelegram(asciiInput);
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0]!, /^\[1\/\d+\]\n/);
    assert.match(chunks.at(-1)!, /^\[\d+\/\d+\]\n/);
    for (const chunk of chunks) assert.ok(utf16Len(chunk) <= 4000);
    assert.equal(chunks.map((chunk) => chunk.replace(/^\[\d+\/\d+\]\n/, '')).join(''), asciiInput);

    const emojiInput = '😀'.repeat(4000);
    const emojiChunks = splitForTelegram(emojiInput);
    for (const chunk of emojiChunks) {
      const body = chunk.replace(/^\[\d+\/\d+\]\n/, '');
      for (let index = 0; index < body.length; ) {
        const codePoint = body.codePointAt(index)!;
        assert.ok(codePoint >= 0x20 || codePoint === 0x0a);
        index += codePoint > 0xffff ? 2 : 1;
      }
    }
    assert.equal(
      emojiChunks.map((chunk) => chunk.replace(/^\[\d+\/\d+\]\n/, '')).join(''),
      emojiInput,
    );

    const lineChunks = splitForTelegram('line\n'.repeat(900));
    const firstBody = lineChunks[0]!.replace(/^\[\d+\/\d+\]\n/, '');
    assert.ok(firstBody.endsWith('line') || firstBody.endsWith('line\n'));
  });
});
