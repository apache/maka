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

import { effect, signal } from 'nsh';
import { setLocale as setNshLocale } from 'nsh/i18n';
import { host as nativeHost } from 'maka/host';
import {
  createI18n,
  negotiateLocale,
  resolveDisplayText,
  resolveLocale,
  resolveLocalizedPresentation,
  type DisplayText,
  type LanguagePreference,
} from '../../../../packages/plugin-sdk/src/index.js';
import en from '../locales/en.json' with { type: 'json' };
import zhCN from '../locales/zh-CN.json' with { type: 'json' };
import zhTW from '../locales/zh-TW.json' with { type: 'json' };
import zhHK from '../locales/zh-HK.json' with { type: 'json' };
import ja from '../locales/ja.json' with { type: 'json' };
import ko from '../locales/ko.json' with { type: 'json' };
import es from '../locales/es.json' with { type: 'json' };
import fr from '../locales/fr.json' with { type: 'json' };
import de from '../locales/de.json' with { type: 'json' };
import ptBR from '../locales/pt-BR.json' with { type: 'json' };
import ru from '../locales/ru.json' with { type: 'json' };
import it from '../locales/it.json' with { type: 'json' };

export type MessageKey = keyof typeof en;

const catalog = createI18n<MessageKey>({
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

const nativeLocale = nativeHost.systemLocale;
export const currentLocale = signal(resolveLocale('auto', nativeLocale));
let observedRevision = -1;

// Keep NSH's native environment (Intl, system menus, and CoreText/DirectWrite/Pango
// CJK glyph selection) synchronized with the active workbench locale.
function syncNshLocale(locale: string) {
  try {
    setNshLocale(locale);
  } catch {
    // Headless unit test stubs may omit nsh/i18n runtime bindings.
  }
}

syncNshLocale(currentLocale());
effect(() => {
  syncNshLocale(currentLocale());
});

/** Host preferences are the authority; an older startup read cannot undo a saved change. */
export function applyLanguagePreference(
  preference: LanguagePreference,
  revision: number,
  resolvedLanguage?: string,
) {
  if (revision < observedRevision) return;
  observedRevision = revision;
  if (preference !== 'auto') {
    currentLocale.set(resolveLocale(preference, nativeLocale));
    return;
  }
  const local = resolveLocale('auto', nativeLocale);
  if (resolvedLanguage && negotiateLocale(local) !== negotiateLocale(resolvedLanguage)) {
    currentLocale.set(resolvedLanguage);
  } else {
    currentLocale.set(local);
  }
}

/** Render selects one immutable catalog and formats ICU placeholders/plurals for the active locale. */
export function tr(key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
  return catalog.t(currentLocale(), key, values);
}

/** Merge stable ASCII shortcuts with localized search keywords for the active locale. */
export function localizedKeywords(base: readonly string[], key: MessageKey): string[] {
  const extra = tr(key)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...base, ...extra])];
}

export function messageTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A recorded chat message's local date and time in the compact transcript. */
export function messageDateTime(at: number): string {
  return new Date(at).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** A plugin's name and description in the interface's language, as its manifest translates them. */
export function localizedPresentation<T extends { displayName: string; description: string }>(
  presentation: T & { localizations?: { [locale: string]: T | undefined } },
): T {
  return resolveLocalizedPresentation(presentation, currentLocale());
}

/** Honor authored DisplayText translations; opaque custom titles keep their fallback. */
export function displayText(text: DisplayText): string {
  return resolveDisplayText(text, currentLocale());
}
