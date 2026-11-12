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

import { mount, View, Text, signal, effect, cleanup, host as events } from 'nsh';
import { Button } from 'nsh/base';
import { AppliedPresetDetails } from '../../app/AppliedPresetDetails';
import { SubagentSettings } from '../../app/SubagentSettings';
import { createPresetSettings } from '../../app/presetSettingsState';
import { createSettingsOperations } from '../../app/settingsOperations';
import { C, captionTextStyle } from '../../app/ui';
import { currentLocale } from '../../app/locale';
import type { Host } from '../../app/host';
import type { ServiceMethods } from '../../../../../packages/plugin-sdk/src/index';

mount(() => {
  type Preset = NonNullable<ServiceMethods['agent']['preset']['output']>['preset'];
  let saved: Preset | null = null;
  let conflict = false;
  const host = {
    pendingSettings: async () => [],
    query: async (_: string, method: string) => {
      if (method === 'presets')
        return saved ? [{ ...saved, availability: { kind: 'available' } }] : [];
      if (method === 'preset') return { preset: saved, availability: { kind: 'available' } };
      const choice = {
        label: 'Test model',
        sourceName: 'Local',
        selection: { kind: 'model', connectionId: 'local', modelId: 'test' },
        thinkingLevels: ['low', 'high'],
      };
      if (method === 'model') return { kind: 'ready', choice };
      if (method === 'models')
        return { kind: 'ready', revision: 'models', next: null, choices: [choice] };
      throw Error(method);
    },
    settingsMutation: async (_: string, method: string, input: any) => {
      let result;
      if (conflict) result = { kind: 'conflict', actual: 2 };
      else if (method === 'deletePreset') {
        saved = null;
        result = { kind: 'deleted', id: 'preset' };
      } else {
        saved = { ...saved, ...input, id: 'preset', revision: (saved?.revision ?? 0) + 1 };
        result = { kind: 'saved', preset: saved };
      }
      return {
        reply: {
          receipt: {
            kind: 'recorded',
            outcome: { kind: 'returned', result: { kind: 'success', value: result } },
          },
        },
      };
    },
  } as unknown as Host;
  const snapshot = {
    id: 'preset',
    revision: 1,
    name: 'Reviewer',
    instruction:
      '# Review Rust changes\n\nIdentify correctness regressions.\nExplain the affected execution path and a concrete fix.\n\n保留完整的角色指令。',
    model: { connectionId: 'local', modelId: 'test' },
    thinkingLevel: 'high' as const,
  };
  const details = signal(false);
  const operations = createSettingsOperations(host);
  const owner = createPresetSettings(host, operations);
  effect(() => {
    void events.call('fixture.outcome', {
      error: operations.error(),
      details: details(),
      description: owner.editor()?.values.description,
    });
  });
  owner.activate();
  cleanup(
    events.on('fixture.seed', () => {
      saved = {
        ...snapshot,
        description: 'Review correctness and recovery behavior',
        enabled: true,
      };
      owner.refresh();
    }),
  );
  cleanup(
    events.on('fixture.conflict', () => {
      conflict = true;
      owner.change('description', 'My unsaved review draft');
      void owner.save();
    }),
  );
  cleanup(
    events.on('fixture.details', () => {
      saved = null;
      operations.error.set('');
      details.set(true);
    }),
  );
  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <View style={{ flexDirection: 'row', gap: 12, padding: 12 }}>
        <Button
          testID="new"
          accessibilityLabel={
            details() ? 'Snapshot shown' : operations.error() ? 'Conflict recorded' : 'New'
          }
          onPress={() => void owner.open(null)}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>New</Text>
        </Button>
        <Button
          testID="conflict"
          onPress={() => {
            conflict = true;
          }}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>Conflict</Text>
        </Button>
        <Button testID="zh" onPress={() => currentLocale.set('zh-CN')}>
          <Text style={{ ...captionTextStyle, color: C.text }}>简体</Text>
        </Button>
        <Button testID="tw" onPress={() => currentLocale.set('zh-TW')}>
          <Text style={{ ...captionTextStyle, color: C.text }}>繁體</Text>
        </Button>
      </View>
      <Text style={{ ...captionTextStyle, color: C.text }}>{operations.error()}</Text>
      <If when={details()} else={<SubagentSettings owner={owner} />}>
        <View style={{ padding: 24 }}>
          <AppliedPresetDetails
            preset={snapshot}
            backend={{
              kind: 'model',
              connectionId: 'other',
              modelId: 'switched',
              thinkingLevel: 'low',
            }}
          />
        </View>
      </If>
    </View>
  );
});
