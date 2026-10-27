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

import { inputAction, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { tr } from './locale';
import { C, controlStyle, controlHoverStyle, controlFocusStyle, controlDisabledStyle } from './ui';

export function ConnectionLogin(props: { owner: ModelSettingsOwner; disabled: boolean }) {
  const owner = props.owner;
  const methods = () =>
    owner.editor()!.provider.descriptor.authentication.filter((m) => m.interactive);
  const login = () => owner.login.state();
  return (
    <If when={methods().length > 0}>
      <View style={{ gap: 8 }}>
        <Text style={{ color: C.text, fontWeight: '700' }}>{tr('Provider sign-in')}</Text>
        <If when={!owner.editor()!.baseline}>
          <Text style={{ color: C.muted }}>
            {tr('Save this connection before starting sign-in.')}
          </Text>
        </If>
        <If when={owner.editor()!.baseline && !login()}>
          <Text style={{ color: C.muted }}>
            {owner.credential()?.configured
              ? tr('A provider credential is stored. Sign in again to replace it.')
              : tr('Complete sign-in with your provider. Credentials stay in the Host vault.')}
          </Text>
          <Each of={methods()} key={(method) => method.id}>
            {(method) => (
              <Button
                accessibilityLabel={method().label}
                disabled={props.disabled || owner.dirty()}
                onPress={inputAction(owner.login.start, owner.loginAction(method().id))}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ color: C.accent }}>{method().label}</Text>
              </Button>
            )}
          </Each>
          <If when={owner.dirty()}>
            <Text style={{ color: C.muted }}>
              {tr('Save or discard connection edits before signing in.')}
            </Text>
          </If>
        </If>
        <If when={login()}>
          <Text style={{ color: C.muted }}>
            {login()!.cancelling
              ? tr('Cancelling sign-in; waiting for the original result…')
              : login()!.prompt
                ? login()!.prompt!.userCode
                  ? tr('Open this URL in your browser and enter the code. Waiting for sign-in…')
                  : tr('Open this URL in your browser. Waiting for sign-in…')
                : tr('Starting sign-in…')}
          </Text>
          <If when={login()!.prompt}>
            <Text style={[{ color: C.text }, { userSelect: 'text' }]}>{login()!.prompt!.url}</Text>
            <If when={login()!.prompt!.userCode}>
              <Text style={[{ color: C.accent, fontWeight: '700' }, { userSelect: 'text' }]}>
                {login()!.prompt!.userCode}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Button
                accessibilityLabel={tr('Copy sign-in URL')}
                onPress={inputAction(owner.login.copy, {
                  occurrence: login()!.occurrence,
                  field: 'url',
                  value: login()!.prompt!.url,
                })}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ color: C.accent }}>{tr('Copy URL')}</Text>
              </Button>
              <If when={login()!.prompt!.userCode}>
                <Button
                  accessibilityLabel={tr('Copy sign-in code')}
                  onPress={inputAction(owner.login.copy, {
                    occurrence: login()!.occurrence,
                    field: 'userCode',
                    value: login()!.prompt!.userCode,
                  })}
                  style={controlStyle}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ color: C.accent }}>{tr('Copy code')}</Text>
                </Button>
              </If>
            </View>
          </If>
          <Button
            accessibilityLabel={tr('Cancel provider sign-in')}
            disabled={login()!.cancelling}
            onPress={inputAction(owner.login.cancel, login()!.occurrence)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ color: C.warning }}>{tr('Cancel sign-in')}</Text>
          </Button>
        </If>
      </View>
    </If>
  );
}
