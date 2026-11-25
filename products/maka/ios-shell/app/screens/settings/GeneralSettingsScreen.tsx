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
import { tr } from '../../locale';
import { InsetGroup, GroupRow } from '../../ui';
import { readGeneral, saveInstructions, savePreference } from '../../state/settings/general';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import type { SettingsPreferencesMutation } from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import {
  SettingChoice,
  SettingField,
  SettingsForm,
  SettingSwitch,
  type SettingsPageProps,
} from './SettingsForm';

export function GeneralSettingsScreen(props: SettingsPageProps) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const data = signal<Awaited<ReturnType<typeof readGeneral>> | null>(null);
  const instructions = signal('');
  const prompt = signal('');
  const useDefaultPrompt = signal(false);
  const load = async () => {
    const next = await readGeneral(rpc);
    data.set(next);
    instructions.set(next.instructions.kind === 'available' ? next.instructions.content : '');
    prompt.set(next.preferences.compactionPrompt);
    useDefaultPrompt.set(
      next.preferences.compactionPrompt === next.preferences.defaultCompactionPrompt,
    );
  };
  const reload = () => void work.run(load);
  reload();
  const preferences = () => data()!.preferences;
  const basis = () => data()?.instructions;
  const customPromptChanged = () =>
    useDefaultPrompt()
      ? preferences().compactionPrompt !== preferences().defaultCompactionPrompt
      : prompt() !== preferences().compactionPrompt;
  const dirty = () => {
    const doc = basis();
    return (
      !!data() &&
      ((doc?.kind === 'available' && doc.content !== instructions()) || customPromptChanged())
    );
  };
  const change = (mutation: SettingsPreferencesMutation) =>
    work.run(async () => {
      const next = await savePreference(rpc, preferences(), mutation);
      data.update((prev) => ({ ...prev!, preferences: next }));
    });
  const save = () =>
    void work.run(async () => {
      const doc = basis();
      if (doc?.kind === 'available' && doc.content !== instructions()) {
        await saveInstructions(rpc, doc, instructions());
        const updated = await rpc.query('agent', 'globalInstructions', {});
        data.update((prev) => ({ ...prev!, instructions: updated }));
      }
      if (work.canWrite() && customPromptChanged()) {
        const next = await savePreference(rpc, preferences(), {
          kind: 'compaction_prompt',
          prompt: useDefaultPrompt() ? null : prompt().trim() || null,
        });
        data.update((prev) => ({ ...prev!, preferences: next }));
        prompt.set(next.compactionPrompt);
        useDefaultPrompt.set(next.compactionPrompt === next.defaultCompactionPrompt);
      }
    });

  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('General')}
      work={work}
      ready={!!data()}
      reload={reload}
      dirty={dirty()}
      save={save}
    >
      <InsetGroup>
        <SettingChoice
          title={tr('Assistant language')}
          divider
          value={preferences().language ?? 'auto'}
          options={[
            { id: 'auto', label: tr('System') },
            { id: 'en', label: 'English' },
            { id: 'zh-CN', label: '简体中文' },
            { id: 'zh-TW', label: '繁體中文' },
          ]}
          disabled={work.busy()}
          change={(preference) => void change({ kind: 'language', preference })}
        />
        <SettingChoice
          title={tr('Default sandbox mode')}
          divider
          value={preferences().defaultSandboxMode}
          options={[
            { id: 'read-only', label: tr('Read-only') },
            { id: 'workspace-write', label: tr('Workspace write') },
            { id: 'danger-full-access', label: tr('Full access') },
          ]}
          disabled={work.busy()}
          change={(mode) => void change({ kind: 'default_sandbox', mode })}
        />
        <SettingSwitch
          title={tr('Automatic terminal titles')}
          checked={preferences().shell.titles}
          disabled={work.busy()}
          divider
          change={(titles) =>
            void change({ kind: 'shell', value: { ...preferences().shell, titles } })
          }
        />
        <SettingSwitch
          title={tr('Message predictions')}
          checked={preferences().predictions.enabled}
          disabled={work.busy()}
          change={(enabled) =>
            void change({
              kind: 'message_predictions',
              settings: { ...preferences().predictions, enabled },
            })
          }
        />
      </InsetGroup>
      <InsetGroup>
        <SettingSwitch
          title={tr('Workspace instructions')}
          checked={preferences().workspaceInstructions}
          disabled={work.busy()}
          divider
          change={(enabled) => void change({ kind: 'workspace_instructions', enabled })}
        />
        <If
          when={basis()?.kind === 'available'}
          else={<GroupRow title={tr('Source unavailable')} />}
        >
          <SettingField
            label="AGENTS.md"
            multiline
            value={instructions()}
            edit={instructions.set}
            disabled={work.busy()}
          />
        </If>
      </InsetGroup>
      <InsetGroup>
        <SettingField
          label={tr('Compaction prompt')}
          multiline
          value={useDefaultPrompt() ? preferences().defaultCompactionPrompt : prompt()}
          edit={prompt.set}
          disabled={work.busy() || useDefaultPrompt()}
          divider
        />
        <SettingSwitch
          title={tr('Use Host default')}
          checked={useDefaultPrompt()}
          disabled={work.busy()}
          change={useDefaultPrompt.set}
        />
      </InsetGroup>
    </SettingsForm>
  );
}
