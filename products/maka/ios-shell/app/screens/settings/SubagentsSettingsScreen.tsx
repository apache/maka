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
import { tr } from '../../locale';
import { modelChoices } from '../../state/settings/models';
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
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const rows = signal<ServiceMethods['agent']['presets']['output'] | null>(null);
  const reload = () => void work.run(async () => rows.set(await rpc.query('agent', 'presets', {})));
  effect(() => {
    if (props.active?.() ?? true) untracked(reload);
  });
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Subagents')}
      work={work}
      ready={rows() !== null}
      reload={reload}
    >
      <InsetGroup>
        <Each of={rows() ?? []} key={(preset) => preset.id}>
          {(preset) => (
            <GroupRow
              title={preset().name}
              subtitle={[
                preset().description,
                [preset().model.modelId, preset().thinkingLevel].filter(Boolean).join(' · '),
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

const modelKey = (model: PresetDraft['model']) =>
  JSON.stringify([model.connectionId, model.modelId, model.serviceTier ?? null]);

export function SubagentEditor(props: SettingsPageProps & { presetId: string | null }) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const original = signal<Preset | null>(null);
  const draft = signal<PresetDraft | null>(null);
  const models = signal<Awaited<ReturnType<typeof modelChoices>>>([]);
  let baseline = '';
  const load = () =>
    void work.run(async () => {
      const [detail, choices] = await Promise.all([
        props.presetId ? rpc.query('agent', 'preset', { id: props.presetId }) : null,
        modelChoices(rpc),
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
      models.set(choices);
      draft.set(value);
    });
  load();
  const edit = (changes: Partial<PresetDraft>) =>
    draft.update((value) => ({ ...value!, ...changes }));
  const currentModel = () =>
    models().find(({ selection }) => modelKey(selection) === modelKey(draft()!.model));
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
          value={modelKey(draft()!.model)}
          options={[
            ...(!currentModel() && draft()!.model.modelId
              ? [{ id: modelKey(draft()!.model), label: draft()!.model.modelId }]
              : []),
            ...models().map(({ selection, label }) => ({ id: modelKey(selection), label })),
          ]}
          disabled={work.busy()}
          divider={!!currentModel()?.thinkingLevels.length}
          change={(id) => {
            const model = models().find(({ selection }) => modelKey(selection) === id);
            if (model) edit({ model: model.selection, thinkingLevel: null });
          }}
        />
        <If when={currentModel()?.thinkingLevels.length}>
          <SettingChoice
            title={tr('Default thinking level')}
            value={draft()!.thinkingLevel ?? ''}
            options={[
              { id: '', label: tr('Default') },
              ...currentModel()!.thinkingLevels.map((id) => ({ id, label: id })),
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
