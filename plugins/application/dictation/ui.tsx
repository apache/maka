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

import { effect, platform, signal, type JSX } from 'nsh';
import { host } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { dictationPreferences as preferences } from '../../../products/maka/workbench/app/dictationPreferences';
import {
  SettingsBody,
  SettingsProblem,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from '../../../products/maka/workbench/app/SettingsPage';

interface DictationInput extends QuickToolInput {
  startDictation(): void;
}

function Tool({ input }: UiEmbeddedViewProps<DictationInput, JSX.Element>) {
  input.attach({
    entries: () => [
      {
        id: 'start',
        title: tr('Start dictation'),
        icon: 'mic',
        keywords: ['dictate', 'dictation', 'voice', '听写', '聽寫'],
        run: input.startDictation,
      },
    ],
    items: () => [],
  });
  return null;
}

function Preferences() {
  void preferences.initialize();
  const microphones = () => host.dictationMicrophones() as { id: string; name: string }[];
  const devices = signal(microphones());
  const choices = () => {
    const selected = preferences.microphone();
    return [
      { value: '', title: tr('Follow system input') },
      ...devices().map(({ id, name }) => ({ value: id, title: name })),
      ...(selected && !devices().some((device) => device.id === selected)
        ? [{ value: selected, title: tr('Selected microphone (disconnected)'), disabled: true }]
        : []),
    ];
  };
  return (
    <SettingsBody>
      <SettingsSection note={tr('Dictation uses the model connection from General settings.')}>
        <SettingsSwitch
          label={tr('Enable dictation')}
          checked={preferences.enabled()}
          disabled={preferences.busy()}
          onPress={() => void preferences.save('enabled', String(!preferences.enabled()))}
        />
        <SettingsSwitch
          label={tr('Listen when Quick Tools opens')}
          checked={preferences.listenOnOpen()}
          disabled={!preferences.enabled() || preferences.busy()}
          onPress={() => void preferences.save('listenOnOpen', String(!preferences.listenOnOpen()))}
        />
        <SettingsSelect
          label={tr('Microphone')}
          value={preferences.microphone()}
          choices={choices()}
          disabled={preferences.busy()}
          onOpen={() => devices.set(microphones())}
          change={(value) => void preferences.save('microphone', value)}
        />
      </SettingsSection>
      <If when={!!preferences.error()}>
        <SettingsProblem message={preferences.error()} />
      </If>
    </SettingsBody>
  );
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  const supported = platform.os === 'macos' && platform.idiom !== 'terminal';
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: (props: UiEmbeddedViewProps<DictationInput, JSX.Element>) =>
          supported ? <Tool {...props} /> : null,
      },
      preferences: { kind: 'settings', render: () => (supported ? <Preferences /> : null) },
    },
  };
};
