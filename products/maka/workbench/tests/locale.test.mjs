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
import { readdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };`,
  'maka/host': `export const host = { systemLocale: 'ko-KR' };`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier in native)
      return {
        url: `data:text/javascript,${encodeURIComponent(native[specifier])}`,
        shortCircuit: true,
      };
    if (specifier.startsWith('.') && specifier.endsWith('.js'))
      return next(specifier.replace(/\.js$/, '.ts'), context);
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { applyLanguagePreference, displayText, tr } = await import(new URL('locale.ts', appRoot));
const { languageIndex } = await import(new URL('../../../../plugins/shared/locale.ts', appRoot));
const catalogs = {};
for (const file of await readdir(appRoot)) {
  const name = /^locale-(.+)\.ts$/.exec(file)?.[1];
  if (name) Object.assign(catalogs, { [name]: await import(new URL(file, appRoot)) });
}
hooks.deregister();

const messages = (module) => Object.entries(Object.values(module)[0]);
const placeholders = (text) => (text.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? []).sort();
let revision = 0;
const use = (preference) => applyLanguagePreference(preference, revision++);

test('a Korean system locale selects Korean copy and untranslated keys fall back to English', () => {
  use('auto');
  assert.equal(tr('Cancel'), '취소');
  assert.equal(tr('Suggested message: {message}', { message: '안녕' }), '추천 메시지: 안녕');
  const [untranslated] = Object.values(catalogs)
    .flatMap(messages)
    .find(([, message]) => message[3] === undefined);
  assert.equal(tr(untranslated), untranslated);
});

test('explicit languages and neighbouring language tags keep their existing copy', () => {
  use('zh-TW');
  assert.equal(tr('Cancel'), '取消');
  use('en');
  assert.equal(tr('Cancel'), 'Cancel');
  assert.equal(languageIndex('ko'), 3);
  assert.equal(languageIndex('kok-IN'), 0);
});

test('display text uses an authored Korean translation before its fallback', () => {
  use('auto');
  assert.equal(displayText({ fallback: 'General', translations: { ko: '일반' } }), '일반');
  assert.equal(displayText({ fallback: 'General', translations: { 'zh-CN': '常规' } }), 'General');
});

test('Korean copy keeps the placeholders of its English source', (t) => {
  for (const name of Object.keys(catalogs).sort()) {
    const entries = messages(catalogs[name]);
    const translated = entries.filter(([, message]) => message[3] !== undefined);
    for (const [key, message] of translated)
      assert.deepEqual(placeholders(message[3]), placeholders(message[0]), key);
    t.diagnostic(`ko ${name}: ${translated.length}/${entries.length} translated`);
  }
});
