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

import { cleanup, inputAction, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import type {
  AgentWorkspace,
  AgentWorkspaceSelection,
  ConfigurationLocation,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { SettingsOperations } from './settingsOperations';
import { settingsRejection } from './settingsOperations';
import { WorkspacePicker } from './WorkspacePicker';
import { ChoiceIndicator } from './ChoiceIndicator';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function createConfigurationWorkspace(operations: SettingsOperations) {
  const workspace = signal<AgentWorkspace | null>(null);
  const picker = signal<number | null>(null);
  let serial = 0;
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const busy = () =>
    operations.busy() || !operations.pendingKnown() || operations.pending().length > 0;
  return {
    workspace,
    picker,
    busy,
    recovered: (value: unknown) => {
      if (!value) throw settingsRejection({ reason: 'workspace_unavailable' });
      workspace.set(value as AgentWorkspace);
      picker.set(null);
    },
    global: () => {
      workspace.set(null);
    },
    open: () => {
      picker.set(++serial);
    },
    close: (instance: number) => {
      if (picker() !== instance) return false;
      picker.set(null);
      return true;
    },
    async choose(selection: AgentWorkspaceSelection) {
      if (selection.kind !== 'directory') return;
      await operations.run(async () => {
        const selected = await operations.mutate('agent', 'selectWorkspace', selection.selection);
        if (!selected) throw settingsRejection({ reason: 'workspace_unavailable' });
        if (alive) {
          workspace.set(selected);
          picker.set(null);
        }
      });
    },
  };
}
export type ConfigurationWorkspace = ReturnType<typeof createConfigurationWorkspace>;

export function ManageButton<T>(props: {
  label: string;
  accessibilityLabel?: string;
  action(argument: T): unknown;
  argument: T;
  disabled?: boolean;
  selected?: boolean;
  children?: JSX.Element;
  danger?: boolean;
}) {
  return (
    <Button
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={inputAction(props.action, props.argument)}
      style={{
        ...controlStyle,
        borderWidth: 1,
        borderColor: props.selected ? C.accent : C.line,
        flexDirection: 'row',
        gap: 8,
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      {props.children ?? (
        <Text style={{ ...bodyTextStyle, color: props.danger ? C.danger : C.text }}>
          {props.label}
        </Text>
      )}
    </Button>
  );
}
export function ConfigurationScope(props: { owner: ConfigurationWorkspace }) {
  const owner = props.owner;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ManageButton
          label={tr('Global')}
          action={owner.global}
          argument={null}
          selected={!owner.workspace()}
          disabled={owner.busy()}
        />
        <ManageButton
          label={
            owner.workspace()
              ? tr('Project: {name}', {
                  name:
                    owner.workspace()!.path.split(/[\\/]/).filter(Boolean).at(-1) ??
                    owner.workspace()!.path,
                })
              : tr('Choose project…')
          }
          action={owner.open}
          argument={null}
          selected={!!owner.workspace()}
          disabled={owner.busy()}
        />
      </View>
      <Each of={owner.picker() === null ? [] : [owner.picker()!]} key={(instance) => instance}>
        {(instance) => (
          <WorkspacePicker
            instance={instance()}
            current={() => owner.picker() === instance()}
            close={owner.close}
            create={owner.choose}
            changed={() => {}}
          />
        )}
      </Each>
    </View>
  );
}
export function LocationChoices(props: {
  targets: { location: ConfigurationLocation; path: string }[];
  selected: ConfigurationLocation | null;
  choose(location: ConfigurationLocation): void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.targets} key={(target) => target.location}>
        {(target) => (
          <ManageButton
            label={target().path}
            action={props.choose}
            argument={target().location}
            disabled={props.disabled}
            selected={props.selected === target().location}
          >
            <ChoiceIndicator
              kind="radio"
              checked={props.selected === target().location}
              disabled={props.disabled}
            />
            <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>{target().path}</Text>
          </ManageButton>
        )}
      </Each>
    </View>
  );
}
