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

import { signal } from 'nsh';
import type {
  ModelOverride,
  ThinkingLevel,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { InsetGroup } from '../../ui';
import { connectionBasis, readConnection } from '../../state/settings/models';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import {
  SettingChoice,
  SettingField,
  SettingsForm,
  SettingSwitch,
  type SettingsPageProps,
} from './SettingsForm';

const limitKeys = [
  'contextWindow',
  'inputLimit',
  'maxOutputTokens',
  'compactionThreshold',
] as const;

export function ConnectionModelScreen(
  props: SettingsPageProps & { connectionId: string; modelId: string; onSaved: () => void },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const detail = signal<Awaited<ReturnType<typeof readConnection>> | null>(null);
  const draft = signal<ModelOverride>({});
  const limits = signal({
    contextWindow: '',
    inputLimit: '',
    maxOutputTokens: '',
    compactionThreshold: '',
  });
  const thinkingLevels = signal<ThinkingLevel[]>([]);
  const enabled = signal(false);
  const original = () => detail()?.editing.modelOverrides?.[props.modelId] ?? {};
  const load = async () => {
    const value = await readConnection(rpc, props.connectionId);
    const resolved = await rpc.query('settings', 'resolveModel', {
      connectionId: props.connectionId,
      modelId: props.modelId,
    });
    detail.set(value);
    draft.set(original());
    enabled.set(value.editing.enabledModelIds.includes(props.modelId));
    limits.set(
      Object.fromEntries(
        limitKeys.map((key) => [key, String(original()[key] ?? '')]),
      ) as ReturnType<typeof limits>,
    );
    thinkingLevels.set(resolved.kind === 'ready' ? [...resolved.choice.thinkingLevels] : []);
  };
  const reload = () => void work.run(load);
  reload();
  const edit = (change: Partial<ModelOverride>) =>
    draft.update((value) => ({ ...value, ...change }));
  const dirty = () =>
    !!detail() &&
    (enabled() !== detail()!.editing.enabledModelIds.includes(props.modelId) ||
      JSON.stringify(draft()) !== JSON.stringify(original()) ||
      limitKeys.some((key) => limits()[key] !== String(original()[key] ?? '')));
  const save = () =>
    void work.run(async () => {
      const model = { ...draft() };
      for (const key of limitKeys) {
        const value = limits()[key].trim();
        delete model[key];
        if (!value) continue;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
          throw new Error(tr('Token limits must be positive whole numbers.'));
        model[key] = Number(value);
      }
      const facts = detail()!;
      const ids = new Set(facts.editing.enabledModelIds);
      if (enabled()) ids.add(props.modelId);
      else ids.delete(props.modelId);
      const result = await rpc.mutate('settings', 'update', {
        expected: connectionBasis(facts.target),
        changes: {
          enabledModelIds: [...ids],
          modelOverrides: { ...facts.editing.modelOverrides, [props.modelId]: model },
        },
      });
      if (result.kind !== 'committed') throw new Error(result.kind);
      props.onSaved();
      if (work.canWrite()) props.onBack();
    });
  const labels = () => ({
    contextWindow: tr('Context window'),
    inputLimit: tr('Input limit'),
    maxOutputTokens: tr('Max output tokens'),
    compactionThreshold: tr('Compaction threshold'),
  });
  return (
    <SettingsForm
      rootId={props.rootId}
      backLabel={props.backLabel}
      active={props.active}
      onBack={props.onBack}
      title={props.modelId}
      work={work}
      ready={!!detail()}
      reload={reload}
      dirty={dirty()}
      save={save}
    >
      <InsetGroup header={tr('Model')}>
        <SettingField
          label={tr('Name')}
          value={draft().displayName ?? ''}
          edit={(displayName) => edit({ displayName: displayName || undefined })}
          disabled={work.busy()}
          divider
        />
        <SettingSwitch
          title={tr('Enabled')}
          checked={enabled()}
          change={enabled.set}
          disabled={work.busy()}
          divider
        />
        <If when={thinkingLevels().length > 0}>
          <SettingChoice
            title={tr('Default thinking level')}
            value={draft().defaultThinkingLevel ?? ''}
            options={[
              { id: '', label: tr('Default') },
              ...thinkingLevels().map((id) => ({ id, label: id })),
            ]}
            disabled={work.busy()}
            change={(level) => edit({ defaultThinkingLevel: level || undefined })}
          />
        </If>
        <SettingSwitch
          title={tr('Code Mode')}
          checked={draft().codeMode ?? true}
          change={(codeMode) => edit({ codeMode })}
          disabled={work.busy()}
          divider
        />
        <SettingSwitch
          title={tr('Apply Patch')}
          checked={draft().applyPatch ?? false}
          change={(applyPatch) => edit({ applyPatch })}
          disabled={work.busy()}
        />
      </InsetGroup>
      <InsetGroup header={tr('Token limits')}>
        <Each of={[...limitKeys]} key={(key) => key}>
          {(key, index) => (
            <SettingField
              label={labels()[key()]}
              value={limits()[key()]}
              edit={(value) => limits.update((prev) => ({ ...prev, [key()]: value }))}
              keyboard="number-pad"
              disabled={work.busy()}
              divider={index() < limitKeys.length - 1}
            />
          )}
        </Each>
      </InsetGroup>
    </SettingsForm>
  );
}
