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

import { signal } from 'nsh';
import { composerMessages } from './locale-composer';
import type { DisplayText, LanguagePreference } from '../../../../packages/plugin-sdk/src/index.js';
import { createCopy, languageIndex, resolveLocale } from '../../../../plugins/shared/locale.js';
import { host as nativeHost } from 'maka/host';
import { commonMessages } from './locale-common';
import { conversationMessages } from './locale-conversation';
import { settingsMessages } from './locale-settings';
import { workspaceMessages } from './locale-workspace';

const nativeLocale = nativeHost.systemLocale;
const currentLocale = signal(resolveLocale('auto', nativeLocale));
let observedRevision = -1;
const copy = createCopy({
  ...commonMessages,
  ...conversationMessages,
  ...composerMessages,
  ...settingsMessages,
  ...workspaceMessages,
});
export type MessageKey = keyof ReturnType<typeof copy>;

/** Host preferences are the authority; an older startup read cannot undo a saved change. */
export function applyLanguagePreference(preference: LanguagePreference, revision: number) {
  if (revision < observedRevision) return;
  observedRevision = revision;
  currentLocale.set(resolveLocale(preference, nativeLocale));
}

/** Render selects one immutable catalog; interpolation never rebuilds the catalog. */
export function tr(key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
  const message = copy(currentLocale())[key];
  return values === undefined
    ? message
    : message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) =>
        name in values ? String(values[name]) : placeholder,
      );
}

/** Honor authored DisplayText translations; opaque custom titles keep their fallback. */
export function displayText(text: DisplayText): string {
  const locale = currentLocale();
  return (
    text.translations?.[locale] ??
    text.translations?.[locale.split('-')[0]!] ??
    text.translations?.[(['en', 'zh-CN', 'zh-TW'] as const)[languageIndex(locale)]] ??
    text.fallback
  );
}
