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

import { LoadingIndicator } from './Loading';
import { inputAction } from 'nsh';
import { tr } from './locale';
import type { ProxyProtocol } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { NetworkSettingsOwner } from './networkSettingsState.ts';
import {
  SettingsBody,
  SettingsButton,
  SettingsDiscard,
  SettingsInput,
  SettingsLede,
  SettingsProblem,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';

const protocols: ProxyProtocol[] = ['http', 'https', 'socks5'];

export function NetworkSettings(props: { owner: NetworkSettingsOwner }) {
  const owner = props.owner;
  return (
    <If
      when={!owner.discarding.asking()}
      else={<SettingsDiscard onDiscard={owner.discarding.discard} onKeep={owner.discarding.keep} />}
    >
      <NetworkForm owner={owner} />
    </If>
  );
}

function NetworkForm(props: { owner: NetworkSettingsOwner }) {
  const owner = props.owner;
  const value = () => owner.draft()!;
  const disabled = () => owner.disabled();
  const choose = (choice: Parameters<NetworkSettingsOwner['choose']>[0]) => owner.choose(choice);
  return (
    <If
      when={owner.draft() && owner.snapshot()}
      else={
        <SettingsBody>
          <If
            when={owner.loading()}
            else={<SettingsProblem retry={inputAction(owner.reload, owner.action())} />}
          >
            <LoadingIndicator label={tr('Loading network settings…')} />
          </If>
        </SettingsBody>
      }
    >
      <SettingsBody
        footer={
          owner.dirty() ? (
            <>
              <SettingsButton
                label={tr('Discard')}
                accessibilityLabel={tr('Reload network settings')}
                tone="quiet"
                disabled={disabled()}
                onPress={inputAction(owner.reload, owner.action())}
              />
              <SettingsButton
                label={tr('Save')}
                accessibilityLabel={tr('Save network settings')}
                tone="primary"
                disabled={disabled()}
                onPress={inputAction(owner.save, owner.action())}
              />
            </>
          ) : undefined
        }
      >
        <SettingsLede>
          {tr('Applies to new requests. Requests already running keep their settings.')}
        </SettingsLede>
        <SettingsSection>
          <SettingsSwitch
            label={tr('Proxy')}
            checked={value().proxy.enabled}
            disabled={disabled()}
            onPress={() =>
              choose({ ...owner.action(), kind: 'enabled', value: !value().proxy.enabled })
            }
          />
          <SettingsSelect
            label={tr('Protocol')}
            value={value().proxy.protocol}
            disabled={disabled()}
            choices={protocols.map((protocol) => ({ value: protocol, title: protocol }))}
            change={(protocol) =>
              choose({ ...owner.action(), kind: 'protocol', value: protocol as ProxyProtocol })
            }
          />
          <SettingsInput
            label={tr('Proxy host')}
            description={tr('Hostname or IP address; enter the port separately.')}
            value={value().proxy.host}
            disabled={disabled()}
            change={(text) => owner.edit('host', text)}
          />
          <SettingsInput
            label={tr('Proxy port')}
            value={value().port}
            disabled={disabled()}
            change={(text) => owner.edit('port', text)}
          />
        </SettingsSection>
        <SettingsSection
          note={
            value().proxy.authEnabled
              ? owner.snapshot()?.credential.configured
                ? tr('A proxy password is stored. Its value is never read back.')
                : tr('No proxy password is stored.')
              : tr('Saving with proxy authentication disabled deletes its stored password.')
          }
        >
          <SettingsSwitch
            label={tr('Proxy authentication')}
            checked={value().proxy.authEnabled}
            disabled={disabled()}
            onPress={() =>
              choose({
                ...owner.action(),
                kind: 'authentication',
                value: !value().proxy.authEnabled,
              })
            }
          />
          <If when={value().proxy.authEnabled}>
            <SettingsInput
              label={tr('Proxy username')}
              value={value().proxy.username}
              disabled={disabled()}
              change={(text) => owner.edit('username', text)}
            />
            <SettingsSelect
              label={tr('Proxy password')}
              value={value().credential === 'replace' ? 'replace' : 'keep'}
              disabled={disabled()}
              choices={[
                { value: 'keep', title: tr('Keep stored password') },
                { value: 'replace', title: tr('Replace password') },
              ]}
              change={(credential) =>
                choose({
                  ...owner.action(),
                  kind: 'credential',
                  value: credential as 'keep' | 'replace',
                })
              }
            />
            <If when={value().credential === 'replace'}>
              <SettingsInput
                label={tr('New password')}
                description={tr('Stored securely, separately from your proxy settings.')}
                value={value().secret}
                masked
                disabled={disabled()}
                change={(text) => owner.edit('secret', text)}
              />
            </If>
          </If>
        </SettingsSection>
        <SettingsSection
          title={tr('Proxy bypass rules')}
          note={
            owner.snapshot()!.proxy.autoBypassDomains.length > 0
              ? tr('Automatic bypass: {domains}', {
                  domains: owner.snapshot()!.proxy.autoBypassDomains.join(', '),
                })
              : tr('One bypass rule per line. Automatic rules are retained.')
          }
        >
          <SettingsTextArea
            label={tr('Proxy bypass rules')}
            value={value().bypass}
            lines={5}
            monospace
            disabled={disabled()}
            change={(text) => owner.edit('bypass', text)}
          />
        </SettingsSection>
      </SettingsBody>
    </If>
  );
}
