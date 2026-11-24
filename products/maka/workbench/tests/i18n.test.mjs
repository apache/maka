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
});
