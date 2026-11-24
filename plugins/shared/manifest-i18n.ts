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

import {
  SUPPORTED_LOCALES,
  createI18n,
  type DisplayText,
  type SupportedLocaleTag,
} from '../../packages/plugin-sdk/src/index.js';
import en from './manifest-locales/en.json' with { type: 'json' };
import zhCN from './manifest-locales/zh-CN.json' with { type: 'json' };
import zhTW from './manifest-locales/zh-TW.json' with { type: 'json' };
import zhHK from './manifest-locales/zh-HK.json' with { type: 'json' };
import ja from './manifest-locales/ja.json' with { type: 'json' };
import ko from './manifest-locales/ko.json' with { type: 'json' };
import es from './manifest-locales/es.json' with { type: 'json' };
import fr from './manifest-locales/fr.json' with { type: 'json' };
import de from './manifest-locales/de.json' with { type: 'json' };
import ptBR from './manifest-locales/pt-BR.json' with { type: 'json' };
import ru from './manifest-locales/ru.json' with { type: 'json' };
import it from './manifest-locales/it.json' with { type: 'json' };

type ManifestKey = keyof typeof en;

const catalog = createI18n<ManifestKey>({
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  ja,
  ko,
  es,
  fr,
  de,
  'pt-BR': ptBR,
  ru,
  it,
});

const NON_DEFAULT_LOCALES: readonly Exclude<SupportedLocaleTag, 'en'>[] = SUPPORTED_LOCALES.filter(
  (
    entry,
  ): entry is (typeof SUPPORTED_LOCALES)[number] & {
    readonly tag: Exclude<SupportedLocaleTag, 'en'>;
  } => entry.tag !== 'en',
).map((entry) => entry.tag);

export function packageLocalizations(
  id: string,
): Record<string, { displayName: string; description: string }> {
  const nameKey = `pkg.${id}.displayName` as ManifestKey;
  const descKey = `pkg.${id}.description` as ManifestKey;
  const out: Record<string, { displayName: string; description: string }> = {};
  for (const tag of NON_DEFAULT_LOCALES) {
    out[tag] = {
      displayName: catalog.t(tag, nameKey),
      description: catalog.t(tag, descKey),
    };
  }
  return out;
}

export function localizedTitle(fallback: string): DisplayText {
  const key = `title.${fallback}` as ManifestKey;
  const translations: Record<string, string> = {};
  for (const tag of NON_DEFAULT_LOCALES) {
    translations[tag] = catalog.t(tag, key);
  }
  return { fallback, translations };
}

/** Populate all 12 built-in locales for a package manifest's localizations. */
export function localizePackage<T extends { id: string }>(manifest: T): T {
  return {
    ...manifest,
    localizations: packageLocalizations(manifest.id),
  };
}
