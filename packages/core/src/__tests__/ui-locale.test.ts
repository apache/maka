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
import { describe, it } from 'node:test';
import {
  UI_LOCALES,
  defineUiMessageCatalog,
  formatUiMessage,
  isUiLocale,
  isUiLocalePreference,
  normalizeUiLocalePreference,
  resolveSystemUiLocale,
  resolveUiLocale,
  resolveUiMessageCatalog,
  uiLocaleToIntlLocale,
} from '../ui-locale.js';

describe('UI locale', () => {
  it('accepts only the supported resolved locales and preferences', () => {
    assert.equal(['zh-CN', 'zh-TW', 'en'].every(isUiLocale), true);
    assert.equal(isUiLocale('zh'), false);
    assert.equal(['auto', 'zh-CN', 'zh-TW', 'en'].every(isUiLocalePreference), true);
  });

  it('normalizes the legacy persisted preference without widening the locale contract', () => {
    assert.equal(normalizeUiLocalePreference('zh'), 'zh-CN');
    assert.equal(normalizeUiLocalePreference('zh-TW'), 'zh-TW');
    assert.equal(normalizeUiLocalePreference('unsupported'), 'auto');
  });

  for (const [languages, expected] of [
    [['zh-CN'], 'zh-CN'],
    [['zh-SG'], 'zh-CN'],
    [['zh-Hans'], 'zh-CN'],
    [['zh-TW'], 'zh-TW'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh_MO'], 'zh-TW'],
    [['zh_TW.UTF-8'], 'zh-TW'],
    [['fr-FR', 'en-US'], 'en'],
    [[], 'en'],
  ] as const) {
    it(`resolves system languages ${languages.join(',')} to ${expected}`, () => {
      assert.equal(resolveSystemUiLocale(languages), expected);
    });
  }

  it('resolves explicit preferences and overrides before the system locale', () => {
    assert.equal(resolveUiLocale('auto', 'zh-TW'), 'zh-TW');
    assert.equal(resolveUiLocale('zh-CN', 'zh-TW'), 'zh-CN');
    assert.equal(resolveUiLocale('zh-CN', 'zh-CN', 'en'), 'en');
  });

  it('keeps every locale guard and formatter in step with UI_LOCALES', () => {
    for (const locale of UI_LOCALES) {
      assert.ok(isUiLocale(locale), locale);
      assert.equal(resolveSystemUiLocale([locale]), locale);
      assert.equal(uiLocaleToIntlLocale(locale), locale);
    }
    const intlLocales = UI_LOCALES.map(uiLocaleToIntlLocale);
    assert.equal(new Set(intlLocales).size, UI_LOCALES.length);
  });
});

describe('UI message catalogs', () => {
  it('falls back to complete English copy for missing translations', () => {
    const catalog = defineUiMessageCatalog<{
      title: string;
      detail: { ready: string; waiting: string };
    }>()({
      en: { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      'zh-CN': { title: '状态', detail: { ready: '就绪' } },
    });

    assert.deepEqual(resolveUiMessageCatalog(catalog), {
      en: { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      'zh-CN': { title: '状态', detail: { ready: '就绪', waiting: 'Waiting' } },
      'zh-TW': { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
    });
  });

  it('uses locale-aware ICU plural rules', () => {
    const template = '{count, plural, one {# tool} other {# tools}}';

    assert.equal(formatUiMessage(template, { count: 1 }, 'en'), '1 tool');
    assert.equal(formatUiMessage(template, { count: 3 }, 'en'), '3 tools');
  });

  it('fails soft for missing or inherited interpolation values', () => {
    assert.equal(formatUiMessage('Hello {name}', {}, 'en'), 'Hello {name}');
    assert.equal(formatUiMessage('{constructor}', {}, 'en'), '{constructor}');
  });
});
