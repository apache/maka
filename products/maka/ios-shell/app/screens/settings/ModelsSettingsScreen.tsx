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

import { effect, signal, untracked } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { activeHostInfo } from '../../state/hostPool';
import type {
  Identity,
  SettingsConnectionSummary,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { GroupRow, InsetGroup } from '../../ui';
import {
  connectionCatalog,
  type ConnectionCatalog,
  modelChoices,
  modelConnectionLabels,
  modelLabel,
  providerCatalog,
  readConnection,
  setExternalRuntime,
  connectionBasis,
} from '../../state/settings/models';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import {
  SettingChoice,
  SettingField,
  SettingSwitch,
  SettingStatus,
  SettingsForm,
  type SettingsPageProps,
} from './SettingsForm';

export function ModelsSettingsScreen(
  props: SettingsPageProps & {
    revision: number;
    onChanged: () => void;
    openConnection: (row: SettingsConnectionSummary) => void;
    openProviders: (catalog: () => ConnectionCatalog | null) => void;
  },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const data = signal<{
    catalog: ConnectionCatalog;
    generation: number;
    revision: number;
    models: Awaited<ReturnType<typeof modelChoices>>;
    external: Awaited<ReturnType<typeof loadExternal>>;
  } | null>(null);
  const loadExternal = () => rpc.query('agent', 'externalAgents', {});
  const generation = () => activeHostInfo(props.rootId)?.generation;
  const load = async () => {
    const started = generation();
    const revision = props.revision;
    if (started === undefined) return;
    const [catalog, models, external] = await Promise.all([
      connectionCatalog(rpc),
      modelChoices(rpc),
      loadExternal(),
    ]);
    if (started === generation() && revision === props.revision) {
      data.set({ catalog, models, external, generation: started, revision });
    }
  };
  const reload = () => void work.run(load);
  let requested: { generation: number; revision: number } | undefined;
  effect(() => {
    const connected = generation();
    const revision = props.revision;
    if (work.busy() || connected === undefined) return;
    if (requested?.generation === connected && requested.revision === revision) return;
    requested = { generation: connected, revision };
    untracked(reload);
  });
  const ready = () => {
    const snapshot = data();
    return (
      !!snapshot && snapshot.generation === generation() && snapshot.revision === props.revision
    );
  };
  const currentCatalog = () => (!work.busy() && ready() ? data()!.catalog : null);
  const changeRuntime = async (id: string, enabled: boolean) => {
    const current = work.fence();
    if (enabled) {
      const { action } = await AlertDialog.show({
        title: tr('Confirm permissions and enable'),
        description: tr(
          'This agent runs in its native full-access mode. It can read and write files, run commands and access the network outside the Maka sandbox.',
        ),
        actions: [
          { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
          { id: 'enable', label: tr('Enable'), role: 'default' },
        ],
      });
      if (action !== 'enable') return;
    }
    if (!current()) return;
    await work.run(async () => {
      await setExternalRuntime(rpc, id, enabled);
      await load();
    });
  };
  const modelId = (connectionId: string, modelId: string) =>
    JSON.stringify([connectionId, modelId]);
  const selected = () => {
    const target = data()?.catalog.defaultTarget;
    return target ? modelId(target.connectionId, target.modelId) : '';
  };
  const currentModel = () =>
    data()?.models.find(
      (row) => modelId(row.selection.connectionId, row.selection.modelId) === selected(),
    );
  const modelOptions = () => {
    const snapshot = data();
    const labels = modelConnectionLabels(snapshot?.catalog);
    return [
      { id: '', label: tr('None') },
      ...(snapshot?.models ?? []).map((row) => ({
        id: modelId(row.selection.connectionId, row.selection.modelId),
        label: modelLabel(row.label, row.selection.connectionId, labels),
      })),
    ];
  };
  const externalStatus = () => {
    switch (data()?.external.state.kind) {
      case 'ready':
        return { label: tr('Ready'), tone: 'success' } as const;
      case 'enabled':
        return { label: tr('Enabled'), tone: 'success' } as const;
      case 'disabled':
        return { label: tr('Disabled'), tone: 'muted-foreground' } as const;
      case 'workspace_required':
        return { label: tr('Workspace required'), tone: 'warning' } as const;
      case 'unavailable':
        return { label: tr('Unavailable'), tone: 'destructive' } as const;
    }
  };
  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Models & Connections')}
      work={work}
      ready={ready()}
      reload={reload}
    >
      <InsetGroup>
        <SettingChoice
          title={tr('Default model')}
          divider={!!currentModel()?.thinkingLevels.length}
          value={selected()}
          options={modelOptions()}
          disabled={work.busy()}
          change={(id) =>
            void work.run(async () => {
              const target = data()!.models.find(
                (row) => modelId(row.selection.connectionId, row.selection.modelId) === id,
              )?.selection;
              const result = await rpc.mutate('settings', 'setDefault', {
                expectedCatalogRevision: data()!.catalog.revision,
                target: target
                  ? { connectionId: target.connectionId, modelId: target.modelId }
                  : null,
              });
              if (result.kind !== 'committed') throw new Error(result.kind);
              props.onChanged();
            })
          }
        />
        <If when={currentModel()?.thinkingLevels.length}>
          <SettingChoice
            title={tr('Default thinking level')}
            value={currentModel()?.defaultThinkingLevel ?? ''}
            options={currentModel()!.thinkingLevels.map((id) => ({ id, label: id }))}
            disabled={work.busy()}
            change={(level) =>
              void work.run(async () => {
                const target = currentModel()!.selection;
                const detail = await readConnection(rpc, target.connectionId);
                const modelOverrides = {
                  ...detail.editing.modelOverrides,
                  [target.modelId]: {
                    ...detail.editing.modelOverrides?.[target.modelId],
                    defaultThinkingLevel: level || undefined,
                  },
                };
                const result = await rpc.mutate('settings', 'update', {
                  expected: connectionBasis(detail.target),
                  changes: { modelOverrides },
                });
                if (result.kind !== 'committed') throw new Error(result.kind);
                await load();
              })
            }
          />
        </If>
      </InsetGroup>
      <InsetGroup header={tr('Connections')}>
        <Each of={data()?.catalog.rows ?? []} key={(row) => row.basis.connectionId}>
          {(row) => (
            <GroupRow
              title={row().name}
              subtitle={row().provider.name}
              value={String(row().enabledModelCount)}
              disabled={work.busy() || !row().editable}
              chevron
              divider
              onPress={() => props.openConnection(row())}
            />
          )}
        </Each>
        <GroupRow
          title={tr('Add connection')}
          tone="primary"
          chevron
          disabled={!currentCatalog()}
          onPress={() => props.openProviders(currentCatalog)}
        />
      </InsetGroup>
      <InsetGroup header={tr('External Agents')}>
        <Each of={data()?.external.runtimes ?? []} key={(row) => row.id}>
          {(row) => (
            <SettingSwitch
              title={row().name}
              checked={row().enabled}
              divider
              disabled={
                work.busy() || !activeHostInfo(props.rootId)?.endpoints.includes('management')
              }
              change={(enabled) => void changeRuntime(row().id, enabled)}
            />
          )}
        </Each>
        <If when={externalStatus()}>
          <GroupRow
            title={tr('Status')}
            trailing={
              <SettingStatus label={externalStatus()!.label} tone={externalStatus()!.tone} />
            }
          />
        </If>
      </InsetGroup>
    </SettingsForm>
  );
}

export function ProviderPicker(
  props: SettingsPageProps & {
    catalog: () => ConnectionCatalog | null;
    onSelect: (provider: Identity, catalog: ConnectionCatalog) => void;
  },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const providers = signal<Awaited<ReturnType<typeof providerCatalog>> | null>(null);
  const search = signal('');
  const matches = () =>
    (providers() ?? []).filter((row) =>
      row.label.toLowerCase().includes(search().trim().toLowerCase()),
    );
  const reload = () => void work.run(async () => providers.set(await providerCatalog(rpc)));
  reload();
  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Provider')}
      work={work}
      ready={!!providers()}
      reload={reload}
    >
      <InsetGroup>
        <SettingField
          label={tr('Search providers')}
          value={search()}
          edit={search.set}
          divider={matches().length > 0}
        />
        <Each of={matches()} key={(row) => JSON.stringify(row.identity)}>
          {(row, index) => (
            <GroupRow
              title={row().label}
              chevron
              divider={index() < matches().length - 1}
              disabled={!props.catalog()}
              onPress={() => {
                const catalog = props.catalog();
                if (catalog) props.onSelect(row().identity, catalog);
              }}
            />
          )}
        </Each>
      </InsetGroup>
    </SettingsForm>
  );
}
