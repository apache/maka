import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import {
  UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  isUiLocale,
  isUiLocalePreference,
  resolveSystemUiLocale,
  resolveUiLocale,
  uiLocaleToIntlLocale,
} from '../index.js';

it('validates and resolves the complete UI locale contract', () => {
  assert.deepEqual([...UI_LOCALES], ['zh', 'en']);
  assert.deepEqual([...UI_LOCALE_PREFERENCES], ['auto', 'zh', 'en']);
  for (const [value, expected] of [
    ['zh', true],
    ['en', true],
    ['auto', false],
    ['ja', false],
    [null, false],
  ] as const) {
    assert.equal(isUiLocale(value), expected);
  }
  for (const [value, expected] of [
    ['auto', true],
    ['zh', true],
    ['en', true],
    ['ja', false],
    [undefined, false],
  ] as const) {
    assert.equal(isUiLocalePreference(value), expected);
  }
  assert.equal(resolveSystemUiLocale(['zh-CN', 'en-US']), 'zh');
  assert.equal(resolveSystemUiLocale(['ja-JP', 'en-GB']), 'en');
  assert.equal(resolveSystemUiLocale(['fr-FR', 'de-DE']), 'en');
  assert.equal(resolveSystemUiLocale([]), 'en');
  assert.equal(resolveUiLocale('auto', 'zh'), 'zh');
  assert.equal(resolveUiLocale('auto', 'en'), 'en');
  assert.equal(resolveUiLocale('zh', 'en'), 'zh');
  assert.equal(resolveUiLocale('en', 'zh'), 'en');
  assert.equal(resolveUiLocale('auto', 'zh', 'en'), 'en');
  assert.equal(resolveUiLocale('en', 'en', 'zh'), 'zh');
  assert.equal(resolveUiLocale('zh', 'en', null), 'zh');
  assert.equal(uiLocaleToIntlLocale('zh'), 'zh-CN');
  assert.equal(uiLocaleToIntlLocale('en'), 'en');
});
