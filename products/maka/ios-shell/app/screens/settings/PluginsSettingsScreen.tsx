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
import type { PackageRef } from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import {
  activatePlugin,
  committed,
  downloadPlugin,
  readPlugin,
  readPlugins,
} from '../../state/settings/plugins';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
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

export function PluginsSettingsScreen(
  props: SettingsPageProps & { open: (instance: string[]) => void },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const inventory = signal<Awaited<ReturnType<typeof readPlugins>> | null>(null);
  const packages = signal<PackageRef[]>([]);
  const url = signal('');
  const use = signal<'host' | 'ui' | 'composition'>('ui');
  const load = async () => {
    const [rows, deployment] = await Promise.all([
      readPlugins(rpc),
      rpc.query('deploymentManager', 'read', {}),
    ]);
    if (rows.source.revision !== deployment.source.reference.revision)
      throw new Error(tr('Refresh and try again.'));
    inventory.set(rows);
    packages.set(
      deployment.packages.filter(
        (pkg) =>
          !rows.rows.some(
            (row) => row.package.id === pkg.id && row.package.revision === pkg.revision,
          ),
      ),
    );
  };
  const reload = () => void work.run(load);
  effect(() => {
    if (props.active?.() ?? true) untracked(reload);
  });
  const install = async () => {
    const address = url().trim();
    // Avoid sending signed URLs or userinfo as an ordinary settings draft.
    if (!/^https:\/\/[^/?#@]+\/[^?#]+$/i.test(address)) {
      work.error.set(tr('Enter a public HTTPS URL.'));
      return;
    }
    const current = work.fence();
    const source = inventory()!.source;
    const kind = use();
    if (
      !(await confirmSettingAction(
        tr('Install from URL'),
        tr('Install'),
        false,
        tr('This changes the deployment on the selected computer.'),
      )) ||
      !current()
    )
      return;
    await work.run(async () => {
      const downloaded = await downloadPlugin(rpc, source, address);
      if (!work.canWrite()) return;
      url.set('');
      const id = downloaded.package.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!inventory()!.rows.some(({ package: pkg }) => pkg.id === downloaded.package.id)) {
        await activatePlugin(rpc, downloaded.source, 'ios-' + id, downloaded.package, kind);
      }
      if (work.canWrite()) await load();
    }, tr('Could not install the plugin.'));
  };
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Plugins')}
      work={work}
      ready={!!inventory()}
      reload={reload}
      dirty={!!url()}
    >
      <InsetGroup header={tr('Installed plugins')}>
        <If when={inventory()?.rows.length === 0}>
          <GroupRow title={tr('None')} />
        </If>
        <Each of={inventory()?.rows ?? []} key={(row) => JSON.stringify(row.instance)}>
          {(row, index) => (
            <GroupRow
              title={row().presentation?.displayName ?? row().path.join(' / ')}
              subtitle={row().package.id}
              trailing={
                <SettingStatus
                  label={row().disabled || row().parentDisabled ? tr('Disabled') : tr('Enabled')}
                  tone={row().disabled || row().parentDisabled ? 'muted-foreground' : 'success'}
                />
              }
              chevron
              divider={index() < inventory()!.rows.length - 1}
              disabled={work.busy()}
              onPress={() => props.open(row().instance)}
            />
          )}
        </Each>
      </InsetGroup>
      <InsetGroup header={tr('Install from URL')}>
        <SettingField
          label="URL"
          value={url()}
          edit={url.set}
          keyboard="url"
          disabled={work.busy()}
          divider
        />
        <SettingChoice
          title={tr('Package entry')}
          value={use()}
          options={[
            { id: 'ui', label: 'UI' },
            { id: 'host', label: tr('Host') },
            { id: 'composition', label: tr('Composition') },
          ]}
          change={use.set}
          disabled={work.busy()}
          divider
        />
        <GroupRow
          title={tr('Install')}
          tone="primary"
          disabled={work.busy() || !url().trim()}
          onPress={() => void install()}
        />
      </InsetGroup>
      <If when={packages().length}>
        <InsetGroup header={tr('Inactive packages')}>
          <Each of={packages()} key={(pkg) => pkg.id + '@' + pkg.revision}>
            {(pkg, index) => (
              <GroupRow
                title={pkg().id}
                subtitle={pkg().revision}
                divider={index() < packages().length - 1}
              />
            )}
          </Each>
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}

export function PluginDetailScreen(props: SettingsPageProps & { instance: string[] }) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.canWrite);
  const details = signal<Awaited<ReturnType<typeof readPlugin>> | null>(null);
  const load = async () => details.set(await readPlugin(rpc, props.instance));
  const reload = () => void work.run(load);
  reload();
  const title = () =>
    details()?.row.presentation?.displayName ?? details()?.row.path.join(' / ') ?? tr('Plugins');
  const removable = () => details()?.row.path.length === 1 && !details()?.row.structural;
  const toggle = (enabled: boolean) =>
    void work.run(async () => {
      committed(
        await rpc.mutate('deploymentManager', 'setEnabled', {
          expectedRevision: details()!.source.revision,
          instance: props.instance,
          enabled,
        }),
      );
      if (work.canWrite()) await load();
    });
  const remove = async () => {
    const value = details()!;
    const current = work.fence();
    if (
      !(await confirmSettingAction(tr('Remove {name}?', { name: title() }), tr('Remove'))) ||
      !current()
    )
      return;
    await work.run(async () => {
      committed(
        await rpc.mutate('deploymentManager', 'editComposition', {
          expectedRevision: value.source.revision,
          edits: [{ kind: 'remove', name: value.row.path[0] }],
        }),
      );
      if (work.canWrite()) props.onBack();
    });
  };
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={tr('Plugins')}
      title={title()}
      work={work}
      ready={!!details()}
      reload={reload}
    >
      <InsetGroup>
        <GroupRow
          title={details()!.row.package.id}
          subtitle={details()!.row.package.revision}
          divider
        />
        <SettingSwitch
          title={tr('Enabled')}
          checked={!details()!.row.disabled && !details()!.row.parentDisabled}
          disabled={work.busy() || details()!.row.parentDisabled}
          change={toggle}
        />
      </InsetGroup>
      <If when={details()?.fields.length}>
        <InsetGroup header={tr('Package settings')}>
          <Each of={details()?.fields ?? []} key={(field) => field.key}>
            {(field, index) => (
              <GroupRow
                title={field().label}
                subtitle={field().description || undefined}
                value={field().present ? tr('Configured') : undefined}
                divider={index() < details()!.fields.length - 1}
              />
            )}
          </Each>
        </InsetGroup>
      </If>
      <If when={details()?.bindings.length}>
        <InsetGroup header={tr('Bindings')}>
          <Each of={details()?.bindings ?? []} key={(name) => name}>
            {(name, index) => (
              <GroupRow title={name()} divider={index() < details()!.bindings.length - 1} />
            )}
          </Each>
        </InsetGroup>
      </If>
      <If when={removable()}>
        <InsetGroup>
          <GroupRow
            title={tr('Remove')}
            tone="destructive"
            disabled={work.busy()}
            onPress={() => void remove()}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}
