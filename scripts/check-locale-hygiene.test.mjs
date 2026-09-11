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
import test from 'node:test';
import { compare, scanSource } from './check-locale-hygiene.mjs';

function rules(source) {
  return scanSource(source).map(({ rule }) => rule);
}

test('flags locale literal comparisons in either quote style', () => {
  assert.deepEqual(rules("const label = locale === 'zh-CN' ? '启用' : 'Enable';"), [
    'locale-literal-compare',
  ]);
  assert.deepEqual(rules("if (input.locale !== 'en') return zh;"), ['locale-literal-compare']);
  assert.deepEqual(rules("const zh = locale.startsWith('zh');"), ['locale-literal-compare']);
  assert.deepEqual(rules('if (locale === "en") return en;'), ['locale-literal-compare']);
});

test('counts every match on a line, not the line', () => {
  assert.deepEqual(
    rules(
      "const closeLabel = input.locale === 'zh-CN' ? '关闭' : input.locale === 'zh-TW' ? '關閉' : 'Close';",
    ),
    ['locale-literal-compare', 'locale-literal-compare'],
  );
});

test('flags silent locale defaults and payload sniffing', () => {
  assert.deepEqual(
    rules("export function f(error: unknown, locale: UiLocale = 'zh-CN'): string {"),
    ['silent-locale-default'],
  );
  assert.deepEqual(rules('  locale: UiLocale = "en",'), ['silent-locale-default']);
  assert.deepEqual(rules('if (/[\\u4e00-\\u9fff]/.test(raw)) return raw;'), ['cjk-sniff']);
  assert.deepEqual(rules('if (/[\\u4E00-\\u9FFF]/.test(raw)) return raw;'), ['cjk-sniff']);
  assert.deepEqual(rules("  '凭据已保存': '憑證已儲存',"), ['string-keyed-translation']);
  assert.deepEqual(rules('  "凭据已保存": "憑證已儲存",'), ['string-keyed-translation']);
});

test('ignores catalog indexing', () => {
  assert.deepEqual(
    rules(
      "const copy = COPY[locale]; const zhCn = { 'zh-CN': '启用', 'zh-TW': '啟用', en: 'Enable' };",
    ),
    [],
  );
  assert.deepEqual(rules('export function f(error: unknown, locale: UiLocale): string {'), []);
  assert.deepEqual(rules("  let locale: UiLocale = 'en';"), []);
});

test('compare fails only on growth per rule', () => {
  const one = "locale === 'zh-CN'";
  const two = `${one}\n${one}`;
  assert.deepEqual(compare('a.ts', one, one), []);
  assert.deepEqual(compare('a.ts', two, one), []);
  assert.deepEqual(
    compare('a.ts', one, `${two}\n/[\\u4e00-\\u9fff]/`).map(
      ({ rule, base, current }) => `${rule} ${base}->${current}`,
    ),
    ['locale-literal-compare 1->2', 'cjk-sniff 0->1'],
  );
});
