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

import { signal, untracked } from 'nsh';
import type { AgentWorkspace } from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { listHostProjects } from '../../state/sessions';
import { SettingChoice } from './SettingsForm';

export function workspaceScope(rootId: string, alive: () => boolean) {
  const projects = signal<Awaited<ReturnType<typeof listHostProjects>>>([]);
  const selected = signal('');
  return {
    selected,
    workspace(): AgentWorkspace | null {
      const project = projects().find(({ reference }) => reference.id === selected());
      return project ? { path: project.path, projectId: project.reference.id } : null;
    },
    async load() {
      const rows = await listHostProjects(rootId, alive);
      if (!alive()) return;
      projects.set(rows);
      if (!rows.some(({ reference }) => reference.id === untracked(selected))) selected.set('');
    },
    options() {
      return [
        { id: '', label: tr('Global') },
        ...projects().map((project) => ({ id: project.reference.id, label: project.name })),
      ];
    },
  };
}

export function WorkspaceScope(props: {
  scope: ReturnType<typeof workspaceScope>;
  disabled: boolean;
  change: (id: string) => void;
}) {
  return (
    <SettingChoice
      title={tr('Workspace')}
      value={props.scope.selected()}
      options={props.scope.options()}
      disabled={props.disabled}
      change={props.change}
    />
  );
}
