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
  resolveSystemUiLocale,
  resolveUiMessageCatalog,
  uiLocaleToIntlLocale,
} from '../ui-locale.js';

describe('UI message catalogs', () => {
  it('falls back to complete English copy for missing translations', () => {
    const catalog = defineUiMessageCatalog<{
      title: string;
      detail: { ready: string; waiting: string };
    }>()({
      en: { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      zh: { title: '状态', detail: { ready: '就绪' } },
    });

    assert.deepEqual(resolveUiMessageCatalog(catalog), {
      en: { title: 'Status', detail: { ready: 'Ready', waiting: 'Waiting' } },
      zh: { title: '状态', detail: { ready: '就绪', waiting: 'Waiting' } },
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

  it('keeps every locale guard in step with UI_LOCALES', () => {
    for (const locale of UI_LOCALES) {
      assert.ok(isUiLocale(locale), locale);
      assert.equal(resolveSystemUiLocale([locale]), locale);
    }
    const intlLocales = UI_LOCALES.map(uiLocaleToIntlLocale);
    assert.equal(new Set(intlLocales).size, UI_LOCALES.length);
  });
});
