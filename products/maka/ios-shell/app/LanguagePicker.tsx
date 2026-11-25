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

import { computed, Text } from 'nsh';
import { MenuButton } from 'nsh/base';
import { SUPPORTED_LOCALES } from '../../../../packages/plugin-sdk/src/index.js';
import {
  isLanguagePreference,
  languagePreference,
  languagePreferenceBusy,
  languagePreferenceError,
  saveLanguagePreference,
  tr,
} from './locale';

export function LanguagePicker() {
  const items = computed(() => [
    { id: 'auto', label: tr('Automatic (system)'), checked: languagePreference() === 'auto' },
    ...SUPPORTED_LOCALES.map(({ tag, autonym }) => ({
      id: tag,
      label: autonym,
      checked: languagePreference() === tag,
    })),
  ]);

  return (
    <>
      <MenuButton
        items={items()}
        disabled={languagePreferenceBusy()}
        accessibilityLabel={tr('Language')}
        class="min-h-12 flex-row items-center justify-between border-t border-border px-4 active:opacity-75 transition-opacity duration-150 disabled:opacity-50"
        onSelect={({ id }) => {
          if (isLanguagePreference(id)) void saveLanguagePreference(id);
        }}
      >
        <Text class="text-foreground">{tr('Language')}</Text>
        <Text class="text-muted-foreground">{items().find(({ checked }) => checked)?.label}</Text>
      </MenuButton>
      <If when={languagePreferenceError() !== null}>
        <Text class="px-4 pb-3 text-destructive">
          {tr('Error: {detail}', { detail: languagePreferenceError() ?? '' })}
        </Text>
      </If>
    </>
  );
}
