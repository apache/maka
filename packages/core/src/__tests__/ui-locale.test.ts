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
    assert.equal(['zh-CN', 'zh-TW', 'ko', 'en'].every(isUiLocale), true);
    assert.equal(isUiLocale('zh'), false);
    assert.equal(isUiLocale('ko-KR'), false);
    assert.equal(['auto', 'zh-CN', 'zh-TW', 'ko', 'en'].every(isUiLocalePreference), true);
  });

  it('normalizes the legacy persisted preference without widening the locale contract', () => {
    assert.equal(normalizeUiLocalePreference('zh'), 'zh-CN');
    assert.equal(normalizeUiLocalePreference('zh-TW'), 'zh-TW');
    assert.equal(normalizeUiLocalePreference('ko'), 'ko');
    assert.equal(normalizeUiLocalePreference('auto'), 'auto');
    assert.equal(normalizeUiLocalePreference('ko-KR'), 'auto');
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
    [['ko'], 'ko'],
    [['ko-KR'], 'ko'],
    [['ko_KR'], 'ko'],
    [['KO-Kr'], 'ko'],
    [['ko_KR.UTF-8'], 'ko'],
    [['ko-Kore-KR'], 'ko'],
    [['ko', 'ko-KR', 'en'], 'ko'],
    [['en', 'ko'], 'en'],
    [['ko', 'en'], 'ko'],
    [['fr-FR', 'ko-KR'], 'ko'],
    [['kok-IN'], 'en'],
    [['fr-FR', 'en-US'], 'en'],
    [[], 'en'],
  ] as const) {
    it(`resolves system languages ${languages.join(',')} to ${expected}`, () => {
      assert.equal(resolveSystemUiLocale(languages), expected);
    });
  }

  it('resolves explicit preferences and overrides before the system locale', () => {
    assert.equal(resolveUiLocale('auto', 'zh-TW'), 'zh-TW');
    assert.equal(resolveUiLocale('auto', 'ko'), 'ko');
    assert.equal(resolveUiLocale('zh-CN', 'zh-TW'), 'zh-CN');
    assert.equal(resolveUiLocale('ko', 'en'), 'ko');
    assert.equal(resolveUiLocale('en', 'ko'), 'en');
    assert.equal(resolveUiLocale('zh-CN', 'zh-CN', 'en'), 'en');
    assert.equal(resolveUiLocale('auto', 'ko', 'zh-TW'), 'zh-TW');
  });

  it('keeps every locale guard and formatter in step with UI_LOCALES', () => {
    // `ko` is the first locale whose Intl tag is not its own name, so this can
    // no longer assert identity. Pinning the table keeps a locale added later
    // from silently reaching `Intl` without a deliberate tag.
    const intlTags: Record<(typeof UI_LOCALES)[number], string> = {
      'zh-CN': 'zh-CN',
      'zh-TW': 'zh-TW',
      ko: 'ko-KR',
      en: 'en',
    };
    for (const locale of UI_LOCALES) {
      assert.ok(isUiLocale(locale), locale);
      assert.equal(resolveSystemUiLocale([locale]), locale);
      assert.equal(uiLocaleToIntlLocale(locale), intlTags[locale]);
    }
    const intlLocales = UI_LOCALES.map(uiLocaleToIntlLocale);
    assert.equal(new Set(intlLocales).size, UI_LOCALES.length);
    for (const tag of intlLocales) {
      assert.equal(new Intl.Locale(tag).baseName, tag, tag);
    }
  });

  it('maps ko onto the region-qualified Intl tag', () => {
    assert.equal(uiLocaleToIntlLocale('ko'), 'ko-KR');
    assert.equal(uiLocaleToIntlLocale('en'), 'en');
    assert.equal(uiLocaleToIntlLocale('zh-CN'), 'zh-CN');
    assert.equal(uiLocaleToIntlLocale('zh-TW'), 'zh-TW');
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
      ko: { title: '상태', detail: { ready: '준비됨' } },
    });

    assert.deepEqual(resolveUiMessageCatalog(catalog), {
      en: { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      'zh-CN': { title: '状态', detail: { ready: '就绪', waiting: 'Waiting' } },
      'zh-TW': { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      ko: { title: '상태', detail: { ready: '준비됨', waiting: 'Waiting' } },
    });
  });

  it('uses locale-aware ICU plural rules', () => {
    const template = '{count, plural, one {# tool} other {# tools}}';

    assert.equal(formatUiMessage(template, { count: 1 }, 'en'), '1 tool');
    assert.equal(formatUiMessage(template, { count: 3 }, 'en'), '3 tools');

    // Korean has one plural form; both counts take the `other` branch.
    const koTemplate = '{count, plural, other {도구 #개}}';
    assert.equal(formatUiMessage(koTemplate, { count: 1 }, 'ko'), '도구 1개');
    assert.equal(formatUiMessage(koTemplate, { count: 3 }, 'ko'), '도구 3개');
  });

  it('fails soft for missing or inherited interpolation values', () => {
    assert.equal(formatUiMessage('Hello {name}', {}, 'en'), 'Hello {name}');
    assert.equal(formatUiMessage('{constructor}', {}, 'en'), '{constructor}');
  });
});
