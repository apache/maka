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

// The language the desktop speaks: English, Simplified Chinese or
// Traditional Chinese, the three the TUI and the native client have. Unless
// the user picks one in Settings it follows the one the system asks for
// (`maka-locale`), mapped as the TUI maps a tag
// (plugins/shared/locale.ts `languageIndex`). The choice is kept in this
// application's localStorage. Words come from messages.js through `t`.

import { system } from 'maka-locale';
import { MESSAGES } from './messages.js';

/** The languages, in the order of a message's entries. */
export const LANGUAGES = ['en', 'zh-CN', 'zh-TW'];
/** What each language is called, in itself, as a language menu lists it. */
export const LANGUAGE_NAMES = { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };
/** The choices Settings offers: follow the system, or one of LANGUAGES. */
export const LANGUAGE_CHOICES = ['system', ...LANGUAGES];

const STORAGE_KEY = 'maka.language';

/** Which of LANGUAGES a BCP 47 tag means. */
export function languageOf(tag) {
  const lower = String(tag).toLowerCase();
  if (!lower.startsWith('zh')) return 'en';
  return lower.includes('hant') || /^zh-(tw|hk|mo)/.test(lower) ? 'zh-TW' : 'zh-CN';
}

function stored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGE_CHOICES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let preference = stored();
let current = resolve(preference);
const listeners = new Set();

function resolve(choice) {
  return choice === 'system' ? languageOf(system()) : choice;
}

/** The language in use. */
export function language() {
  return current;
}

/** The choice in Settings: 'system' or one of LANGUAGES. */
export function languagePreference() {
  return preference;
}

/**
 * Keeps the choice and switches to the language it means. Listeners run at
 * once, inside the caller's event, so they may update retained state such
 * as a field's placeholder; the caller redraws.
 */
export function setLanguagePreference(next) {
  if (!LANGUAGE_CHOICES.includes(next) || next === preference) return;
  preference = next;
  localStorage.setItem(STORAGE_KEY, next);
  const language = resolve(next);
  if (language === current) return;
  current = language;
  for (const listener of listeners) listener(language);
}

/** Calls `listener(language)` after each switch; answers a function that stops it. */
export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The message `key` in the current language, with each `{name}` replaced
 * by `params[name]`. An unknown key is a bug: it throws.
 */
export function t(key, params) {
  const message = MESSAGES[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  const text = message[LANGUAGES.indexOf(current)];
  return params === undefined ? text : fill(text, params);
}

/** `one` for a count of 1 and `other` for the rest, with `{count}` filled in. */
export function tn(count, one, other, params = {}) {
  return t(count === 1 ? one : other, { ...params, count });
}

function fill(text, params) {
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}
