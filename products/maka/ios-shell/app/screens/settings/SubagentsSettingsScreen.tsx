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
import type { ServiceMethods } from '../../../../../../packages/plugin-sdk/src/generated/methods';
import { thinkingLevelLabel, tr } from '../../locale';
import { activeHostInfo } from '../../state/hostPool';
import {
  loadModelCatalog,
  modelChoices,
  modelConnectionLabels,
  modelLabel,
} from '../../state/settings/models';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import {
  deletePreset,
  savePreset,
  type Preset,
  type PresetDraft,
} from '../../state/settings/subagents';
import { GroupRow, InsetGroup } from '../../ui';
import {
  confirmSettingAction,
  SettingChoice,
  SettingField,
  SettingStatus,
  SettingSwitch,
  SettingsForm,
  type SettingsPageProps,
} from './SettingsForm';

export function SubagentsSettingsScreen(
  props: SettingsPageProps & { open: (presetId: string | null) => void },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const snapshot = signal<{
    generation: number;
    presets: ServiceMethods['agent']['presets']['output'];
  } | null>(null);
  const generation = () => activeHostInfo(props.rootId)?.generation;
  const ready = () => snapshot() !== null && snapshot()?.generation === generation();
  const labels = signal<ReadonlyMap<string, string>>(new Map());
  const modelNames = signal<ReadonlyMap<string, string>>(new Map());
  const reload = () =>
    void work.run(async () => {
      const started = generation();
      if (started === undefined) return;
      const current = work.fence();
      const catalog = loadModelCatalog(rpc);
      const choices = modelChoices(rpc).catch((cause) => {
        console.warn('Subagent model names unavailable', cause);
        return [];
      });
      const presets = await rpc.query('agent', 'presets', {});
      if (!current()) return;
      if (snapshot()?.generation !== started) {
        labels.set(new Map());
        modelNames.set(new Map());
      }
      snapshot.set({ generation: started, presets });
      const [metadata, models] = await Promise.all([catalog, choices]);
      if (!current()) return;
      labels.set(modelConnectionLabels(metadata));
      modelNames.set(
        new Map(models.map(({ selection, label }) => [modelDisplayKey(selection), label])),
      );
    });
  const presetModelLabel = (model: PresetDraft['model']) =>
    modelLabel(
      modelNames().get(modelDisplayKey(model)) ?? model.modelId,
      model.connectionId,
      labels(),
    );
  let requested: number | undefined;
  effect(() => {
    if (props.active?.() === false) {
      requested = undefined;
      return;
    }
    const connected = generation();
    if (connected === undefined || work.busy() || requested === connected) return;
    requested = connected;
    untracked(reload);
  });
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Subagents')}
      work={work}
      ready={ready()}
      initialList={!snapshot()}
      reload={reload}
    >
      <InsetGroup>
        <Each of={snapshot()?.presets ?? []} key={(preset) => preset.id}>
          {(preset) => (
            <GroupRow
              title={preset().name}
              subtitle={[
                preset().description,
                [
                  presetModelLabel(preset().model),
                  preset().thinkingLevel == null
                    ? null
                    : thinkingLevelLabel(preset().thinkingLevel!),
                ]
                  .filter(Boolean)
                  .join(' · '),
              ]
                .filter(Boolean)
                .join('\n')}
              trailing={
                !preset().enabled ? (
                  <SettingStatus tone="muted-foreground" label={tr('Disabled')} />
                ) : preset().availability.kind !== 'available' ? (
                  <SettingStatus tone="warning" label={tr('Unavailable')} />
                ) : undefined
              }
              chevron
              divider
              disabled={work.busy()}
              onPress={() => props.open(preset().id)}
            />
          )}
        </Each>
        <GroupRow
          title={tr('Add subagent')}
          tone="primary"
          disabled={work.busy()}
          onPress={() => props.open(null)}
        />
      </InsetGroup>
    </SettingsForm>
  );
}

const modelDisplayKey = (model: PresetDraft['model']) =>
  JSON.stringify([model.connectionId, model.modelId]);

export function SubagentEditor(props: SettingsPageProps & { presetId: string | null }) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const original = signal<Preset | null>(null);
  const draft = signal<PresetDraft | null>(null);
  const inventory = signal<{
    choices: Awaited<ReturnType<typeof modelChoices>>;
    labels: ReadonlyMap<string, string>;
  } | null>(null);
  const models = () => inventory()?.choices ?? [];
  let baseline = '';
  const load = () =>
    void work.run(async () => {
      const [detail, choices, catalog] = await Promise.all([
        props.presetId ? rpc.query('agent', 'preset', { id: props.presetId }) : null,
        modelChoices(rpc),
        loadModelCatalog(rpc),
      ]);
      if (props.presetId && !detail) throw new Error(tr('Unavailable'));
      const old = detail?.preset;
      const first = choices[0]?.selection;
      const value: PresetDraft = old
        ? {
            name: old.name,
            description: old.description,
            instruction: old.instruction,
            model: old.model,
            thinkingLevel: old.thinkingLevel ?? null,
            enabled: old.enabled,
          }
        : {
            name: '',
            description: '',
            instruction: '',
            model: first ?? { connectionId: '', modelId: '' },
            thinkingLevel: null,
            enabled: true,
          };
      baseline = JSON.stringify(value);
      original.set(old ?? null);
      inventory.set({ choices, labels: modelConnectionLabels(catalog) });
      draft.set(value);
    });
  load();
  const edit = (changes: Partial<PresetDraft>) =>
    draft.update((value) => ({ ...value!, ...changes }));
  const choiceLabel = (label: string, connectionId: string) =>
    modelLabel(label, connectionId, inventory()!.labels);
  const currentModel = () =>
    models().find(
      ({ selection }) => modelDisplayKey(selection) === modelDisplayKey(draft()!.model),
    );
  const dirty = () => !!draft() && JSON.stringify(draft()) !== baseline;
  const save = () =>
    void work.run(async () => {
      const value = draft()!;
      if (!value.name.trim() || !value.model.modelId)
        throw new Error(tr('Enter a name and select a model.'));
      await savePreset(rpc, { ...value, name: value.name.trim() }, original());
      if (work.canWrite()) props.onBack();
    });
  const remove = async () => {
    const preset = original()!;
    const current = work.fence();
    if (
      !(await confirmSettingAction(tr('Delete {name}?', { name: preset.name }), tr('Delete'))) ||
      !current()
    )
      return;
    await work.run(async () => {
      await deletePreset(rpc, preset);
      if (work.canWrite()) props.onBack();
    });
  };
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      title={original()?.name ?? tr('Add subagent')}
      onBack={props.onBack}
      backLabel={tr('Subagents')}
      work={work}
      ready={!!draft()}
      reload={load}
      dirty={dirty()}
      save={save}
    >
      <InsetGroup>
        <SettingField
          label={tr('Name')}
          value={draft()!.name}
          edit={(name) => edit({ name })}
          disabled={work.busy()}
          divider
        />
        <SettingField
          label={tr('Description')}
          value={draft()!.description}
          edit={(description) => edit({ description })}
          disabled={work.busy()}
          divider
        />
        <SettingField
          label={tr('Instructions')}
          value={draft()!.instruction}
          edit={(instruction) => edit({ instruction })}
          multiline
          disabled={work.busy()}
          divider
        />
        <SettingSwitch
          title={tr('Enabled')}
          checked={draft()!.enabled}
          disabled={work.busy()}
          change={(enabled) => edit({ enabled })}
        />
      </InsetGroup>
      <InsetGroup>
        <SettingChoice
          title={tr('Model')}
          value={modelDisplayKey(draft()!.model)}
          options={[
            ...(!currentModel() && draft()!.model.modelId
              ? [
                  {
                    id: modelDisplayKey(draft()!.model),
                    label: choiceLabel(draft()!.model.modelId, draft()!.model.connectionId),
                  },
                ]
              : []),
            ...models().map(({ selection, label }) => ({
              id: modelDisplayKey(selection),
              label: choiceLabel(label, selection.connectionId),
            })),
          ]}
          disabled={work.busy()}
          divider={!!currentModel()?.thinkingLevels.length}
          change={(id) => {
            if (id === modelDisplayKey(draft()!.model)) return;
            const model = models().find(({ selection }) => modelDisplayKey(selection) === id);
            if (model) edit({ model: model.selection, thinkingLevel: null });
          }}
        />
        <If when={currentModel()?.thinkingLevels.length}>
          <SettingChoice
            title={tr('Default thinking level')}
            value={draft()!.thinkingLevel ?? ''}
            options={[
              { id: '', label: tr('Default') },
              ...currentModel()!.thinkingLevels.map((id) => ({
                id,
                label: thinkingLevelLabel(id),
              })),
            ]}
            disabled={work.busy()}
            change={(level) => edit({ thinkingLevel: level || null })}
          />
        </If>
      </InsetGroup>
      <If when={original()}>
        <InsetGroup>
          <GroupRow
            title={tr('Delete')}
            tone="destructive"
            disabled={work.busy()}
            onPress={() => void remove()}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}
