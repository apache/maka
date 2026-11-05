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
import type { AgentExternalRuntime } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ExternalAgentSettingsOwner } from './externalAgentSettingsState';
import { ChoiceIndicator } from './ChoiceIndicator';
import { LoadingState } from './Loading';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  fieldBoxStyle,
} from './ui';

function installationText(value: AgentExternalRuntime['installation']) {
  switch (value.kind) {
    case 'available':
      return value.version
        ? tr('Installed ({version})', { version: value.version })
        : tr('Installed');
    case 'not_found':
      return tr('Not installed');
    case 'unsupported':
      return tr('Unsupported: {detail}', { detail: value.detail });
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}
function authenticationText(value: AgentExternalRuntime['authentication']) {
  switch (value.kind) {
    case 'authenticated':
      return tr('Signed in ({source})', { source: value.source });
    case 'unauthenticated':
      return [tr('Not signed in ({source})', { source: value.source }), value.detail]
        .filter(Boolean)
        .join(' — ');
    case 'unsupported':
      return tr('Authentication status is not supported');
    case 'unknown':
      return [
        tr('Authentication status unknown'),
        value.source,
        value.detail,
        value.configured?.join(', '),
      ]
        .filter(Boolean)
        .join(' — ');
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}
function modelsText(value: AgentExternalRuntime['models']) {
  switch (value.kind) {
    case 'ready':
      return tr('{count} models available', { count: value.count });
    case 'unauthenticated':
      return [tr('Sign in to discover models'), value.detail].filter(Boolean).join(' — ');
    case 'unsupported':
      return tr('Unsupported: {detail}', { detail: value.detail });
    case 'unavailable':
      return tr('Models unavailable');
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}

function shortStatus(value: AgentExternalRuntime) {
  if (value.installation.kind === 'not_found') return tr('Not installed');
  if (value.installation.kind === 'unsupported') return tr('Not supported on this device');
  if (value.installation.kind === 'error') return tr('Could not check installation');
  if (value.authentication.kind === 'unauthenticated') return tr('Sign in required');
  if (value.models.kind === 'ready')
    return tr('{count} models available', { count: value.models.count });
  if (value.authentication.kind === 'error' || value.authentication.kind === 'unknown')
    return tr('Could not verify sign-in');
  if (value.models.kind === 'unauthenticated') return tr('Sign in required');
  return tr('Models unavailable');
}

export function ExternalAgentSettings(props: { owner: ExternalAgentSettingsOwner }) {
  const owner = props.owner;
  const buttonStyle = { ...controlStyle, alignSelf: 'flex-start' as const };
  const textStyle = { ...bodyTextStyle, color: C.text };
  const mutedStyle = { ...captionTextStyle, color: C.muted };
  const unavailable = () => {
    const state = owner.catalog()?.state;
    return owner.failure() ?? (state?.kind === 'unavailable' ? state.message : null);
  };
  const statusLabel = (id: string) => {
    const status = owner.status(id);
    if (status) return shortStatus(status);
    if (owner.loading()) return tr('Checking external agents…');
    if (owner.catalog()?.state.kind === 'workspace_required')
      return tr('Choose a workspace to check status');
    return tr('Status unavailable');
  };
  return (
    <Scroll accessibilityLabel={tr('External agent runtimes')} style={{ flex: 1, minHeight: 0 }}>
      <View style={{ gap: 10, padding: 8 }}>
        <Button
          disabled={owner.disabled()}
          accessibilityLabel={tr('Refresh external agents')}
          onPress={inputAction(owner.reload, owner.action())}
          style={buttonStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={textStyle}>{tr('Refresh')}</Text>
        </Button>
        <If when={owner.loading() && !owner.basis()}>
          <LoadingState label={tr('Checking external agents…')} />
        </If>
        <If when={unavailable()}>
          <Button
            accessibilityLabel={tr('Show external agent error details')}
            onPress={inputAction(owner.toggleDetails, { ...owner.action(), runtime: 'error' })}
            style={buttonStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={mutedStyle}>
              {tr('Status unavailable')} · {tr('Details')}
            </Text>
          </Button>
          <If when={owner.details() === 'error'}>
            <Text style={mutedStyle}>{unavailable()}</Text>
          </If>
        </If>
        <If when={owner.confirmation()}>
          <View style={{ ...fieldBoxStyle(), padding: 12, gap: 10 }}>
            <Text style={textStyle}>
              {tr('Enable {name}', { name: owner.confirmation()!.name })}
            </Text>
            <Text style={textStyle}>
              {tr(
                'This agent runs in its native full-access mode. It can read and write files, run commands and access the network outside the Maka sandbox.',
              )}
            </Text>
            <Text style={mutedStyle}>{tr('Other Maka permissions stay unchanged.')}</Text>
            <Button
              disabled={owner.disabled()}
              selected={owner.confirmation()!.acknowledged}
              accessibilityLabel={tr('I understand and accept the external agent permissions')}
              onPress={inputAction(owner.acknowledge, {
                ...owner.action(),
                value: !owner.confirmation()!.acknowledged,
              })}
              style={{ ...buttonStyle, flexDirection: 'row', gap: 8, alignItems: 'center' }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <ChoiceIndicator
                kind="checkbox"
                checked={owner.confirmation()!.acknowledged}
                disabled={owner.disabled()}
              />
              <Text style={textStyle}>{tr('I understand and accept these permissions')}</Text>
            </Button>
            <Button
              disabled={owner.disabled() || !owner.confirmation()!.acknowledged}
              accessibilityLabel={tr('Confirm permissions and enable')}
              onPress={inputAction(owner.enable, owner.action())}
              style={buttonStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={textStyle}>{tr('Confirm permissions and enable')}</Text>
            </Button>
            <Button
              disabled={owner.disabled()}
              accessibilityLabel={tr('Cancel enabling external agents')}
              onPress={inputAction(owner.cancel, owner.action())}
              style={buttonStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={textStyle}>{tr('Cancel')}</Text>
            </Button>
          </View>
        </If>
        <If when={!owner.confirmation()}>
          <Each of={owner.runtimes()} key={(runtime) => runtime.id}>
            {(runtime) => (
              <View style={{ gap: 6, paddingVertical: 8 }}>
                <Button
                  disabled={owner.disabled()}
                  selected={runtime().enabled}
                  accessibilityLabel={tr(runtime().enabled ? 'Disable {name}' : 'Enable {name}', {
                    name: runtime().name,
                  })}
                  onPress={
                    runtime().enabled
                      ? inputAction(owner.disable, { ...owner.action(), runtime: runtime().id })
                      : inputAction(owner.requestEnable, {
                          ...owner.action(),
                          runtime: runtime().id,
                        })
                  }
                  style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...textStyle, flex: 1 }}>{runtime().name}</Text>
                  <ChoiceIndicator
                    kind="switch"
                    checked={runtime().enabled}
                    disabled={owner.disabled()}
                  />
                </Button>
                <If when={runtime().enabled}>
                  <View style={{ paddingHorizontal: controlStyle.paddingHorizontal, gap: 6 }}>
                    <Text style={mutedStyle}>{statusLabel(runtime().id)}</Text>
                    <Button
                      accessibilityLabel={tr(
                        owner.details() === runtime().id
                          ? 'Hide {name} details'
                          : 'Show {name} details',
                        { name: runtime().name },
                      )}
                      onPress={inputAction(owner.toggleDetails, {
                        ...owner.action(),
                        runtime: runtime().id,
                      })}
                      style={buttonStyle}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text style={mutedStyle}>
                        {owner.details() === runtime().id ? tr('Hide details') : tr('Details')}
                      </Text>
                    </Button>
                    <If when={owner.details() === runtime().id}>
                      <If when={owner.status(runtime().id)}>
                        <Text style={mutedStyle}>
                          {installationText(owner.status(runtime().id)!.installation)}
                        </Text>
                        <If when={owner.status(runtime().id)!.installation.kind === 'available'}>
                          <Text style={mutedStyle}>
                            {authenticationText(owner.status(runtime().id)!.authentication)}
                          </Text>
                          <Text style={mutedStyle}>
                            {modelsText(owner.status(runtime().id)!.models)}
                          </Text>
                          <Text style={mutedStyle}>
                            {tr(
                              'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.',
                            )}
                          </Text>
                        </If>
                      </If>
                    </If>
                    <If when={owner.status(runtime().id)?.installation.kind === 'not_found'}>
                      <Text style={mutedStyle}>
                        {tr('Install and sign in using the native CLI, then Refresh.')}
                      </Text>
                    </If>
                  </View>
                </If>
              </View>
            )}
          </Each>
        </If>
      </View>
    </Scroll>
  );
}
