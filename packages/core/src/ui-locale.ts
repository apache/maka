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

import { IntlMessageFormat } from 'intl-messageformat';

/** Resolved locales supported by human-facing Maka clients. */
export const UI_LOCALES = ['zh-CN', 'zh-TW', 'en'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** Shared UI preference vocabulary. A resolved locale is never persisted. */
export type UiLocalePreference = 'auto' | UiLocale;

export const UI_LOCALE_PREFERENCES = ['auto', ...UI_LOCALES] as const;

/** A catalog must carry copy for every supported resolved locale. */
export type UiCatalog<T> = Record<UiLocale, T>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export type UiMessageCatalog<T> = {
  readonly en: T;
} & Partial<{
  readonly [Locale in Exclude<UiLocale, 'en'>]: DeepPartial<T>;
}>;

type ExactMessageShape<Actual, Expected> = Actual extends readonly unknown[]
  ? NonNullable<Expected> extends readonly unknown[]
    ? Actual
    : never
  : Actual extends object
    ? Exclude<keyof Actual, keyof NonNullable<Expected>> extends never
      ? {
          readonly [Key in keyof Actual]: ExactMessageShape<
            Actual[Key],
            NonNullable<Expected>[Key & keyof NonNullable<Expected>]
          >;
        }
      : never
    : Actual;

const messageFormatters = new Map<string, IntlMessageFormat>();

export function defineUiMessageCatalog<Expected>() {
  return <Catalog extends UiMessageCatalog<Expected>>(
    catalog: Catalog & {
      readonly en: ExactMessageShape<Catalog['en'], Expected>;
    } & {
      readonly [Locale in Exclude<UiLocale, 'en'>]?: ExactMessageShape<
        NonNullable<Catalog[Locale]>,
        DeepPartial<Expected>
      >;
    },
  ): UiMessageCatalog<Expected> => catalog;
}

export function resolveUiMessageCatalog<T>(catalog: UiMessageCatalog<T>): UiCatalog<T> {
  return Object.fromEntries(
    UI_LOCALES.map((locale) => [
      locale,
      locale === 'en'
        ? catalog.en
        : mergeUiMessages(catalog.en, catalog[locale] as DeepPartial<T> | undefined),
    ]),
  ) as UiCatalog<T>;
}

export function formatUiMessage(
  template: string,
  values: Readonly<Record<string, string | number | bigint | boolean | Date | null | undefined>>,
  locale: UiLocale,
): string {
  try {
    const intlLocale = uiLocaleToIntlLocale(locale);
    const cacheKey = `${intlLocale}\u0000${template}`;
    let formatter = messageFormatters.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(template, intlLocale);
      messageFormatters.set(cacheKey, formatter);
    }
    const safeValues = Object.assign(Object.create(null) as Record<string, unknown>, values);
    const formatted = formatter.format(safeValues);
    return Array.isArray(formatted) ? formatted.join('') : String(formatted);
  } catch {
    return template;
  }
}

function mergeUiMessages<T>(fallback: T, translation: DeepPartial<T> | undefined): T {
  if (translation === undefined) return fallback;
  if (!isMessageRecord(fallback) || !isMessageRecord(translation)) return translation as T;
  return Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => [
      key,
      mergeUiMessages(value, Object.hasOwn(translation, key) ? translation[key] : undefined),
    ]),
  ) as T;
}

function isMessageRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en';
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === 'auto' || isUiLocale(value);
}

/** Decode persisted or externally supplied preferences into the closed locale vocabulary. */
export function normalizeUiLocalePreference(value: unknown): UiLocalePreference {
  if (value === 'zh') return 'zh-CN';
  return isUiLocalePreference(value) ? value : 'auto';
}

/** Resolve the first supported language in the operating system preference list. */
export function resolveSystemUiLocale(languages: readonly string[] | null | undefined): UiLocale {
  for (const language of languages ?? []) {
    const normalized = language.trim().replaceAll('_', '-');
    if (/^zh(?:[-.]|$)/iu.test(normalized)) {
      if (/^zh-(?:tw|hk|mo)(?:[-.]|$)/iu.test(normalized)) return 'zh-TW';
      if (/^zh-hant(?:[-.]|$)/iu.test(normalized)) return 'zh-TW';
      return 'zh-CN';
    }
    if (/^en(?:[-.]|$)/iu.test(normalized)) return 'en';
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
export function uiLocaleToIntlLocale(locale: UiLocale): UiLocale {
  return locale;
}
