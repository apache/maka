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

import { inputAction, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { tr } from './locale';
import type { ProxyProtocol } from '../../../../packages/plugin-sdk/src/generated/runtime';
import { SettingsField } from './SettingsField';
import { ChoiceIndicator } from './ChoiceIndicator';
import type { NetworkSettingsOwner } from './networkSettings.ts';
import {
  bodyTextStyle,
  captionTextStyle,
  C,
  controlStyle,
  controlHoverStyle,
  fieldBoxStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function NetworkSettings(props: { owner: NetworkSettingsOwner }) {
  const owner = props.owner;
  const value = () => owner.draft()!;
  const disabled = () => owner.disabled();
  const protocols: ProxyProtocol[] = ['http', 'https', 'socks5'];
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <If when={owner.loading()}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Loading network settings…')}</Text>
      </If>
      <If when={owner.draft() && owner.snapshot()}>
        <Scroll style={{ flex: 1, minHeight: 0 }}>
          <View style={{ gap: 12, padding: 8 }}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Applies to new requests. Requests already running keep their settings.')}
            </Text>
            <Button
              disabled={disabled()}
              selected={value().proxy.enabled}
              accessibilityLabel={tr('Enable Host proxy')}
              onPress={inputAction(owner.choose, {
                ...owner.action(),
                kind: 'enabled',
                value: !value().proxy.enabled,
              })}
              style={{
                ...controlStyle,
                ...fieldBoxStyle,
                minHeight: 40,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>{tr('Proxy')}</Text>
              <ChoiceIndicator
                kind="switch"
                checked={value().proxy.enabled}
                disabled={disabled()}
              />
            </Button>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Each of={protocols} key={(protocol) => protocol}>
                {(protocol) => (
                  <Button
                    disabled={disabled()}
                    selected={value().proxy.protocol === protocol()}
                    accessibilityLabel={tr('Proxy protocol {protocol}', { protocol: protocol() })}
                    onPress={inputAction(owner.choose, {
                      ...owner.action(),
                      kind: 'protocol',
                      value: protocol(),
                    })}
                    style={{
                      ...controlStyle,
                      minHeight: 40,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    selectedStyle={{ backgroundColor: C.raised }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={value().proxy.protocol === protocol()}
                      disabled={disabled()}
                    />
                    <Text style={{ ...bodyTextStyle, color: C.text }}>{protocol()}</Text>
                  </Button>
                )}
              </Each>
            </View>
            <SettingsField
              label={tr('Proxy host')}
              value={value().proxy.host}
              disabled={disabled()}
              change={(text) => owner.edit('host', text)}
              hint={tr('Hostname or IP address; enter the port separately.')}
            />
            <SettingsField
              label={tr('Proxy port')}
              value={value().port}
              disabled={disabled()}
              change={(text) => owner.edit('port', text)}
            />
            <Button
              disabled={disabled()}
              selected={value().proxy.authEnabled}
              accessibilityLabel={tr('Enable proxy authentication')}
              onPress={inputAction(owner.choose, {
                ...owner.action(),
                kind: 'authentication',
                value: !value().proxy.authEnabled,
              })}
              style={{
                ...controlStyle,
                ...fieldBoxStyle,
                minHeight: 40,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>
                {tr('Proxy authentication')}
              </Text>
              <ChoiceIndicator
                kind="switch"
                checked={value().proxy.authEnabled}
                disabled={disabled()}
              />
            </Button>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Saving with proxy authentication disabled deletes its stored password.')}
            </Text>
            <If when={value().proxy.authEnabled}>
              <SettingsField
                label={tr('Proxy username')}
                value={value().proxy.username}
                disabled={disabled()}
                change={(text) => owner.edit('username', text)}
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Button
                  disabled={disabled()}
                  selected={value().credential === 'keep'}
                  accessibilityLabel={tr('Keep proxy password')}
                  onPress={inputAction(owner.choose, {
                    ...owner.action(),
                    kind: 'credential',
                    value: 'keep',
                  })}
                  style={{
                    ...controlStyle,
                    minHeight: 40,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  selectedStyle={{ backgroundColor: C.raised }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <ChoiceIndicator
                    kind="radio"
                    checked={value().credential === 'keep'}
                    disabled={disabled()}
                  />
                  <Text style={{ ...bodyTextStyle, color: C.text }}>
                    {tr('Keep stored password')}
                  </Text>
                </Button>
                <Button
                  disabled={disabled()}
                  selected={value().credential === 'replace'}
                  accessibilityLabel={tr('Replace proxy password')}
                  onPress={inputAction(owner.choose, {
                    ...owner.action(),
                    kind: 'credential',
                    value: 'replace',
                  })}
                  style={{
                    ...controlStyle,
                    minHeight: 40,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  selectedStyle={{ backgroundColor: C.raised }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <ChoiceIndicator
                    kind="radio"
                    checked={value().credential === 'replace'}
                    disabled={disabled()}
                  />
                  <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Replace password')}</Text>
                </Button>
              </View>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {owner.snapshot()?.credential.configured
                  ? tr('A proxy password is stored. Its value is never read back.')
                  : tr('No proxy password is stored.')}
              </Text>
              <If when={value().credential === 'replace'}>
                <SettingsField
                  label={tr('Proxy password')}
                  value={value().secret}
                  masked
                  disabled={disabled()}
                  change={(text) => owner.edit('secret', text)}
                  hint={tr('Stored securely, separately from your proxy settings.')}
                />
              </If>
            </If>
            <SettingsField
              label={tr('Proxy bypass rules')}
              value={value().bypass}
              multiline
              disabled={disabled()}
              change={(text) => owner.edit('bypass', text)}
              hint={tr('One bypass rule per line. Automatic rules are retained.')}
            />
            <If when={owner.snapshot()!.proxy.autoBypassDomains.length > 0}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Automatic bypass: {domains}', {
                  domains: owner.snapshot()!.proxy.autoBypassDomains.join(', '),
                })}
              </Text>
            </If>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('Save network settings')}
              onPress={inputAction(owner.save, owner.action())}
              style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
              hoverStyle={{ backgroundColor: C.accentHover }}
              focusStyle={{ backgroundColor: C.accentHover }}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...bodyTextStyle, color: C.background, fontWeight: '500' }}>
                {tr('Save network settings')}
              </Text>
            </Button>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('Reload network settings')}
              onPress={inputAction(owner.reload, owner.action())}
              style={{ ...controlStyle, ...fieldBoxStyle, alignSelf: 'flex-start' }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                {tr('Discard edits and reload')}
              </Text>
            </Button>
          </View>
        </Scroll>
      </If>
      <If when={!owner.draft() && !owner.loading()}>
        <Button
          accessibilityLabel={tr('Reload network settings')}
          onPress={inputAction(owner.reload, owner.action())}
          style={{ ...controlStyle, alignSelf: 'flex-start' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>
            {tr('Reload network settings')}
          </Text>
        </Button>
      </If>
    </View>
  );
}
