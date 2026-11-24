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

import { signal, type Signal } from 'nsh';
import { host as nativeHost } from 'maka/host';
import {
  formatMessage,
  negotiateLocale,
  normalizeLocaleTag,
  resolveDisplayText,
  resolveLocale,
  resolveLocalizedPresentation,
  type DisplayText,
  type LanguagePreference,
} from '../../../../packages/plugin-sdk/src/index.js';
import type en from '../locales/en.json';

export type MessageKey = keyof typeof en;

type WorkbenchTranslator = (
  locale: string,
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

interface WorkbenchLocaleState {
  readonly nativeLocale: unknown;
  readonly currentLocale: Signal<string>;
  observedRevision: number;
  translate: WorkbenchTranslator | null;
  nshSynced: boolean;
}

const WORKBENCH_LOCALE_KEY = Symbol.for('maka.workbench.i18n');

/**
 * Keep regional tags whose primary language matches the negotiated built-in locale
 * (e.g. en-GB -> en-GB, fr-CA -> fr-CA) so Intl preserves regional date/number
 * formatting, while remapping aliases and unsupported tags (e.g. yue-Hant-HK -> zh-HK,
 * zh-MO -> zh-HK, zh-Hant -> zh-TW, ar-SA -> en) onto their negotiated built-in tag so
 * QuickJS Intl and native CJK glyph shaping never fall back to en-US or Simplified Han.
 */
export function resolveUiLocale(raw: string): string {
  const normalized = normalizeLocaleTag(raw);
  const builtin = negotiateLocale(raw);
  if (!normalized) return builtin;
  if (builtin.startsWith('zh-')) {
    const lower = normalized.toLowerCase();
    const builtinLower = builtin.toLowerCase();
    return lower === builtinLower || lower.startsWith(`${builtinLower}-`) ? normalized : builtin;
  }
  const rawLang = normalized.split('-')[0];
  const builtinLang = builtin.split('-')[0];
  return rawLang === builtinLang ? normalized : builtin;
}

const globals = globalThis as Record<symbol, WorkbenchLocaleState | undefined>;
const state: WorkbenchLocaleState =
  globals[WORKBENCH_LOCALE_KEY] ??
  (globals[WORKBENCH_LOCALE_KEY] = {
    nativeLocale: nativeHost.systemLocale,
    currentLocale: signal(resolveUiLocale(resolveLocale('auto', nativeHost.systemLocale))),
    observedRevision: -1,
    translate: null,
    nshSynced: false,
  });

export const currentLocale = state.currentLocale;

/** Register the single window-owned catalog and NSH locale sync (idempotent). */
export function registerWorkbenchLocaleRuntime(
  translate: WorkbenchTranslator,
  bindNshSync?: () => void,
) {
  state.translate = translate;
  if (!state.nshSynced && bindNshSync) {
    state.nshSynced = true;
    bindNshSync();
  }
}

/** Host preferences are the authority; an older startup read cannot undo a saved change. */
export function applyLanguagePreference(
  preference: LanguagePreference,
  revision: number,
  resolvedLanguage?: string,
) {
  if (revision < state.observedRevision) return;
  state.observedRevision = revision;
  if (preference !== 'auto') {
    currentLocale.set(resolveUiLocale(resolveLocale(preference, state.nativeLocale)));
    return;
  }
  const local = resolveUiLocale(resolveLocale('auto', state.nativeLocale));
  if (resolvedLanguage && negotiateLocale(local) !== negotiateLocale(resolvedLanguage)) {
    currentLocale.set(resolveUiLocale(resolvedLanguage));
  } else {
    currentLocale.set(local);
  }
}

/** Render selects one immutable catalog and formats ICU placeholders/plurals for the active locale. */
export function tr(key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
  const locale = currentLocale();
  if (state.translate) {
    return state.translate(locale, key, values);
  }
  return formatMessage(key, locale, values);
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
