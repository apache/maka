/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { platform, signal, Text, View, windowSize } from 'nsh';
import { Checkbox } from 'nsh/base';
import { ChoiceIndicator } from './ChoiceIndicator';
import { SettingsButton } from './SettingsPage';
import { tr, type MessageKey } from './locale';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  radius,
} from './ui';
import {
  approvedDiscoveryNames,
  type DiscoveryToolPreview,
  type DiscoveryToolSelection,
} from './discoveryCore';

const labels = {
  read_files: 'Discovery file reading tools',
  history: 'Discovery history tools',
  modify_files: 'Discovery file editing tools',
  commands: 'Discovery terminal tools',
  web: 'Discovery web tools',
  sessions: 'Discovery session tools',
  desktop: 'Discovery desktop tools',
  other: 'Discovery extension tools',
  plugin_management: 'Discovery plugin management',
} as const satisfies Record<NonNullable<DiscoveryToolSelection[string]>, MessageKey>;

type Group = keyof typeof labels;
const categories = Object.keys(labels) as Group[];

function namesIn(preview: DiscoveryToolPreview, group: Group) {
  return preview.names.filter((name) => preview.groups[name] === group);
}

function partialStatus(names: string[], selection: DiscoveryToolSelection) {
  const selected = names.filter((name) => Object.hasOwn(selection, name)).length;
  return selected > 0 && selected < names.length
    ? tr('Discovery partially enabled', { selected, total: names.length })
    : undefined;
}

export function discoverySelectionLabel(selection: DiscoveryToolSelection) {
  const enabled = new Set(Object.values(selection));
  return (
    categories
      .filter((group) => enabled.has(group))
      .map((group) => tr(labels[group]))
      .join(' · ') || tr('Only investigation completion')
  );
}

export function discoveryExternalToolNotice(selection: DiscoveryToolSelection) {
  const enabled = new Set(Object.values(selection));
  const groups = (['commands', 'desktop', 'other'] as const)
    .filter((group) => enabled.has(group))
    .map((group) => tr(labels[group]));
  return groups.length
    ? tr('Discovery external tool scope', {
        tools: groups.join(tr('Discovery list separator')),
      })
    : '';
}

export function DiscoveryToolPicker(props: {
  preview: DiscoveryToolPreview;
  selection: DiscoveryToolSelection;
  change(group: Group, selection: DiscoveryToolSelection): void;
  disabled: boolean;
}) {
  const groups = () => categories.filter((group) => namesIn(props.preview, group).length > 0);
  const enabledCount = () => new Set(Object.values(props.selection)).size;
  const details = signal(false);
  const checked = (name: string) => Object.hasOwn(props.selection, name);
  const toggle = (group: Group) => {
    const names = namesIn(props.preview, group);
    const turnOn = !names.every(checked);
    const next = Object.entries(props.preview.groups).filter(([name, category]) =>
      category === group ? turnOn : checked(name),
    );
    props.change(group, Object.fromEntries(next));
  };
  return (
    <View style={{ gap: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          rowGap: 2,
        }}
      >
        <Each of={groups()} key={(group) => group}>
          {(group) => {
            const names = () => namesIn(props.preview, group());
            const all = () => names().every(checked);
            const partial = () => partialStatus(names(), props.selection);
            const label = () => tr(labels[group()]);
            return (
              <Checkbox
                accessibilityLabel={tr('{label}: {state}', {
                  label: label(),
                  state: partial() ?? tr(all() ? 'On' : 'Off'),
                })}
                checked={all()}
                indeterminate={!!partial()}
                indicator={
                  <ChoiceIndicator
                    kind="checkbox"
                    checked={all()}
                    mixed={!!partial()}
                    disabled={props.disabled}
                  />
                }
                disabled={props.disabled}
                onChange={() => toggle(group())}
                style={{
                  width: windowSize().width < 480 || platform.idiom === 'terminal' ? '100%' : '49%',
                  minHeight: platform.idiom === 'terminal' ? 16 : 32,
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                  borderRadius: radius(6),
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                hoverStyle={{ backgroundColor: C.raised }}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <View style={{ minWidth: 0, flexShrink: 1 }}>
                  <Text style={{ ...bodyTextStyle, color: C.text }}>{label()}</Text>
                  <If when={partial()}>
                    {(status) => (
                      <Text style={{ ...captionTextStyle, color: C.secondary }}>{status()}</Text>
                    )}
                  </If>
                </View>
              </Checkbox>
            );
          }}
        </Each>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Text style={{ ...captionTextStyle, color: C.muted, flexShrink: 1 }}>
          {enabledCount()
            ? tr('Discovery selected groups', { selected: enabledCount(), total: groups().length })
            : tr('Only investigation completion')}
        </Text>
        <SettingsButton
          label={tr(details() ? 'Hide approved tool names' : 'Show approved tool names')}
          tone="quiet"
          onPress={() => details.set(!details())}
        />
      </View>
      <If when={details()}>
        <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
          {approvedDiscoveryNames(props.preview, props.selection).join(' · ')}
        </Text>
      </If>
    </View>
  );
}
