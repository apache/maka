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

/** Resolved locales supported by human-facing Maka clients. */
export const UI_LOCALES = ['zh', 'en'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** Shared UI preference vocabulary. A resolved locale is never persisted. */
export type UiLocalePreference = 'auto' | UiLocale;

export const UI_LOCALE_PREFERENCES = ['auto', ...UI_LOCALES] as const;

/** A catalog must carry copy for every supported resolved locale. */
export type UiCatalog<T> = Record<UiLocale, T>;

export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh' || value === 'en';
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === 'auto' || isUiLocale(value);
}

/** Resolve the first supported language in the operating system preference list. */
export function resolveSystemUiLocale(languages: readonly string[] | null | undefined): UiLocale {
  for (const language of languages ?? []) {
    const normalized = language.trim();
    if (/^zh(?:[-_]|$)/iu.test(normalized)) return 'zh';
    if (/^en(?:[-_]|$)/iu.test(normalized)) return 'en';
  }
  return 'en';
}

/**
 * Derive one resolved UI locale.
 *
 * Call-site overrides are deliberately highest priority. Explicit preferences
 * beat the system locale; `auto` follows the supported system locale without
 * persisting the derived value.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLocale: UiLocale,
  override?: UiLocale | null,
): UiLocale {
  if (override) return override;
  return preference === 'auto' ? systemLocale : preference;
}

/** Locale identifier used by every locale-sensitive Intl formatter. */
export function uiLocaleToIntlLocale(locale: UiLocale): 'zh-CN' | 'en' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
