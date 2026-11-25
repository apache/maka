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

import { effect, signal, untracked, View } from 'nsh';
import { TextView } from 'nsh/base';
import type {
  AgentWorkspace,
  ConfigurationLocation,
  SkillLibraryDiscoveredSource,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import { manageSkill, readSkill, readSkills } from '../../state/settings/skills';
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
import { workspaceScope, WorkspaceScope } from './WorkspaceScope';

export type SkillTarget = { workspace: AgentWorkspace | null; reference: string; revision: string };

export function SkillsSettingsScreen(
  props: SettingsPageProps & { open: (target: SkillTarget) => void },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const scope = workspaceScope(props.rootId, work.canWrite);
  const inventory = signal<Awaited<ReturnType<typeof readSkills>> | null>(null);
  const source = signal('');
  const discovered = signal<SkillLibraryDiscoveredSource | null>(null);
  const location = signal<ConfigurationLocation | ''>('');
  const selection = signal<string[]>([]);
  const load = async () => inventory.set(await readSkills(rpc, scope.workspace(), ''));
  const reload = () =>
    void work.run(async () => {
      await scope.load();
      await load();
    });
  effect(() => {
    if (props.active?.() ?? true) untracked(reload);
  });
  const discover = () =>
    void work.run(async () => {
      const value = await rpc.query('skillLibrary', 'discoverSource', {
        workspace: scope.workspace(),
        source: source().trim(),
      });
      if (!work.canWrite()) return;
      discovered.set(value);
      selection.set([]);
      location.set(inventory()?.targets[0]?.location ?? '');
    }, tr('Could not read the skill source.'));
  const install = async () => {
    const value = discovered();
    const target = location();
    if (!value || !target || !selection().length) return;
    const current = work.fence();
    const input = {
      workspace: scope.workspace(),
      location: target,
      source: value.source,
      skills: selection(),
    };
    if (!(await confirmSettingAction(tr('Install skills?'), tr('Install'), false)) || !current())
      return;
    await work.run(async () => {
      const result = await rpc.mutate('skillLibrary', 'install', input);
      if (!work.canWrite()) return;
      const failed = result.results.filter((entry) => entry.kind === 'rejected');
      selection.set(failed.map((entry) => entry.directory));
      if (!failed.length) {
        source.set('');
        discovered.set(null);
      }
      await load();
      if (failed.length) throw new Error(tr('Some skills could not be installed.'));
    }, tr('Some skills could not be installed.'));
  };
  const group = (bundled: boolean) =>
    (inventory()?.entries ?? []).filter((entry) => entry.bundled === bundled);
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Skills')}
      work={work}
      ready={!!inventory()}
      reload={reload}
    >
      <InsetGroup>
        <WorkspaceScope
          scope={scope}
          disabled={work.busy()}
          change={(id) => {
            scope.selected.set(id);
            discovered.set(null);
            selection.set([]);
            void work.run(load);
          }}
        />
      </InsetGroup>
      <Each of={[false, true]} key={(value) => String(value)}>
        {(bundled) => (
          <If when={group(bundled()).length}>
            <InsetGroup header={bundled() ? tr('Bundled skills') : tr('Installed skills')}>
              <Each of={group(bundled())} key={(entry) => entry.reference}>
                {(entry, index) => (
                  <GroupRow
                    title={entry().name}
                    subtitle={entry().description || entry().source}
                    trailing={
                      bundled() ? (
                        <SettingStatus label={tr('Read-only')} tone="muted-foreground" />
                      ) : !entry().valid ? (
                        <SettingStatus label={tr('Unavailable')} tone="warning" />
                      ) : undefined
                    }
                    divider={index() < group(bundled()).length - 1}
                    chevron
                    disabled={work.busy()}
                    onPress={() =>
                      props.open({
                        workspace: scope.workspace(),
                        reference: entry().reference,
                        revision: inventory()!.revision,
                      })
                    }
                  />
                )}
              </Each>
            </InsetGroup>
          </If>
        )}
      </Each>
      <If when={!inventory()?.entries.length}>
        <InsetGroup>
          <GroupRow title={tr('No skills')} />
        </InsetGroup>
      </If>
      <If when={inventory()?.writable && inventory()?.targets.length}>
        <InsetGroup header={tr('Install skills')}>
          <SettingField
            label={tr('Source')}
            value={source()}
            edit={(value) => {
              source.set(value);
              discovered.set(null);
              selection.set([]);
            }}
            disabled={work.busy()}
            divider
          />
          <GroupRow
            title={tr('Find skills')}
            tone="primary"
            disabled={!source().trim() || work.busy()}
            onPress={discover}
          />
        </InsetGroup>
      </If>
      <If when={discovered()}>
        <InsetGroup>
          <SettingChoice
            title={tr('Install location')}
            value={location()}
            options={inventory()!.targets.map((target) => ({
              id: target.location,
              label: target.path,
            }))}
            change={location.set}
            disabled={work.busy()}
            divider
          />
          <Each of={discovered()?.skills ?? []} key={(row) => row.directory}>
            {(row) => (
              <SettingSwitch
                title={row().name}
                checked={selection().includes(row().directory)}
                disabled={work.busy()}
                divider
                change={(checked) =>
                  selection.update((items) =>
                    checked
                      ? [...items, row().directory]
                      : items.filter((id) => id !== row().directory),
                  )
                }
              />
            )}
          </Each>
          <GroupRow
            title={tr('Install')}
            tone="primary"
            disabled={!selection().length || work.busy()}
            onPress={() => void install()}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}

export function SkillDetailScreen(props: SettingsPageProps & { target: SkillTarget }) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const document = signal<Awaited<ReturnType<typeof readSkill>> | null>(null);
  const { workspace, reference } = props.target;
  const load = () => void work.run(async () => document.set(await readSkill(rpc, props.target)));
  load();
  const update = (enabled: boolean) =>
    void work.run(async () => {
      const current = document()!;
      const result = await rpc.mutate('skillLibrary', 'setPreference', {
        reference,
        revision: current.preferenceRevision,
        preference: { ...current.entry.preference, enabled },
      });
      if (result.kind !== 'applied') throw new Error(result.kind);
      if (work.canWrite()) props.onBack();
    });
  const manage = async (method: 'update' | 'delete') => {
    const current = work.fence();
    if (
      method === 'delete' &&
      !(await confirmSettingAction(
        tr('Delete {name}?', { name: document()!.entry.name }),
        tr('Delete'),
      ))
    )
      return;
    if (!current()) return;
    await work.run(async () => {
      await manageSkill(rpc, method, workspace, reference);
      if (work.canWrite()) props.onBack();
    });
  };
  const editable = () => document()?.writable && !document()?.entry.bundled;
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={tr('Skills')}
      title={document()?.entry.name ?? tr('Skills')}
      work={work}
      ready={!!document()}
      reload={load}
    >
      <InsetGroup footer={document()?.entry.bundled ? tr('Read-only') : document()?.entry.source}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <TextView markdown={document()!.text} selectable />
        </View>
      </InsetGroup>
      <If when={document()?.preferencesWritable && !document()?.entry.bundled}>
        <InsetGroup>
          <SettingSwitch
            title={tr('Enabled')}
            checked={document()!.entry.preference.enabled}
            disabled={work.busy()}
            change={update}
          />
        </InsetGroup>
      </If>
      <If when={editable()}>
        <InsetGroup>
          <If when={document()?.entry.installation}>
            <GroupRow
              title={tr('Update')}
              tone="primary"
              divider
              disabled={work.busy()}
              onPress={() => void manage('update')}
            />
          </If>
          <GroupRow
            title={tr('Delete')}
            tone="destructive"
            disabled={work.busy()}
            onPress={() => void manage('delete')}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}
