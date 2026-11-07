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

import { cleanup, signal } from 'nsh';
import type {
  AgentWorkspace,
  AgentWorkspaceSelection,
  ConfigurationLocation,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { SettingsOperations } from './settingsOperations';
import { settingsRejection } from './settingsOperations';
import { WorkspacePicker } from './WorkspacePicker';
import { tr } from './locale';
import { SettingsSegmented, SettingsSelect } from './SettingsPage';

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
        const selected = await operations.mutate('agent', 'selectWorkspace', {
          path: selection.path,
        });
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

export function ConfigurationScope(props: { owner: ConfigurationWorkspace }) {
  const owner = props.owner;
  const project = () => {
    const path = owner.workspace()?.path;
    return path
      ? tr('Project: {name}', { name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path })
      : tr('Choose project…');
  };
  return (
    <>
      <SettingsSegmented
        label={tr('Scope')}
        description={owner.workspace()?.path}
        value={owner.workspace() ? 'project' : 'global'}
        choices={[
          { value: 'global', title: tr('Global') },
          { value: 'project', title: project() },
        ]}
        disabled={owner.busy()}
        change={(value) => (value === 'global' ? owner.global() : owner.open())}
      />
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
    </>
  );
}

export function LocationChoices(props: {
  targets: { location: ConfigurationLocation; path: string }[];
  selected: ConfigurationLocation | null;
  choose(location: ConfigurationLocation): void;
  disabled?: boolean;
}) {
  return (
    <SettingsSelect
      label={tr('Configuration location')}
      value={props.selected}
      disabled={props.disabled}
      choices={props.targets.map((target) => ({ value: target.location, title: target.path }))}
      change={(location) => props.choose(location as ConfigurationLocation)}
    />
  );
}
