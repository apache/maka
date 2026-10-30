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

import { cleanup, effect, signal, untracked } from 'nsh';
import type { Host } from './host';
import type { SettingsOperations } from './settingsOperations';
import { settingsRejection } from './settingsOperations';
import type { ConfigurationWorkspace } from './ConfigurationScope';
import type {
  AgentMcpConfigurationList,
  AgentMcpConfigurationLocation,
  AgentMcpConfigurationEntry,
  AgentMcpConfigurationChange,
  AgentWorkspace,
  ConfigurationLocation,
} from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import { UiError } from './text';

type Pair = { id: number; name: string; value: string };
type Group = 'env' | 'headers' | 'headerEnv';
type Argument = { id: number; value: string };
export type McpEditor = {
  original: string | null;
  workspace: AgentWorkspace | null;
  revision: string;
  location: ConfigurationLocation;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: Argument[];
  cwd: string;
  passEnv: string;
  env: Pair[];
  url: string;
  headers: Pair[];
  headerEnv: Pair[];
  enabled: boolean;
  advanced: boolean;
};
export type McpRow = {
  workspace: AgentWorkspace | null;
  location: AgentMcpConfigurationLocation;
  entry: AgentMcpConfigurationEntry;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const mcpDisabled = (configuration: unknown) => object(configuration).disabled === true;
export const mcpLaunch = (configuration: unknown) => {
  const value = object(configuration);
  return typeof value.command === 'string'
    ? [value.command, ...strings(value.args)].join(' ')
    : text(value.url);
};
export function createMcpSettings(
  host: Host,
  operations: SettingsOperations,
  scope: ConfigurationWorkspace,
) {
  const active = signal(false);
  const loading = signal(false);
  const inventory = signal<AgentMcpConfigurationList | null>(null);
  const editor = signal<McpEditor | null>(null);
  const deleting = signal<McpRow | null>(null);
  const query = signal('');
  let serial = 0;
  let read = 0;
  let alive = true;
  cleanup(() => {
    alive = false;
    ++read;
  });
  const load = async () => {
    const request = ++read;
    loading.set(true);
    try {
      const result = await host.query('agent', 'mcpConfigurations', {
        workspace: scope.workspace(),
      });
      if (alive && request === read) inventory.set(result);
    } catch (error) {
      if (alive && request === read) {
        inventory.set(null);
        operations.report(error);
      }
    } finally {
      if (alive && request === read) loading.set(false);
    }
  };
  effect(() => {
    const visible = active();
    scope.workspace();
    if (visible)
      untracked(() => {
        editor.set(null);
        deleting.set(null);
        void load();
      });
  });
  const pairs = (value: unknown) =>
    Object.entries(object(value)).map(([name, value]) => ({
      id: ++serial,
      name,
      value: text(value),
    }));
  const open = (row: McpRow | null) => {
    const locations = inventory()?.locations ?? [];
    const location =
      row?.location.location ??
      locations.find(
        (location) => location.location === (scope.workspace() ? 'project:agents' : 'user:agents'),
      )?.location ??
      locations[0]?.location;
    if (!location) return;
    const configuration = object(row?.entry.configuration);
    editor.set({
      original: row?.entry.name ?? null,
      location,
      workspace: row?.workspace ?? scope.workspace(),
      revision:
        row?.location.revision ??
        locations.find((target) => target.location === location)!.revision,
      name: row?.entry.name ?? '',
      transport: typeof configuration.url === 'string' ? 'http' : 'stdio',
      command: text(configuration.command),
      args: strings(configuration.args).map((value) => ({ id: ++serial, value })),
      cwd: text(configuration.cwd),
      passEnv: strings(configuration.passEnv).join('\n'),
      env: pairs(configuration.env),
      url: text(configuration.url),
      headers: pairs(configuration.headers),
      headerEnv: pairs(configuration.headerEnv),
      enabled: configuration.disabled !== true,
      advanced: false,
    });
  };
  const change = <K extends keyof McpEditor>(field: K, value: McpEditor[K]) => {
    const draft = editor();
    if (draft)
      editor.set({
        ...draft,
        [field]: value,
        ...(field === 'location'
          ? {
              revision:
                inventory()?.locations.find((target) => target.location === value)?.revision ??
                draft.revision,
            }
          : {}),
      });
  };
  const changePair = (input: {
    group: Group;
    id: number;
    field: 'name' | 'value';
    value: string;
  }) => {
    const draft = editor();
    if (draft)
      change(
        input.group,
        draft[input.group].map((pair) =>
          pair.id === input.id ? { ...pair, [input.field]: input.value } : pair,
        ),
      );
  };
  const addPair = (group: Group) => {
    const draft = editor();
    if (draft) change(group, [...draft[group], { id: ++serial, name: '', value: '' }]);
  };
  const removePair = (input: { group: Group; id: number }) => {
    const draft = editor();
    if (draft)
      change(
        input.group,
        draft[input.group].filter((pair) => pair.id !== input.id),
      );
  };
  const rows = () => {
    const search = query().trim().toLowerCase();
    return (inventory()?.locations ?? [])
      .flatMap((location) =>
        location.servers.map((entry) => ({ location, entry, workspace: scope.workspace() })),
      )
      .filter(
        ({ location, entry }) =>
          !search ||
          `${entry.name} ${location.path} ${mcpLaunch(entry.configuration)}`
            .toLowerCase()
            .includes(search),
      );
  };
  const pairValues = (pairs: Pair[]) => {
    const values: Record<string, string> = {};
    for (const pair of pairs) {
      if (!pair.name || Object.hasOwn(values, pair.name))
        throw new UiError('Environment and header names must be nonempty and unique.');
      Object.defineProperty(values, pair.name, { value: pair.value, enumerable: true });
    }
    return values;
  };
  const save = (draft: McpEditor | null) => {
    if (!draft) return;
    void operations.run(async () => {
      const location = inventory()?.locations.find(
        (location) => location.location === draft.location,
      );
      if (!location) return;
      if (!draft.original && location.servers.some((entry) => entry.name === draft.name))
        throw new UiError('A server with this name already exists at this location.');
      const configuration =
        draft.transport === 'stdio'
          ? {
              type: 'stdio',
              command: draft.command,
              args: draft.args.map((argument) => argument.value),
              ...(draft.cwd ? { cwd: draft.cwd } : {}),
              env: pairValues(draft.env),
              passEnv: draft.passEnv.split('\n').filter(Boolean),
              disabled: !draft.enabled,
            }
          : {
              type: 'http',
              url: draft.url,
              headers: pairValues(draft.headers),
              headerEnv: pairValues(draft.headerEnv),
              disabled: !draft.enabled,
            };
      const input: AgentMcpConfigurationChange = {
        workspace: draft.workspace,
        location: draft.location,
        revision: draft.revision,
        name: draft.name,
        change: { kind: 'save', configuration },
      };
      const result = await operations.mutate('agent', 'manageMcpServer', input);
      if (result.kind !== 'saved') throw settingsRejection(result);
      if (alive) {
        editor.set(null);
        operations.notice.set(tr('MCP server saved.'));
        await load();
      }
    });
  };
  const remove = (row: McpRow) => {
    void operations.run(async () => {
      const result = await operations.mutate('agent', 'manageMcpServer', {
        workspace: row.workspace,
        location: row.location.location,
        revision: row.location.revision,
        name: row.entry.name,
        change: { kind: 'delete' },
      });
      if (result.kind !== 'saved') throw settingsRejection(result);
      if (alive) {
        deleting.set(null);
        operations.notice.set(tr('MCP server deleted.'));
        await load();
      }
    });
  };
  const back = () => {
    if (deleting()) {
      deleting.set(null);
      return false;
    }
    if (editor()) {
      editor.set(null);
      return false;
    }
    return true;
  };
  return {
    scope,
    loading,
    inventory,
    editor,
    deleting,
    query,
    busy: scope.busy,
    rows,
    open,
    change,
    changePair,
    addPair,
    removePair,
    save,
    remove,
    back,
    refresh: () => {
      editor.set(null);
      deleting.set(null);
      void load();
    },
    addArgument: () => {
      const draft = editor();
      if (draft) change('args', [...draft.args, { id: ++serial, value: '' }]);
    },
    changeArgument: (input: { id: number; value: string }) => {
      const draft = editor();
      if (draft)
        change(
          'args',
          draft.args.map((argument) =>
            argument.id === input.id ? { ...argument, value: input.value } : argument,
          ),
        );
    },
    removeArgument: (id: number) => {
      const draft = editor();
      if (draft)
        change(
          'args',
          draft.args.filter((argument) => argument.id !== id),
        );
    },
    activate: () => {
      active.set(true);
    },
    deactivate: () => {
      active.set(false);
      ++read;
      loading.set(false);
    },
    navigation: () =>
      `${editor()?.original ?? 'list'}:${!!editor()}:${deleting()?.entry.name ?? ''}`,
    recovered: () => {
      editor.set(null);
      deleting.set(null);
      void load();
    },
  };
}
export type McpSettingsOwner = ReturnType<typeof createMcpSettings>;
