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
import { signal, Text, View } from 'nsh';
import { SettingsButton, SettingsRow, SettingsSwitch } from './SettingsPage';
import { tr, type MessageKey } from './locale';
import { C, captionTextStyle } from './ui';
import {
  approvedDiscoveryNames,
  type DiscoveryToolPreview,
  type DiscoveryToolSelection,
} from './discoveryCore';

const labels = {
  read_files: 'Discovery file reading tools',
  modify_files: 'Discovery file editing tools',
  history: 'Discovery history tools',
  commands: 'Discovery terminal tools',
  web: 'Discovery web tools',
  sessions: 'Discovery session tools',
  desktop: 'Discovery desktop tools',
  other: 'Discovery extension tools',
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

export function discoverySelectionLabel(
  selection: DiscoveryToolSelection,
  preview?: DiscoveryToolPreview,
) {
  const enabled = new Set(Object.values(selection));
  return (
    categories
      .filter((group) => enabled.has(group))
      .map((group) => {
        const label = tr(labels[group]);
        const status = preview && partialStatus(namesIn(preview, group), selection);
        return status ? tr('{label}: {state}', { label, state: status }) : label;
      })
      .join(' · ') || tr('Only investigation completion')
  );
}

export function DiscoveryToolPicker(props: {
  preview: DiscoveryToolPreview;
  selection: DiscoveryToolSelection;
  change(group: Group, selection: DiscoveryToolSelection): void;
  disabled: boolean;
}) {
  const expanded = signal(false);
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
      <Text style={{ ...captionTextStyle, color: C.secondary }}>
        {discoverySelectionLabel(props.selection, props.preview)}
      </Text>
      <SettingsButton
        label={tr(expanded() ? 'Hide discovery tool groups' : 'Choose discovery tool groups')}
        tone="quiet"
        disabled={props.disabled}
        onPress={() => expanded.set(!expanded())}
      />
      <If when={expanded()}>
        <Each of={categories.filter((group) => namesIn(props.preview, group).length > 0)}>
          {(group) => {
            const names = () => namesIn(props.preview, group());
            const label = () => tr(labels[group()]);
            return (
              <If
                when={partialStatus(names(), props.selection)}
                else={
                  <SettingsSwitch
                    label={label()}
                    checked={names().every(checked)}
                    disabled={props.disabled}
                    onPress={() => toggle(group())}
                  />
                }
              >
                {(status) => (
                  <SettingsRow
                    label={label()}
                    status={status()}
                    accessibilityLabel={tr('{label}: {state}', { label: label(), state: status() })}
                    disabled={props.disabled}
                    onPress={() => toggle(group())}
                  />
                )}
              </If>
            );
          }}
        </Each>
        <SettingsButton
          label={tr(details() ? 'Hide approved tool names' : 'Show approved tool names')}
          tone="quiet"
          onPress={() => details.set(!details())}
        />
        <If when={details()}>
          <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
            {approvedDiscoveryNames(props.preview, props.selection).join(' · ')}
          </Text>
        </If>
      </If>
    </View>
  );
}
