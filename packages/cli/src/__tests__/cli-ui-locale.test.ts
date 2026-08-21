import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveCliUiLocale } from '../cli-ui-locale.js';

describe('CLI TUI locale authority', () => {
  test('an explicit MAKA_LOCALE wins over the POSIX locale', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'zh', LC_ALL: 'en_US.UTF-8' }), {
      ok: true,
      locale: 'zh',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'EN', LANG: 'zh_CN.UTF-8' }), {
      ok: true,
      locale: 'en',
    });
  });

  test('auto honors POSIX locale authority order', () => {
    assert.deepEqual(
      resolveCliUiLocale({
        MAKA_LOCALE: 'auto',
        LC_ALL: 'C.UTF-8',
        LC_MESSAGES: 'zh_CN.UTF-8',
        LANG: 'zh_CN.UTF-8',
      }),
      { ok: true, locale: 'en' },
    );
    assert.deepEqual(resolveCliUiLocale({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }), {
      ok: true,
      locale: 'zh',
    });
    assert.deepEqual(resolveCliUiLocale({ LANG: 'en_US.UTF-8' }), {
      ok: true,
      locale: 'en',
    });
    assert.deepEqual(resolveCliUiLocale({}), { ok: true, locale: 'en' });
  });

  test('rejects an unsupported explicit preference with a configuration error', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'fr' }), {
      ok: false,
      message: 'Invalid MAKA_LOCALE "fr". Expected zh, en, or auto.',
    });
  });
});
