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
import { registerHooks } from 'node:module';
import test from 'node:test';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/packages/plugin-sdk/src/')) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  },
});

const {
  SUPPORTED_LOCALES,
  createI18n,
  extractIcuParams,
  formatMessage,
  negotiateLocale,
  normalizeLocaleTag,
  pluralCategory,
  resolveDisplayText,
} = await import(new URL('../../../../packages/plugin-sdk/src/i18n.ts', import.meta.url));
hooks.deregister();

test('negotiates all 12 built-in LTR locales with script-aware CJK & compliance autonyms', () => {
  assert.equal(SUPPORTED_LOCALES.length, 12);
  const byTag = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.tag, l]));
  assert.equal(byTag['zh-TW'].autonym, '繁體中文（中國台灣）');
  assert.equal(byTag['zh-HK'].autonym, '繁體中文（中國香港）');

  assert.equal(normalizeLocaleTag('zh_hant_hk.UTF-8'), 'zh-Hant-HK');
  assert.equal(normalizeLocaleTag('pt_br@currency=BRL'), 'pt-BR');
  assert.equal(negotiateLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(negotiateLocale('zh-Hant-TW'), 'zh-TW');
  assert.equal(negotiateLocale('zh-Hant-HK'), 'zh-HK');
  assert.equal(negotiateLocale('zh-MO'), 'zh-HK');
  assert.equal(negotiateLocale('yue-Hant-HK'), 'zh-HK');
  assert.equal(negotiateLocale('ja-JP'), 'ja');
  assert.equal(negotiateLocale('ko-KR'), 'ko');
  assert.equal(negotiateLocale('es-MX'), 'es');
  assert.equal(negotiateLocale('fr-CA'), 'fr');
  assert.equal(negotiateLocale('de-AT'), 'de');
  assert.equal(negotiateLocale('pt-PT'), 'pt-BR');
  assert.equal(negotiateLocale('ru-RU'), 'ru');
  assert.equal(negotiateLocale('it-CH'), 'it');
  assert.equal(negotiateLocale(['ar-SA', 'ja-JP', 'en-US']), 'ja');
});

test('CLDR plural rules and ICU formatting cover CJK, French, and 4-form Russian', () => {
  assert.equal(pluralCategory('zh-HK', 1), 'other');
  assert.equal(pluralCategory('ja', 1), 'other');
  assert.equal(pluralCategory('fr', 0), 'one');
  assert.equal(pluralCategory('fr', 1), 'one');
  assert.equal(pluralCategory('fr', 2), 'other');
  assert.equal(pluralCategory('ru', 1), 'one');
  assert.equal(pluralCategory('ru', 2), 'few');
  assert.equal(pluralCategory('ru', 5), 'many');
  assert.equal(pluralCategory('ru', 11), 'many');
  assert.equal(pluralCategory('ru', 21), 'one');

  const ruTpl =
    '{count, plural, one {# инструмент} few {# инструмента} many {# инструментов} other {# инструментов}}';
  assert.equal(formatMessage(ruTpl, 'ru', { count: 1 }), '1 инструмент');
  assert.equal(formatMessage(ruTpl, 'ru', { count: 3 }), '3 инструмента');
  assert.equal(formatMessage(ruTpl, 'ru', { count: 5 }), '5 инструментов');
  assert.equal(formatMessage(ruTpl, 'ru', { count: 21 }), '21 инструмент');
  assert.equal(formatMessage("Literal '{raw}' it''s ok", 'en', {}), "Literal {raw} it's ok");

  // Numeric placeholders and '#' follow locale grouping/decimals while strings stay verbatim.
  assert.equal(formatMessage('{count} files', 'en', { count: 1_234 }), '1,234 files');
  assert.equal(formatMessage('{count} files', 'de', { count: 1_234 }), '1.234 files');
  assert.equal(formatMessage('{count} files', 'fr', { count: 1_234 }), '1\u202f234 files');
  assert.equal(formatMessage('{count} files', 'zh-CN', { count: 1_234 }), '1,234 files');
  const pluralEn = '{count, plural, one {# item} other {# items}}';
  assert.equal(formatMessage(pluralEn, 'en', { count: 1_234 }), '1,234 items');
  assert.equal(formatMessage(pluralEn, 'de', { count: 1_234 }), '1.234 items');
  assert.equal(formatMessage(pluralEn, 'fr', { count: 1_234 }), '1\u202f234 items');
  assert.equal(formatMessage(pluralEn, 'zh-CN', { count: 1_234 }), '1,234 items');
  assert.equal(
    formatMessage('Pull request #{number}', 'en', { number: String(7251) }),
    'Pull request #7251',
  );
  assert.equal(
    formatMessage('{width} × {height}', 'en', { width: String(1920), height: String(1080) }),
    '1920 × 1080',
  );
  assert.equal(formatMessage('{n} items', 'en', { n: -0 }), '0 items');
  assert.equal(formatMessage('{n} items', 'en', { n: Number.NaN }), 'NaN items');
  assert.equal(formatMessage('{n} items', 'en', { n: Number.POSITIVE_INFINITY }), 'Infinity items');
});

test('zh-HK overlay inherits from zh-TW and never falls back to zh-CN simplified', () => {
  const i18n = createI18n({
    en: { folder: 'Folder', save: 'Save' },
    'zh-CN': { folder: '文件夹', save: '保存' },
    'zh-TW': { folder: '資料夾', save: '儲存' },
    'zh-HK': { folder: '檔案夾' },
  });
  assert.equal(i18n.t('zh-HK', 'folder'), '檔案夾');
  assert.equal(i18n.t('zh-HK', 'save'), '儲存');
  assert.equal(i18n.t('zh-TW', 'folder'), '資料夾');

  const display = {
    fallback: 'English',
    translations: { 'zh-CN': '简体', 'zh-TW': '繁體' },
  };
  assert.equal(resolveDisplayText(display, 'zh-HK'), '繁體');
  assert.equal(
    resolveDisplayText(
      { fallback: 'English', translations: { zh: '简体', 'zh-CN': '简体' } },
      'zh-HK',
    ),
    'English',
  );
  // Primary language subtag wins before falling back to en.
  assert.equal(
    resolveDisplayText(
      { fallback: 'English', translations: { en: 'English', pt: 'Português' } },
      'pt-BR',
    ),
    'Português',
  );
  assert.equal(
    resolveDisplayText({ fallback: 'English', translations: { 'zh-tw': '繁體' } }, 'zh-HK'),
    '繁體',
  );
});

test('BCP 47 extensions, fractional/million plurals, and ICU edge cases', () => {
  assert.equal(normalizeLocaleTag('en_us-u-hc-h23'), 'en-US-u-hc-h23');
  assert.equal(normalizeLocaleTag('zh_cn-x-hk'), 'zh-CN-x-hk');
  assert.equal(negotiateLocale('zh-CN-x-hk'), 'zh-CN');

  // CLDR 45+ million many & fractional / non-finite handling
  assert.equal(pluralCategory('pt-PT', 0), 'other');
  assert.equal(pluralCategory('pt-BR', 0), 'one');
  assert.equal(formatMessage('{n, plural, one {one} other {other}}', 'pt-PT', { n: 0 }), 'other');
  assert.equal(formatMessage('{n, plural, one {one} other {other}}', 'pt-BR', { n: 0 }), 'one');
  assert.equal(pluralCategory('es', 1_000_000), 'many');
  assert.equal(pluralCategory('fr', 1_000_000), 'many');
  assert.equal(pluralCategory('it', 1_000_000), 'many');
  assert.equal(pluralCategory('pt-BR', 1_000_000), 'many');
  assert.equal(pluralCategory('en', 1.5), 'other');
  assert.equal(pluralCategory('fr', 1.5), 'one');
  assert.equal(pluralCategory('ru', 1.5), 'other');
  assert.equal(pluralCategory('en', Number.NaN), 'other');
  assert.equal(pluralCategory('ru', Number.POSITIVE_INFINITY), 'other');

  // Doubled apostrophes unescape even without values
  const i18n = createI18n({ en: { apostrophe: "It''s ready" } });
  assert.equal(i18n.t('en', 'apostrophe'), "It's ready");

  // '#' only opens ICU quoting inside plural blocks; nested select inherits activeCount
  assert.equal(formatMessage("Issue '#12'", 'en'), "Issue '#12'");
  assert.equal(
    formatMessage("{n, plural, one {'#12' # item} other {'#12' # items}}", 'en', { n: 2 }),
    '#12 2 items',
  );
  assert.equal(
    formatMessage('{n, plural, other {{kind, select, file {# files} other {# items}}}}', 'en', {
      n: 3,
      kind: 'file',
    }),
    '3 files',
  );

  // Malformed or unsupported brace expressions stay intact verbatim at runtime
  assert.equal(formatMessage('{action: "click"}', 'en', {}), '{action: "click"}');
  assert.equal(formatMessage('Total: {n, number}', 'en', { n: 42 }), 'Total: {n, number}');
  assert.equal(formatMessage("Unclosed '{foo}", 'en', {}), "Unclosed '{foo}");

  // Strict catalog validator rejects malformed/conflicting/unclosed ICU patterns
  for (const invalid of [
    '{count, plural, other {# items}',
    '{kind, select, a {A} other {B}',
    "Use '{foo} {bar}",
    '{x, select, a {A} other {B}} {x, plural, other {#}}',
    '{x, plural, other {#}} {x, select, a {A} other {B}}',
    '{count, plural, one {a} one {b} other {c}}',
    '{kind, select, a {A} a {B} other {C}}',
    'Hello } world',
    'Hello {1} world',
  ]) {
    assert.throws(() => extractIcuParams(invalid), 'expected strict error for: ' + invalid);
  }
  assert.deepEqual(extractIcuParams("Issue '#12 failed: {reason}"), [['reason', 'text']]);
  assert.deepEqual(
    extractIcuParams('{count, plural, other {{kind, select, a {# items} other {# things}}}}'),
    [
      ['count', 'count'],
      ['kind', 'text'],
    ],
  );
});

test('importing workbench locale.ts never mutates nsh/i18n and resolves UI locales cleanly', async () => {
  let setLocaleCalls = 0;
  const appUrl = new URL('../app/', import.meta.url);
  const localeHooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'nsh') {
        return {
          url: `data:text/javascript,${encodeURIComponent(`
            export function signal(initial) {
              let value = initial;
              const fn = () => value;
              fn.set = (v) => { value = v; };
              return fn;
            }
          `)}`,
          shortCircuit: true,
        };
      }
      if (specifier === 'maka/host') {
        return {
          url: `data:text/javascript,${encodeURIComponent(
            "export const host = { systemLocale: 'en-US' };",
          )}`,
          shortCircuit: true,
        };
      }
      if (specifier === 'nsh/i18n') {
        return {
          url: `data:text/javascript,${encodeURIComponent(
            'export function setLocale() { globalThis.__testSetLocaleCount = (globalThis.__testSetLocaleCount ?? 0) + 1; }',
          )}`,
          shortCircuit: true,
        };
      }
      if (
        specifier.endsWith('.js') &&
        (context.parentURL?.includes('/packages/plugin-sdk/src/') ||
          specifier.includes('/packages/plugin-sdk/src/'))
      ) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      if (
        context.parentURL?.startsWith(appUrl.href) &&
        specifier.startsWith('.') &&
        !/\.\w+$/.test(specifier)
      ) {
        return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  try {
    globalThis.__testSetLocaleCount = 0;
    const { currentLocale, resolveUiLocale } = await import(new URL('locale.ts', appUrl));
    const { formatCompactCount, formatCount, formatDecimal } = await import(
      new URL('numberFormat.ts', appUrl)
    );
    setLocaleCalls = globalThis.__testSetLocaleCount;
    assert.equal(setLocaleCalls, 0);
    assert.equal(resolveUiLocale('yue-Hant-HK'), 'zh-HK');
    assert.equal(resolveUiLocale('zh-MO'), 'zh-HK');
    assert.equal(resolveUiLocale('zh-Hant'), 'zh-TW');
    assert.equal(resolveUiLocale('en-GB'), 'en-GB');
    assert.equal(resolveUiLocale('ar-SA'), 'en');

    currentLocale.set('en');
    assert.equal(formatCount(1_234_567), '1,234,567');
    assert.equal(formatCompactCount(1_500), '1.5k');
    assert.equal(formatDecimal(1_234.5, 1, 1), '1,234.5');
    assert.equal(formatDecimal(-0, 2), '0');
    assert.equal(formatDecimal(Number.NaN, 2), 'NaN');
    currentLocale.set('de');
    assert.equal(formatCount(1_234_567), '1.234.567');
    assert.match(formatCompactCount(1_500_000), /Mio./);
    assert.equal(formatDecimal(1_234.5, 1, 1), '1.234,5');
  } finally {
    delete globalThis.__testSetLocaleCount;
    delete globalThis[Symbol.for('maka.workbench.i18n')];
    localeHooks.deregister();
  }
});
