import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SESSION_NAME_MAX_CODE_POINTS, normalizeUserSessionName } from '../session-name.js';

describe('normalizeUserSessionName', () => {
  it('rejects invalid runtime values and empty sanitized names without throwing', () => {
    for (const value of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      Symbol('x'),
      () => '',
      BigInt(1),
      '',
      ' \t\n ',
      '\x00\x01\x02',
    ]) {
      assert.doesNotThrow(() => normalizeUserSessionName(value));
      assert.equal(normalizeUserSessionName(value).ok, false, String(value));
    }
  });

  it('preserves representative Unicode while trimming and collapsing whitespace', () => {
    const cases = [
      ['My chat session', 'My chat session'],
      ['帮我写 Python 🐍 代码', '帮我写 Python 🐍 代码'],
      ['  hello  ', 'hello'],
      ['foo\t\tbar\n baz', 'foo bar baz'],
    ] as const;
    for (const [input, value] of cases) {
      assert.deepEqual(normalizeUserSessionName(input), { ok: true, value });
    }
  });

  it('neutralizes control and bidi characters while removing zero-width characters', () => {
    const cases = [
      ['safe\x00name', 'safe name'],
      ['a\x7fb\x80c\x9fd', 'a b c d'],
      ['file‮txt.exe', 'file txt.exe'],
      ['pre⁦post', 'pre post'],
      ['clean​name', 'cleanname'],
      ['ad‍min', 'admin'],
    ] as const;
    for (const [input, value] of cases) {
      assert.deepEqual(normalizeUserSessionName(input), { ok: true, value });
    }
  });

  it('normalizes canonically equivalent text to NFC', () => {
    assert.deepEqual(normalizeUserSessionName('café'), { ok: true, value: 'café' });
  });

  it('caps by code points after sanitization without splitting surrogate pairs', () => {
    const exact = `${'a'.repeat(SESSION_NAME_MAX_CODE_POINTS - 1)}🦊`;
    assert.deepEqual(normalizeUserSessionName(exact), { ok: true, value: exact });

    const result = normalizeUserSessionName(`${exact}overflow`);
    assert.ok(result.ok);
    assert.equal(Array.from(result.value).length, SESSION_NAME_MAX_CODE_POINTS);
    assert.ok(result.value.endsWith('🦊'));

    assert.deepEqual(normalizeUserSessionName(`\x00\x00valid name`), {
      ok: true,
      value: 'valid name',
    });
  });
});
