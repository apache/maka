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
  NetworkProxy,
  SettingsNetworkSnapshot,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { InsetGroup } from '../../ui';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import { saveNetwork } from '../../state/settings/network';
import {
  SettingChoice,
  SettingField,
  SettingsForm,
  SettingSwitch,
  type SettingsPageProps,
} from './SettingsForm';

export function NetworkSettingsScreen(props: SettingsPageProps) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const basis = signal<SettingsNetworkSnapshot | null>(null);
  const draft = signal<NetworkProxy | null>(null);
  const port = signal('');
  const bypass = signal('');
  const password = signal('');
  cleanup(() => password.set(''));
  const accept = (value: SettingsNetworkSnapshot) => {
    basis.set(value);
    draft.set(value.proxy);
    port.set(value.proxy.port ? String(value.proxy.port) : '');
    bypass.set(value.proxy.bypassList.join('\n'));
  };
  const reload = () =>
    void work.run(async () => accept(await rpc.query('settings', 'network', {})));
  reload();
  const proxy = () => draft()!;
  const edit = (changes: Partial<NetworkProxy>) => draft.set({ ...proxy(), ...changes });
  const dirty = () =>
    !!basis() &&
    (JSON.stringify(proxy()) !== JSON.stringify(basis()!.proxy) ||
      Number(port()) !== basis()!.proxy.port ||
      bypass() !== basis()!.proxy.bypassList.join('\n') ||
      !!password());
  const invalid = () => {
    const p = Number(port());
    return (
      (proxy().enabled && (!proxy().host.trim() || p < 1)) ||
      (port() !== '' && (!/^\d+$/.test(port()) || p > 65535))
    );
  };
  const save = () => {
    if (invalid()) return work.error.set(tr('Enter a proxy host and a port from 1 to 65535.'));
    if (proxy().authEnabled && !basis()!.credential.configured && !password())
      return work.error.set(tr('Enter a proxy password.'));
    const secret = password();
    void work.run(
      async () => {
        const value = await saveNetwork(
          rpc,
          basis()!,
          {
            ...proxy(),
            host: proxy().host.trim(),
            port: Number(port()),
            bypassList: bypass()
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
          },
          secret,
        );
        password.set('');
        accept(value);
      },
      secret ? tr('Could not save the proxy password.') : undefined,
    );
  };
  return (
    <SettingsForm
      rootId={props.rootId}
      active={props.active}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('Network Proxy')}
      work={work}
      ready={!!draft()}
      reload={reload}
      dirty={dirty()}
      save={save}
    >
      <InsetGroup>
        <SettingSwitch
          title={tr('Enable proxy')}
          checked={proxy().enabled}
          disabled={work.busy()}
          divider
          change={(enabled) => edit({ enabled })}
        />
        <SettingChoice
          title={tr('Protocol')}
          divider
          value={proxy().protocol}
          disabled={work.busy()}
          options={[
            { id: 'http', label: 'HTTP' },
            { id: 'https', label: 'HTTPS' },
            { id: 'socks5', label: 'SOCKS5' },
          ]}
          change={(protocol) => edit({ protocol })}
        />
        <SettingField
          label={tr('Host')}
          value={proxy().host}
          disabled={work.busy()}
          edit={(host) => edit({ host })}
          divider
        />
        <SettingField
          label={tr('Port')}
          value={port()}
          disabled={work.busy()}
          edit={port.set}
          keyboard="number-pad"
          divider
        />
        <SettingField
          label={tr('Bypass list')}
          value={bypass()}
          disabled={work.busy()}
          edit={bypass.set}
          multiline
        />
      </InsetGroup>
      <InsetGroup
        header={tr('Authentication')}
        footer={
          basis()?.credential.configured && !proxy().authEnabled
            ? tr('Saving removes the stored password.')
            : undefined
        }
      >
        <SettingSwitch
          title={tr('Proxy authentication')}
          checked={proxy().authEnabled}
          disabled={work.busy()}
          divider={proxy().authEnabled}
          change={(authEnabled) => {
            edit({ authEnabled });
            if (!authEnabled) password.set('');
          }}
        />
        <If when={proxy().authEnabled}>
          <SettingField
            label={tr('Username')}
            value={proxy().username}
            disabled={work.busy()}
            edit={(username) => edit({ username })}
            divider
          />
          <SettingField
            label={basis()?.credential.configured ? tr('Replace password') : tr('Password')}
            value={password()}
            disabled={work.busy()}
            edit={password.set}
            secret
          />
        </If>
      </InsetGroup>
    </SettingsForm>
  );
}
