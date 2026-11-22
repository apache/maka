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

import { inputAction, Text } from 'nsh';
import type { ModelSettingsOwner } from './settings';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import { providerLabel } from './settingsLabels';
import { SettingsButton, SettingsRow, SettingsSection } from './SettingsPage';
import { C } from './ui';

export function ConnectionLogin(props: { owner: ModelSettingsOwner; disabled: boolean }) {
  const owner = props.owner;
  const methods = () =>
    owner.editor()!.provider.descriptor.authentication.filter((m) => m.interactive);
  const authorization = owner.login.authorization;
  const signedIn = () => !!owner.credential()?.configured;
  const needsSave = () => !owner.editor()!.baseline || owner.dirty();
  const label = (method: { label: string }) =>
    needsSave()
      ? tr('Save and sign in')
      : signedIn()
        ? tr('Sign in again')
        : method.label === 'Sign in with ChatGPT'
          ? tr('Sign in with ChatGPT')
          : method.label;
  return (
    <SettingsSection title={tr('Account')}>
      <SettingsRow
        label={signedIn() ? tr('Signed in') : tr('Not signed in')}
        description={providerLabel(owner.editor()!.provider.descriptor.label)}
        trailing={
          <If when={!owner.login.state()}>
            <Each of={methods()} key={(method) => method.id}>
              {(method) => (
                <SettingsButton
                  label={label(method())}
                  tone={signedIn() ? undefined : 'primary'}
                  disabled={props.disabled}
                  onPress={inputAction(owner.signIn, { ...owner.action(), method: method().id })}
                />
              )}
            </Each>
          </If>
        }
      />
      <If when={owner.login.state()?.kind === 'models'}>
        <SettingsRow label="" leading={<LoadingIndicator label={tr('Loading models…')} />} />
      </If>
      <If when={authorization()}>
        <SettingsRow
          label={
            authorization()!.cancelling
              ? tr('Cancelling sign-in…')
              : !authorization()!.prompt
                ? tr('Starting sign-in…')
                : authorization()!.browser === 'failed'
                  ? tr('Copy the URL and open it in your browser.')
                  : tr('Complete sign-in in your browser.')
          }
          trailing={
            <SettingsButton
              label={tr('Cancel sign-in')}
              accessibilityLabel={tr('Cancel provider sign-in')}
              tone="quiet"
              disabled={authorization()!.cancelling}
              onPress={inputAction(owner.login.cancel, authorization()!.occurrence)}
            />
          }
        />
        <If when={authorization()!.prompt?.userCode}>
          <SettingsRow
            label={tr('Sign-in code')}
            trailing={
              <>
                <Text
                  style={[
                    {
                      color: C.text,
                      fontSize: 18,
                      lineHeight: 24,
                      fontWeight: '600',
                      fontFamily: 'monospace',
                    },
                    { userSelect: 'text' },
                  ]}
                >
                  {authorization()!.prompt!.userCode}
                </Text>
                <SettingsButton
                  label={owner.login.copied() === 'userCode' ? tr('Copied') : tr('Copy code')}
                  accessibilityLabel={tr('Copy sign-in code')}
                  tone="quiet"
                  onPress={inputAction(owner.login.copy, {
                    occurrence: authorization()!.occurrence,
                    field: 'userCode',
                    value: authorization()!.prompt!.userCode,
                  })}
                />
              </>
            }
          />
        </If>
        <If when={authorization()!.prompt}>
          <SettingsRow
            label={tr('Sign-in page')}
            description={authorization()!.prompt!.url}
            trailing={
              <>
                <SettingsButton
                  label={owner.login.copied() === 'url' ? tr('Copied') : tr('Copy URL')}
                  accessibilityLabel={tr('Copy sign-in URL')}
                  tone="quiet"
                  onPress={inputAction(owner.login.copy, {
                    occurrence: authorization()!.occurrence,
                    field: 'url',
                    value: authorization()!.prompt!.url,
                  })}
                />
                <SettingsButton
                  label={
                    authorization()!.browser === 'opening'
                      ? tr('Opening browser…')
                      : tr('Open sign-in page')
                  }
                  accessibilityLabel={tr('Open sign-in page')}
                  tone="primary"
                  disabled={authorization()!.cancelling || authorization()!.browser === 'opening'}
                  onPress={inputAction(owner.login.open, {
                    occurrence: authorization()!.occurrence,
                    url: authorization()!.prompt!.url,
                  })}
                />
              </>
            }
          />
        </If>
      </If>
    </SettingsSection>
  );
}
