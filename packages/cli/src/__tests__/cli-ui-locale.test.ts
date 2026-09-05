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
import { describe, test } from 'node:test';
import { resolveCliUiLocale } from '../cli-ui-locale.js';

describe('CLI TUI locale authority', () => {
  test('an explicit MAKA_LOCALE wins over the POSIX locale', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'zh-CN', LC_ALL: 'en_US.UTF-8' }), {
      ok: true,
      locale: 'zh-CN',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'ZH-TW', LC_ALL: 'zh_CN.UTF-8' }), {
      ok: true,
      locale: 'zh-TW',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'EN', LANG: 'zh_CN.UTF-8' }), {
      ok: true,
      locale: 'en',
    });
  });

  test('preserves legacy and POSIX-style Chinese aliases', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'zh' }), {
      ok: true,
      locale: 'zh-CN',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'zh_CN' }), {
      ok: true,
      locale: 'zh-CN',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'zh_TW' }), {
      ok: true,
      locale: 'zh-TW',
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
      locale: 'zh-CN',
    });
    assert.deepEqual(resolveCliUiLocale({ LANG: 'en_US.UTF-8' }), {
      ok: true,
      locale: 'en',
    });
    assert.deepEqual(resolveCliUiLocale({ LANG: 'zh_TW.UTF-8' }), {
      ok: true,
      locale: 'zh-TW',
    });
    assert.deepEqual(resolveCliUiLocale({}), { ok: true, locale: 'en' });
  });

  test('treats empty and whitespace-only MAKA_LOCALE as auto', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: '', LANG: 'zh_TW.UTF-8' }), {
      ok: true,
      locale: 'zh-TW',
    });
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: '  \t ', LANG: 'zh_CN.UTF-8' }), {
      ok: true,
      locale: 'zh-CN',
    });
  });

  test('rejects an unsupported explicit preference with a configuration error', () => {
    assert.deepEqual(resolveCliUiLocale({ MAKA_LOCALE: 'fr' }), {
      ok: false,
      message: 'Invalid MAKA_LOCALE "fr". Expected zh-CN, zh-TW, en, or auto.',
    });
  });
});
