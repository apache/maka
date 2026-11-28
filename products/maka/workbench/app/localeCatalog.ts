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

import { effect } from 'nsh';
import { setLocale as setNshLocale } from 'nsh/i18n';
import { workbenchLocales } from 'maka/host';
import {
  createI18n,
  type LocaleCatalogBundle,
  type PartialLocaleMessages,
  type SupportedLocaleTag,
} from '../../../../packages/plugin-sdk/src/index.js';
import en from '../locales/en.json' with { type: 'json' };
import { currentLocale, registerWorkbenchLocaleRuntime, type MessageKey } from './locale';

const NON_ENGLISH_LOCALES: readonly Exclude<SupportedLocaleTag, 'en'>[] = [
  'zh-CN',
  'zh-TW',
  'zh-HK',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'pt-BR',
  'ru',
  'it',
];

function createLazyBundle(): LocaleCatalogBundle<MessageKey> {
  const loaded = new Map<string, PartialLocaleMessages<MessageKey> | undefined>();
  const bundle: Record<string, unknown> = { en };
  for (const tag of NON_ENGLISH_LOCALES) {
    Object.defineProperty(bundle, tag, {
      enumerable: true,
      get(): PartialLocaleMessages<MessageKey> | undefined {
        if (loaded.has(tag)) return loaded.get(tag);
        const raw =
          typeof workbenchLocales?.read === 'function' ? workbenchLocales.read(tag) : null;
        const parsed = raw ? (JSON.parse(raw) as PartialLocaleMessages<MessageKey>) : undefined;
        loaded.set(tag, parsed);
        return parsed;
      },
    });
  }
  return bundle as LocaleCatalogBundle<MessageKey>;
}

const catalog = createI18n<MessageKey>(createLazyBundle());

/**
 * Install the single window-owned workbench translation catalog and bind NSH's
 * native locale (Intl, system menus, and CoreText/DirectWrite/Pango CJK glyph
 * shaping) to currentLocale. Call once from each standalone QuickJS window entry
 * point (never from dynamically imported plugin UI bundles).
 */
export function installWorkbenchLocaleCatalog() {
  registerWorkbenchLocaleRuntime(catalog.t, () => {
    let lastSynced: string | null = null;
    const sync = (locale: string) => {
      if (locale === lastSynced) return;
      lastSynced = locale;
      setNshLocale(locale);
    };
    sync(currentLocale());
    effect(() => {
      sync(currentLocale());
    });
  });
}
