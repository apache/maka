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
import { computerPermissionMessages } from './locale-computer-permissions';
import { goalMessages } from './locale-goal';
import { composerMessages } from './locale-composer';
import { roomMessages } from './locale-rooms';
import type { DisplayText, LanguagePreference } from '../../../../packages/plugin-sdk/src/index.js';
import { createCopy, languageIndex, resolveLocale } from '../../../../plugins/shared/locale.js';
import { host as nativeHost } from 'maka/host';
import { commonMessages } from './locale-common';
import { conversationMessages } from './locale-conversation';
import { settingsMessages } from './locale-settings';
import { workspaceMessages } from './locale-workspace';
import { recallMessages } from './locale-recall';
import { pluginMessages } from './locale-plugins';
import { configurationMessages } from './locale-configuration';
import { externalAgentMessages } from './locale-external-agents';
import { toolActivityMessages } from './locale-tool-activity';
import { sessionToolMessages } from './locale-tool-sessions';
import { deploymentToolMessages } from './locale-tool-deployment';
import { automationMessages } from './locale-automation';
import { nativeToolMessages } from './locale-tool-native';
import { discoveryMessages } from './locale-discovery';

import { subagentMessages } from './locale-subagents';

const nativeLocale = nativeHost.systemLocale;
export const currentLocale = signal(resolveLocale('auto', nativeLocale));
let observedRevision = -1;
const copy = createCopy({
  ...commonMessages,
  ...subagentMessages,
  ...computerPermissionMessages,
  ...goalMessages,
  ...conversationMessages,
  ...composerMessages,
  ...roomMessages,
  ...settingsMessages,
  ...workspaceMessages,
  ...recallMessages,
  ...pluginMessages,
  ...configurationMessages,
  ...externalAgentMessages,
  ...toolActivityMessages,
  ...sessionToolMessages,
  ...deploymentToolMessages,
  ...nativeToolMessages,
  ...automationMessages,
  ...discoveryMessages,
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
  const locale = currentLocale();
  const translations = presentation.localizations;
  return (
    translations?.[locale] ??
    translations?.[locale.split('-')[0]!] ??
    translations?.[(['en', 'zh-CN', 'zh-TW', 'ko'] as const)[languageIndex(locale)]] ??
    presentation
  );
}

/** Honor authored DisplayText translations; opaque custom titles keep their fallback. */
export function displayText(text: DisplayText): string {
  const locale = currentLocale();
  return (
    text.translations?.[locale] ??
    text.translations?.[locale.split('-')[0]!] ??
    text.translations?.[(['en', 'zh-CN', 'zh-TW', 'ko'] as const)[languageIndex(locale)]] ??
    text.fallback
  );
}
