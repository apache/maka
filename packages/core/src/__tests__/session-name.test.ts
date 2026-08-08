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

  // #1404: the shared sanitizeUnicodeText pipeline (union coverage) now also
  // neutralizes the bidi marks (ALM/LRM/RLM) and invisible operators
  // (WJ/IT/IS/IP) that session-name used to miss. Written with \u escapes so
  // the source stays plain text. Locks the coverage so it can't silently drift
  // back out of sync with foreign-session.
  it('neutralizes the bidi marks and invisible operators the union pipeline adds', () => {
    const cases = [
      // bidi marks → space: U+061C ALM, U+200E LRM, U+200F RLM
      ['a\u061Cb\u200Ec\u200Fd', 'a b c d'],
      // invisible format chars → removed: U+2060 WJ, U+2061 IT, U+2062 IS, U+2063 IP, U+2064 IP
      ['x\u2060y\u2061z\u2062w\u2063v\u2064u', 'xyzwvu'],
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
