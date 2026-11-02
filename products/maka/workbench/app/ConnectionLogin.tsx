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
import { inputAction, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function ConnectionLogin(props: { owner: ModelSettingsOwner; disabled: boolean }) {
  const owner = props.owner;
  const methods = () =>
    owner.editor()!.provider.descriptor.authentication.filter((m) => m.interactive);
  const authorization = owner.login.authorization;
  const needsSave = () => !owner.editor()!.baseline || owner.dirty();
  const label = (method: { label: string }) =>
    needsSave()
      ? tr('Save and sign in')
      : owner.credential()?.configured
        ? tr('Sign in again')
        : method.label === 'Sign in with ChatGPT'
          ? tr('Sign in with ChatGPT')
          : method.label;
  return (
    <If when={methods().length > 0}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon
            name={owner.credential()?.configured ? 'check' : 'lock'}
            color={owner.credential()?.configured ? C.success : C.secondary}
          />
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
            {owner.credential()?.configured ? tr('Signed in') : tr('Provider sign-in')}
          </Text>
        </View>
        <If when={!owner.login.state()}>
          <Each of={methods()} key={(method) => method.id}>
            {(method) => (
              <Button
                accessibilityLabel={label(method())}
                disabled={props.disabled}
                onPress={inputAction(owner.signIn, { ...owner.action(), method: method().id })}
                style={{
                  ...controlStyle,
                  alignSelf: 'flex-start',
                  ...(!owner.credential()?.configured ? { backgroundColor: C.accent } : {}),
                }}
                hoverStyle={
                  owner.credential()?.configured
                    ? controlHoverStyle()
                    : { backgroundColor: C.accentHover }
                }
                focusStyle={{
                  ...controlFocusStyle(),
                  ...(!owner.credential()?.configured ? { backgroundColor: C.accentHover } : {}),
                }}
                activeStyle={{
                  backgroundColor: owner.credential()?.configured ? C.raised : C.accentHover,
                }}
                disabledStyle={controlDisabledStyle}
              >
                <Text
                  style={{
                    ...captionTextStyle,
                    color: owner.credential()?.configured ? C.secondary : C.background,
                    fontWeight: '500',
                  }}
                >
                  {label(method())}
                </Text>
              </Button>
            )}
          </Each>
        </If>
        <If when={owner.login.state()?.kind === 'models'}>
          <LoadingIndicator label={tr('Loading models…')} />
        </If>
        <If when={authorization()}>
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>
            {authorization()!.cancelling
              ? tr('Cancelling sign-in…')
              : !authorization()!.prompt
                ? tr('Starting sign-in…')
                : authorization()!.browser === 'failed'
                  ? tr('Copy the URL and open it in your browser.')
                  : tr('Complete sign-in in your browser.')}
          </Text>
          <If when={authorization()!.prompt}>
            <If when={authorization()!.prompt!.userCode}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}
              >
                <Text
                  style={[
                    { color: C.text, fontSize: 20, fontWeight: '600', fontFamily: 'monospace' },
                    { userSelect: 'text' },
                  ]}
                >
                  {authorization()!.prompt!.userCode}
                </Text>
                <Button
                  accessibilityLabel={tr('Copy sign-in code')}
                  onPress={inputAction(owner.login.copy, {
                    occurrence: authorization()!.occurrence,
                    field: 'userCode',
                    value: authorization()!.prompt!.userCode,
                  })}
                  style={controlStyle}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  activeStyle={{ backgroundColor: C.raised }}
                >
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {owner.login.copied() === 'userCode' ? tr('Copied') : tr('Copy code')}
                  </Text>
                </Button>
              </View>
            </If>
            <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
              {authorization()!.prompt!.url}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <Button
                accessibilityLabel={tr('Open sign-in page')}
                disabled={authorization()!.cancelling || authorization()!.browser === 'opening'}
                onPress={inputAction(owner.login.open, {
                  occurrence: authorization()!.occurrence,
                  url: authorization()!.prompt!.url,
                })}
                style={{ ...controlStyle, backgroundColor: C.accent }}
                hoverStyle={{ backgroundColor: C.accentHover }}
                focusStyle={{ backgroundColor: C.accentHover }}
                activeStyle={{ backgroundColor: C.accentHover }}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '500' }}>
                  {authorization()!.browser === 'opening'
                    ? tr('Opening browser…')
                    : tr('Open sign-in page')}
                </Text>
              </Button>
              <Button
                accessibilityLabel={tr('Copy sign-in URL')}
                onPress={inputAction(owner.login.copy, {
                  occurrence: authorization()!.occurrence,
                  field: 'url',
                  value: authorization()!.prompt!.url,
                })}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                activeStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {owner.login.copied() === 'url' ? tr('Copied') : tr('Copy URL')}
                </Text>
              </Button>
            </View>
          </If>
          <Button
            accessibilityLabel={tr('Cancel provider sign-in')}
            disabled={authorization()!.cancelling}
            onPress={inputAction(owner.login.cancel, authorization()!.occurrence)}
            style={{ ...controlStyle, alignSelf: 'flex-start' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.raised }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Cancel sign-in')}</Text>
          </Button>
        </If>
      </View>
    </If>
  );
}
