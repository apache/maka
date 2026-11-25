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

import { effect, locale, localeSettings, signal, Storage } from 'nsh';
import { setLocale as setNshLocale } from 'nsh/i18n';
import {
  negotiateSingleLocale,
  normalizeLocaleTag,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocaleTag,
} from '../../../../packages/plugin-sdk/src/index.js';
import { type MessageKey, translate } from './localeCatalog';

export type { MessageKey } from './localeCatalog';
export type LanguagePreference = 'auto' | SupportedLocaleTag;

const STORAGE_KEY = 'maka.ios.languagePreference';

export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'auto' || SUPPORTED_LOCALES.some(({ tag }) => tag === value);
}

function supportedDeviceLocale(raw: string): string | null {
  const tag = normalizeLocaleTag(raw);
  const supported = tag && negotiateSingleLocale(tag);
  if (!tag || !supported) return null;
  // Keep regional formatting, but give NSH the negotiated Chinese glyph variant.
  return supported.startsWith('zh-') ? supported : tag;
}

// Capture the platform's choice before setLocale changes the NSH environment.
const deviceLocale =
  localeSettings()
    .languages.map(supportedDeviceLocale)
    .find((tag) => tag !== null) ??
  supportedDeviceLocale(locale()) ??
  'en';
const preference = signal<LanguagePreference | null>(null);
const saving = signal(false);
const error = signal<string | null>(null);

export const languagePreference = () => preference();
export const languagePreferenceBusy = () => preference() === null || saving();
export const languagePreferenceError = () => error();
export const currentLocale = () => resolveLocale(preference(), deviceLocale);

export function tr(key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
  return translate(currentLocale(), key, values);
}

function reportStorageError(cause: unknown) {
  error.set(cause instanceof Error ? cause.message : String(cause));
}

export function installIosLocaleCatalog() {
  setNshLocale(currentLocale());
  effect(() => setNshLocale(currentLocale()));
  void Storage.getItem(STORAGE_KEY).then(
    (saved) => {
      if (saved === null) {
        preference.set('auto');
      } else if (isLanguagePreference(saved)) {
        preference.set(saved);
      } else {
        error.set(tr('Invalid stored language preference.'));
        preference.set('auto');
      }
    },
    (cause: unknown) => {
      reportStorageError(cause);
      preference.set('auto');
    },
  );
}

export async function saveLanguagePreference(next: LanguagePreference) {
  if (languagePreferenceBusy() || (next === preference() && error() === null)) return;
  saving.set(true);
  try {
    await Storage.setItem(STORAGE_KEY, next);
  } catch (cause) {
    reportStorageError(cause);
    return;
  } finally {
    saving.set(false);
  }
  preference.set(next);
  error.set(null);
}
