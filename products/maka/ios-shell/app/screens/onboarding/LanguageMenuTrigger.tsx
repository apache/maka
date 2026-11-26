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

import { Text, View, token } from 'nsh';
import { MenuButton, type MenuButtonItem } from 'nsh/base';
import { SUPPORTED_LOCALES } from '../../../../../../packages/plugin-sdk/src/index.js';
import {
  isLanguagePreference,
  languagePreference,
  languagePreferenceBusy,
  saveLanguagePreference,
  tr,
} from '../../locale';
import { hapticSelection } from '../../state/preferences';
import { type } from '../../theme/tokens';
import { Icon } from '../../ui';

export function buildLanguageMenuItems(): MenuButtonItem[] {
  const pref = languagePreference() ?? 'auto';
  return [
    {
      id: 'auto',
      label: tr('Automatic (System)'),
      checked: pref === 'auto',
      singleSelection: true,
    },
    ...SUPPORTED_LOCALES.map((entry) => ({
      id: entry.tag,
      label: entry.autonym,
      checked: pref === entry.tag,
      singleSelection: true,
    })),
  ];
}

export function currentLanguageDisplayName(): string {
  const pref = languagePreference();
  if (pref === null) return '';
  if (pref === 'auto') return tr('Automatic');
  return SUPPORTED_LOCALES.find((entry) => entry.tag === pref)?.autonym ?? pref;
}

export function onSelectLanguageId(id: string) {
  if (!isLanguagePreference(id)) return;
  hapticSelection();
  void saveLanguagePreference(id);
}

/** Discrete language switcher button for Onboarding navigation header. */
export function LanguageHeaderButton() {
  return (
    <MenuButton
      accessibilityLabel={tr('Language')}
      title={tr('Language')}
      disabled={languagePreferenceBusy()}
      items={buildLanguageMenuItems()}
      onSelect={({ id }) => onSelectLanguageId(id)}
    >
      <View
        class="active:opacity-60"
        style={{
          minHeight: 36,
          paddingHorizontal: 10,
          borderRadius: 999,
          backgroundColor: token('surface-muted'),
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <Icon name="globe" color={token('primary')} size={15} />
        <Text
          style={{
            ...type.footnote,
            fontWeight: '500',
            color: token('foreground'),
          }}
        >
          {currentLanguageDisplayName()}
        </Text>
      </View>
    </MenuButton>
  );
}
