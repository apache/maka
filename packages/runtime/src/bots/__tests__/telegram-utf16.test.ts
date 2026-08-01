import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { utf16Len, prefixWithinUtf16, splitForTelegram } = __TEST__;

describe('Telegram UTF-16 limits', () => {
  it('counts BMP and astral-plane characters in UTF-16 code units', () => {
    for (const [text, expected] of [
      ['', 0],
      ['hello', 5],
      ['你好世界', 4],
      ['😀', 2],
      ['a😀b', 4],
      ['\u{20000}', 2],
    ] as const) {
      assert.equal(utf16Len(text), expected, text);
    }
  });

  it('truncates prefixes without splitting surrogate pairs', () => {
    for (const [text, limit, expected] of [
      ['hello', 100, 'hello'],
      ['abcdef', 3, 'abc'],
      ['a😀', 2, 'a'],
      ['😀😀😀😀', 5, '😀😀'],
    ] as const) {
      assert.equal(prefixWithinUtf16(text, limit), expected, text);
    }
  });

  it('splits oversized text within limits, on code points, and preferably at newlines', () => {
    assert.deepEqual(splitForTelegram('hello world'), ['hello world']);

    const chunks = splitForTelegram('a'.repeat(8500));
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0]!, /^\[1\/\d+\]\n/);
    assert.match(chunks.at(-1)!, /^\[\d+\/\d+\]\n/);
    for (const chunk of chunks) assert.ok(utf16Len(chunk) <= 4000);

    for (const chunk of splitForTelegram('😀'.repeat(4000))) {
      const body = chunk.replace(/^\[\d+\/\d+\]\n/, '');
      for (let index = 0; index < body.length; ) {
        const codePoint = body.codePointAt(index)!;
        assert.ok(codePoint >= 0x20 || codePoint === 0x0a);
        index += codePoint > 0xffff ? 2 : 1;
      }
    }

    const lineChunks = splitForTelegram('line\n'.repeat(900));
    const firstBody = lineChunks[0]!.replace(/^\[\d+\/\d+\]\n/, '');
    assert.ok(firstBody.endsWith('line') || firstBody.endsWith('line\n'));
  });
});
